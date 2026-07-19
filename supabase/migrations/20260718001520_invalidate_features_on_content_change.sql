begin;

create or replace function public.ingest_news_entries_v2(
    p_target_id uuid,
    p_entries jsonb
)
returns table (
    item_index integer,
    news_entry_id uuid,
    disposition text,
    error_code text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_bounded_entries jsonb;
    v_result record;
    v_item jsonb;
    v_summary text;
    v_body_text text;
    v_title text;
    v_content_hash text;
    v_fetched_at timestamptz;
    v_extractor_version integer;
begin
    if p_entries is null
       or pg_catalog.jsonb_typeof(p_entries) <> 'array'
       or pg_catalog.jsonb_array_length(p_entries) not between 1 and 50 then
        raise exception using errcode = '22023',
            message = 'entries must be an array of 1 to 50 items';
    end if;

    select pg_catalog.jsonb_agg(
        (item.value - 'body_text' - 'summary')
            || pg_catalog.jsonb_build_object('summary', null)
        order by item.ordinality
    )
    into v_bounded_entries
    from pg_catalog.jsonb_array_elements(p_entries)
        with ordinality as item(value, ordinality);

    for v_result in
        select *
        from public.ingest_news_entries(p_target_id, v_bounded_entries)
    loop
        item_index := v_result.item_index;
        news_entry_id := v_result.news_entry_id;
        disposition := v_result.disposition;
        error_code := v_result.error_code;

        if news_entry_id is not null and error_code is null then
            v_item := p_entries -> (item_index - 1);
            v_summary := nullif(v_item ->> 'summary', '');
            v_body_text := nullif(v_item ->> 'body_text', '');
            v_title := v_item ->> 'title';
            v_content_hash := v_item ->> 'content_hash';
            v_fetched_at := coalesce(
                (v_item ->> 'fetched_at')::timestamptz,
                pg_catalog.now()
            );
            v_extractor_version := coalesce(
                (v_item ->> 'extractor_version')::integer,
                1
            );

            update public.news_entries as entry
            set title = pg_catalog.btrim(v_title),
                summary = v_summary,
                body_text = v_body_text,
                content_hash = v_content_hash,
                fetched_at = greatest(entry.fetched_at, v_fetched_at),
                extractor_version = v_extractor_version,
                enriched_text = null,
                enricher_version = null,
                embedding = null,
                embedding_model = null,
                entity_set = '{}'::text[],
                event_keys = '{}'::text[]
            where entry.id = news_entry_id
              and (
                  coalesce(entry.extractor_version, 0) < v_extractor_version
                  or (
                      entry.extractor_version = v_extractor_version
                      and (
                          (entry.body_text is null and v_body_text is not null)
                          or (entry.summary is null and v_summary is not null)
                          or length(v_body_text) > length(entry.body_text)
                      )
                  )
              );
        end if;

        return next;
    end loop;
end;
$$;

revoke execute on function public.ingest_news_entries_v2(uuid, jsonb)
    from public, anon, authenticated;
grant execute on function public.ingest_news_entries_v2(uuid, jsonb)
    to service_role;

commit;
