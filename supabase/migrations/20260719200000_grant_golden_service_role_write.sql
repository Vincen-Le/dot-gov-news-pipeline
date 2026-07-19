begin;

-- Golden curation happens locally (slice loop) and mirrors up to hosted as
-- the durable copy. service_role needs write access for that mirror; the
-- table stays RLS-locked for every other role.
grant insert, update on table public.golden_news_entries to service_role;
-- golden category labels FK into topic_categories, so the seed taxonomy
-- mirrors up through the same channel
grant insert, update on table public.topic_categories to service_role;

commit;
