begin;

create table public.news_source_publishers (
    news_source_id uuid primary key
        references public.news_sources(id) on delete cascade,
    publisher_key text not null,
    first_observed_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint news_source_publishers_key_bounded
        check (length(publisher_key) between 1 and 128)
);

do $$
begin
    if exists (
        select 1
        from public.news_backfill_targets
        group by news_source_id
        having count(distinct publisher_key) <> 1
    ) then
        raise exception using errcode = '23514',
            message = 'a curated news source has conflicting publisher keys';
    end if;
end;
$$;

insert into public.news_source_publishers (news_source_id, publisher_key)
select news_source_id, min(publisher_key)
from public.news_backfill_targets
group by news_source_id;

create index news_source_publishers_publisher_key_idx
    on public.news_source_publishers (publisher_key, news_source_id);

comment on table public.news_source_publishers is
    'Durable one-to-one attribution of a curated news source to the publisher key used as agency identity.';
comment on column public.news_source_publishers.publisher_key is
    'Stable curated publisher identity; never derived from the fetch or archive hostname.';

create function public.record_news_source_publisher()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.news_source_publishers (
        news_source_id,
        publisher_key
    ) values (
        new.news_source_id,
        new.publisher_key
    )
    on conflict (news_source_id) do update
    set updated_at = pg_catalog.now()
    where news_source_publishers.publisher_key = excluded.publisher_key;

    if not found then
        raise exception using errcode = '23514',
            message = 'news source publisher key conflicts with its curated identity';
    end if;
    return new;
end;
$$;

create trigger news_backfill_targets_record_publisher
before insert or update of news_source_id, publisher_key
on public.news_backfill_targets
for each row execute function public.record_news_source_publisher();

alter table public.news_source_publishers enable row level security;

revoke all privileges on table public.news_source_publishers
    from public, anon, authenticated, service_role;
grant select on table public.news_source_publishers to service_role;

revoke execute on function public.record_news_source_publisher()
    from public, anon, authenticated, service_role;

commit;
