begin;

revoke execute on function
    public.replace_golden_storyline_fallback_thumbnails(text, jsonb)
    from service_role;

comment on function
    public.replace_golden_storyline_fallback_thumbnails(text, jsonb) is
    'Sealed one-time recovery operation used for deterministic-shuffle-bag-v1. No API role may execute it after finalization.';

notify pgrst, 'reload schema';

commit;
