begin;

-- The experiment ledger (runs, rank snapshots, cluster snapshots) is
-- produced locally per pipeline DB and mirrors up to hosted Supabase as the
-- durable copy, same channel as the golden_* mirror. service_role gets
-- write access for that mirror; everything else stays select-only.
grant insert, update, delete on table public.simple_v1_experiment_runs
    to service_role;
grant insert, update, delete on table public.simple_v1_experiment_cluster_snapshots
    to service_role;
grant insert, update, delete on table public.simple_v1_rank_snapshots
    to service_role;

commit;
