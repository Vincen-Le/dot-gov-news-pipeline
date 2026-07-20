begin;

create or replace function public.publish_golden_event_card_article_overview(
    p_article_overview jsonb,
    p_enrichment_version integer,
    p_event_card_id uuid,
    p_generated_at timestamptz,
    p_input_hash text,
    p_model text,
    p_prompt_hash text,
    p_prompt_version integer,
    p_source_card_version integer,
    p_source_content_hashes text[],
    p_source_entry_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    existing_row public.golden_event_card_article_overviews%rowtype;
    write_time timestamptz := pg_catalog.clock_timestamp();
begin
    -- This also serializes first publication, when no row exists to lock yet.
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_event_card_id::text, 0)
    );

    select *
    into existing_row
    from public.golden_event_card_article_overviews
    where event_card_id = p_event_card_id
    for update;

    if found then
        if existing_row.input_hash <> p_input_hash then
            raise exception
                'article overview input hash conflict for card %',
                p_event_card_id;
        end if;

        if existing_row.enrichment_version > p_enrichment_version
            or existing_row.prompt_version > p_prompt_version then
            raise exception
                'article overview version regression for card %',
                p_event_card_id;
        end if;

        if existing_row.enrichment_version = p_enrichment_version
            and existing_row.prompt_version = p_prompt_version then
            if existing_row.article_overview is distinct from p_article_overview
                or existing_row.model is distinct from p_model
                or existing_row.prompt_hash is distinct from p_prompt_hash
                or existing_row.source_card_version is distinct from p_source_card_version
                or existing_row.source_entry_ids is distinct from p_source_entry_ids
                or existing_row.source_content_hashes is distinct from p_source_content_hashes then
                raise exception
                    'article overview version is immutable for card %',
                    p_event_card_id;
            end if;
            return;
        end if;

        update public.golden_event_card_article_overviews
        set
            article_overview = p_article_overview,
            enrichment_version = p_enrichment_version,
            generated_at = p_generated_at,
            model = p_model,
            prompt_hash = p_prompt_hash,
            prompt_version = p_prompt_version,
            source_card_version = p_source_card_version,
            source_content_hashes = p_source_content_hashes,
            source_entry_ids = p_source_entry_ids,
            updated_at = write_time
        where event_card_id = p_event_card_id;
        return;
    end if;

    insert into public.golden_event_card_article_overviews (
        article_overview,
        created_at,
        enrichment_version,
        event_card_id,
        generated_at,
        input_hash,
        model,
        prompt_hash,
        prompt_version,
        source_card_version,
        source_content_hashes,
        source_entry_ids,
        updated_at
    ) values (
        p_article_overview,
        write_time,
        p_enrichment_version,
        p_event_card_id,
        p_generated_at,
        p_input_hash,
        p_model,
        p_prompt_hash,
        p_prompt_version,
        p_source_card_version,
        p_source_content_hashes,
        p_source_entry_ids,
        write_time
    );
end;
$$;

comment on function public.publish_golden_event_card_article_overview(
    jsonb,
    integer,
    uuid,
    timestamptz,
    text,
    text,
    text,
    integer,
    integer,
    text[],
    uuid[]
) is
    'Atomically inserts or version-upgrades one card overview while rejecting stale inputs, version regressions, and same-version rewrites.';

revoke all on function public.publish_golden_event_card_article_overview(
    jsonb,
    integer,
    uuid,
    timestamptz,
    text,
    text,
    text,
    integer,
    integer,
    text[],
    uuid[]
) from public, anon, authenticated;

grant execute on function public.publish_golden_event_card_article_overview(
    jsonb,
    integer,
    uuid,
    timestamptz,
    text,
    text,
    text,
    integer,
    integer,
    text[],
    uuid[]
) to service_role;

comment on column public.golden_event_card_article_overviews.article_overview is
    'Bounded aggregate payload containing a plain-language summary and two to five sourced key points for v2 rows.';

commit;
