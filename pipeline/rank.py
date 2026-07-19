"""Rank observability: per-run facet snapshots and the read-only LLM rank
audit. The audit never mutates rank_key — its verdicts are tuning signal
(metrics + weight fitting), by design (see the ranking v1 spec)."""

from __future__ import annotations

from pipeline.config import Config

# One insert-select freezes the whole per-facet ranking. Facets expand via a
# lateral union: global always; one row per agency; theme/category when the
# theme workstream has assigned them. Ties break on content-stable columns
# before id (ids regenerate across replays).
_SNAPSHOT_SQL = """
insert into public.rank_snapshots
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
    cursor = db.conn.execute(
        _SNAPSHOT_SQL, {"run_id": run_id, "tau": cfg.tau_seconds})
    return {"snapshot_rows": cursor.rowcount}
