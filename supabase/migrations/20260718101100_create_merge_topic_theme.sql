-- Inline theme merge: the stage-4 adjudicator may decide two candidate themes
-- name the same subject. Loser's storylines repoint to the winner; loser is
-- tombstoned via merged_into. Aggregates recompute from storylines rows, same
-- convention as assign_storyline_theme.

create or replace function public.merge_topic_theme(
    p_loser_id uuid,
    p_winner_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
    if p_loser_id = p_winner_id then
        raise exception 'merge_topic_theme: loser and winner are the same theme';
    end if;

    update public.storylines set theme_id = p_winner_id
    where theme_id = p_loser_id;

    update public.topic_themes set
        merged_into = p_winner_id,
        storyline_count = 0
    where id = p_loser_id;

    update public.topic_themes t set
        storyline_count = (select count(*) from public.storylines s where s.theme_id = t.id),
        first_storyline_at = (select min(s.first_entry_at) from public.storylines s where s.theme_id = t.id),
        newest_storyline_at = (select max(s.newest_entry_at) from public.storylines s where s.theme_id = t.id)
    where t.id = p_winner_id;
end
$fn$;

comment on function public.merge_topic_theme is
    'Adjudicator-directed theme merge: repoint storylines, tombstone loser via merged_into, recompute winner aggregates from storylines rows.';

revoke execute on function public.merge_topic_theme(uuid, uuid)
    from public, anon, authenticated;
grant execute on function public.merge_topic_theme(uuid, uuid) to service_role;
