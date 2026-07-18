begin;

insert into public.rubric_weights (rubric_version, criterion, weight)
values
    (1, 'mass_impact', 1.0),
    (1, 'health_safety', 1.0),
    (1, 'economic', 1.0),
    (1, 'policy_change', 1.0),
    (1, 'rights_legal', 1.0),
    (1, 'national_scope', 1.0),
    (1, 'urgency', 1.0),
    (1, 'novelty', 1.0);

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
    select
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
        end
        + 0.5 * ln(1 + greatest(coalesce(p_distinct_agencies, 0), 0))
        + 0.5 * ln(1 + greatest(coalesce(p_distinct_feeds, 0), 0))
        + ln(greatest(coalesce(p_source_weight_max, 1.0), 0.001))
        + extract(epoch from least(p_newest_entry_at, now())) / p_tau
$fn$;

comment on function public.compute_rank_key is
    'Single source of truth for card rank_key: rubric points (prior = half total weight when unjudged) + corroboration logs + source authority + freshness/tau. Cards are write-once, so this runs exactly once per card.';

revoke execute on function public.compute_rank_key(jsonb, integer, integer, integer, real, timestamptz, double precision)
    from public, anon, authenticated;
grant execute on function public.compute_rank_key(jsonb, integer, integer, integer, real, timestamptz, double precision)
    to service_role;

commit;
