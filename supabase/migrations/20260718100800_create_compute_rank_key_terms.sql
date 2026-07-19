begin;

create or replace function public.compute_rank_key_terms(
    p_rubric jsonb,
    p_rubric_version integer,
    p_distinct_agencies integer,
    p_distinct_feeds integer,
    p_source_weight_max real,
    p_newest_entry_at timestamptz,
    p_tau double precision default 124600.0
) returns jsonb
language sql
stable
set search_path = ''
as $fn$
    select jsonb_build_object(
        'rubric_points',
        case
            when p_rubric is null then
                (select 0.5 * sum(rw.weight)
                 from public.rubric_weights rw
                 where rw.rubric_version = coalesce(p_rubric_version, 1))
            else
                coalesce(
                    (select sum(
                        case
                            when p_rubric -> rw.criterion in ('1'::jsonb, 'true'::jsonb) then rw.weight
                            else 0.0
                        end)
                     from public.rubric_weights rw
                     where rw.rubric_version = p_rubric_version),
                    0.0)
        end,
        'prior_used', p_rubric is null,
        'agency_term', 0.5 * ln(1 + greatest(coalesce(p_distinct_agencies, 0), 0)),
        'feed_term', 0.5 * ln(1 + greatest(coalesce(p_distinct_feeds, 0), 0)),
        'source_term', ln(greatest(coalesce(p_source_weight_max, 1.0), 0.001)),
        'freshness_term', extract(epoch from least(p_newest_entry_at, now())) / p_tau
    )
$fn$;

comment on function public.compute_rank_key_terms is
    'Per-term decomposition of compute_rank_key. compute_rank_key is defined as the sum of these terms, so the displayed breakdown provably sums to the stored key.';

create or replace function public.compute_rank_key(
    p_rubric jsonb,
    p_rubric_version integer,
    p_distinct_agencies integer,
    p_distinct_feeds integer,
    p_source_weight_max real,
    p_newest_entry_at timestamptz,
    p_tau double precision default 124600.0
) returns double precision
language sql
stable
set search_path = ''
as $fn$
    select (t.terms ->> 'rubric_points')::double precision
         + (t.terms ->> 'agency_term')::double precision
         + (t.terms ->> 'feed_term')::double precision
         + (t.terms ->> 'source_term')::double precision
         + (t.terms ->> 'freshness_term')::double precision
    from (
        select public.compute_rank_key_terms(
            p_rubric, p_rubric_version, p_distinct_agencies, p_distinct_feeds,
            p_source_weight_max, p_newest_entry_at, p_tau) as terms
    ) t
$fn$;

comment on function public.compute_rank_key is
    'Single source of truth for card rank_key: sum of compute_rank_key_terms (rubric points or unjudged prior + corroboration logs + source authority + freshness/tau). Cards are write-once, so this runs exactly once per card.';

revoke execute on function public.compute_rank_key_terms(jsonb, integer, integer, integer, real, timestamptz, double precision)
    from public, anon, authenticated;
grant execute on function public.compute_rank_key_terms(jsonb, integer, integer, integer, real, timestamptz, double precision)
    to service_role;

commit;
