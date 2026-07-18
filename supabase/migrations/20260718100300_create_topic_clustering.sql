begin;

create table public.topic_categories (
    id uuid primary key default gen_random_uuid(),
    display_name text not null,
    origin text not null,
    proposal_reason text,
    created_at timestamptz not null default now(),
    constraint topic_categories_display_name_bounded
        check (length(display_name) between 1 and 128),
    constraint topic_categories_origin_valid
        check (origin in ('seed', 'llm')),
    constraint topic_categories_proposal_reason_bounded
        check (proposal_reason is null or length(proposal_reason) <= 2048)
);

comment on table public.topic_categories is
    'Broad filter taxonomy. Seed rows ship in this migration; the classifier may propose additions (origin=llm, audited via proposal_reason and a dashboard badge).';

create unique index topic_categories_display_name_idx
    on public.topic_categories (lower(display_name));

create table public.topic_themes (
    id uuid primary key default gen_random_uuid(),
    display_name text not null,
    centroid bytea,
    category_id uuid references public.topic_categories(id),
    storyline_count integer not null default 0,
    first_storyline_at timestamptz,
    newest_storyline_at timestamptz,
    merged_into uuid references public.topic_themes(id),
    name_model text,
    created_at timestamptz not null default now(),
    constraint topic_themes_display_name_bounded
        check (length(display_name) between 1 and 256),
    constraint topic_themes_centroid_bounded
        check (centroid is null or octet_length(centroid) between 2 and 4096),
    constraint topic_themes_storyline_count_nonnegative
        check (storyline_count >= 0),
    constraint topic_themes_name_model_bounded
        check (name_model is null or length(name_model) <= 256)
);

comment on table public.topic_themes is
    'Mid-level emergent topics. Centroid = mean of member storyline centroids; display_name maintained by the join adjudicator. merged_into reserved for future consolidation.';

create index topic_themes_category_idx on public.topic_themes (category_id);

alter table public.storylines
    add column theme_id uuid references public.topic_themes(id),
    add column theme_attach_method text,
    add column theme_similarity real,
    add column theme_reason text,
    add constraint storylines_theme_attach_method_valid
        check (theme_attach_method is null or theme_attach_method in
            ('adjudicated_join', 'new_theme', 'reassigned')),
    add constraint storylines_theme_similarity_valid
        check (theme_similarity is null
            or (theme_similarity >= -1.0 and theme_similarity <= 1.0)),
    add constraint storylines_theme_reason_bounded
        check (theme_reason is null or length(theme_reason) <= 2048);

comment on column public.storylines.theme_id is
    'Current topic theme; audit trio theme_attach_method/theme_similarity/theme_reason records the decision in force, same philosophy as episode_entries.';

create index storylines_theme_idx on public.storylines (theme_id);

create or replace function public.upsert_topic_category(
    p_display_name text,
    p_origin text,
    p_proposal_reason text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_id uuid;
begin
    insert into public.topic_categories (display_name, origin, proposal_reason)
    values (p_display_name, p_origin, p_proposal_reason)
    on conflict (lower(display_name)) do nothing
    returning id into v_id;
    if v_id is null then
        select id into v_id from public.topic_categories
        where lower(display_name) = lower(p_display_name);
    end if;
    return v_id;
end
$fn$;

create or replace function public.create_topic_theme(
    p_display_name text,
    p_centroid bytea,
    p_category_id uuid,
    p_name_model text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_id uuid;
begin
    insert into public.topic_themes (display_name, centroid, category_id, name_model)
    values (left(p_display_name, 256), p_centroid, p_category_id, p_name_model)
    returning id into v_id;
    return v_id;
end
$fn$;

create or replace function public.update_topic_theme(
    p_theme_id uuid,
    p_display_name text,
    p_centroid bytea,
    p_category_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
    update public.topic_themes set
        display_name = coalesce(left(p_display_name, 256), display_name),
        centroid = coalesce(p_centroid, centroid),
        category_id = coalesce(p_category_id, category_id)
    where id = p_theme_id;
end
$fn$;

create or replace function public.assign_storyline_theme(
    p_storyline_id uuid,
    p_theme_id uuid,
    p_method text,
    p_similarity real,
    p_reason text,
    p_theme_centroid bytea,
    p_theme_display_name text
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_old uuid;
begin
    select theme_id into v_old from public.storylines where id = p_storyline_id;

    update public.storylines set
        theme_id = p_theme_id,
        theme_attach_method = p_method,
        theme_similarity = p_similarity,
        theme_reason = left(p_reason, 2048)
    where id = p_storyline_id;

    -- recompute-from-source, same as attach_entry_to_episode: replays converge
    update public.topic_themes t set
        display_name = coalesce(left(p_theme_display_name, 256), t.display_name),
        centroid = coalesce(p_theme_centroid, t.centroid),
        storyline_count = (select count(*) from public.storylines s where s.theme_id = t.id),
        first_storyline_at = (select min(s.first_entry_at) from public.storylines s where s.theme_id = t.id),
        newest_storyline_at = (select max(s.newest_entry_at) from public.storylines s where s.theme_id = t.id)
    where t.id = p_theme_id;

    if v_old is not null and v_old <> p_theme_id then
        update public.topic_themes t set
            storyline_count = (select count(*) from public.storylines s where s.theme_id = t.id),
            first_storyline_at = (select min(s.first_entry_at) from public.storylines s where s.theme_id = t.id),
            newest_storyline_at = (select max(s.newest_entry_at) from public.storylines s where s.theme_id = t.id)
        where t.id = v_old;
    end if;
end
$fn$;

comment on function public.assign_storyline_theme is
    'Sole storyline->theme write path. Storyline carries the attach audit; both themes'' aggregates recompute from storylines rows. Optional rename/centroid piggyback on the join.';

alter table public.topic_categories enable row level security;
alter table public.topic_themes enable row level security;

revoke all privileges on table public.topic_categories
    from public, anon, authenticated, service_role;
revoke all privileges on table public.topic_themes
    from public, anon, authenticated, service_role;

grant select on table public.topic_categories, public.topic_themes
    to service_role;

do $grants$
declare
    v_sig text;
begin
    foreach v_sig in array array[
        'public.upsert_topic_category(text, text, text)',
        'public.create_topic_theme(text, bytea, uuid, text)',
        'public.update_topic_theme(uuid, text, bytea, uuid)',
        'public.assign_storyline_theme(uuid, uuid, text, real, text, bytea, text)'
    ] loop
        execute format('revoke execute on function %s from public, anon, authenticated', v_sig);
        execute format('grant execute on function %s to service_role', v_sig);
    end loop;
end
$grants$;

-- Seed taxonomy: plan's 20 plus Agriculture, Civil Rights & Liberties, and
-- Public Lands & Natural Resources — Comparative Agendas Project majors with
-- dedicated agencies (USDA, DOJ-CRT/EEOC, DOI) that otherwise pollute
-- neighboring categories.
insert into public.topic_categories (display_name, origin) values
    ('Immigration & Border', 'seed'),
    ('Public Health', 'seed'),
    ('Food & Drug Safety', 'seed'),
    ('Defense & Military', 'seed'),
    ('Veterans Affairs', 'seed'),
    ('Justice & Law Enforcement', 'seed'),
    ('Courts & Legal Rulings', 'seed'),
    ('Economy & Labor', 'seed'),
    ('Taxes & Revenue', 'seed'),
    ('Financial Regulation', 'seed'),
    ('Energy & Environment', 'seed'),
    ('Transportation & Infrastructure', 'seed'),
    ('Education', 'seed'),
    ('Housing & Urban Development', 'seed'),
    ('Social Security & Benefits', 'seed'),
    ('Science & Space', 'seed'),
    ('Technology & Cybersecurity', 'seed'),
    ('Elections & Government Operations', 'seed'),
    ('Foreign Affairs & Trade', 'seed'),
    ('Disaster Response & Emergency', 'seed'),
    ('Agriculture', 'seed'),
    ('Civil Rights & Liberties', 'seed'),
    ('Public Lands & Natural Resources', 'seed');

commit;
