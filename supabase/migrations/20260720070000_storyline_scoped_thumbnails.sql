begin;

-- Thumbnail assets are immutable and reusable. Their relationship to the
-- golden serving surface is storyline-scoped so every historical and future
-- event card in a chain resolves the same image without copying a foreign key
-- onto either event_cards or storylines.
create table public.images (
    id uuid primary key default gen_random_uuid(),
    input_hash text not null,
    enrichment_version integer not null,
    source_card_version integer,
    source_entry_ids uuid[] not null default '{}',
    image_concept jsonb not null,
    r2_master_key text not null,
    r2_card_key text not null,
    r2_social_key text not null,
    master_sha256 text not null,
    card_sha256 text not null,
    social_sha256 text not null,
    master_mime_type text not null,
    card_mime_type text not null,
    social_mime_type text not null,
    master_width integer not null,
    master_height integer not null,
    card_width integer not null,
    card_height integer not null,
    social_width integer not null,
    social_height integer not null,
    alt_text text not null,
    focal_x numeric(6, 5) not null,
    focal_y numeric(6, 5) not null,
    model text not null,
    prompt_version integer not null,
    prompt_hash text not null,
    generated_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint images_input_hash_valid
        check (input_hash ~ '^[0-9a-f]{64}$'),
    constraint images_versions_positive
        check (
            enrichment_version >= 1
            and (source_card_version is null or source_card_version >= 1)
            and prompt_version >= 1
        ),
    constraint images_sources_valid
        check (
            cardinality(source_entry_ids) between 0 and 256
            and array_position(source_entry_ids, null) is null
        ),
    constraint images_concept_valid
        check (
            jsonb_typeof(image_concept) = 'object'
            and pg_catalog.pg_column_size(image_concept) <= 16384
        ),
    constraint images_r2_keys_bounded
        check (
            length(r2_master_key) between 1 and 1024
            and length(r2_card_key) between 1 and 1024
            and length(r2_social_key) between 1 and 1024
        ),
    constraint images_hashes_valid
        check (
            master_sha256 ~ '^[0-9a-f]{64}$'
            and card_sha256 ~ '^[0-9a-f]{64}$'
            and social_sha256 ~ '^[0-9a-f]{64}$'
            and prompt_hash ~ '^[0-9a-f]{64}$'
        ),
    constraint images_mime_types_valid
        check (
            master_mime_type in ('image/avif', 'image/jpeg', 'image/png', 'image/webp')
            and card_mime_type in ('image/avif', 'image/jpeg', 'image/png', 'image/webp')
            and social_mime_type in ('image/avif', 'image/jpeg', 'image/png', 'image/webp')
        ),
    constraint images_dimensions_valid
        check (
            master_width between 1 and 16384
            and master_height between 1 and 16384
            and card_width between 1 and 16384
            and card_height between 1 and 16384
            and social_width between 1 and 16384
            and social_height between 1 and 16384
        ),
    constraint images_alt_bounded
        check (length(alt_text) between 1 and 512),
    constraint images_focal_valid
        check (focal_x between 0 and 1 and focal_y between 0 and 1),
    constraint images_model_bounded
        check (length(model) between 1 and 256),
    constraint images_timestamps_ordered
        check (updated_at >= created_at)
);

comment on table public.images is
    'Immutable generated or seeded image assets and R2 provenance. Serving relationships live in association tables rather than on storylines or event cards.';
comment on column public.images.source_card_version is
    'Optional generation provenance. It is populated for legacy card-derived images but is not the serving identity.';

create index images_input_idx
    on public.images (input_hash, enrichment_version);
create index images_master_sha_idx
    on public.images (master_sha256);

create table public.golden_storyline_thumbnails (
    storyline_id uuid primary key,
    image_id uuid not null references public.images(id),
    selection_source text not null default 'generated',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint golden_storyline_thumbnails_selection_source_valid
        check (selection_source in ('generated', 'category_fallback', 'agency_fallback')),
    constraint golden_storyline_thumbnails_timestamps_ordered
        check (updated_at >= created_at)
);

comment on table public.golden_storyline_thumbnails is
    'Exactly one immutable thumbnail selection per golden storyline. Golden storyline ids intentionally have no FK because mirror reconstruction can replace those rows.';

create index golden_storyline_thumbnails_image_idx
    on public.golden_storyline_thumbnails (image_id);

-- Refuse to silently discard enrichment rows whose card disappeared from the
-- golden mirror. Operators must repair that mirror before this migration can
-- safely determine a storyline identity.
do $$
begin
    if exists (
        select 1
        from public.golden_event_card_thumbnails legacy
        left join public.golden_event_cards cards
          on cards.id = legacy.event_card_id
        where cards.id is null
    ) then
        raise exception
            'cannot migrate orphan golden_event_card_thumbnails rows to storyline scope';
    end if;
end;
$$;

-- Keep the earliest thumbnail-bearing card as the canonical lifetime image.
-- DISTINCT ON also makes this deterministic on databases that still contain
-- pre-normalization conflicts.
create temporary table migrated_storyline_thumbnails
on commit drop
as
select distinct on (cards.storyline_id)
    gen_random_uuid() as image_id,
    cards.storyline_id,
    legacy.input_hash,
    legacy.enrichment_version,
    legacy.source_card_version,
    legacy.source_entry_ids,
    legacy.image_concept,
    legacy.r2_master_key,
    legacy.r2_card_key,
    legacy.r2_social_key,
    legacy.master_sha256,
    legacy.card_sha256,
    legacy.social_sha256,
    legacy.master_mime_type,
    legacy.card_mime_type,
    legacy.social_mime_type,
    legacy.master_width,
    legacy.master_height,
    legacy.card_width,
    legacy.card_height,
    legacy.social_width,
    legacy.social_height,
    legacy.alt_text,
    legacy.focal_x,
    legacy.focal_y,
    legacy.model,
    legacy.prompt_version,
    legacy.prompt_hash,
    legacy.generated_at,
    legacy.created_at,
    legacy.updated_at
from public.golden_event_card_thumbnails legacy
join public.golden_event_cards cards
  on cards.id = legacy.event_card_id
order by
    cards.storyline_id,
    cards.newest_entry_at asc,
    cards.generated_at asc,
    cards.version asc,
    cards.id asc;

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
)
select
    image_id,
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
from migrated_storyline_thumbnails;

insert into public.golden_storyline_thumbnails (
    storyline_id,
    image_id,
    selection_source,
    created_at,
    updated_at
)
select
    storyline_id,
    image_id,
    'generated',
    created_at,
    updated_at
from migrated_storyline_thumbnails;

drop table public.golden_event_card_thumbnails;

-- The legacy name remains read-only during application rollout. It derives a
-- card-shaped result from the storyline association, so old readers continue
-- to work while old card-scoped writers fail instead of violating the model.
create view public.golden_event_card_thumbnails
with (security_invoker = true)
as
select
    cards.id as event_card_id,
    images.input_hash,
    images.enrichment_version,
    images.source_card_version,
    images.source_entry_ids,
    images.image_concept,
    images.r2_master_key,
    images.r2_card_key,
    images.r2_social_key,
    images.master_sha256,
    images.card_sha256,
    images.social_sha256,
    images.master_mime_type,
    images.card_mime_type,
    images.social_mime_type,
    images.master_width,
    images.master_height,
    images.card_width,
    images.card_height,
    images.social_width,
    images.social_height,
    images.alt_text,
    images.focal_x,
    images.focal_y,
    images.model,
    images.prompt_version,
    images.prompt_hash,
    images.generated_at,
    images.created_at,
    images.updated_at
from public.golden_event_cards cards
join public.golden_storyline_thumbnails thumbnails
  on thumbnails.storyline_id = cards.storyline_id
join public.images images
  on images.id = thumbnails.image_id;

comment on view public.golden_event_card_thumbnails is
    'Read-only compatibility projection. Canonical thumbnail storage is public.golden_storyline_thumbnails joined to public.images by storyline_id.';

create or replace function public.publish_golden_storyline_thumbnail(
    p_image jsonb,
    p_storyline_id uuid,
    p_selection_source text default 'generated'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    existing_image public.images%rowtype;
    new_image_id uuid;
    write_time timestamptz := pg_catalog.clock_timestamp();
begin
    if p_selection_source not in ('generated', 'category_fallback', 'agency_fallback') then
        raise exception 'invalid thumbnail selection source %', p_selection_source;
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_storyline_id::text, 0)
    );

    select images.*
    into existing_image
    from public.golden_storyline_thumbnails thumbnails
    join public.images images on images.id = thumbnails.image_id
    where thumbnails.storyline_id = p_storyline_id
    for update of thumbnails, images;

    if found then
        if existing_image.input_hash is distinct from (p_image ->> 'input_hash')
            or existing_image.master_sha256 is distinct from (p_image ->> 'master_sha256')
            or existing_image.card_sha256 is distinct from (p_image ->> 'card_sha256')
            or existing_image.social_sha256 is distinct from (p_image ->> 'social_sha256')
            or existing_image.r2_master_key is distinct from (p_image ->> 'r2_master_key')
            or existing_image.r2_card_key is distinct from (p_image ->> 'r2_card_key')
            or existing_image.r2_social_key is distinct from (p_image ->> 'r2_social_key') then
            raise exception
                'storyline % already has a different immutable thumbnail',
                p_storyline_id;
        end if;
        return;
    end if;

    insert into public.images (
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
    returning id into new_image_id;

    insert into public.golden_storyline_thumbnails (
        storyline_id,
        image_id,
        selection_source,
        created_at,
        updated_at
    ) values (
        p_storyline_id,
        new_image_id,
        p_selection_source,
        write_time,
        write_time
    );
end;
$$;

comment on function public.publish_golden_storyline_thumbnail(jsonb, uuid, text) is
    'Atomically publishes the first immutable thumbnail for a golden storyline and accepts only exact idempotent retries.';

alter table public.images enable row level security;
alter table public.golden_storyline_thumbnails enable row level security;

revoke all privileges on table
    public.images,
    public.golden_storyline_thumbnails
    from public, anon, authenticated, service_role;
revoke all privileges on table public.golden_event_card_thumbnails
    from public, anon, authenticated, service_role;

grant select, insert on table public.images to service_role;
grant select, insert on table public.golden_storyline_thumbnails to service_role;
grant select on table public.golden_event_card_thumbnails to service_role;

revoke all on function public.publish_golden_storyline_thumbnail(jsonb, uuid, text)
    from public, anon, authenticated;
grant execute on function public.publish_golden_storyline_thumbnail(jsonb, uuid, text)
    to service_role;

notify pgrst, 'reload schema';

commit;
