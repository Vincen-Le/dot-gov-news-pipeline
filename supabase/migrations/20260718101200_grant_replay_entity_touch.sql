-- The lab replay (pipeline/runner.py cluster) emulates ingest-time entity
-- touching in event time: bench corpora arrive via direct-SQL sync, so the
-- ingest-path touch never happened and reset_clusters wipes the prepare-time
-- partials. The helper therefore needs service_role execute after all.
grant execute on function public.touch_entity_stats(text[], timestamptz)
    to service_role;
