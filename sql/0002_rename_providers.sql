-- Migration for apps that applied 0001_generations.sql before the
-- provider catalog was renamed (i.e. when the table had a check
-- constraint allowing only 'wavespeed' and 'openai').
--
-- New apps applying 0001 today don't need this — 0001 has already
-- been updated to omit the check constraint.

alter table public.generations
  drop constraint if exists generations_provider_check;

update public.generations
  set provider = 'wavespeed-nano-banana-pro'
  where provider = 'wavespeed';

update public.generations
  set provider = 'fal-gpt-image-2'
  where provider = 'openai';

-- ----------------------------------------------------------------
-- gogo-gallery ONLY: also has a `settings` table with a
-- default_provider row. Run this AFTER the above if that table
-- exists in your project (other consuming apps don't have it):
--
--   update public.settings
--     set value = 'wavespeed-gpt-image-2'
--     where key = 'default_provider' and value in ('wavespeed', 'openai');
-- ----------------------------------------------------------------
