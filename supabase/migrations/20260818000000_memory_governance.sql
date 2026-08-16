-- Milestone 3, Slice 1: governed structured-memory writes and durable jobs.
-- The queue is retained for later background consolidation; its proposals now
-- target structured memory items rather than Markdown documents.

alter table public.memory_item_revisions
  add column if not exists idempotency_key text
  check (idempotency_key is null or char_length(idempotency_key) between 1 and 240);
create unique index if not exists memory_item_revisions_profile_idempotency_idx
  on public.memory_item_revisions(profile_id, idempotency_key)
  where idempotency_key is not null;

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
  canonical_key text not null check (char_length(canonical_key) between 1 and 200),
  proposed_content text not null check (char_length(proposed_content) between 1 and 500000),
  category public.memory_item_category not null default 'other',
  value_scope public.memory_item_value_scope not null default 'single',
  origin public.memory_item_origin not null default 'inferred',
  confidence numeric(4,3) not null default 0.5 check (confidence >= 0 and confidence <= 1),
  importance numeric(4,3) not null default 0.5 check (importance >= 0 and importance <= 1),
  sensitivity text not null default 'normal' check (sensitivity in ('normal', 'sensitive', 'highly_sensitive')),
  expected_item_revision bigint,
  mutation_kind text not null check (mutation_kind in ('create', 'update', 'supersede', 'merge')),
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
    references public.memory_consolidation_jobs(id, profile_id, thread_id, source_run_id) on delete cascade,
  constraint memory_mutation_proposals_result_revision_fkey
    foreign key (result_revision_id, profile_id)
    references public.memory_item_revisions(id, profile_id) on delete set null
);
create index if not exists memory_mutation_proposals_job_status_idx
  on public.memory_mutation_proposals(profile_id, job_id, status, proposal_index);

create or replace function public.validate_memory_proposal_sources()
returns trigger language plpgsql security definer set search_path = public as $$
declare source_message_id uuid;
begin
  foreach source_message_id in array new.source_message_ids loop
    if not exists (select 1 from public.messages m where m.id = source_message_id and m.profile_id = new.profile_id and m.thread_id = new.thread_id) then
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

create or replace function public.enqueue_memory_consolidation_job(p_profile_id text, p_thread_id uuid, p_source_run_id uuid)
returns setof public.memory_consolidation_jobs language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.agent_runs r where r.id = p_source_run_id and r.profile_id = p_profile_id and r.thread_id = p_thread_id and r.status = 'completed' and r.assistant_message_id is not null) then
    raise exception 'Only completed runs with persisted assistant messages can be consolidated';
  end if;
  return query insert into public.memory_consolidation_jobs(profile_id, thread_id, source_run_id)
    values (p_profile_id, p_thread_id, p_source_run_id)
    on conflict (profile_id, source_run_id) do update set updated_at = now()
    returning memory_consolidation_jobs.*;
end;
$$;

create or replace function public.claim_memory_consolidation_jobs(p_worker_id text, p_limit integer default 1, p_lease_seconds integer default 120)
returns setof public.memory_consolidation_jobs language sql security definer set search_path = public as $$
  with candidates as (
    select j.id, j.profile_id, j.thread_id, j.source_run_id from public.memory_consolidation_jobs j
    where ((j.status = 'pending' and j.available_at <= now()) or (j.status = 'running' and j.lease_expires_at is not null and j.lease_expires_at <= now()))
      and j.attempts < 3 order by j.available_at asc, j.created_at asc for update skip locked limit least(greatest(coalesce(p_limit, 1), 1), 3)
  )
  update public.memory_consolidation_jobs j set status = 'running', attempts = j.attempts + 1,
    locked_by = left(nullif(trim(coalesce(p_worker_id, '')), ''), 120), locked_at = now(),
    lease_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 15), 900)), updated_at = now()
  from candidates c where j.id = c.id and j.profile_id = c.profile_id and j.thread_id = c.thread_id and j.source_run_id = c.source_run_id returning j.*;
$$;

create or replace function public.finish_memory_consolidation_job(
  p_profile_id text, p_job_id uuid, p_worker_id text, p_status text, p_error_code text default null,
  p_error_message text default null, p_retry boolean default false, p_available_at timestamptz default null
)
returns setof public.memory_consolidation_jobs language plpgsql security definer set search_path = public as $$
declare next_status text;
begin
  if p_status not in ('completed', 'failed', 'skipped') then raise exception 'Invalid consolidation completion status'; end if;
  select case when p_retry and attempts < 3 then 'pending' else p_status end into next_status
  from public.memory_consolidation_jobs where id = p_job_id and profile_id = p_profile_id and locked_by = p_worker_id for update;
  if not found then raise exception 'Consolidation job lease not owned by worker'; end if;
  return query update public.memory_consolidation_jobs j set status = next_status,
    available_at = case when next_status = 'pending' then coalesce(p_available_at, now() + interval '30 seconds') else j.available_at end,
    lease_expires_at = null, locked_at = null, locked_by = null,
    last_error_code = case when p_error_code is null then null else left(p_error_code, 120) end,
    last_error_message = case when p_error_message is null then null else left(p_error_message, 500) end,
    completed_at = case when next_status in ('completed', 'skipped', 'failed') then now() else null end, updated_at = now()
  where j.id = p_job_id and j.profile_id = p_profile_id returning j.*;
end;
$$;

create or replace function public.apply_memory_mutation_proposal(p_profile_id text, p_job_id uuid, p_proposal_id uuid, p_worker_id text)
returns table (status text, proposal_id uuid, item_id uuid, item_revision bigint, profile_global_revision bigint,
  revision_id uuid, source_id uuid, reason text)
language plpgsql security definer set search_path = public, extensions as $$
declare proposal public.memory_mutation_proposals%rowtype; first_source_message_id uuid; applied record; conflict_reason text;
begin
  select * into proposal from public.memory_mutation_proposals where id = p_proposal_id and profile_id = p_profile_id and job_id = p_job_id for update;
  if not found then raise exception 'Memory mutation proposal not found'; end if;
  if proposal.status <> 'proposed' then
    return query select proposal.status, proposal.id, revision.item_id, revision.item_revision, revision.profile_global_revision,
      revision.id, source.id, proposal.reason
    from public.memory_item_revisions revision left join public.memory_item_sources source
      on source.revision_id = revision.id and source.profile_id = revision.profile_id
    where revision.id = proposal.result_revision_id and revision.profile_id = proposal.profile_id;
    if not found then return query select proposal.status, proposal.id, null::uuid, null::bigint, null::bigint, proposal.result_revision_id, null::uuid, proposal.reason; end if;
    return;
  end if;
  if not exists (select 1 from public.memory_consolidation_jobs j where j.id = proposal.job_id and j.profile_id = proposal.profile_id and j.locked_by = p_worker_id) then raise exception 'Consolidation job lease not owned by worker'; end if;
  first_source_message_id := proposal.source_message_ids[1];
  begin
    select * into applied from public.apply_memory_item_revision(proposal.profile_id, proposal.canonical_key, proposal.proposed_content,
      proposal.category, proposal.value_scope, proposal.origin, proposal.confidence, proposal.importance, proposal.sensitivity, 'active', proposal.mutation_kind,
      proposal.expected_item_revision, 'message', proposal.thread_id, first_source_message_id, null, null, proposal.rationale,
      jsonb_build_object('proposal_id', proposal.id, 'job_id', proposal.job_id, 'source_run_id', proposal.source_run_id,
        'source_message_ids', to_jsonb(proposal.source_message_ids),
        'relation', case when proposal.mutation_kind = 'supersede' then 'corrects' else 'derived' end), proposal.idempotency_key);
    -- The revision RPC records the first source. Preserve every source message
    -- from the governed proposal against the same immutable revision so exact
    -- provenance is never reduced to a summary or a single representative hit.
    foreach first_source_message_id in array proposal.source_message_ids[2:array_length(proposal.source_message_ids, 1)] loop
      insert into public.memory_item_sources(profile_id, item_id, revision_id, source_kind, source_thread_id, source_message_id, metadata)
      values (proposal.profile_id, applied.item_id, applied.revision_id, 'message', proposal.thread_id, first_source_message_id,
        jsonb_build_object('proposal_id', proposal.id, 'job_id', proposal.job_id, 'source_run_id', proposal.source_run_id,
          'relation', case when proposal.mutation_kind = 'supersede' then 'corrects' else 'derived' end));
    end loop;
  exception when others then
    conflict_reason := left(sqlerrm, 500);
    if sqlerrm like 'Stale memory%' or sqlerrm like 'Memory item already exists%' or sqlerrm like 'Memory idempotency%' then
      update public.memory_mutation_proposals set status = 'conflict', reason = conflict_reason, updated_at = now() where id = proposal.id and profile_id = proposal.profile_id;
      return query select 'conflict', proposal.id, null::uuid, null::bigint, null::bigint, null::uuid, null::uuid, conflict_reason; return;
    end if;
    raise;
  end;
  update public.memory_mutation_proposals set status = 'applied', result_revision_id = applied.revision_id, applied_at = now(), updated_at = now() where id = proposal.id and profile_id = proposal.profile_id;
  return query select 'applied', proposal.id, applied.item_id, applied.item_revision, applied.profile_global_revision, applied.revision_id, applied.source_id, null::text;
end;
$$;

alter table public.memory_consolidation_jobs enable row level security;
alter table public.memory_mutation_proposals enable row level security;
revoke all on table public.memory_consolidation_jobs from public, anon, authenticated;
revoke all on table public.memory_mutation_proposals from public, anon, authenticated;
revoke all on function public.enqueue_memory_consolidation_job(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_memory_consolidation_jobs(text, integer, integer) from public, anon, authenticated;
revoke all on function public.finish_memory_consolidation_job(text, uuid, text, text, text, text, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.apply_memory_mutation_proposal(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.enqueue_memory_consolidation_job(text, uuid, uuid) to service_role;
grant execute on function public.claim_memory_consolidation_jobs(text, integer, integer) to service_role;
grant execute on function public.finish_memory_consolidation_job(text, uuid, text, text, text, text, boolean, timestamptz) to service_role;
grant execute on function public.apply_memory_mutation_proposal(text, uuid, uuid, text) to service_role;
