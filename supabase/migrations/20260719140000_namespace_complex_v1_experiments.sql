-- Reserve parallel experiment namespaces for the complex and simplified pipelines.
begin;

alter table public.experiment_runs
    rename to complex_v1_experiment_runs;
alter table public.experiment_cluster_snapshots
    rename to complex_v1_experiment_cluster_snapshots;

alter index public.experiment_runs_created_idx
    rename to complex_v1_experiment_runs_created_idx;
alter index public.experiment_cluster_snapshots_created_idx
    rename to complex_v1_experiment_cluster_snapshots_created_idx;
alter index public.experiment_cluster_snapshots_one_best_idx
    rename to complex_v1_experiment_cluster_snapshots_one_best_idx;

drop trigger experiment_cluster_snapshots_payload_immutable
    on public.complex_v1_experiment_cluster_snapshots;
drop function public.capture_experiment_cluster_snapshot(uuid);
drop function public.annotate_experiment_cluster_snapshot(uuid, text, jsonb, boolean);
drop function public.reject_experiment_snapshot_payload_update();

create function public.complex_v1_capture_experiment_cluster_snapshot(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_snapshot jsonb;
    v_counts jsonb;
begin
    if not exists (
        select 1 from public.complex_v1_experiment_runs where id = p_run_id
    ) then
        raise exception 'unknown complex_v1 experiment run %', p_run_id
            using errcode = '23503';
    end if;

    v_snapshot := pg_catalog.jsonb_build_object(
        'storylines', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data) order by row_data.id)
            from (
                select id, entity_set, event_keys, agency_ids, distinct_feeds,
                       entry_count, episode_count, first_entry_at, newest_entry_at,
                       latest_card_id, merged_into, theme_id, theme_attach_method,
                       theme_similarity, theme_reason, category_id, category_method,
                       category_reason
                from public.storylines
            ) as row_data
        ), '[]'::jsonb),
        'episodes', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data)
                                        order by row_data.first_entry_at, row_data.id)
            from (
                select id, storyline_id, status, entity_set, event_keys,
                       entry_count, first_entry_at, newest_entry_at, attach_method,
                       attach_similarity, attach_reason, adjudicator_model
                from public.episodes
            ) as row_data
        ), '[]'::jsonb),
        'episode_entries', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data)
                                        order by row_data.episode_id, row_data.entry_id)
            from (
                select episode_id, entry_id, is_syndicated, attach_method,
                       similarity, matched_entry_id, threshold_used,
                       embedding_model, attached_at
                from public.episode_entries
            ) as row_data
        ), '[]'::jsonb),
        'news_entries', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data)
                                        order by row_data.published_at, row_data.id)
            from (
                select ne.id, ne.title, ne.url, ne.published_at, ne.entity_set,
                       ne.event_keys, nsp.publisher_key as agency
                from public.news_entries ne
                join (
                    select distinct entry_id from public.episode_entries
                ) members on members.entry_id = ne.id
                left join public.news_source_publishers nsp
                  on nsp.news_source_id = ne.news_source_id
            ) as row_data
        ), '[]'::jsonb),
        'event_cards', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data)
                                        order by row_data.storyline_id,
                                                 row_data.kind, row_data.version desc)
            from (
                select id, storyline_id, episode_id, kind, version, headline,
                       summary, timeline, rubric, interest_reason, rank_key,
                       superseded_by, judge_model, generated_at
                from public.event_cards
            ) as row_data
        ), '[]'::jsonb),
        'topic_themes', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data)
                                        order by row_data.display_name, row_data.id)
            from (
                select id, display_name, category_id, storyline_count,
                       first_storyline_at, newest_storyline_at, merged_into,
                       name_model, inclusion_criterion, demoted_at
                from public.topic_themes
            ) as row_data
        ), '[]'::jsonb),
        'topic_categories', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data)
                                        order by row_data.display_name, row_data.id)
            from (
                select id, display_name, origin, proposal_reason
                from public.topic_categories
            ) as row_data
        ), '[]'::jsonb)
    );

    v_counts := pg_catalog.jsonb_build_object(
        'storylines', pg_catalog.jsonb_array_length(v_snapshot -> 'storylines'),
        'episodes', pg_catalog.jsonb_array_length(v_snapshot -> 'episodes'),
        'episode_entries', pg_catalog.jsonb_array_length(v_snapshot -> 'episode_entries'),
        'news_entries', pg_catalog.jsonb_array_length(v_snapshot -> 'news_entries'),
        'event_cards', pg_catalog.jsonb_array_length(v_snapshot -> 'event_cards'),
        'topic_themes', pg_catalog.jsonb_array_length(v_snapshot -> 'topic_themes'),
        'topic_categories', pg_catalog.jsonb_array_length(v_snapshot -> 'topic_categories')
    );

    insert into public.complex_v1_experiment_cluster_snapshots
        (run_id, snapshot, row_counts)
    values (p_run_id, v_snapshot, v_counts);

    return v_counts;
end;
$fn$;

comment on function public.complex_v1_capture_experiment_cluster_snapshot(uuid) is
    'Atomically copies the complex_v1 derived clustering state into one immutable experiment-tagged JSON payload. A run can be captured exactly once.';

revoke all on function public.complex_v1_capture_experiment_cluster_snapshot(uuid)
    from public, anon, authenticated, service_role;

create function public.complex_v1_annotate_experiment_cluster_snapshot(
    p_run_id uuid,
    p_note text default null,
    p_reward jsonb default null,
    p_is_best boolean default false
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
    if p_is_best then
        update public.complex_v1_experiment_cluster_snapshots
        set is_best = false,
            updated_at = pg_catalog.now()
        where is_best and run_id <> p_run_id;
    end if;

    update public.complex_v1_experiment_cluster_snapshots
    set note = p_note,
        reward = p_reward,
        is_best = p_is_best,
        updated_at = pg_catalog.now()
    where run_id = p_run_id;

    if not found then
        raise exception 'unknown complex_v1 experiment snapshot %', p_run_id
            using errcode = 'P0002';
    end if;
end;
$fn$;

comment on function public.complex_v1_annotate_experiment_cluster_snapshot(uuid, text, jsonb, boolean) is
    'Adds complex_v1 replay metadata after judging and optionally promotes this run as the single dashboard best run. It never rewrites the captured clustering payload.';

revoke all on function public.complex_v1_annotate_experiment_cluster_snapshot(uuid, text, jsonb, boolean)
    from public, anon, authenticated, service_role;

create function public.complex_v1_reject_experiment_snapshot_payload_update()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
    if new.run_id is distinct from old.run_id
       or new.schema_version is distinct from old.schema_version
       or new.snapshot is distinct from old.snapshot
       or new.row_counts is distinct from old.row_counts
       or new.created_at is distinct from old.created_at then
        raise exception 'complex_v1 experiment snapshot payloads are immutable'
            using errcode = '55000';
    end if;
    return new;
end;
$fn$;

create trigger complex_v1_experiment_cluster_snapshots_payload_immutable
before update on public.complex_v1_experiment_cluster_snapshots
for each row execute function public.complex_v1_reject_experiment_snapshot_payload_update();

revoke all on function public.complex_v1_reject_experiment_snapshot_payload_update()
    from public, anon, authenticated, service_role;

comment on table public.complex_v1_experiment_runs is
    'One row per complex_v1 clustering experiment: resolved config, cluster report, summary stats, and timing.';
comment on table public.complex_v1_experiment_cluster_snapshots is
    'One immutable clustering-state payload per completed complex_v1 experiment, with mutable post-judging metadata.';

commit;
