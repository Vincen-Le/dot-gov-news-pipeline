begin;

select plan(7);

select has_table(
    'public', 'demo_content_revisions',
    'demo content revision singleton exists'
);

select ok(
    (
        select relrowsecurity
        from pg_catalog.pg_class
        where oid = 'public.demo_content_revisions'::regclass
    ),
    'demo content revisions use RLS'
);

select ok(
    has_table_privilege('service_role', 'public.demo_content_revisions', 'select')
    and not has_table_privilege('service_role', 'public.demo_content_revisions', 'insert')
    and not has_table_privilege('service_role', 'public.demo_content_revisions', 'update')
    and not has_table_privilege('anon', 'public.demo_content_revisions', 'select'),
    'only server-side readers can resolve the revision'
);

select ok(
    not has_function_privilege(
        'service_role', 'public.bump_demo_content_revision()', 'execute'
    )
    and not has_function_privilege(
        'anon', 'public.bump_demo_content_revision()', 'execute'
    ),
    'the revision can only be advanced by serving-table triggers'
);

select is(
    (
        select count(*)
        from pg_catalog.pg_trigger
        where tgfoid = 'public.bump_demo_content_revision()'::regprocedure
          and not tgisinternal
    ),
    8::bigint,
    'all mutable demo serving tables advance the cache namespace'
);

select is(
    (select revision from public.demo_content_revisions where id),
    1::bigint,
    'the initial content revision is one'
);

set local role service_role;

insert into public.golden_topic_categories (display_name, origin)
values ('Demo revision trigger fixture', 'seed');

reset role;

select is(
    (select revision from public.demo_content_revisions where id),
    2::bigint,
    'a reviewed serving-table write advances the content revision'
);

select * from finish();

rollback;
