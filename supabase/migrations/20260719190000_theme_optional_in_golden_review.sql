begin;

-- Slice-based curation (2026-07-19): golden rows are reviewed slice by
-- slice as the replay advances, but themes structurally cannot exist until
-- enough storylines accumulate (spine_theme_min_size). A reviewed row
-- therefore requires episode, storyline, and category labels, while the
-- theme pair is optional — but must be both-set or both-null so a half
-- label can never sneak in. Theme labels are back-filled and re-reviewed
-- once the theme layer matures.
alter table public.golden_news_entries
    drop constraint golden_news_entries_reviewed_complete;
alter table public.golden_news_entries
    add constraint golden_news_entries_reviewed_complete
        check (
            review_status <> 'reviewed'
            or (
                gold_episode_id is not null
                and gold_episode_label is not null
                and gold_storyline_id is not null
                and gold_storyline_label is not null
                and gold_category_id is not null
                and reviewed_at is not null
            )
        );
alter table public.golden_news_entries
    add constraint golden_news_entries_theme_pair
        check ((gold_theme_id is null) = (gold_theme_name is null));

commit;
