-- Manual QA can attach storylines to themes directly (slice-3 review:
-- recurring weekly digests grouped as a theme). Mirrors
-- 20260719160000_allow_manual_category_method for the theme axis.

alter table public.storylines
    drop constraint storylines_theme_attach_method_valid;

alter table public.storylines
    add constraint storylines_theme_attach_method_valid
        check (theme_attach_method is null or theme_attach_method in
            ('adjudicated_join', 'knn_join', 'new_theme', 'reassigned',
             'criterion_join', 'promoted', 'sweep_join', 'manual'));

-- the golden mirror carries the same check under the same name
alter table public.golden_storylines
    drop constraint storylines_theme_attach_method_valid;

alter table public.golden_storylines
    add constraint storylines_theme_attach_method_valid
        check (theme_attach_method is null or theme_attach_method in
            ('adjudicated_join', 'knn_join', 'new_theme', 'reassigned',
             'criterion_join', 'promoted', 'sweep_join', 'manual'));
