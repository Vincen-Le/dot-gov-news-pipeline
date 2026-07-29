begin;

create table public.golden_storyline_explorer_nodes (
    storyline_id uuid primary key,
    projection_version text not null,
    x double precision not null,
    y double precision not null,
    rank_percentile real not null,
    neighbors jsonb not null default '[]'::jsonb,
    generated_at timestamptz not null default now(),
    constraint golden_storyline_explorer_version_bounded
        check (length(projection_version) between 1 and 128),
    constraint golden_storyline_explorer_coordinates_finite
        check (
            x not in ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)
            and y not in ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)
        ),
    constraint golden_storyline_explorer_rank_percentile_valid
        check (rank_percentile between 0 and 1),
    constraint golden_storyline_explorer_neighbors_valid
        check (
            jsonb_typeof(neighbors) = 'array'
            and pg_catalog.pg_column_size(neighbors) <= 16384
        )
);

comment on table public.golden_storyline_explorer_nodes is
    'Versioned two-dimensional semantic projection and exact cosine neighbors for the reviewed demo storyline explorer. Raw centroids remain server-side.';

create index golden_storyline_explorer_version_idx
    on public.golden_storyline_explorer_nodes (projection_version);

alter table public.golden_storyline_explorer_nodes enable row level security;

revoke all privileges on table public.golden_storyline_explorer_nodes
    from public, anon, authenticated, service_role;
grant select, insert, update, delete on table
    public.golden_storyline_explorer_nodes to service_role;

commit;
