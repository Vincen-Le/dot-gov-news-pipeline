-- Snapshot completeness: capture centroids and the card columns needed to
-- restore a run's full serving state from its snapshot alone. The 2026-07-20
-- local wipe showed snapshots were the only copy of unpromoted cluster state,
-- but lacked centroids (storylines/episodes/themes) and four event_cards
-- columns (rubric_version, representative_entry_id, newest_entry_at,
-- prompt_version), so an exact restore was impossible. bytea centroids
-- serialize through to_jsonb as their hex text form and cast back on insert.
begin;

create or replace function public.simple_v1_capture_experiment_cluster_snapshot(p_run_id uuid)
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
        select 1 from public.simple_v1_experiment_runs where id = p_run_id
    ) then
        raise exception 'unknown simple_v1 experiment run %', p_run_id
            using errcode = '23503';
    end if;

    v_snapshot := pg_catalog.jsonb_build_object(
        'storylines', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data) order by row_data.id)
            from (
                select id, entity_set, event_keys, centroid, topic, cluster_topic,
                       agency_ids, distinct_feeds, entry_count, episode_count,
                       source_weight_max, first_entry_at, newest_entry_at,
                       latest_card_id, merged_into, created_at, theme_id,
                       theme_attach_method, theme_similarity, theme_reason,
                       category_id, category_method, category_reason
                from public.storylines
            ) as row_data
        ), '[]'::jsonb),
        'episodes', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data)
                                        order by row_data.first_entry_at, row_data.id)
            from (
                select id, storyline_id, status, centroid, entity_set, event_keys,
                       entry_count, first_entry_at, newest_entry_at, attach_method,
                       attach_similarity, attach_reason, adjudicator_model,
                       created_at
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
                       summary, timeline, rubric, rubric_version, interest_reason,
                       representative_entry_id, newest_entry_at, rank_key,
                       superseded_by, judge_model, prompt_version, generated_at
                from public.event_cards
            ) as row_data
        ), '[]'::jsonb),
        'topic_themes', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data)
                                        order by row_data.display_name, row_data.id)
            from (
                select id, display_name, centroid, category_id, storyline_count,
                       first_storyline_at, newest_storyline_at, merged_into,
                       name_model, inclusion_criterion, demoted_at, created_at
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

    insert into public.simple_v1_experiment_cluster_snapshots
        (run_id, snapshot, row_counts)
    values (p_run_id, v_snapshot, v_counts);

    return v_counts;
end;
$fn$;

commit;
