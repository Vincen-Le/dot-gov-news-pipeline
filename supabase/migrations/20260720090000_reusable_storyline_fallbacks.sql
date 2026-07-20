begin;

alter table public.topic_categories
    add column image_id uuid references public.images(id);
alter table public.golden_topic_categories
    add column image_id uuid;

comment on column public.topic_categories.image_id is
    'Reusable fallback image for storylines assigned to this category.';
comment on column public.golden_topic_categories.image_id is
    'Golden mirror copy of the reusable category fallback image id.';

create table public.agency_thumbnail_images (
    publisher_key text primary key,
    image_id uuid not null references public.images(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint agency_thumbnail_images_key_bounded
        check (length(publisher_key) between 1 and 128),
    constraint agency_thumbnail_images_timestamps_ordered
        check (updated_at >= created_at)
);

comment on table public.agency_thumbnail_images is
    'Agency manifest mapping stable publisher keys to reusable fallback images.';

create index topic_categories_image_idx
    on public.topic_categories (image_id) where image_id is not null;
create index golden_topic_categories_image_idx
    on public.golden_topic_categories (image_id) where image_id is not null;
create index agency_thumbnail_images_image_idx
    on public.agency_thumbnail_images (image_id);

create or replace function public.inherit_golden_category_image()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if new.image_id is null then
        select categories.image_id
        into new.image_id
        from public.topic_categories categories
        where lower(categories.display_name) = lower(new.display_name);
    end if;
    return new;
end;
$$;

create trigger golden_topic_categories_inherit_image
before insert or update of display_name, image_id
on public.golden_topic_categories
for each row execute function public.inherit_golden_category_image();

create or replace function public.assign_golden_storyline_fallback_thumbnail(
    p_storyline_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    chosen_image_id uuid;
    chosen_source text;
begin
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_storyline_id::text, 0)
    );

    select thumbnails.image_id
    into chosen_image_id
    from public.golden_storyline_thumbnails thumbnails
    where thumbnails.storyline_id = p_storyline_id;
    if found then
        return chosen_image_id;
    end if;

    select candidates.image_id, candidates.selection_source
    into chosen_image_id, chosen_source
    from (
        select categories.image_id, 'category_fallback'::text as selection_source
        from public.golden_storylines storylines
        join public.golden_topic_categories categories
          on categories.id = storylines.category_id
        where storylines.id = p_storyline_id
          and categories.image_id is not null

        union all

        select agencies.image_id, 'agency_fallback'::text as selection_source
        from public.golden_storylines storylines
        cross join lateral unnest(storylines.agency_ids) as keys(publisher_key)
        join public.agency_thumbnail_images agencies
          on agencies.publisher_key = keys.publisher_key
        where storylines.id = p_storyline_id
    ) candidates
    order by random()
    limit 1;

    if chosen_image_id is null then
        return null;
    end if;

    insert into public.golden_storyline_thumbnails (
        storyline_id,
        image_id,
        selection_source
    ) values (
        p_storyline_id,
        chosen_image_id,
        chosen_source
    )
    on conflict (storyline_id) do nothing;

    select thumbnails.image_id
    into chosen_image_id
    from public.golden_storyline_thumbnails thumbnails
    where thumbnails.storyline_id = p_storyline_id;
    return chosen_image_id;
end;
$$;

comment on function public.assign_golden_storyline_fallback_thumbnail(uuid) is
    'Randomly chooses one available category or agency image exactly once per unassigned golden storyline; an existing canonical association always wins.';

create or replace function public.assign_new_golden_storyline_thumbnail()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform public.assign_golden_storyline_fallback_thumbnail(new.id);
    return new;
end;
$$;

create trigger golden_storylines_assign_thumbnail
after insert on public.golden_storylines
for each row execute function public.assign_new_golden_storyline_thumbnail();

create or replace function public.publish_reusable_image(
    p_image jsonb,
    p_scope text,
    p_scope_key text,
    p_display_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    persisted_image public.images%rowtype;
    reusable_image_id uuid := (p_image ->> 'id')::uuid;
    write_time timestamptz := pg_catalog.clock_timestamp();
begin
    if p_scope not in ('category', 'agency') then
        raise exception 'invalid reusable image scope %', p_scope;
    end if;
    if length(p_scope_key) not between 1 and 128 then
        raise exception 'invalid reusable image scope key';
    end if;
    if p_image #>> '{image_concept,key}' is distinct from p_scope_key
        or p_image #>> '{image_concept,scope}' is distinct from p_scope then
        raise exception 'reusable image metadata does not match its scope';
    end if;

    insert into public.images (
        id,
        input_hash,
        enrichment_version,
        source_card_version,
        source_entry_ids,
        image_concept,
        r2_master_key,
        r2_card_key,
        r2_social_key,
        master_sha256,
        card_sha256,
        social_sha256,
        master_mime_type,
        card_mime_type,
        social_mime_type,
        master_width,
        master_height,
        card_width,
        card_height,
        social_width,
        social_height,
        alt_text,
        focal_x,
        focal_y,
        model,
        prompt_version,
        prompt_hash,
        generated_at,
        created_at,
        updated_at
    ) values (
        reusable_image_id,
        p_image ->> 'input_hash',
        (p_image ->> 'enrichment_version')::integer,
        (p_image ->> 'source_card_version')::integer,
        array(select jsonb_array_elements_text(p_image -> 'source_entry_ids'))::uuid[],
        p_image -> 'image_concept',
        p_image ->> 'r2_master_key',
        p_image ->> 'r2_card_key',
        p_image ->> 'r2_social_key',
        p_image ->> 'master_sha256',
        p_image ->> 'card_sha256',
        p_image ->> 'social_sha256',
        p_image ->> 'master_mime_type',
        p_image ->> 'card_mime_type',
        p_image ->> 'social_mime_type',
        (p_image ->> 'master_width')::integer,
        (p_image ->> 'master_height')::integer,
        (p_image ->> 'card_width')::integer,
        (p_image ->> 'card_height')::integer,
        (p_image ->> 'social_width')::integer,
        (p_image ->> 'social_height')::integer,
        p_image ->> 'alt_text',
        (p_image ->> 'focal_x')::numeric,
        (p_image ->> 'focal_y')::numeric,
        p_image ->> 'model',
        (p_image ->> 'prompt_version')::integer,
        p_image ->> 'prompt_hash',
        (p_image ->> 'generated_at')::timestamptz,
        write_time,
        write_time
    )
    on conflict (id) do nothing;

    select images.*
    into strict persisted_image
    from public.images images
    where images.id = reusable_image_id;

    if persisted_image.input_hash is distinct from (p_image ->> 'input_hash')
        or persisted_image.master_sha256 is distinct from (p_image ->> 'master_sha256')
        or persisted_image.card_sha256 is distinct from (p_image ->> 'card_sha256')
        or persisted_image.social_sha256 is distinct from (p_image ->> 'social_sha256') then
        raise exception 'reusable image % conflicts with its immutable row', reusable_image_id;
    end if;

    if p_scope = 'category' then
        if exists (
            select 1
            from public.topic_categories categories
            where lower(categories.display_name) = lower(p_display_name)
              and categories.image_id is not null
              and categories.image_id <> reusable_image_id
        ) then
            raise exception 'category % already has a different image', p_display_name;
        end if;
        update public.topic_categories
        set image_id = reusable_image_id
        where lower(display_name) = lower(p_display_name)
          and (image_id is null or image_id = reusable_image_id);
        if not found then
            raise exception 'category % was not found', p_display_name;
        end if;
        update public.golden_topic_categories
        set image_id = reusable_image_id
        where lower(display_name) = lower(p_display_name)
          and (image_id is null or image_id = reusable_image_id);
    else
        insert into public.agency_thumbnail_images (
            publisher_key,
            image_id,
            created_at,
            updated_at
        ) values (
            p_scope_key,
            reusable_image_id,
            write_time,
            write_time
        )
        on conflict (publisher_key) do update
        set updated_at = excluded.updated_at
        where agency_thumbnail_images.image_id = excluded.image_id;
        if not found then
            raise exception 'agency % already has a different image', p_scope_key;
        end if;
    end if;

    perform public.assign_golden_storyline_fallback_thumbnail(storylines.id)
    from public.golden_storylines storylines
    left join public.golden_topic_categories categories
      on categories.id = storylines.category_id
    where not exists (
        select 1
        from public.golden_storyline_thumbnails thumbnails
        where thumbnails.storyline_id = storylines.id
    )
      and (
        (p_scope = 'category' and lower(categories.display_name) = lower(p_display_name))
        or (p_scope = 'agency' and p_scope_key = any(storylines.agency_ids))
      );
end;
$$;

comment on function public.publish_reusable_image(jsonb, text, text, text) is
    'Idempotently registers one immutable reusable image, connects it to a category or agency, then assigns matching unfilled storylines once.';

select public.assign_golden_storyline_fallback_thumbnail(storylines.id)
from public.golden_storylines storylines
where not exists (
    select 1
    from public.golden_storyline_thumbnails thumbnails
    where thumbnails.storyline_id = storylines.id
);

alter table public.agency_thumbnail_images enable row level security;

revoke all privileges on table public.agency_thumbnail_images
    from public, anon, authenticated, service_role;
grant select, insert, update on table public.agency_thumbnail_images
    to service_role;
grant update (image_id) on table public.topic_categories
    to service_role;
grant update (image_id) on table public.golden_topic_categories
    to service_role;

revoke execute on function public.inherit_golden_category_image()
    from public, anon, authenticated, service_role;
revoke execute on function public.assign_new_golden_storyline_thumbnail()
    from public, anon, authenticated, service_role;
revoke execute on function public.assign_golden_storyline_fallback_thumbnail(uuid)
    from public, anon, authenticated;
grant execute on function public.assign_golden_storyline_fallback_thumbnail(uuid)
    to service_role;
revoke execute on function public.publish_reusable_image(jsonb, text, text, text)
    from public, anon, authenticated;
grant execute on function public.publish_reusable_image(jsonb, text, text, text)
    to service_role;

notify pgrst, 'reload schema';

commit;
