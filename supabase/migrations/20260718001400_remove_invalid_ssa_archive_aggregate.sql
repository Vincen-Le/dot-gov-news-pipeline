begin;

-- The legacy SSA yearly archive renders many releases in one document. The
-- first collector revision collapsed its date anchors to the yearly page URL,
-- producing one synthetic aggregate instead of atomic news events. Remove that
-- row before replaying the corrected individually-addressable archive source.
delete from public.news_backfill_candidate_outcomes as outcome
where outcome.news_entry_id in (
    select entry.id
    from public.news_entries as entry
    where entry.url_canonical = 'https://www.ssa.gov/news/press/releases/2025'
);

delete from public.news_backfill_run_entries as run_entry
where run_entry.news_entry_id in (
    select entry.id
    from public.news_entries as entry
    where entry.url_canonical = 'https://www.ssa.gov/news/press/releases/2025'
);

delete from public.news_entries
where url_canonical = 'https://www.ssa.gov/news/press/releases/2025';

commit;
