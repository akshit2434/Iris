-- Lightweight relationship-onboarding state. Durable personal facts stay in
-- the governed memory workspace; this row only records progress and consent.
create type public.onboarding_lifecycle_state as enum ('not_started', 'in_progress', 'complete', 'deferred');
create type public.onboarding_accountability_tone as enum ('gentle', 'balanced', 'direct');

create table if not exists public.onboarding_profiles (
  profile_id text primary key references public.profiles(id) on delete cascade,
  state public.onboarding_lifecycle_state not null default 'not_started',
  deferred_at timestamptz,
  confirmed_timezone text,
  accountability_tone public.onboarding_accountability_tone,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((state = 'deferred') = (deferred_at is not null)),
  unique (profile_id)
);

alter table public.onboarding_profiles enable row level security;
revoke all on table public.onboarding_profiles from public, anon, authenticated;
