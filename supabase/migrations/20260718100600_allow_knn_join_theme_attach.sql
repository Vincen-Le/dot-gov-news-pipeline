begin;

-- Theme assignment moved from LLM adjudication to KNN majority vote over
-- themed storyline centroids; 'knn_join' audits that path. 'adjudicated_join'
-- stays valid for historical rows.
alter table public.storylines
    drop constraint storylines_theme_attach_method_valid;
alter table public.storylines
    add constraint storylines_theme_attach_method_valid
        check (theme_attach_method is null or theme_attach_method in
            ('adjudicated_join', 'knn_join', 'new_theme', 'reassigned'));

commit;
