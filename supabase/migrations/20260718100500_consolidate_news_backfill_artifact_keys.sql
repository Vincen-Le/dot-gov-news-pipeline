-- Point historical provenance at the global content-addressed R2 namespace.
-- Apply only after consolidate-artifacts has copied every legacy object.

update public.news_backfill_targets
set coverage_evidence_artifact_key = regexp_replace(
    coverage_evidence_artifact_key,
    '^.*/([0-9a-f]{64})\.[a-z0-9]+$',
    'news-backfill/objects/\1'
)
where coverage_evidence_artifact_key is not null
  and coverage_evidence_artifact_key not like 'news-backfill/objects/%'
  and coverage_evidence_artifact_key ~ '/[0-9a-f]{64}\.[a-z0-9]+$';

update public.news_backfill_run_entries
set raw_artifact_key = regexp_replace(
    raw_artifact_key,
    '^.*/([0-9a-f]{64})\.[a-z0-9]+$',
    'news-backfill/objects/\1'
)
where raw_artifact_key not like 'news-backfill/objects/%'
  and raw_artifact_key ~ '/[0-9a-f]{64}\.[a-z0-9]+$';

update public.news_backfill_candidate_outcomes
set raw_artifact_key = regexp_replace(
    raw_artifact_key,
    '^.*/([0-9a-f]{64})\.[a-z0-9]+$',
    'news-backfill/objects/\1'
)
where raw_artifact_key not like 'news-backfill/objects/%'
  and raw_artifact_key ~ '/[0-9a-f]{64}\.[a-z0-9]+$';

update public.news_backfill_identity_conflicts
set raw_artifact_key = regexp_replace(
    raw_artifact_key,
    '^.*/([0-9a-f]{64})\.[a-z0-9]+$',
    'news-backfill/objects/\1'
)
where raw_artifact_key not like 'news-backfill/objects/%'
  and raw_artifact_key ~ '/[0-9a-f]{64}\.[a-z0-9]+$';
