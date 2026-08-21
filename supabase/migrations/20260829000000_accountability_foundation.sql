-- Milestone 4, Slice 1: accountability foundation.
-- Open loops are person-scoped, never thread-scoped. Origin thread/message
-- references are deep-link provenance only. Raw history remains untouched.

create type public.open_loop_kind as enum ('commitment', 'routine', 'idea');
create type public.open_loop_status as enum ('open', 'paused', 'done', 'cancelled', 'dropped');
create type public.loop_event_kind as enum (
  'created', 'clarified', 'rescheduled', 'paused', 'resumed',
  'nudged', 'completed', 'cancelled', 'dropped', 'reopened', 'suppressed', 'note'
);
create type public.scheduled_check_status as enum ('pending', 'delivered', 'merged', 'cancelled', 'expired');
create type public.checkin_delivery_status as enum ('pending', 'delivered', 'answered', 'cancelled');

create table if not exists public.open_loops (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 300),
  details text check (details is null or (char_length(details) between 1 and 5000 and details !~ E'\\u0000')),
  kind public.open_loop_kind not null default 'commitment',
  status public.open_loop_status not null default 'open',
  due_at timestamptz,
  cadence jsonb,
  origin_thread_id uuid,
  origin_message_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (id, profile_id),
  constraint open_loops_status_lifecycle_check check (
    (status in ('open','paused') and closed_at is null)
    or (status in ('done','cancelled','dropped') and closed_at is not null)
  ),
  constraint open_loops_routine_cadence_check check (kind <> 'routine' or cadence is not null)
);
create index if not exists open_loops_profile_status_idx
  on public.open_loops(profile_id, status, updated_at desc);

create table if not exists public.loop_events (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  loop_id uuid not null,
  kind public.loop_event_kind not null,
  detail text check (detail is null or char_length(detail) between 1 and 2000),
  actor text not null default 'agent' check (actor in ('user', 'agent', 'system')),
  source_thread_id uuid,
  source_message_id uuid,
  agent_run_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, profile_id),
  constraint loop_events_loop_fkey
    foreign key (loop_id, profile_id)
    references public.open_loops(id, profile_id) on delete restrict,
  constraint loop_events_thread_fkey
    foreign key (source_thread_id, profile_id)
    references public.threads(id, profile_id) on delete restrict,
  constraint loop_events_message_fkey
    foreign key (source_message_id, profile_id, source_thread_id)
    references public.messages(id, profile_id, thread_id) on delete restrict,
  check ((source_message_id is null) or source_thread_id is not null)
);
create index if not exists loop_events_profile_loop_created_idx
  on public.loop_events(profile_id, loop_id, created_at desc);

create or replace function public.prevent_loop_event_mutation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Loop events are immutable';
end;
$$;
drop trigger if exists loop_events_immutable on public.loop_events;
create trigger loop_events_immutable
before update or delete on public.loop_events
for each row execute function public.prevent_loop_event_mutation();

create table if not exists public.checkin_deliveries (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  thread_id uuid not null,
  message_id uuid,
  summary text check (summary is null or char_length(summary) between 1 and 4000),
  status public.checkin_delivery_status not null default 'pending',
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  answered_at timestamptz,
  unique (id, profile_id),
  constraint checkin_deliveries_thread_fkey
    foreign key (thread_id, profile_id)
    references public.threads(id, profile_id) on delete restrict,
  constraint checkin_deliveries_message_fkey
    foreign key (message_id, profile_id, thread_id)
    references public.messages(id, profile_id, thread_id) on delete set null
);
create index if not exists checkin_deliveries_profile_status_idx
  on public.checkin_deliveries(profile_id, status, created_at desc);

create table if not exists public.checkin_delivery_items (
  delivery_id uuid not null,
  loop_id uuid not null,
  profile_id text not null,
  response text check (response is null or char_length(response) between 1 and 2000),
  responded boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (delivery_id, loop_id),
  constraint checkin_delivery_items_delivery_fkey
    foreign key (delivery_id, profile_id)
    references public.checkin_deliveries(id, profile_id) on delete cascade,
  constraint checkin_delivery_items_loop_fkey
    foreign key (loop_id, profile_id)
    references public.open_loops(id, profile_id) on delete restrict
);

create table if not exists public.scheduled_checks (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  loop_id uuid not null,
  due_at timestamptz not null,
  status public.scheduled_check_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  escalation_tier integer not null default 0 check (escalation_tier >= 0),
  delivery_id uuid,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or char_length(cancel_reason) between 1 and 500),
  created_at timestamptz not null default now(),
  unique (id, profile_id),
  constraint scheduled_checks_loop_fkey
    foreign key (loop_id, profile_id)
    references public.open_loops(id, profile_id) on delete restrict,
  constraint scheduled_checks_delivery_fkey
    foreign key (delivery_id, profile_id)
    references public.checkin_deliveries(id, profile_id) on delete set null,
  constraint scheduled_checks_status_timestamps_check check (
    (status = 'pending' and delivered_at is null and cancelled_at is null)
    or (status in ('delivered','merged') and delivered_at is not null and cancelled_at is null)
    or (status in ('cancelled','expired') and cancelled_at is not null)
  )
);
create index if not exists scheduled_checks_due_idx
  on public.scheduled_checks(due_at) where status = 'pending';

create table if not exists public.loop_suppressions (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  subject text not null check (char_length(subject) between 2 and 200),
  reason text not null default 'User asked Iris to stop following up'
    check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default now(),
  lifted_at timestamptz,
  unique (id, profile_id)
);
create unique index if not exists loop_suppressions_profile_subject_active_idx
  on public.loop_suppressions(profile_id, subject) where lifted_at is null;

alter table public.open_loops enable row level security;
alter table public.loop_events enable row level security;
alter table public.checkin_deliveries enable row level security;
alter table public.checkin_delivery_items enable row level security;
alter table public.scheduled_checks enable row level security;
alter table public.loop_suppressions enable row level security;
revoke all on table public.open_loops from public, anon, authenticated;
revoke all on table public.loop_events from public, anon, authenticated;
revoke all on table public.checkin_deliveries from public, anon, authenticated;
revoke all on table public.checkin_delivery_items from public, anon, authenticated;
revoke all on table public.scheduled_checks from public, anon, authenticated;
revoke all on table public.loop_suppressions from public, anon, authenticated;
