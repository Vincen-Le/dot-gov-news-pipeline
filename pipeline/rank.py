"""Rank observability: per-run facet snapshots and the read-only LLM rank
audit. The audit never mutates rank_key — its verdicts are tuning signal
(metrics + weight fitting), by design (see the ranking v1 spec)."""

from __future__ import annotations

import json

from pipeline.config import Config
from pipeline.experiment import _NAMESPACES

# rank_snapshots predates per-pipeline namespacing (supabase/migrations/
# 20260719140000) and was left bare for complex_v1; only simple_v1 gets its
# own namespaced copy (20260719150000). Namespace resolves through the same
# fixed engine dict experiment.py uses — never from user input.
def _rank_snapshot_table(cfg: Config) -> str:
    ns = _NAMESPACES.get(cfg.engine)
    assert ns is not None, f"no namespace registered for engine {cfg.engine!r}"
    return "rank_snapshots" if ns == "complex_v1" else f"{ns}_rank_snapshots"


# One insert-select freezes the whole per-facet ranking. Facets expand via a
# lateral union: global always; one row per agency; theme/category when the
# theme workstream has assigned them. Ties break on content-stable columns
# before id (ids regenerate across replays).
_SNAPSHOT_SQL = """
insert into public.{table}
    (run_id, facet_type, facet_key, position, storyline_id, card_id,
     rank_key, terms, judged, headline, summary, rubric, interest_reason,
     agencies, feeds, entry_count, newest_entry_at)
select
    %(run_id)s,
    f.facet_type,
    f.facet_key,
    row_number() over (
        partition by f.facet_type, f.facet_key
        order by c.rank_key desc, s.first_entry_at, c.headline, s.id),
    s.id,
    c.id,
    c.rank_key,
    public.compute_rank_key_terms(
        c.rubric, c.rubric_version, cardinality(s.agency_ids),
        s.distinct_feeds, s.source_weight_max, c.newest_entry_at, %(tau)s),
    c.rubric is not null,
    c.headline,
    c.summary,
    c.rubric,
    c.interest_reason,
    cardinality(s.agency_ids),
    s.distinct_feeds,
    s.entry_count,
    c.newest_entry_at
from public.storylines s
join public.event_cards c on c.id = s.latest_card_id
cross join lateral (
    select 'global'::text as facet_type, ''::text as facet_key
    union all
    select 'agency', a from unnest(s.agency_ids) as a
    union all
    select 'theme', s.theme_id::text where s.theme_id is not null
    union all
    select 'category', t.category_id::text
    from public.topic_themes t
    where t.id = s.theme_id and t.category_id is not null
) f
where s.merged_into is null
"""


def snapshot_run(db, cfg: Config, run_id: str) -> dict:
    table = _rank_snapshot_table(cfg)
    cursor = db.conn.execute(
        _SNAPSHOT_SQL.format(table=table), {"run_id": run_id, "tau": cfg.tau_seconds})
    return {"snapshot_rows": cursor.rowcount}


_TERM_KEYS = ("rubric_points", "agency_term", "feed_term", "source_term",
              "freshness_term")


def _audit_item(row: dict, newest) -> dict:
    age_h = 0.0
    if row.get("newest_entry_at") is not None and newest is not None:
        age_h = max(0.0, (newest - row["newest_entry_at"]).total_seconds() / 3600)
    return {"headline": row["headline"] or "(no headline)",
            "summary": row.get("summary") or "",
            "agencies": row["agencies"], "feeds": row["feeds"],
            "entries": row["entry_count"], "age_hours": round(age_h, 1)}


def _verdict(fwd: dict, rev: dict) -> str:
    # position-bias control: keep only swap-consistent verdicts
    if fwd["prefers"] == "a" and rev["prefers"] == "b":
        return "a"
    if fwd["prefers"] == "b" and rev["prefers"] == "a":
        return "b"
    return "inconsistent"


def audit_run(db, models, cfg: Config, run_id: str) -> dict:
    if cfg.engine == "spine":
        raise ValueError("rank audit not yet supported for simple_v1")
    facets = [f.strip() for f in cfg.rank_audit_facets.split(",") if f.strip()]
    rows = db.all(
        """
        select facet_type, facet_key, position, storyline_id, headline, summary,
               agencies, feeds, entry_count, newest_entry_at, terms
        from public.rank_snapshots
        where run_id = %(run)s and facet_type = any(%(facets)s)
          and position <= %(k)s
        order by facet_type, facet_key, position
        """,
        {"run": run_id, "facets": facets, "k": cfg.rank_audit_top_k})

    groups: dict[tuple, list[dict]] = {}
    for row in rows:
        groups.setdefault((row["facet_type"], row["facet_key"]), []).append(row)

    pairs = agree = disagree = inconsistent = 0
    per_facet: dict[str, dict] = {}
    delta_sums = {k: 0.0 for k in _TERM_KEYS}
    for (facet_type, facet_key), members in groups.items():
        newest = max((m["newest_entry_at"] for m in members
                      if m["newest_entry_at"] is not None), default=None)
        stats = per_facet.setdefault(facet_type, {"pairs": 0, "agree": 0,
                                                  "disagree": 0, "inconsistent": 0})
        for i, a in enumerate(members):
            for b in members[i + 1: i + 1 + cfg.rank_audit_window]:
                fwd = models.compare_rank(_audit_item(a, newest), _audit_item(b, newest))
                rev = models.compare_rank(_audit_item(b, newest), _audit_item(a, newest))
                llm = _verdict(fwd, rev)
                pairs += 1
                stats["pairs"] += 1
                if llm == "a":
                    agree += 1
                    stats["agree"] += 1
                elif llm == "b":
                    disagree += 1
                    stats["disagree"] += 1
                    for key in _TERM_KEYS:
                        delta_sums[key] += float(a["terms"][key]) - float(b["terms"][key])
                else:
                    inconsistent += 1
                    stats["inconsistent"] += 1
                db.conn.execute(
                    """
                    insert into public.rank_audit_pairs
                        (run_id, facet_type, facet_key, position_a, position_b,
                         storyline_a, storyline_b, llm_prefers, llm_reason,
                         judge_model, prompt_version)
                    values (%(run)s, %(ft)s, %(fk)s, %(pa)s, %(pb)s, %(sa)s, %(sb)s,
                            %(llm)s, %(reason)s, %(model)s, %(pv)s)
                    on conflict (run_id, facet_type, facet_key, position_a, position_b)
                    do update set llm_prefers = excluded.llm_prefers,
                                  llm_reason = excluded.llm_reason,
                                  sampled_at = now()
                    """,
                    {"run": run_id, "ft": facet_type, "fk": facet_key,
                     "pa": a["position"], "pb": b["position"],
                     "sa": a["storyline_id"], "sb": b["storyline_id"],
                     "llm": llm,
                     "reason": (fwd["reason"] if llm != "inconsistent"
                                else f"fwd: {fwd['reason']} / rev: {rev['reason']}")[:2048],
                     "model": cfg.audit_model, "pv": cfg.prompt_version})

    decided = agree + disagree
    metrics = {
        "pairs": pairs,
        "agreement_rate": (agree / decided) if decided else None,
        # Kendall tau over the sampled pairs: concordant - discordant fraction
        "kendall_tau_sampled": ((agree - disagree) / decided) if decided else None,
        "inconsistent_rate": (inconsistent / pairs) if pairs else None,
        "per_facet": per_facet,
        "disagreement_term_deltas": (
            {k: delta_sums[k] / disagree for k in _TERM_KEYS} if disagree else {}),
    }
    db.conn.execute(
        "insert into public.rank_audit_runs (run_id, config, metrics) "
        "values (%(run)s, %(config)s::jsonb, %(metrics)s::jsonb)",
        {"run": run_id,
         "config": json.dumps({"top_k": cfg.rank_audit_top_k,
                               "window": cfg.rank_audit_window,
                               "facets": facets,
                               "audit_model": cfg.audit_model,
                               "prompt_version": cfg.prompt_version}),
         "metrics": json.dumps(metrics, default=str)})
    return metrics
