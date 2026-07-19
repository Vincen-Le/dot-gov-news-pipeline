begin;

select plan(14);

select has_table('public', 'topic_categories', 'topic_categories table exists');
select has_table('public', 'topic_themes', 'topic_themes table exists');
select has_column('public', 'storylines', 'theme_id', 'storylines gained theme_id');
select has_column('public', 'storylines', 'theme_attach_method',
    'storylines gained theme attach audit');

select is(
    (
        select count(*)::integer
        from pg_catalog.pg_class
        join pg_catalog.pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relname in ('topic_categories', 'topic_themes')
          and pg_class.relrowsecurity
    ),
    2,
    'RLS enabled on both topic tables'
);

select ok(
    not has_table_privilege('anon', 'public.topic_categories', 'select')
    and not has_table_privilege('anon', 'public.topic_themes', 'select'),
    'anon cannot read topic tables'
);

select ok(
    (select count(*) from public.topic_categories where origin = 'seed') >= 15,
    'seed taxonomy is populated'
);

select throws_ok(
    $$insert into public.topic_categories (display_name, origin)
      values ('Bogus', 'invented')$$,
    '23514', null, 'origin outside seed/llm rejected'
);

-- RPC round-trip fixtures
select lives_ok(
    $$select public.upsert_topic_category('Test LLM Cat', 'llm', 'proposed by test')$$,
    'upsert_topic_category inserts'
);
select is(
    public.upsert_topic_category('Test LLM Cat', 'llm', 'dup call'),
    (select id from public.topic_categories where display_name = 'Test LLM Cat'),
    'upsert_topic_category is idempotent on display_name'
);

insert into public.storylines (id, first_entry_at, newest_entry_at)
values ('00000000-0000-0000-0000-0000000000a1', now() - interval '2 days', now());

select lives_ok(
    $$select public.create_topic_theme(
        'FDA drug recalls', decode('0011', 'hex'),
        (select id from public.topic_categories where display_name = 'Test LLM Cat'),
        'test-model', 'FDA actions involving drug recalls')$$,
    'create_topic_theme inserts'
);

select lives_ok(
    $$select public.assign_storyline_theme(
        '00000000-0000-0000-0000-0000000000a1',
        (select id from public.topic_themes where display_name = 'FDA drug recalls'),
        'adjudicated_join', 0.81, 'same regulatory thread',
        decode('0012', 'hex'), 'FDA drug safety actions')$$,
    'assign_storyline_theme joins storyline and updates the theme'
);

select is(
    (select storyline_count from public.topic_themes
     where display_name = 'FDA drug safety actions'),
    1,
    'assign recomputes storyline_count and applies the rename'
);

select is(
    (select theme_attach_method from public.storylines
     where id = '00000000-0000-0000-0000-0000000000a1'),
    'adjudicated_join',
    'assign audits the attach method on the storyline'
);

select * from finish();
rollback;
