-- Milestone 3, Slice 4: revision reconciliation, governed archive, and
-- durable thread compaction. Raw messages remain immutable source history.

alter table public.thread_context
  add column if not exists compacted_through_message_id uuid,
  add column if not exists compacted_through_created_at timestamptz,
  add column if not exists continuity_revision bigint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.thread_context'::regclass
      and conname = 'thread_context_compacted_message_ownership_fkey'
  ) then
    alter table public.thread_context
      add constraint thread_context_compacted_message_ownership_fkey
      foreign key (compacted_through_message_id, profile_id, thread_id)
      references public.messages(id, profile_id, thread_id)
      on delete set null;
  end if;
end
$$;

create index if not exists thread_context_profile_memory_seen_idx
  on public.thread_context(profile_id, memory_revision_seen);

-- Existing threads get a safe baseline. New threads receive the same baseline
-- transactionally through the trigger below, so they do not replay old deltas.
insert into public.thread_context(thread_id, profile_id, memory_revision_seen)
select t.id, t.profile_id, 0
from public.threads t
on conflict (thread_id) do nothing;

create or replace function public.ensure_thread_context()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.thread_context(thread_id, profile_id, memory_revision_seen)
  select new.id, new.profile_id, coalesce(s.current_revision, 0)
  from public.profile_memory_state s
  where s.profile_id = new.profile_id
  on conflict (thread_id) do nothing;
  if not found then
    insert into public.thread_context(thread_id, profile_id, memory_revision_seen)
    values (new.id, new.profile_id, 0)
    on conflict (thread_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists threads_context_after_insert on public.threads;
create trigger threads_context_after_insert
after insert on public.threads
for each row execute function public.ensure_thread_context();

create or replace function public.advance_thread_memory_revision_seen(
  p_profile_id text,
  p_thread_id uuid,
  p_snapshot_revision bigint
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  bounded_snapshot bigint;
  next_seen bigint;
begin
  if p_snapshot_revision is null or p_snapshot_revision < 0 then
    raise exception 'Invalid memory revision snapshot';
  end if;
  select least(p_snapshot_revision, coalesce(s.current_revision, 0))
    into bounded_snapshot
  from public.profile_memory_state s
  where s.profile_id = p_profile_id;
  bounded_snapshot := coalesce(bounded_snapshot, 0);

  insert into public.thread_context(thread_id, profile_id, memory_revision_seen)
  values (p_thread_id, p_profile_id, bounded_snapshot)
  on conflict (thread_id) do nothing;

  update public.thread_context c
  set memory_revision_seen = greatest(c.memory_revision_seen, bounded_snapshot),
      updated_at = now()
  where c.thread_id = p_thread_id and c.profile_id = p_profile_id
  returning c.memory_revision_seen into next_seen;
  if next_seen is null then raise exception 'Thread context not found'; end if;
  return next_seen;
end;
$$;

create table if not exists public.thread_compaction_jobs (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  thread_id uuid not null,
  source_run_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed', 'conflict', 'skipped')),
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 10),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 240),
  expected_compacted_through_message_id uuid,
  expected_continuity_revision bigint not null default 0 check (expected_continuity_revision >= 0),
  checkpoint_message_id uuid not null,
  checkpoint_created_at timestamptz not null,
  recent_tail_messages integer not null default 24 check (recent_tail_messages between 4 and 100),
  available_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  last_error_message text check (last_error_message is null or char_length(last_error_message) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (id, profile_id, thread_id, source_run_id),
  unique (profile_id, source_run_id),
  unique (profile_id, idempotency_key),
  constraint thread_compaction_jobs_thread_fkey
    foreign key (thread_id, profile_id) references public.threads(id, profile_id) on delete cascade,
  constraint thread_compaction_jobs_run_fkey
    foreign key (source_run_id, profile_id, thread_id) references public.agent_runs(id, profile_id, thread_id) on delete cascade,
  constraint thread_compaction_jobs_checkpoint_fkey
    foreign key (checkpoint_message_id, profile_id, thread_id) references public.messages(id, profile_id, thread_id) on delete cascade,
  constraint thread_compaction_jobs_expected_checkpoint_fkey
    foreign key (expected_compacted_through_message_id, profile_id, thread_id) references public.messages(id, profile_id, thread_id) on delete set null
);

create index if not exists thread_compaction_jobs_claim_idx
  on public.thread_compaction_jobs(status, available_at, created_at);

create or replace function public.enqueue_thread_compaction_job(
  p_profile_id text,
  p_thread_id uuid,
  p_source_run_id uuid,
  p_min_messages integer default 80,
  p_recent_tail_messages integer default 24
)
returns setof public.thread_compaction_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  message_count integer;
  bounded_tail integer := least(greatest(coalesce(p_recent_tail_messages, 24), 4), 100);
  checkpoint_offset integer;
  checkpoint record;
  context_row public.thread_context%rowtype;
  key text := 'thread-compaction:' || p_source_run_id::text;
begin
  if not exists (
    select 1 from public.agent_runs r
    where r.id = p_source_run_id and r.profile_id = p_profile_id and r.thread_id = p_thread_id
      and r.status = 'completed' and r.assistant_message_id is not null
  ) then
    raise exception 'Only completed runs with persisted assistant messages can be compacted';
  end if;

  select count(*)::integer into message_count
  from public.messages m
  where m.profile_id = p_profile_id and m.thread_id = p_thread_id;
  if message_count < greatest(coalesce(p_min_messages, 80), 1) then return; end if;

  select * into context_row
  from public.thread_context c
  where c.thread_id = p_thread_id and c.profile_id = p_profile_id
  for update;
  if not found then
    insert into public.thread_context(thread_id, profile_id)
    values (p_thread_id, p_profile_id)
    returning * into context_row;
  end if;

  checkpoint_offset := greatest(message_count - bounded_tail - 1, 0);
  select m.id, m.created_at into checkpoint
  from public.messages m
  where m.profile_id = p_profile_id and m.thread_id = p_thread_id
  order by m.created_at asc, m.id asc
  offset checkpoint_offset limit 1;
  if checkpoint.id is null then return; end if;

  return query
  insert into public.thread_compaction_jobs(
    profile_id, thread_id, source_run_id, idempotency_key,
    expected_compacted_through_message_id, expected_continuity_revision,
    checkpoint_message_id, checkpoint_created_at, recent_tail_messages
  ) values (
    p_profile_id, p_thread_id, p_source_run_id, key,
    context_row.compacted_through_message_id, context_row.continuity_revision,
    checkpoint.id, checkpoint.created_at, bounded_tail
  )
  on conflict (profile_id, source_run_id) do update set updated_at = now()
  returning thread_compaction_jobs.*;
end;
$$;

create or replace function public.claim_thread_compaction_jobs(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 120
)
returns setof public.thread_compaction_jobs
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select j.id, j.profile_id, j.thread_id, j.source_run_id
    from public.thread_compaction_jobs j
    where ((j.status = 'pending' and j.available_at <= now())
      or (j.status = 'running' and j.lease_expires_at is not null and j.lease_expires_at <= now()))
      and j.attempts < 3
    order by j.available_at asc, j.created_at asc
    for update skip locked
    limit least(greatest(coalesce(p_limit, 1), 1), 2)
  )
  update public.thread_compaction_jobs j
  set status = 'running', attempts = j.attempts + 1,
      locked_by = left(nullif(trim(coalesce(p_worker_id, '')), ''), 120),
      locked_at = now(),
      lease_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 15), 900)),
      updated_at = now()
  from candidates c
  where j.id = c.id and j.profile_id = c.profile_id and j.thread_id = c.thread_id and j.source_run_id = c.source_run_id
  returning j.*;
$$;

create or replace function public.apply_thread_compaction_checkpoint(
  p_profile_id text,
  p_job_id uuid,
  p_worker_id text,
  p_continuity_summary text,
  p_pinned_notes text[],
  p_checkpoint_message_id uuid,
  p_checkpoint_created_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.thread_compaction_jobs%rowtype;
  updated_count integer;
begin
  select * into job_row
  from public.thread_compaction_jobs
  where id = p_job_id and profile_id = p_profile_id and locked_by = p_worker_id
  for update;
  if not found then raise exception 'Thread compaction lease not owned by worker'; end if;

  update public.thread_context c
  set continuity_summary = left(coalesce(p_continuity_summary, ''), 12000),
      pinned_notes = coalesce((select array_agg(left(note, 500)) from unnest(coalesce(p_pinned_notes, '{}'::text[])) note limit 12), '{}'::text[]),
      compacted_through_message_id = p_checkpoint_message_id,
      compacted_through_created_at = p_checkpoint_created_at,
      continuity_revision = c.continuity_revision + 1,
      updated_at = now()
  where c.thread_id = job_row.thread_id and c.profile_id = p_profile_id
    and c.continuity_revision = job_row.expected_continuity_revision
    and c.compacted_through_message_id is not distinct from job_row.expected_compacted_through_message_id;
  get diagnostics updated_count = row_count;
  return case when updated_count > 0 then 'applied' else 'conflict' end;
end;
$$;

create or replace function public.finish_thread_compaction_job(
  p_profile_id text,
  p_job_id uuid,
  p_worker_id text,
  p_status text,
  p_error_code text default null,
  p_error_message text default null,
  p_retry boolean default false,
  p_available_at timestamptz default null
)
returns setof public.thread_compaction_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  next_status text;
begin
  if p_status not in ('completed', 'failed', 'conflict', 'skipped') then raise exception 'Invalid thread compaction completion status'; end if;
  select case when p_retry and attempts < 3 then 'pending' else p_status end into next_status
  from public.thread_compaction_jobs
  where id = p_job_id and profile_id = p_profile_id and locked_by = p_worker_id
  for update;
  if not found then raise exception 'Thread compaction lease not owned by worker'; end if;

  return query update public.thread_compaction_jobs j
  set status = next_status,
      available_at = case when next_status = 'pending' then coalesce(p_available_at, now() + interval '30 seconds') else j.available_at end,
      lease_expires_at = null, locked_at = null, locked_by = null,
      last_error_code = left(p_error_code, 120),
      last_error_message = left(p_error_message, 500),
      completed_at = case when next_status in ('completed', 'failed', 'conflict', 'skipped') then now() else null end,
      updated_at = now()
  where j.id = p_job_id and j.profile_id = p_profile_id
  returning j.*;
end;
$$;

alter table public.thread_context enable row level security;
alter table public.thread_compaction_jobs enable row level security;
revoke all on table public.thread_compaction_jobs from public, anon, authenticated;
revoke all on function public.advance_thread_memory_revision_seen(text, uuid, bigint) from public, anon, authenticated;
revoke all on function public.enqueue_thread_compaction_job(text, uuid, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.claim_thread_compaction_jobs(text, integer, integer) from public, anon, authenticated;
revoke all on function public.apply_thread_compaction_checkpoint(text, uuid, text, text, text[], uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.finish_thread_compaction_job(text, uuid, text, text, text, text, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.advance_thread_memory_revision_seen(text, uuid, bigint) to service_role;
grant execute on function public.enqueue_thread_compaction_job(text, uuid, uuid, integer, integer) to service_role;
grant execute on function public.claim_thread_compaction_jobs(text, integer, integer) to service_role;
grant execute on function public.apply_thread_compaction_checkpoint(text, uuid, text, text, text[], uuid, timestamptz) to service_role;
grant execute on function public.finish_thread_compaction_job(text, uuid, text, text, text, text, boolean, timestamptz) to service_role;
