-- Milestone 3, Slice 3: governed canonical writes and durable consolidation.
-- This migration is additive to the memory foundation. All tables remain
-- server-only: RLS is enabled and browser roles receive no table access.

alter table public.memory_document_revisions
  add column if not exists idempotency_key text
  check (idempotency_key is null or char_length(idempotency_key) between 1 and 240);

create unique index if not exists memory_document_revisions_profile_idempotency_idx
  on public.memory_document_revisions(profile_id, idempotency_key)
  where idempotency_key is not null;

-- The original function signature is replaced so every caller uses the
-- idempotent form. Existing data is preserved; only the function definition
-- changes.
drop function if exists public.apply_memory_document_revision(text, text, text, text, bigint, text, uuid, uuid, uuid, uuid, text, jsonb);

create or replace function public.apply_memory_document_revision(
  p_profile_id text,
  p_logical_key text,
  p_content_markdown text,
  p_mutation_kind text,
  p_expected_document_revision bigint default null,
  p_source_kind text default 'manual',
  p_source_thread_id uuid default null,
  p_source_message_id uuid default null,
  p_source_agent_event_id uuid default null,
  p_source_agent_run_id uuid default null,
  p_source_excerpt text default null,
  p_source_metadata jsonb default '{}'::jsonb,
  p_idempotency_key text default null
)
returns table (
  profile_id text,
  document_id uuid,
  document_revision bigint,
  profile_global_revision bigint,
  revision_id uuid,
  provenance_id uuid
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  state_revision bigint;
  current_document public.memory_documents%rowtype;
  existing_revision record;
  next_document_revision bigint;
  next_global_revision bigint;
  new_document_id uuid;
  new_revision_id uuid;
  new_provenance_id uuid;
  normalized_key text := trim(coalesce(p_logical_key, ''));
  normalized_content text := coalesce(p_content_markdown, '');
  normalized_hash text := encode(digest(normalized_content, 'sha256'), 'hex');
  normalized_idempotency text := nullif(trim(coalesce(p_idempotency_key, '')), '');
begin
  if not exists (select 1 from public.profiles p where p.id = p_profile_id) then
    raise exception 'Unknown profile scope';
  end if;
  if normalized_key = '' or char_length(normalized_key) > 200 or normalized_key !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$' then
    raise exception 'Invalid canonical memory logical key';
  end if;
  if normalized_content = '' or char_length(normalized_content) > 500000 then
    raise exception 'Canonical memory content must be non-empty natural Markdown';
  end if;
  if p_mutation_kind not in ('create', 'update', 'archive', 'restore', 'merge') then
    raise exception 'Invalid canonical memory mutation';
  end if;
  if normalized_idempotency is not null and char_length(normalized_idempotency) > 240 then
    raise exception 'Canonical memory idempotency key is too long';
  end if;
  if p_source_kind not in ('message', 'thread', 'agent_event', 'manual', 'system') then
    raise exception 'Invalid memory provenance source';
  end if;
  if p_source_kind = 'message' and (p_source_message_id is null or p_source_thread_id is null) then
    raise exception 'Message provenance requires message and thread ownership';
  end if;
  if p_source_kind = 'thread' and p_source_thread_id is null then
    raise exception 'Thread provenance requires thread ownership';
  end if;
  if p_source_kind = 'agent_event' and (p_source_agent_event_id is null or p_source_agent_run_id is null or p_source_thread_id is null) then
    raise exception 'Agent-event provenance requires event, run, and thread ownership';
  end if;
  if p_source_kind in ('manual', 'system') and (p_source_message_id is not null or p_source_agent_event_id is not null) then
    raise exception 'Manual/system provenance cannot claim a message or event';
  end if;

  -- Exact retries return the original result without advancing either
  -- document or profile-global revision. Any mismatched replay is rejected.
  if normalized_idempotency is not null then
    select
      r.profile_id as existing_profile_id,
      r.document_id as existing_document_id,
      r.document_revision as existing_document_revision,
      r.profile_global_revision as existing_global_revision,
      r.id as existing_revision_id,
      r.content_hash as existing_content_hash,
      r.mutation_kind as existing_mutation_kind,
      d.logical_key as existing_logical_key,
      p.id as existing_provenance_id,
      p.source_kind as existing_source_kind,
      p.source_thread_id as existing_source_thread_id,
      p.source_message_id as existing_source_message_id,
      p.source_agent_event_id as existing_source_agent_event_id,
      p.source_agent_run_id as existing_source_agent_run_id,
      p.source_excerpt as existing_source_excerpt,
      p.metadata as existing_metadata
    into existing_revision
    from public.memory_document_revisions r
    join public.memory_documents d
      on d.id = r.document_id and d.profile_id = r.profile_id
    join public.memory_provenance p
      on p.document_revision_id = r.id and p.profile_id = r.profile_id
    where r.profile_id = p_profile_id and r.idempotency_key = normalized_idempotency
    limit 1;

    if found then
      if existing_revision.existing_logical_key is distinct from normalized_key
        or existing_revision.existing_content_hash is distinct from normalized_hash
        or existing_revision.existing_mutation_kind is distinct from p_mutation_kind
        or existing_revision.existing_source_kind is distinct from p_source_kind
        or existing_revision.existing_source_thread_id is distinct from p_source_thread_id
        or existing_revision.existing_source_message_id is distinct from p_source_message_id
        or existing_revision.existing_source_agent_event_id is distinct from p_source_agent_event_id
        or existing_revision.existing_source_agent_run_id is distinct from p_source_agent_run_id
        or existing_revision.existing_source_excerpt is distinct from left(p_source_excerpt, 2000)
        or existing_revision.existing_metadata is distinct from coalesce(p_source_metadata, '{}'::jsonb) then
        raise exception 'Canonical memory idempotency key replay mismatch';
      end if;
      return query select
        existing_revision.existing_profile_id,
        existing_revision.existing_document_id,
        existing_revision.existing_document_revision,
        existing_revision.existing_global_revision,
        existing_revision.existing_revision_id,
        existing_revision.existing_provenance_id;
      return;
    end if;
  end if;

  insert into public.profile_memory_state(profile_id)
  values (p_profile_id)
  on conflict do nothing;
  select current_revision into state_revision
  from public.profile_memory_state as state
  where state.profile_id = p_profile_id
  for update;

  select * into current_document
  from public.memory_documents as document
  where document.profile_id = p_profile_id
    and document.logical_key = normalized_key
    and (document.archived_at is null or p_mutation_kind = 'restore')
  for update;

  if not found then
    if p_mutation_kind not in ('create', 'archive') or p_expected_document_revision is not null then
      raise exception 'Stale canonical memory document revision';
    end if;
    new_document_id := gen_random_uuid();
    next_document_revision := 1;
    insert into public.memory_documents(id, profile_id, logical_key, content_markdown, document_revision, content_hash, archived_at)
    values (new_document_id, p_profile_id, normalized_key, normalized_content, next_document_revision, normalized_hash, case when p_mutation_kind = 'archive' then now() else null end);
  else
    if p_mutation_kind = 'create' then
      raise exception 'Canonical memory document already exists';
    end if;
    if p_mutation_kind not in ('archive', 'restore') and (p_expected_document_revision is null or p_expected_document_revision <> current_document.document_revision) then
      raise exception 'Stale canonical memory document revision';
    end if;
    new_document_id := current_document.id;
    next_document_revision := current_document.document_revision + 1;
    update public.memory_documents as memory_document
    set content_markdown = normalized_content,
        document_revision = next_document_revision,
        content_hash = normalized_hash,
        updated_at = now(),
        archived_at = case when p_mutation_kind = 'archive' then now() else null end
    where memory_document.id = current_document.id and memory_document.profile_id = p_profile_id;
  end if;

  next_global_revision := state_revision + 1;
  update public.profile_memory_state
  set current_revision = next_global_revision, updated_at = now()
  where public.profile_memory_state.profile_id = p_profile_id;

  insert into public.memory_document_revisions(
    profile_id, document_id, document_revision, profile_global_revision,
    content_markdown, content_hash, mutation_kind, idempotency_key
  ) values (
    p_profile_id, new_document_id, next_document_revision, next_global_revision,
    normalized_content, normalized_hash, p_mutation_kind, normalized_idempotency
  ) returning id into new_revision_id;

  insert into public.memory_provenance(
    profile_id, document_id, document_revision_id, source_kind,
    source_thread_id, source_message_id, source_agent_event_id, source_agent_run_id,
    source_excerpt, metadata
  ) values (
    p_profile_id, new_document_id, new_revision_id, p_source_kind,
    p_source_thread_id, p_source_message_id, p_source_agent_event_id, p_source_agent_run_id,
    left(p_source_excerpt, 2000), coalesce(p_source_metadata, '{}'::jsonb)
  ) returning id into new_provenance_id;

  return query select p_profile_id, new_document_id, next_document_revision, next_global_revision, new_revision_id, new_provenance_id;
end;
$$;

create table if not exists public.memory_consolidation_jobs (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  thread_id uuid not null,
  source_run_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed', 'skipped')),
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 10),
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
  constraint memory_consolidation_jobs_thread_fkey
    foreign key (thread_id, profile_id) references public.threads(id, profile_id) on delete cascade,
  constraint memory_consolidation_jobs_run_fkey
    foreign key (source_run_id, profile_id, thread_id) references public.agent_runs(id, profile_id, thread_id) on delete cascade
);

create index if not exists memory_consolidation_jobs_claim_idx
  on public.memory_consolidation_jobs(status, available_at, created_at);

create table if not exists public.memory_mutation_proposals (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  thread_id uuid not null,
  source_run_id uuid not null,
  job_id uuid not null,
  proposal_index integer not null check (proposal_index >= 0 and proposal_index < 20),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 240),
  logical_key text not null check (char_length(logical_key) between 1 and 200),
  proposed_content_markdown text not null check (char_length(proposed_content_markdown) between 1 and 500000),
  expected_document_revision bigint,
  mutation_kind text not null check (mutation_kind in ('create', 'update', 'merge')),
  source_message_ids uuid[] not null check (cardinality(source_message_ids) between 1 and 20),
  rationale text check (rationale is null or char_length(rationale) <= 500),
  status text not null default 'proposed' check (status in ('proposed', 'applied', 'rejected', 'conflict')),
  reason text check (reason is null or char_length(reason) <= 500),
  result_revision_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  applied_at timestamptz,
  unique (id, profile_id, job_id),
  unique (job_id, proposal_index),
  unique (profile_id, idempotency_key),
  constraint memory_mutation_proposals_job_fkey
    foreign key (job_id, profile_id, thread_id, source_run_id)
    references public.memory_consolidation_jobs(id, profile_id, thread_id, source_run_id)
    on delete cascade,
  constraint memory_mutation_proposals_result_revision_fkey
    foreign key (result_revision_id, profile_id)
    references public.memory_document_revisions(id, profile_id)
    on delete set null
);

create index if not exists memory_mutation_proposals_job_status_idx
  on public.memory_mutation_proposals(profile_id, job_id, status, proposal_index);

create or replace function public.validate_memory_proposal_sources()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  source_message_id uuid;
begin
  foreach source_message_id in array new.source_message_ids loop
    if not exists (
      select 1 from public.messages m
      where m.id = source_message_id
        and m.profile_id = new.profile_id
        and m.thread_id = new.thread_id
    ) then
      raise exception 'Memory proposal source message is outside the active profile/thread';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists memory_mutation_proposals_validate_sources on public.memory_mutation_proposals;
create trigger memory_mutation_proposals_validate_sources
before insert or update of profile_id, thread_id, source_message_ids on public.memory_mutation_proposals
for each row execute function public.validate_memory_proposal_sources();

create or replace function public.enqueue_memory_consolidation_job(
  p_profile_id text,
  p_thread_id uuid,
  p_source_run_id uuid
)
returns setof public.memory_consolidation_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.agent_runs r
    where r.id = p_source_run_id and r.profile_id = p_profile_id and r.thread_id = p_thread_id
      and r.status = 'completed' and r.assistant_message_id is not null
  ) then
    raise exception 'Only completed runs with persisted assistant messages can be consolidated';
  end if;

  return query
  insert into public.memory_consolidation_jobs(profile_id, thread_id, source_run_id)
  values (p_profile_id, p_thread_id, p_source_run_id)
  on conflict (profile_id, source_run_id) do update
    set updated_at = now()
  returning memory_consolidation_jobs.*;
end;
$$;

create or replace function public.claim_memory_consolidation_jobs(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 120
)
returns setof public.memory_consolidation_jobs
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select j.id, j.profile_id, j.thread_id, j.source_run_id
    from public.memory_consolidation_jobs j
    where (
      (j.status = 'pending' and j.available_at <= now())
      or (j.status = 'running' and j.lease_expires_at is not null and j.lease_expires_at <= now())
    )
      and j.attempts < 3
    order by j.available_at asc, j.created_at asc
    for update skip locked
    limit least(greatest(coalesce(p_limit, 1), 1), 3)
  )
  update public.memory_consolidation_jobs j
  set status = 'running',
      attempts = j.attempts + 1,
      locked_by = left(nullif(trim(coalesce(p_worker_id, '')), ''), 120),
      locked_at = now(),
      lease_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 15), 900)),
      updated_at = now()
  from candidates c
  where j.id = c.id and j.profile_id = c.profile_id and j.thread_id = c.thread_id and j.source_run_id = c.source_run_id
  returning j.*;
$$;

create or replace function public.finish_memory_consolidation_job(
  p_profile_id text,
  p_job_id uuid,
  p_worker_id text,
  p_status text,
  p_error_code text default null,
  p_error_message text default null,
  p_retry boolean default false,
  p_available_at timestamptz default null
)
returns setof public.memory_consolidation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  next_status text;
begin
  if p_status not in ('completed', 'failed', 'skipped') then
    raise exception 'Invalid consolidation completion status';
  end if;
  select case when p_retry and attempts < 3 then 'pending' else p_status end
    into next_status
  from public.memory_consolidation_jobs
  where id = p_job_id and profile_id = p_profile_id and locked_by = p_worker_id
  for update;
  if not found then raise exception 'Consolidation job lease not owned by worker'; end if;

  return query
  update public.memory_consolidation_jobs j
  set status = next_status,
      available_at = case when next_status = 'pending' then coalesce(p_available_at, now() + interval '30 seconds') else j.available_at end,
      lease_expires_at = null,
      locked_at = null,
      locked_by = null,
      last_error_code = case when p_error_code is null then null else left(p_error_code, 120) end,
      last_error_message = case when p_error_message is null then null else left(p_error_message, 500) end,
      completed_at = case when next_status in ('completed', 'skipped', 'failed') then now() else null end,
      updated_at = now()
  where j.id = p_job_id and j.profile_id = p_profile_id
  returning j.*;
end;
$$;

create or replace function public.apply_memory_mutation_proposal(
  p_profile_id text,
  p_job_id uuid,
  p_proposal_id uuid,
  p_worker_id text
)
returns table (
  status text,
  proposal_id uuid,
  document_id uuid,
  document_revision bigint,
  profile_global_revision bigint,
  revision_id uuid,
  provenance_id uuid,
  reason text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  proposal public.memory_mutation_proposals%rowtype;
  first_source_message_id uuid;
  applied record;
  conflict_reason text;
begin
  select * into proposal
  from public.memory_mutation_proposals
  where id = p_proposal_id and profile_id = p_profile_id and job_id = p_job_id
  for update;
  if not found then raise exception 'Memory mutation proposal not found'; end if;

  if proposal.status <> 'proposed' then
    return query
    select proposal.status,
      proposal.id,
      revision.document_id,
      revision.document_revision,
      revision.profile_global_revision,
      revision.id,
      provenance.id,
      proposal.reason
    from public.memory_document_revisions revision
    left join public.memory_provenance provenance
      on provenance.document_revision_id = revision.id
      and provenance.profile_id = revision.profile_id
    where revision.id = proposal.result_revision_id
      and revision.profile_id = proposal.profile_id;
    if not found then
      return query select proposal.status, proposal.id, null::uuid, null::bigint, null::bigint,
        proposal.result_revision_id, null::uuid, proposal.reason;
    end if;
    return;
  end if;
  if not exists (
    select 1 from public.memory_consolidation_jobs j
    where j.id = proposal.job_id and j.profile_id = proposal.profile_id and j.locked_by = p_worker_id
  ) then
    raise exception 'Consolidation job lease not owned by worker';
  end if;

  first_source_message_id := proposal.source_message_ids[1];
  begin
    select * into applied
    from public.apply_memory_document_revision(
      proposal.profile_id,
      proposal.logical_key,
      proposal.proposed_content_markdown,
      proposal.mutation_kind,
      proposal.expected_document_revision,
      'message',
      proposal.thread_id,
      first_source_message_id,
      null,
      null,
      proposal.rationale,
      jsonb_build_object('proposal_id', proposal.id, 'job_id', proposal.job_id, 'source_run_id', proposal.source_run_id),
      proposal.idempotency_key
    );
  exception when others then
    conflict_reason := left(sqlerrm, 500);
    if sqlerrm like 'Stale canonical%' or sqlerrm like 'Canonical memory document already exists%' then
      update public.memory_mutation_proposals
      set status = 'conflict', reason = conflict_reason, updated_at = now()
      where id = proposal.id and profile_id = proposal.profile_id;
      return query select 'conflict', proposal.id, null::uuid, null::bigint, null::bigint, null::uuid, null::uuid, conflict_reason;
      return;
    end if;
    raise;
  end;

  update public.memory_mutation_proposals
  set status = 'applied', result_revision_id = applied.revision_id, applied_at = now(), updated_at = now()
  where id = proposal.id and profile_id = proposal.profile_id;
  return query select 'applied', proposal.id, applied.document_id, applied.document_revision,
    applied.profile_global_revision, applied.revision_id, applied.provenance_id, null::text;
end;
$$;

alter table public.memory_consolidation_jobs enable row level security;
alter table public.memory_mutation_proposals enable row level security;
revoke all on table public.memory_consolidation_jobs from public, anon, authenticated;
revoke all on table public.memory_mutation_proposals from public, anon, authenticated;

revoke all on function public.apply_memory_document_revision(text, text, text, text, bigint, text, uuid, uuid, uuid, uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.apply_memory_document_revision(text, text, text, text, bigint, text, uuid, uuid, uuid, uuid, text, jsonb, text) to service_role;
revoke all on function public.enqueue_memory_consolidation_job(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.enqueue_memory_consolidation_job(text, uuid, uuid) to service_role;
revoke all on function public.claim_memory_consolidation_jobs(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_memory_consolidation_jobs(text, integer, integer) to service_role;
revoke all on function public.finish_memory_consolidation_job(text, uuid, text, text, text, text, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.finish_memory_consolidation_job(text, uuid, text, text, text, text, boolean, timestamptz) to service_role;
revoke all on function public.apply_memory_mutation_proposal(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.apply_memory_mutation_proposal(text, uuid, uuid, text) to service_role;
