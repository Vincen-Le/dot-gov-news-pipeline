begin;

create table public.golden_storyline_thumbnail_assignment_runs (
    id uuid primary key default gen_random_uuid(),
    algorithm text not null,
    assignment_count integer not null,
    previous_assignments jsonb not null,
    new_assignments jsonb not null,
    created_at timestamptz not null default now(),
    constraint golden_storyline_thumbnail_assignment_runs_algorithm_bounded
        check (length(algorithm) between 1 and 128),
    constraint golden_storyline_thumbnail_assignment_runs_count_valid
        check (
            assignment_count > 0
            and jsonb_typeof(previous_assignments) = 'array'
            and jsonb_array_length(previous_assignments) = assignment_count
            and jsonb_typeof(new_assignments) = 'array'
            and jsonb_array_length(new_assignments) = assignment_count
        )
);

comment on table public.golden_storyline_thumbnail_assignment_runs is
    'Recovery record for an explicitly authorized atomic replacement of reusable fallback assignments. Generated thumbnails are never included.';

create or replace function public.replace_golden_storyline_fallback_thumbnails(
    p_algorithm text,
    p_assignments jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    assignment_run_id uuid := pg_catalog.gen_random_uuid();
    generated_count_before integer;
    replacement_count integer;
    write_time timestamptz := pg_catalog.clock_timestamp();
begin
    if p_algorithm is distinct from 'deterministic-shuffle-bag-v1' then
        raise exception 'unsupported fallback assignment algorithm %', p_algorithm;
    end if;
    if pg_catalog.jsonb_typeof(p_assignments) is distinct from 'array'
        or pg_catalog.jsonb_array_length(p_assignments) = 0 then
        raise exception 'fallback assignments must be a non-empty JSON array';
    end if;

    lock table public.golden_storyline_thumbnails in exclusive mode;

    select count(*)::integer
    into generated_count_before
    from public.golden_storyline_thumbnails thumbnails
    where thumbnails.selection_source = 'generated';

    create temporary table reusable_thumbnail_replacements (
        storyline_id uuid not null,
        position integer not null,
        previous_image_id uuid not null,
        previous_selection_source text not null,
        image_id uuid not null,
        selection_source text not null
    ) on commit drop;

    insert into reusable_thumbnail_replacements (
        storyline_id,
        position,
        previous_image_id,
        previous_selection_source,
        image_id,
        selection_source
    )
    select
        assignments.storyline_id,
        assignments.position,
        assignments.previous_image_id,
        assignments.previous_selection_source,
        assignments.image_id,
        assignments.selection_source
    from pg_catalog.jsonb_to_recordset(p_assignments) as assignments(
        storyline_id uuid,
        position integer,
        previous_image_id uuid,
        previous_selection_source text,
        image_id uuid,
        selection_source text
    );

    select count(*)::integer
    into replacement_count
    from reusable_thumbnail_replacements;

    if replacement_count <> pg_catalog.jsonb_array_length(p_assignments) then
        raise exception 'fallback assignment payload contains invalid records';
    end if;
    if exists (
        select 1
        from reusable_thumbnail_replacements replacements
        where not exists (
            select 1
            from public.golden_storylines storylines
            where storylines.id = replacements.storyline_id
        )
    ) then
        raise exception 'replacement plan contains an unknown storyline';
    end if;
    if exists (
        select 1
        from reusable_thumbnail_replacements replacements
        where replacements.position < 1
           or replacements.previous_selection_source not in (
               'category_fallback', 'agency_fallback'
           )
           or replacements.selection_source not in (
               'category_fallback', 'agency_fallback'
           )
    ) then
        raise exception 'fallback assignment payload contains invalid values';
    end if;
    if (
        select count(distinct replacements.storyline_id)
        from reusable_thumbnail_replacements replacements
    ) <> replacement_count then
        raise exception 'fallback assignment payload contains duplicate storylines';
    end if;
    if exists (
        select 1
        from public.golden_storyline_thumbnails thumbnails
        where thumbnails.selection_source in (
            'category_fallback', 'agency_fallback'
        )
          and not exists (
              select 1
              from reusable_thumbnail_replacements replacements
              where replacements.storyline_id = thumbnails.storyline_id
          )
    ) or exists (
        select 1
        from reusable_thumbnail_replacements replacements
        where not exists (
            select 1
            from public.golden_storyline_thumbnails thumbnails
            where thumbnails.storyline_id = replacements.storyline_id
              and thumbnails.selection_source in (
                  'category_fallback', 'agency_fallback'
              )
        )
    ) then
        raise exception 'replacement plan must cover exactly the current fallback rows';
    end if;
    if exists (
        select 1
        from reusable_thumbnail_replacements replacements
        join public.golden_storyline_thumbnails thumbnails
          on thumbnails.storyline_id = replacements.storyline_id
        where thumbnails.image_id <> replacements.previous_image_id
           or thumbnails.selection_source <>
              replacements.previous_selection_source
    ) then
        raise exception 'fallback assignments changed after the plan was built';
    end if;
    if exists (
        select 1
        from reusable_thumbnail_replacements replacements
        join public.golden_storylines storylines
          on storylines.id = replacements.storyline_id
        left join public.golden_topic_categories categories
          on categories.id = storylines.category_id
        where not (
            (
                replacements.selection_source = 'category_fallback'
                and categories.image_id = replacements.image_id
            )
            or (
                replacements.selection_source = 'agency_fallback'
                and exists (
                    select 1
                    from public.agency_thumbnail_images agencies
                    where agencies.publisher_key = any(storylines.agency_ids)
                      and agencies.image_id = replacements.image_id
                )
            )
        )
    ) then
        raise exception 'replacement plan contains an ineligible image';
    end if;

    insert into public.golden_storyline_thumbnail_assignment_runs (
        id,
        algorithm,
        assignment_count,
        previous_assignments,
        new_assignments,
        created_at
    )
    select
        assignment_run_id,
        p_algorithm,
        replacement_count,
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'storyline_id', replacements.storyline_id,
                'position', replacements.position,
                'image_id', replacements.previous_image_id,
                'selection_source', replacements.previous_selection_source
            ) order by replacements.position, replacements.storyline_id
        ),
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'storyline_id', replacements.storyline_id,
                'position', replacements.position,
                'image_id', replacements.image_id,
                'selection_source', replacements.selection_source
            ) order by replacements.position, replacements.storyline_id
        ),
        write_time
    from reusable_thumbnail_replacements replacements;

    delete from public.golden_storyline_thumbnails thumbnails
    using reusable_thumbnail_replacements replacements
    where thumbnails.storyline_id = replacements.storyline_id
      and thumbnails.selection_source in (
          'category_fallback', 'agency_fallback'
      );

    insert into public.golden_storyline_thumbnails (
        storyline_id,
        image_id,
        selection_source,
        created_at,
        updated_at
    )
    select
        replacements.storyline_id,
        replacements.image_id,
        replacements.selection_source,
        write_time,
        write_time
    from reusable_thumbnail_replacements replacements
    order by replacements.position, replacements.storyline_id;

    if (
        select count(*)
        from public.golden_storyline_thumbnails thumbnails
        where thumbnails.selection_source = 'generated'
    ) <> generated_count_before then
        raise exception 'generated thumbnail count changed during fallback replacement';
    end if;

    return assignment_run_id;
end;
$$;

alter table public.golden_storyline_thumbnail_assignment_runs
    enable row level security;

revoke all privileges on table
    public.golden_storyline_thumbnail_assignment_runs
    from public, anon, authenticated, service_role;
grant select on table public.golden_storyline_thumbnail_assignment_runs
    to service_role;

revoke execute on function
    public.replace_golden_storyline_fallback_thumbnails(text, jsonb)
    from public, anon, authenticated;
grant execute on function
    public.replace_golden_storyline_fallback_thumbnails(text, jsonb)
    to service_role;

notify pgrst, 'reload schema';

commit;
