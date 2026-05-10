-- 0003_rate_limit.sql
--
-- Per-user rate-limit support: tracks the anonymous cookie UUID and
-- the (optional) email a visitor entered to unlock a higher quota.
-- Apply per consuming app's Supabase project.
--
-- Counting model:
--   - Default: count generations.user_id over the rolling window.
--   - When the visitor has bypassed via email: count by user_email
--     (catches cookie-clearing within the same email).
--
-- The user_emails table maps cookie UUID -> normalized email so the
-- engine can detect "this cookie has bypassed" without scanning the
-- generations table by email every request.

alter table public.generations
  add column if not exists user_id text,
  add column if not exists user_email text;

-- Indexes scoped by created_at desc match the rate-limit COUNT query
-- (where user_id = ? and created_at >= now() - interval '1 day').
create index if not exists generations_user_id_created_idx
  on public.generations (user_id, created_at desc);

create index if not exists generations_user_email_created_idx
  on public.generations (user_email, created_at desc);

create table if not exists public.user_emails (
  user_id          text primary key,        -- cookie UUID
  email            text not null,           -- as the user typed it
  email_normalized text not null,           -- lowercase + strip Gmail +aliases / dots
  created_at       timestamptz not null default now()
);

-- Look up other cookie UUIDs sharing the same email (used when a user
-- clears cookies, gets a new UUID, then re-enters the same email).
create index if not exists user_emails_email_normalized_idx
  on public.user_emails (email_normalized);

-- Same RLS-by-default stance as generations: deny anon, the engine
-- uses the service-role key which bypasses RLS.
alter table public.user_emails enable row level security;
