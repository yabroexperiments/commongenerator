-- commongenerator generations table.
-- Apply once per consuming app's Supabase project:
--   psql ... -f sql/0001_generations.sql
-- or copy/paste into the Supabase SQL editor.

create extension if not exists "pgcrypto";

create table if not exists public.generations (
  id uuid primary key default gen_random_uuid(),
  -- Free-form opaque tag — e.g. "rating", "gallery-renaissance",
  -- "stickers-action-3". Engine never parses it.
  kind text,
  original_image_url text not null,
  result_image_url text,
  prompt text not null,
  provider text not null check (provider in ('wavespeed', 'openai')),
  -- Provider task ID (Wavespeed prediction ID, Fal request ID, etc).
  provider_task_id text,
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed')),
  error_message text,
  -- App-specific data the engine doesn't care about.
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists generations_kind_idx on public.generations (kind);
create index if not exists generations_status_idx on public.generations (status);
create index if not exists generations_created_at_idx on public.generations (created_at desc);

-- Row-level security: deny by default. The engine uses the service-role
-- key (bypasses RLS) so this only affects clients that hit Supabase
-- directly with the anon key. Adjust per app if you want to expose
-- read-by-id to anonymous browsers (e.g. for a shareable result URL).
alter table public.generations enable row level security;
