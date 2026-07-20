-- Invited contributors read the corpus two ways: the repo's committed
-- publishable key (anon role, PostgREST) and an optional direct read-only
-- role. Both are limited to exactly the three corpus tables that
-- pipeline sync copies. corpus_reader is created nologin; hosted rollout
-- enables login with a password manually (never in a migration).

begin;

do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'corpus_reader') then
        create role corpus_reader nologin noinherit;
    end if;
end $$;

grant usage on schema public to corpus_reader;

grant select on table public.news_sources to anon, corpus_reader;
grant select on table public.news_source_publishers to anon, corpus_reader;
grant select on table public.news_entries to anon, corpus_reader;

alter table public.news_sources enable row level security;
alter table public.news_source_publishers enable row level security;
alter table public.news_entries enable row level security;

create policy corpus_read on public.news_sources
    for select to anon, corpus_reader using (true);
create policy corpus_read on public.news_source_publishers
    for select to anon, corpus_reader using (true);
create policy corpus_read on public.news_entries
    for select to anon, corpus_reader using (true);

commit;
