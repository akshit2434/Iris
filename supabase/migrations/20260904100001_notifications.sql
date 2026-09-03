-- Per-profile notification controls and browser-scoped Web Push endpoints.
create table if not exists public.profile_notification_preferences (
  profile_id text primary key references public.profiles(id) on delete cascade,
  enabled boolean not null default true,
  preview_level text not null default 'none' check (preview_level in ('none', 'summary')),
  quiet_hours_start time,
  quiet_hours_end time,
  time_zone text not null default 'UTC' check (char_length(time_zone) between 1 and 100),
  salience text not null default 'normal' check (salience in ('silent', 'normal', 'important')),
  updated_at timestamptz not null default now(),
  check ((quiet_hours_start is null) = (quiet_hours_end is null))
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  endpoint text not null unique check (char_length(endpoint) between 1 and 2000),
  p256dh text not null check (char_length(p256dh) between 1 and 500),
  auth text not null check (char_length(auth) between 1 and 500),
  device_id text not null check (char_length(device_id) between 8 and 200),
  user_agent text,
  permission text not null default 'granted' check (permission in ('granted', 'denied', 'default')),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_failure_code text check (last_failure_code is null or char_length(last_failure_code) between 1 and 100),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, device_id)
);
create index if not exists push_subscriptions_active_profile_idx
  on public.push_subscriptions(profile_id, updated_at desc) where revoked_at is null and permission = 'granted';

alter table public.profile_notification_preferences enable row level security;
alter table public.push_subscriptions enable row level security;
revoke all on table public.profile_notification_preferences from public, anon, authenticated;
revoke all on table public.push_subscriptions from public, anon, authenticated;
