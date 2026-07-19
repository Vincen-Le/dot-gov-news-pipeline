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

-- The auto-membership grant from CREATE ROLE gives postgres admin_option
-- on corpus_reader but not set_option (since corpus_reader is NOINHERIT),
-- so postgres cannot SET ROLE corpus_reader without this. Needed so the
-- local db admin connection (pgTAP tests, psql) can impersonate the role;
-- harmless since corpus_reader itself stays nologin/noinherit.
grant corpus_reader to postgres with set true;

grant usage on schema public to corpus_reader;
-- extensions schema holds pgTAP's assertion functions (lives_ok, throws_ok);
-- other client roles (anon, authenticated, service_role) already have this,
-- and corpus_reader needs it so the pgTAP suite can impersonate it in tests.
grant usage on schema extensions to corpus_reader;

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
