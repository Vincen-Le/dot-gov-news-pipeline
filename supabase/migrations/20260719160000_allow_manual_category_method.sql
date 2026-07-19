begin;

-- Human curation writes categories directly during golden-set review;
-- 'manual' records that the label came from a reviewer, not the classifier.
alter table public.storylines
    drop constraint storylines_category_method_valid;
alter table public.storylines
    add constraint storylines_category_method_valid
        check (category_method is null
               or category_method in ('classified', 'retry', 'manual'));

commit;
