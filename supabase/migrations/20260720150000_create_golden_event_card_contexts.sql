begin;

-- Golden render tables are full-rewrite mirrors, so this sidecar deliberately
-- has no FK to golden_event_cards. Rank snapshots later denormalize it again
-- so historical experiments survive future golden image replacement.
create table public.golden_event_card_contexts
    (like public.event_card_contexts including defaults including constraints);
alter table public.golden_event_card_contexts
    add primary key (event_card_id);

comment on table public.golden_event_card_contexts is
    'Golden mirror of exact card-birth contexts. event_card_id intentionally has no FK because golden render images are delete/reinsert mirrors.';

create index golden_event_card_contexts_storyline_cutoff_idx
    on public.golden_event_card_contexts (
        storyline_id, knowledge_cutoff_at, event_card_id
    );
create index golden_event_card_contexts_source_run_idx
    on public.golden_event_card_contexts (source_run_id, event_card_id)
    where source_run_id is not null;

alter table public.golden_event_card_contexts enable row level security;
revoke all privileges on table public.golden_event_card_contexts
    from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.golden_event_card_contexts
    to service_role;

commit;
