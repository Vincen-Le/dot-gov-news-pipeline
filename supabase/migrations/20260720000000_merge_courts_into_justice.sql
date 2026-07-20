-- Manual QA decision (2026-07-19 slice-2 review): "Courts & Legal Rulings"
-- overlaps "Justice & Law Enforcement" too heavily to justify a separate
-- reader-facing category — merge it away. Reassign any members defensively
-- before deleting; golden mirrors are rewritten at `golden promote`, but the
-- delete below also covers an already-mirrored row on hosted.

update public.storylines
set category_id = (select id from public.topic_categories
                   where display_name = 'Justice & Law Enforcement'),
    category_method = 'manual',
    category_reason = 'Manual QA (2026-07-19): Courts & Legal Rulings merged into Justice & Law Enforcement'
where category_id = (select id from public.topic_categories
                     where display_name = 'Courts & Legal Rulings');

update public.golden_storylines
set category_id = (select id from public.topic_categories
                   where display_name = 'Justice & Law Enforcement'),
    category_method = 'manual',
    category_reason = 'Manual QA (2026-07-19): Courts & Legal Rulings merged into Justice & Law Enforcement'
where category_id = (select id from public.topic_categories
                     where display_name = 'Courts & Legal Rulings');

update public.news_entry_topology_labels
set topic_category_id = (select id from public.topic_categories
                         where display_name = 'Justice & Law Enforcement')
where topic_category_id = (select id from public.topic_categories
                           where display_name = 'Courts & Legal Rulings');

delete from public.golden_topic_categories
where display_name = 'Courts & Legal Rulings';

delete from public.topic_categories
where display_name = 'Courts & Legal Rulings';
