begin;

-- Storylines gain a stream-time category label. Audit pair mirrors the theme
-- trio philosophy: the row records the decision in force.
alter table public.storylines
    add column category_id uuid references public.topic_categories(id),
    add column category_method text,
    add column category_reason text,
    add constraint storylines_category_method_valid
        check (category_method is null or category_method in ('classified', 'retry')),
    add constraint storylines_category_reason_bounded
        check (category_reason is null or length(category_reason) <= 2048);

comment on column public.storylines.category_id is
    'Broad seeded category assigned on the stream; the only stream-time topic label. Themes are born offline by the promotion sweep.';

create index storylines_category_resident_idx
    on public.storylines (category_id)
    where theme_id is null and merged_into is null;

-- Themes gain the promotion judge''s membership rule and a demotion tombstone.
alter table public.topic_themes
    add column inclusion_criterion text,
    add column demoted_at timestamptz,
    add constraint topic_themes_inclusion_criterion_bounded
        check (inclusion_criterion is null or length(inclusion_criterion) <= 1024);

comment on column public.topic_themes.inclusion_criterion is
    'One-sentence membership rule written by the promotion judge at theme birth; the stream membership adjudicator tests storylines against it.';
comment on column public.topic_themes.demoted_at is
    'Set by demote_topic_theme; demoted themes are excluded from assignment and surfacing. Dormancy is derived (newest_storyline_at age), never stored.';

-- New attach methods; old values stay valid for existing rows.
alter table public.storylines
    drop constraint storylines_theme_attach_method_valid;
alter table public.storylines
    add constraint storylines_theme_attach_method_valid
        check (theme_attach_method is null or theme_attach_method in
            ('adjudicated_join', 'knn_join', 'new_theme', 'reassigned',
             'criterion_join', 'promoted', 'sweep_join'));

create or replace function public.set_storyline_category(
    p_storyline_id uuid,
    p_category_id uuid,
    p_method text,
    p_reason text
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
    update public.storylines set
        category_id = p_category_id,
        category_method = p_method,
        category_reason = left(p_reason, 2048)
    where id = p_storyline_id;
end
$fn$;

create or replace function public.demote_topic_theme(
    p_theme_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
    update public.storylines set
        theme_id = null,
        theme_attach_method = null,
        theme_similarity = null,
        theme_reason = left('demoted from theme ' || p_theme_id::text, 2048)
    where theme_id = p_theme_id;

    update public.topic_themes set
        demoted_at = now(),
        storyline_count = 0
    where id = p_theme_id;
end
$fn$;

comment on function public.demote_topic_theme is
    'Members fall back to category-only; the theme keeps its row (audit) but is dead for assignment. Sole detach path.';

-- create_topic_theme grows the criterion param; drop the old arity so RPC
-- name resolution stays unambiguous.
drop function public.create_topic_theme(text, bytea, uuid, text);
create function public.create_topic_theme(
    p_display_name text,
    p_centroid bytea,
    p_category_id uuid,
    p_name_model text,
    p_inclusion_criterion text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_id uuid;
begin
    insert into public.topic_themes
        (display_name, centroid, category_id, name_model, inclusion_criterion)
    values (left(p_display_name, 256), p_centroid, p_category_id,
            p_name_model, left(p_inclusion_criterion, 1024))
    returning id into v_id;
    return v_id;
end
$fn$;

do $grants$
declare
    v_sig text;
begin
    foreach v_sig in array array[
        'public.set_storyline_category(uuid, uuid, text, text)',
        'public.demote_topic_theme(uuid)',
        'public.create_topic_theme(text, bytea, uuid, text, text)'
    ] loop
        execute format('revoke execute on function %s from public, anon, authenticated', v_sig);
        execute format('grant execute on function %s to service_role', v_sig);
    end loop;
end
$grants$;

commit;
