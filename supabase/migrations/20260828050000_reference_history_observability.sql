-- Milestone 3: profile/job-scoped telemetry for background Dreaming runs.
--
-- Background synthesis is profile-wide. It must not be forced into a
-- user-facing agent run merely because one source message happened to come
-- from a particular thread. Thread and source-run linkage is optional and is
-- retained only when it can be validated.

create table if not exists public.reference_history_agent_events (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  job_id uuid not null,
  thread_id uuid,
  source_run_id uuid,
  sequence integer not null check (sequence > 0),
  type text not null check (type in ('model_call_started', 'model_call_completed', 'model_call_failed', 'assistant_completed', 'assistant_partial')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, profile_id),
  unique (profile_id, job_id, sequence),
  constraint reference_history_agent_events_job_fkey
    foreign key (job_id, profile_id)
    references public.reference_history_jobs(id, profile_id)
    on delete cascade,
  constraint reference_history_agent_events_thread_fkey
    foreign key (thread_id, profile_id)
    references public.threads(id, profile_id)
    on delete set null (thread_id),
  constraint reference_history_agent_events_run_fkey
    foreign key (source_run_id, profile_id)
    references public.agent_runs(id, profile_id)
    on delete set null (source_run_id)
);

create index if not exists reference_history_agent_events_job_sequence_idx
  on public.reference_history_agent_events(profile_id, job_id, sequence asc);

alter table public.reference_history_agent_events enable row level security;
revoke all on table public.reference_history_agent_events from public, anon, authenticated;
