begin;

-- Review decision (Vincent, 2026-07-19): a storyline should not keep two
-- overview cards when one episode closes. The birth placeholder
-- ('spine_initial_overview' — raw title + enriched text, no rubric) exists
-- only so the link judge has master-node context between storyline birth
-- and the first episode close. Once a judged overview supersedes it, the
-- placeholder carries no information (it duplicates news_entries), so the
-- insert now deletes it instead of keeping it as version history. Judged
-- overviews still supersede-and-persist as before.

create or replace function public.insert_event_card(
    p_storyline_id uuid,
    p_episode_id uuid,
    p_kind text,
    p_headline text,
    p_summary text,
    p_timeline jsonb,
    p_rubric jsonb,
    p_rubric_version integer,
    p_interest_reason text,
    p_representative_entry_id uuid,
    p_judge_model text,
    p_prompt_version integer,
    p_overview_embedding bytea,
    p_tau double precision default 124600.0
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_card uuid;
    v_version integer;
    s public.storylines%rowtype;
begin
    select * into s from public.storylines where id = p_storyline_id;

    select coalesce(max(version), 0) + 1 into v_version
    from public.event_cards
    where storyline_id = p_storyline_id and kind = p_kind;

    insert into public.event_cards
        (storyline_id, episode_id, kind, version, headline, summary, timeline,
         rubric, rubric_version, interest_reason, representative_entry_id,
         newest_entry_at, rank_key, judge_model, prompt_version)
    values
        (p_storyline_id, p_episode_id, p_kind, v_version, p_headline, p_summary, p_timeline,
         p_rubric, p_rubric_version, p_interest_reason, p_representative_entry_id,
         s.newest_entry_at,
         public.compute_rank_key(
             p_rubric, p_rubric_version,
             cardinality(s.agency_ids), s.distinct_feeds,
             s.source_weight_max, s.newest_entry_at, p_tau),
         p_judge_model, p_prompt_version)
    returning id into v_card;

    if p_kind = 'overview' then
        update public.event_cards
        set superseded_by = v_card
        where storyline_id = p_storyline_id
          and kind = 'overview'
          and superseded_by is null
          and id <> v_card;
        update public.storylines
        set latest_card_id = v_card,
            centroid = coalesce(p_overview_embedding, centroid)
        where id = p_storyline_id;
        -- the birth placeholder is pure duplication once a judged overview
        -- exists; drop it rather than keep it as a version
        delete from public.event_cards dead
        where dead.storyline_id = p_storyline_id
          and dead.kind = 'overview'
          and dead.superseded_by = v_card
          and dead.interest_reason = 'spine_initial_overview'
          and not exists (select 1 from public.event_cards ref
                          where ref.superseded_by = dead.id)
          and not exists (select 1 from public.storylines sl
                          where sl.latest_card_id = dead.id);
    elsif p_kind = 'episode' and s.latest_card_id is null then
        -- single-episode collapse: the episode card doubles as the overview
        update public.storylines set latest_card_id = v_card where id = p_storyline_id;
    end if;

    return v_card;
end
$fn$;

comment on function public.insert_event_card is
    'Write-once card insert: rank_key computed at birth; overview kind supersedes the previous overview, refreshes storylines.latest_card_id + centroid, and drops the spine birth placeholder it superseded.';

-- One-time cleanup: superseded placeholders written before this rule.
delete from public.event_cards dead
where dead.kind = 'overview'
  and dead.interest_reason = 'spine_initial_overview'
  and dead.superseded_by is not null
  and not exists (select 1 from public.event_cards ref
                  where ref.superseded_by = dead.id)
  and not exists (select 1 from public.storylines sl
                  where sl.latest_card_id = dead.id);

commit;
