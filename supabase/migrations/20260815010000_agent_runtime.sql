-- Durable agent execution records are additive to the canonical message history.
-- Raw messages remain the source transcript; runs/events describe execution.

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  thread_id uuid not null,
  request_id text not null check (char_length(request_id) between 1 and 200),
  user_message_id uuid,
  assistant_message_id uuid,
  model text not null,
  status text not null check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  failed_at timestamptz,
  error_code text,
  error_message text,
  error_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, profile_id, thread_id),
  unique (profile_id, thread_id, request_id),
  constraint agent_runs_thread_profile_fkey
    foreign key (thread_id, profile_id)
    references public.threads(id, profile_id)
    on delete cascade
);

-- Composite ownership keys ensure message references cannot point across profiles
-- or threads, even when a caller already knows a message UUID.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.messages'::regclass
      and conname = 'messages_id_profile_thread_key'
  ) then
    alter table public.messages
      add constraint messages_id_profile_thread_key
      unique (id, profile_id, thread_id);
  end if;
end
$$;

alter table public.messages
  add column if not exists agent_run_id uuid,
  add column if not exists is_complete boolean not null default true;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.messages'::regclass
      and conname = 'messages_agent_run_profile_thread_fkey'
  ) then
    alter table public.messages
      add constraint messages_agent_run_profile_thread_fkey
      foreign key (agent_run_id, profile_id, thread_id)
      references public.agent_runs(id, profile_id, thread_id)
      on delete set null (agent_run_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.agent_runs'::regclass
      and conname = 'agent_runs_user_message_ownership_fkey'
  ) then
    alter table public.agent_runs
      add constraint agent_runs_user_message_ownership_fkey
      foreign key (user_message_id, profile_id, thread_id)
      references public.messages(id, profile_id, thread_id)
      on delete set null (user_message_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.agent_runs'::regclass
      and conname = 'agent_runs_assistant_message_ownership_fkey'
  ) then
    alter table public.agent_runs
      add constraint agent_runs_assistant_message_ownership_fkey
      foreign key (assistant_message_id, profile_id, thread_id)
      references public.messages(id, profile_id, thread_id)
      on delete set null (assistant_message_id);
  end if;
end
$$;

create table if not exists public.agent_events (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  thread_id uuid not null,
  run_id uuid not null,
  sequence integer not null check (sequence > 0),
  type text not null check (type in (
    'run_started',
    'run_completed',
    'run_failed',
    'tool_call',
    'tool_result'
  )),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, profile_id, thread_id, run_id),
  unique (run_id, sequence),
  constraint agent_events_run_ownership_fkey
    foreign key (run_id, profile_id, thread_id)
    references public.agent_runs(id, profile_id, thread_id)
    on delete cascade
);

create index if not exists agent_runs_profile_thread_started_idx
  on public.agent_runs(profile_id, thread_id, started_at desc);

create index if not exists agent_events_profile_thread_run_sequence_idx
  on public.agent_events(profile_id, thread_id, run_id, sequence asc);

alter table public.agent_runs enable row level security;
alter table public.agent_events enable row level security;
