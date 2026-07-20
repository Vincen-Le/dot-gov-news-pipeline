begin;

-- Mutable demo JSON is cached under this revision. Every transaction that
-- changes the reviewed serving surface advances it; immutable image assets do
-- not need to advance it because a new image always receives a new images.id.
create table public.demo_content_revisions (
    id boolean primary key default true,
    revision bigint not null default 1,
    updated_at timestamptz not null default now(),
    constraint demo_content_revisions_singleton check (id),
    constraint demo_content_revisions_positive check (revision >= 1)
);

insert into public.demo_content_revisions (id, revision)
values (true, 1);

comment on table public.demo_content_revisions is
    'Singleton cache namespace for mutable public demo JSON. Serving-table writes advance revision; clients resolve it before requesting immutable revisioned URLs.';

create function public.bump_demo_content_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.demo_content_revisions
    set revision = revision + 1,
        updated_at = pg_catalog.clock_timestamp()
    where id = true;
    return null;
end;
$$;

create trigger golden_news_entries_demo_revision
after insert or update or delete on public.golden_news_entries
for each statement execute function public.bump_demo_content_revision();

create trigger golden_topic_categories_demo_revision
after insert or update or delete on public.golden_topic_categories
for each statement execute function public.bump_demo_content_revision();

create trigger golden_topic_themes_demo_revision
after insert or update or delete on public.golden_topic_themes
for each statement execute function public.bump_demo_content_revision();

create trigger golden_storylines_demo_revision
after insert or update or delete on public.golden_storylines
for each statement execute function public.bump_demo_content_revision();

create trigger golden_episodes_demo_revision
after insert or update or delete on public.golden_episodes
for each statement execute function public.bump_demo_content_revision();

create trigger golden_event_cards_demo_revision
after insert or update or delete on public.golden_event_cards
for each statement execute function public.bump_demo_content_revision();

create trigger golden_article_overviews_demo_revision
after insert or update or delete on public.golden_event_card_article_overviews
for each statement execute function public.bump_demo_content_revision();

create trigger golden_storyline_thumbnails_demo_revision
after insert or update or delete on public.golden_storyline_thumbnails
for each statement execute function public.bump_demo_content_revision();

alter table public.demo_content_revisions enable row level security;

revoke all privileges on table public.demo_content_revisions
from public, anon, authenticated, service_role;
grant select on table public.demo_content_revisions to service_role;

revoke execute on function public.bump_demo_content_revision()
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
