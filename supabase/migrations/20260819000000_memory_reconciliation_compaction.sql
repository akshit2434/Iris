-- Milestone 3, Slice 3: token-triggered, structured thread continuity.
-- Raw messages remain immutable. A continuity checkpoint is a versioned,
-- rebuildable projection of complete source units, never a replacement log.

alter table public.thread_context
  add column if not exists active_continuity_checkpoint_id uuid,
  add column if not exists continuity_revision bigint not null default 0;

create index if not exists thread_context_profile_memory_seen_idx
  on public.thread_context(profile_id, memory_revision_seen);

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

create table if not exists public.thread_continuity_checkpoints (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  thread_id uuid not null,
  revision bigint not null check (revision >= 1),
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  rendered_text text not null check (char_length(rendered_text) between 1 and 12000),
  covered_through_ordinal bigint not null check (covered_through_ordinal >= 0),
  covered_through_message_id uuid not null,
  covered_through_created_at timestamptz not null,
  source_start_message_id uuid not null,
  source_end_message_id uuid not null,
  source_message_ids uuid[] not null default '{}',
  source_estimated_tokens integer not null check (source_estimated_tokens > 0),
  rendered_tokens integer not null check (rendered_tokens > 0),
  model text not null check (char_length(model) between 1 and 200),
  tokenizer_provider text not null check (char_length(tokenizer_provider) between 1 and 120),
  tokenizer_version text not null check (char_length(tokenizer_version) between 1 and 120),
  summarizer_version text not null check (char_length(summarizer_version) between 1 and 120),
  previous_checkpoint_id uuid,
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (id, profile_id, thread_id),
  unique (profile_id, thread_id, revision),
  constraint thread_continuity_checkpoints_thread_fkey
    foreign key (thread_id, profile_id) references public.threads(id, profile_id) on delete cascade,
  constraint thread_continuity_checkpoints_message_fkey
    foreign key (covered_through_message_id, profile_id, thread_id) references public.messages(id, profile_id, thread_id) on delete cascade,
  constraint thread_continuity_checkpoints_start_message_fkey
    foreign key (source_start_message_id, profile_id, thread_id) references public.messages(id, profile_id, thread_id) on delete cascade,
  constraint thread_continuity_checkpoints_end_message_fkey
    foreign key (source_end_message_id, profile_id, thread_id) references public.messages(id, profile_id, thread_id) on delete cascade,
  constraint thread_continuity_checkpoints_previous_fkey
    foreign key (previous_checkpoint_id) references public.thread_continuity_checkpoints(id) on delete set null
);

alter table public.thread_context
  add constraint thread_context_active_continuity_fkey
  foreign key (active_continuity_checkpoint_id)
  references public.thread_continuity_checkpoints(id)
  on delete set null;

create index if not exists thread_continuity_checkpoints_thread_revision_idx
  on public.thread_continuity_checkpoints(profile_id, thread_id, revision desc);

create table if not exists public.thread_continuity_jobs (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  thread_id uuid not null,
  source_run_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed', 'conflict', 'skipped')),
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 10),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 240),
  expected_checkpoint_id uuid,
  expected_continuity_revision bigint not null default 0 check (expected_continuity_revision >= 0),
  source_start_message_id uuid not null,
  source_end_message_id uuid not null,
  source_start_ordinal bigint not null check (source_start_ordinal >= 0),
  source_end_ordinal bigint not null check (source_end_ordinal >= source_start_ordinal),
  source_estimated_tokens integer not null check (source_estimated_tokens > 0),
  projected_input_tokens integer not null check (projected_input_tokens > 0),
  safe_input_budget_tokens integer not null check (safe_input_budget_tokens > 0),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  model text not null check (char_length(model) between 1 and 200),
  tokenizer_provider text not null check (char_length(tokenizer_provider) between 1 and 120),
  tokenizer_version text not null check (char_length(tokenizer_version) between 1 and 120),
  rebuild_from_raw boolean not null default false,
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
  unique (profile_id, idempotency_key),
  constraint thread_continuity_jobs_thread_fkey
    foreign key (thread_id, profile_id) references public.threads(id, profile_id) on delete cascade,
  constraint thread_continuity_jobs_run_fkey
    foreign key (source_run_id, profile_id, thread_id) references public.agent_runs(id, profile_id, thread_id) on delete cascade,
  constraint thread_continuity_jobs_expected_checkpoint_fkey
    foreign key (expected_checkpoint_id) references public.thread_continuity_checkpoints(id) on delete set null,
  constraint thread_continuity_jobs_start_message_fkey
    foreign key (source_start_message_id, profile_id, thread_id) references public.messages(id, profile_id, thread_id) on delete cascade,
  constraint thread_continuity_jobs_end_message_fkey
    foreign key (source_end_message_id, profile_id, thread_id) references public.messages(id, profile_id, thread_id) on delete cascade
);

create index if not exists thread_continuity_jobs_claim_idx
  on public.thread_continuity_jobs(status, available_at, created_at);

create or replace function public.enqueue_thread_continuity_job(
  p_profile_id text,
  p_thread_id uuid,
  p_source_run_id uuid,
  p_source_start_message_id uuid,
  p_source_end_message_id uuid,
  p_source_start_ordinal bigint,
  p_source_end_ordinal bigint,
  p_source_estimated_tokens integer,
  p_projected_input_tokens integer,
  p_safe_input_budget_tokens integer,
  p_input_hash text,
  p_model text,
  p_tokenizer_provider text,
  p_tokenizer_version text,
  p_rebuild_from_raw boolean default false
)
returns setof public.thread_continuity_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  context_row public.thread_context%rowtype;
  key text := 'thread-continuity:' || p_source_run_id::text || ':' || p_input_hash;
begin
  if p_projected_input_tokens is null or p_safe_input_budget_tokens is null
     or p_projected_input_tokens * 4 < p_safe_input_budget_tokens * 3 then
    return;
  end if;
  if p_source_estimated_tokens is null or p_source_estimated_tokens <= 0 then return; end if;
  if p_source_start_ordinal is null or p_source_end_ordinal is null or p_source_end_ordinal < p_source_start_ordinal then
    raise exception 'Invalid continuity source range';
  end if;
  if not exists (
    select 1 from public.agent_runs r
    where r.id = p_source_run_id and r.profile_id = p_profile_id and r.thread_id = p_thread_id
      and r.status = 'completed' and r.assistant_message_id is not null
  ) then
    raise exception 'Only completed runs with persisted assistant messages can create continuity jobs';
  end if;
  if not exists (select 1 from public.messages m where m.id = p_source_start_message_id and m.profile_id = p_profile_id and m.thread_id = p_thread_id)
     or not exists (select 1 from public.messages m where m.id = p_source_end_message_id and m.profile_id = p_profile_id and m.thread_id = p_thread_id) then
    raise exception 'Continuity source messages are not owned by the thread';
  end if;

  select * into context_row
  from public.thread_context c
  where c.thread_id = p_thread_id and c.profile_id = p_profile_id
  for update;
  if not found then
    insert into public.thread_context(thread_id, profile_id)
    values (p_thread_id, p_profile_id)
    returning * into context_row;
  end if;

  return query
  insert into public.thread_continuity_jobs(
    profile_id, thread_id, source_run_id, idempotency_key,
    expected_checkpoint_id, expected_continuity_revision,
    source_start_message_id, source_end_message_id,
    source_start_ordinal, source_end_ordinal, source_estimated_tokens,
    projected_input_tokens, safe_input_budget_tokens, input_hash,
    model, tokenizer_provider, tokenizer_version, rebuild_from_raw
  ) values (
    p_profile_id, p_thread_id, p_source_run_id, key,
    context_row.active_continuity_checkpoint_id, context_row.continuity_revision,
    p_source_start_message_id, p_source_end_message_id,
    p_source_start_ordinal, p_source_end_ordinal, p_source_estimated_tokens,
    p_projected_input_tokens, p_safe_input_budget_tokens, p_input_hash,
    left(btrim(p_model), 200), left(btrim(p_tokenizer_provider), 120), left(btrim(p_tokenizer_version), 120), coalesce(p_rebuild_from_raw, false)
  )
  on conflict (profile_id, idempotency_key) do update set updated_at = now()
  returning thread_continuity_jobs.*;
end;
$$;

create or replace function public.claim_thread_continuity_jobs(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 120
)
returns setof public.thread_continuity_jobs
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select j.id, j.profile_id, j.thread_id, j.source_run_id
    from public.thread_continuity_jobs j
    where ((j.status = 'pending' and j.available_at <= now())
      or (j.status = 'running' and j.lease_expires_at is not null and j.lease_expires_at <= now()))
      and j.attempts < 3
    order by j.available_at asc, j.created_at asc
    for update skip locked
    limit least(greatest(coalesce(p_limit, 1), 1), 2)
  )
  update public.thread_continuity_jobs j
  set status = 'running', attempts = j.attempts + 1,
      locked_by = left(nullif(trim(coalesce(p_worker_id, '')), ''), 120),
      locked_at = now(),
      lease_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 15), 900)),
      updated_at = now()
  from candidates c
  where j.id = c.id and j.profile_id = c.profile_id and j.thread_id = c.thread_id and j.source_run_id = c.source_run_id
  returning j.*;
$$;

create or replace function public.apply_thread_continuity_checkpoint(
  p_profile_id text,
  p_job_id uuid,
  p_worker_id text,
  p_expected_checkpoint_id uuid,
  p_expected_continuity_revision bigint,
  p_document jsonb,
  p_rendered_text text,
  p_covered_through_ordinal bigint,
  p_covered_through_message_id uuid,
  p_covered_through_created_at timestamptz,
  p_source_start_message_id uuid,
  p_source_end_message_id uuid,
  p_source_message_ids uuid[],
  p_source_estimated_tokens integer,
  p_rendered_tokens integer,
  p_model text,
  p_tokenizer_provider text,
  p_tokenizer_version text,
  p_summarizer_version text,
  p_previous_checkpoint_id uuid,
  p_input_hash text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.thread_continuity_jobs%rowtype;
  context_row public.thread_context%rowtype;
  next_revision bigint;
  new_checkpoint_id uuid;
begin
  select * into job_row
  from public.thread_continuity_jobs
  where id = p_job_id and profile_id = p_profile_id and locked_by = p_worker_id
  for update;
  if not found then raise exception 'Continuity job lease is not owned by worker'; end if;

  select * into context_row
  from public.thread_context c
  where c.thread_id = job_row.thread_id and c.profile_id = p_profile_id
  for update;
  if not found then raise exception 'Thread context not found'; end if;
  if context_row.continuity_revision <> job_row.expected_continuity_revision
     or context_row.active_continuity_checkpoint_id is distinct from job_row.expected_checkpoint_id
     or (not job_row.rebuild_from_raw and p_previous_checkpoint_id is distinct from job_row.expected_checkpoint_id) then
    return 'conflict';
  end if;
  if p_summarizer_version <> 'iris-continuity-summarizer-v1' then
    return 'invalidated';
  end if;

  next_revision := context_row.continuity_revision + 1;
  insert into public.thread_continuity_checkpoints(
    profile_id, thread_id, revision, document, rendered_text,
    covered_through_ordinal, covered_through_message_id, covered_through_created_at,
    source_start_message_id, source_end_message_id, source_message_ids,
    source_estimated_tokens, rendered_tokens, model, tokenizer_provider,
    tokenizer_version, summarizer_version, previous_checkpoint_id, input_hash
  ) values (
    p_profile_id, job_row.thread_id, next_revision, p_document, left(p_rendered_text, 12000),
    p_covered_through_ordinal, p_covered_through_message_id, p_covered_through_created_at,
    p_source_start_message_id, p_source_end_message_id, coalesce(p_source_message_ids, '{}'),
    p_source_estimated_tokens, p_rendered_tokens, left(btrim(p_model), 200), left(btrim(p_tokenizer_provider), 120),
    left(btrim(p_tokenizer_version), 120), left(btrim(p_summarizer_version), 120), p_previous_checkpoint_id, p_input_hash
  ) returning id into new_checkpoint_id;
  update public.thread_context
  set active_continuity_checkpoint_id = new_checkpoint_id,
      continuity_revision = next_revision,
      updated_at = now()
  where thread_id = job_row.thread_id and profile_id = p_profile_id;
  return 'applied';
exception
  when unique_violation then
    return 'conflict';
end;
$$;

create or replace function public.invalidate_thread_continuity_checkpoint(
  p_profile_id text,
  p_thread_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.thread_context
  set active_continuity_checkpoint_id = null,
      continuity_revision = continuity_revision + 1,
      updated_at = now()
  where profile_id = p_profile_id and thread_id = p_thread_id;
end;
$$;

create or replace function public.finish_thread_continuity_job(
  p_profile_id text,
  p_job_id uuid,
  p_worker_id text,
  p_status text,
  p_error_code text default null,
  p_error_message text default null,
  p_retry boolean default false,
  p_available_at timestamptz default null
)
returns setof public.thread_continuity_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  next_status text;
begin
  if p_status not in ('completed', 'failed', 'conflict', 'skipped') then raise exception 'Invalid continuity completion status'; end if;
  select case when p_retry and attempts < 3 then 'pending' else p_status end into next_status
  from public.thread_continuity_jobs
  where id = p_job_id and profile_id = p_profile_id and locked_by = p_worker_id
  for update;
  if not found then raise exception 'Continuity job lease is not owned by worker'; end if;

  return query update public.thread_continuity_jobs j
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
alter table public.thread_continuity_checkpoints enable row level security;
alter table public.thread_continuity_jobs enable row level security;
revoke all on table public.thread_continuity_checkpoints from public, anon, authenticated;
revoke all on table public.thread_continuity_jobs from public, anon, authenticated;
revoke all on function public.advance_thread_memory_revision_seen(text, uuid, bigint) from public, anon, authenticated;
revoke all on function public.enqueue_thread_continuity_job(text, uuid, uuid, uuid, uuid, bigint, bigint, integer, integer, integer, text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.claim_thread_continuity_jobs(text, integer, integer) from public, anon, authenticated;
revoke all on function public.apply_thread_continuity_checkpoint(text, uuid, text, uuid, bigint, jsonb, text, bigint, uuid, timestamptz, uuid, uuid, uuid[], integer, integer, text, text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.invalidate_thread_continuity_checkpoint(text, uuid, text) from public, anon, authenticated;
revoke all on function public.finish_thread_continuity_job(text, uuid, text, text, text, text, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.advance_thread_memory_revision_seen(text, uuid, bigint) to service_role;
grant execute on function public.enqueue_thread_continuity_job(text, uuid, uuid, uuid, uuid, bigint, bigint, integer, integer, integer, text, text, text, text, boolean) to service_role;
grant execute on function public.claim_thread_continuity_jobs(text, integer, integer) to service_role;
grant execute on function public.apply_thread_continuity_checkpoint(text, uuid, text, uuid, bigint, jsonb, text, bigint, uuid, timestamptz, uuid, uuid, uuid[], integer, integer, text, text, text, text, uuid, text) to service_role;
grant execute on function public.invalidate_thread_continuity_checkpoint(text, uuid, text) to service_role;
grant execute on function public.finish_thread_continuity_job(text, uuid, text, text, text, text, boolean, timestamptz) to service_role;
