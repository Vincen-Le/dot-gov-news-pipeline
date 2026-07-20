begin;

-- generated_at is processing/audit time. Historical presentation uses
-- newest_entry_at as the event-time watermark represented by each immutable
-- card version. Episode cards carry their episode's watermark; overview cards
-- carry the storyline watermark captured when the version is written.
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
    v_card_newest_at timestamptz;
    v_version integer;
    v_dropped integer;
    s public.storylines%rowtype;
begin
    select * into s from public.storylines where id = p_storyline_id;

    if p_kind = 'episode' then
        select e.newest_entry_at into v_card_newest_at
        from public.episodes e
        where e.id = p_episode_id and e.storyline_id = p_storyline_id;
        if v_card_newest_at is null then
            raise exception 'episode card requires an episode in the supplied storyline';
        end if;
    else
        v_card_newest_at := s.newest_entry_at;
    end if;

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
         v_card_newest_at,
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
        delete from public.event_cards dead
        where dead.storyline_id = p_storyline_id
          and dead.kind = 'overview'
          and dead.superseded_by = v_card
          and dead.interest_reason = 'spine_initial_overview'
          and not exists (select 1 from public.event_cards ref
                          where ref.superseded_by = dead.id)
          and not exists (select 1 from public.storylines sl
                          where sl.latest_card_id = dead.id);
        get diagnostics v_dropped = row_count;
        if v_dropped > 0 then
            update public.event_cards
            set version = v_version - v_dropped
            where id = v_card;
        end if;
    elsif p_kind = 'episode' and s.latest_card_id is null then
        update public.storylines set latest_card_id = v_card where id = p_storyline_id;
    end if;

    return v_card;
end
$fn$;

-- Repair cards created after their storyline had already advanced to a later
-- episode. Overview watermarks were already captured from the storyline.
update public.event_cards card
set newest_entry_at = episode.newest_entry_at
from public.episodes episode
where card.kind = 'episode'
  and card.episode_id = episode.id
  and card.newest_entry_at is distinct from episode.newest_entry_at;

update public.golden_event_cards card
set newest_entry_at = episode.newest_entry_at
from public.golden_episodes episode
where card.kind = 'episode'
  and card.episode_id = episode.id
  and card.newest_entry_at is distinct from episode.newest_entry_at;

comment on column public.event_cards.newest_entry_at is
    'Event-time watermark represented by this immutable card version: episode newest_entry_at for episode cards, storyline newest_entry_at for overview cards. Historical serving uses this field; generated_at remains processing time.';
comment on column public.golden_event_cards.newest_entry_at is
    'Golden mirror of the event-time watermark used for historical card replay.';

commit;
