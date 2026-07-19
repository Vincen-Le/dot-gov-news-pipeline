begin;

create table public.golden_news_entries (
    news_entry_id uuid primary key
        references public.news_entries(id) on delete restrict,
    content_hash_at_review text not null,
    ordinal integer not null unique,
    batch_number integer not null,
    review_status text not null default 'pending',
    gold_episode_id uuid,
    gold_episode_label text,
    gold_storyline_id uuid,
    gold_storyline_label text,
    gold_theme_id uuid,
    gold_theme_name text,
    gold_category_id uuid references public.topic_categories(id) on delete restrict,
    is_syndicated boolean not null default false,
    notes text,
    proposed_at timestamptz,
    reviewed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint golden_news_entries_content_hash_valid
        check (content_hash_at_review ~ '^[0-9a-f]{64}$'),
    constraint golden_news_entries_ordinal_positive check (ordinal >= 1),
    constraint golden_news_entries_batch_positive check (batch_number >= 1),
    constraint golden_news_entries_review_status_valid
        check (review_status in ('pending', 'proposed', 'reviewed')),
    constraint golden_news_entries_episode_label_bounded
        check (gold_episode_label is null or length(gold_episode_label) between 1 and 512),
    constraint golden_news_entries_storyline_label_bounded
        check (gold_storyline_label is null or length(gold_storyline_label) between 1 and 512),
    constraint golden_news_entries_theme_name_bounded
        check (gold_theme_name is null or length(gold_theme_name) between 1 and 256),
    constraint golden_news_entries_notes_bounded
        check (notes is null or length(notes) <= 4096),
    constraint golden_news_entries_reviewed_complete
        check (
            review_status <> 'reviewed'
            or (
                gold_episode_id is not null
                and gold_episode_label is not null
                and gold_storyline_id is not null
                and gold_storyline_label is not null
                and gold_theme_id is not null
                and gold_theme_name is not null
                and gold_category_id is not null
                and reviewed_at is not null
            )
        )
);

comment on table public.golden_news_entries is
    'One-to-one human-reviewed labels for the contiguous July-August 2025 anchor. Episode, storyline, and theme UUIDs are stable grouping keys, deliberately not foreign keys to disposable clustering tables.';
comment on column public.golden_news_entries.ordinal is
    'Stable chronological position ordered by news_entries.published_at then id.';
comment on column public.golden_news_entries.batch_number is
    'Chronological 50-entry curation batch, assigned when the anchor is initialized.';
comment on column public.golden_news_entries.content_hash_at_review is
    'Corpus-drift guard. Reconstruction and approval reject a changed news entry.';

create index golden_news_entries_batch_status_idx
    on public.golden_news_entries (batch_number, review_status, ordinal);
create index golden_news_entries_episode_idx
    on public.golden_news_entries (gold_episode_id)
    where gold_episode_id is not null;
create index golden_news_entries_storyline_idx
    on public.golden_news_entries (gold_storyline_id)
    where gold_storyline_id is not null;
create index golden_news_entries_theme_idx
    on public.golden_news_entries (gold_theme_id)
    where gold_theme_id is not null;

alter table public.golden_news_entries enable row level security;

revoke all privileges on table public.golden_news_entries
    from public, anon, authenticated, service_role;
grant select on table public.golden_news_entries to service_role;

commit;
