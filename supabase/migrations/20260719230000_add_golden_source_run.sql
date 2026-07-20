begin;

-- A golden render image is durable, while experiment rows are historical.
-- Keep the canonical run UUID on every mirrored card so ranking readers can
-- select exactly one frozen simple_v1 rank snapshot without guessing which
-- experiment happened to produce the current golden surface. Deliberately no
-- FK: deleting experiment history must never delete or invalidate gold.
alter table public.golden_event_cards
    add column source_run_id uuid;

comment on column public.golden_event_cards.source_run_id is
    'Canonical simple_v1 experiment run whose rank snapshot produced this golden render image. No FK: golden data outlives experiment history.';

create index golden_event_cards_source_run_idx
    on public.golden_event_cards (source_run_id, id);

-- Backfill the existing image only when one run''s global card set exactly
-- equals the current golden storyline-card set. Refuse an ambiguous migration
-- instead of silently choosing the newest run.
do $backfill$
declare
    v_live_cards integer;
    v_candidate_count integer;
    v_source_run_id uuid;
begin
    select count(*)::integer
    into v_live_cards
    from public.golden_storylines storyline
    join public.golden_event_cards card
      on card.id = storyline.latest_card_id
    where storyline.merged_into is null;

    if v_live_cards > 0 then
        with live_cards as (
            select card.id
            from public.golden_storylines storyline
            join public.golden_event_cards card
              on card.id = storyline.latest_card_id
            where storyline.merged_into is null
        ),
        candidates as (
            select snapshot.run_id
            from public.simple_v1_rank_snapshots snapshot
            where snapshot.facet_type = 'global'
              and snapshot.facet_key = ''
            group by snapshot.run_id
            having count(distinct snapshot.card_id) = v_live_cards
               and count(distinct snapshot.card_id) filter (
                       where snapshot.card_id in (select id from live_cards)
                   ) = v_live_cards
        )
        select count(*)::integer, (array_agg(run_id))[1]
        into v_candidate_count, v_source_run_id
        from candidates;

        if v_candidate_count <> 1 then
            raise exception
                'cannot backfill golden_event_cards.source_run_id: expected one exact simple_v1 rank-snapshot match, found %',
                v_candidate_count;
        end if;

        update public.golden_event_cards
        set source_run_id = v_source_run_id;
    end if;
end
$backfill$;

alter table public.golden_event_cards
    alter column source_run_id set not null;

commit;
