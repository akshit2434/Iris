-- Milestone 3, Slice 1: structured memory authority and replaceable retrieval.
--
-- Raw messages remain immutable source history. `memory_items` is the current
-- structured authority. Markdown is generated at the context boundary; it is
-- never stored as the authoritative representation of a memory item.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

create table if not exists public.profile_memory_state (
  profile_id text primary key references public.profiles(id) on delete cascade,
  current_revision bigint not null default 0 check (current_revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create type public.memory_item_category as enum (
  'personal_fact', 'preference', 'instruction', 'project', 'goal',
  'relationship', 'active_state', 'pattern', 'other'
);
create type public.memory_item_value_scope as enum ('single', 'multi');
create type public.memory_item_origin as enum ('explicit', 'inferred', 'system');
create type public.memory_item_status as enum ('active', 'superseded', 'archived', 'deleted');

create table if not exists public.memory_items (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  canonical_key text not null check (char_length(canonical_key) between 1 and 200),
  content text not null check (char_length(content) between 1 and 500000 and content !~ E'\\u0000'),
  item_revision bigint not null default 0 check (item_revision >= 0),
  category public.memory_item_category not null default 'other',
  value_scope public.memory_item_value_scope not null default 'single',
  origin public.memory_item_origin not null default 'inferred',
  confidence numeric(4,3) not null default 0.5 check (confidence >= 0 and confidence <= 1),
  importance numeric(4,3) not null default 0.5 check (importance >= 0 and importance <= 1),
  sensitivity text not null default 'normal' check (sensitivity in ('normal', 'sensitive', 'highly_sensitive')),
  status public.memory_item_status not null default 'active',
  valid_from timestamptz,
  valid_until timestamptz,
  last_confirmed_at timestamptz,
  superseded_by_item_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  unique (id, profile_id),
  constraint memory_items_superseded_by_profile_fkey
    foreign key (superseded_by_item_id, profile_id)
    references public.memory_items(id, profile_id) on delete restrict,
  constraint memory_items_validity_check
    check (valid_until is null or valid_from is null or valid_until > valid_from),
  constraint memory_items_lifecycle_timestamps_check
    check (
      (status = 'active' and archived_at is null and deleted_at is null)
      or (status = 'superseded' and archived_at is null and deleted_at is null)
      or (status = 'archived' and archived_at is not null and deleted_at is null)
      or (status = 'deleted' and archived_at is null and deleted_at is not null)
    )
);

-- A singleton key has at most one active current value per profile. Multi-value
-- keys may have several active rows and should use distinct canonical keys when
-- independent provenance or lifecycle control is needed.
create unique index if not exists memory_items_profile_single_active_idx
  on public.memory_items(profile_id, canonical_key)
  where status = 'active' and value_scope = 'single';
create index if not exists memory_items_profile_active_updated_idx
  on public.memory_items(profile_id, status, updated_at desc);
create index if not exists memory_items_profile_key_idx
  on public.memory_items(profile_id, canonical_key, updated_at desc);

create table if not exists public.memory_item_revisions (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  item_id uuid not null,
  item_revision bigint not null check (item_revision > 0),
  profile_global_revision bigint not null check (profile_global_revision > 0),
  canonical_key text not null check (char_length(canonical_key) between 1 and 200),
  content text not null check (char_length(content) between 1 and 500000 and content !~ E'\\u0000'),
  content_hash text not null check (content_hash = encode(digest(content, 'sha256'), 'hex')),
  category public.memory_item_category not null,
  value_scope public.memory_item_value_scope not null,
  origin public.memory_item_origin not null,
  confidence numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  importance numeric(4,3) not null check (importance >= 0 and importance <= 1),
  sensitivity text not null check (sensitivity in ('normal', 'sensitive', 'highly_sensitive')),
  status public.memory_item_status not null,
  valid_from timestamptz,
  valid_until timestamptz,
  last_confirmed_at timestamptz,
  superseded_by_item_id uuid,
  mutation_kind text not null check (mutation_kind in ('create', 'update', 'supersede', 'archive', 'restore', 'delete', 'merge')),
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 1 and 240),
  created_at timestamptz not null default now(),
  unique (id, profile_id),
  unique (item_id, profile_id, item_revision),
  unique (profile_id, profile_global_revision),
  constraint memory_item_revisions_item_fkey
    foreign key (item_id, profile_id)
    references public.memory_items(id, profile_id) on delete restrict,
  constraint memory_item_revisions_superseded_by_profile_fkey
    foreign key (superseded_by_item_id, profile_id)
    references public.memory_items(id, profile_id) on delete restrict,
  constraint memory_item_revisions_validity_check
    check (valid_until is null or valid_from is null or valid_until > valid_from)
);

-- Revisions are the audit ledger. All mutations go through the revision RPC;
-- no caller, including service_role, may rewrite or delete an existing row.
create or replace function public.prevent_memory_item_revision_mutation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Memory item revisions are immutable';
end;
$$;
drop trigger if exists memory_item_revisions_immutable on public.memory_item_revisions;
create trigger memory_item_revisions_immutable
before update or delete on public.memory_item_revisions
for each row execute function public.prevent_memory_item_revision_mutation();

create index if not exists memory_item_revisions_profile_created_idx
  on public.memory_item_revisions(profile_id, created_at desc);
create unique index if not exists memory_item_revisions_profile_idempotency_idx
  on public.memory_item_revisions(profile_id, idempotency_key)
  where idempotency_key is not null;

create table if not exists public.memory_item_sources (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  item_id uuid not null,
  revision_id uuid not null,
  source_kind text not null check (source_kind in ('message', 'thread', 'agent_event', 'manual', 'system')),
  source_thread_id uuid,
  source_message_id uuid,
  source_agent_event_id uuid,
  source_agent_run_id uuid,
  source_excerpt text check (source_excerpt is null or char_length(source_excerpt) <= 2000),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, profile_id),
  constraint memory_item_sources_item_fkey
    foreign key (item_id, profile_id)
    references public.memory_items(id, profile_id) on delete restrict,
  constraint memory_item_sources_revision_fkey
    foreign key (revision_id, profile_id)
    references public.memory_item_revisions(id, profile_id) on delete restrict,
  constraint memory_item_sources_thread_fkey
    foreign key (source_thread_id, profile_id)
    references public.threads(id, profile_id) on delete restrict,
  constraint memory_item_sources_message_fkey
    foreign key (source_message_id, profile_id, source_thread_id)
    references public.messages(id, profile_id, thread_id) on delete restrict,
  constraint memory_item_sources_agent_event_fkey
    foreign key (source_agent_event_id, profile_id, source_thread_id, source_agent_run_id)
    references public.agent_events(id, profile_id, thread_id, run_id) on delete restrict,
  check ((source_message_id is null) or source_thread_id is not null),
  check ((source_agent_event_id is null) = (source_agent_run_id is null)),
  check ((source_agent_event_id is null) or source_thread_id is not null)
);
create index if not exists memory_item_sources_profile_item_idx
  on public.memory_item_sources(profile_id, item_id, created_at desc);
create index if not exists memory_item_sources_profile_revision_idx
  on public.memory_item_sources(profile_id, revision_id, created_at asc);

create or replace function public.prevent_memory_item_source_mutation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Memory item sources are immutable';
end;
$$;
drop trigger if exists memory_item_sources_immutable on public.memory_item_sources;
create trigger memory_item_sources_immutable
before update or delete on public.memory_item_sources
for each row execute function public.prevent_memory_item_source_mutation();

-- A suppression is a durable instruction to the derivation pipeline. It keeps
-- a forgotten item from being recreated from the same old source until the
-- user explicitly lifts it or writes the item again.
create table if not exists public.memory_suppressions (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  canonical_key text not null check (char_length(canonical_key) between 1 and 200),
  content_hash text check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  item_id uuid,
  reason text not null default 'User requested this memory be forgotten' check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default now(),
  lifted_at timestamptz,
  unique (id, profile_id),
  constraint memory_suppressions_item_fkey
    foreign key (item_id, profile_id)
    references public.memory_items(id, profile_id) on delete set null
);
create unique index if not exists memory_suppressions_profile_key_active_idx
  on public.memory_suppressions(profile_id, canonical_key, coalesce(content_hash, ''))
  where lifted_at is null;
create index if not exists memory_suppressions_profile_active_idx
  on public.memory_suppressions(profile_id, created_at desc)
  where lifted_at is null;

-- Derived and replaceable semantic message index. It intentionally stores no
-- message content; raw messages remain the source transcript.
create table if not exists public.message_semantic_index (
  message_id uuid primary key,
  profile_id text not null references public.profiles(id) on delete cascade,
  thread_id uuid not null,
  embedding extensions.vector(1536),
  embedding_model text,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  indexed_at timestamptz not null default now(),
  unique (message_id, profile_id, thread_id),
  constraint message_semantic_index_message_fkey
    foreign key (message_id, profile_id, thread_id)
    references public.messages(id, profile_id, thread_id) on delete cascade,
  check ((embedding is null) or embedding_model is not null),
  check ((embedding is null) or embedding_model <> '')
);

alter table public.messages
  add column if not exists search_vector tsvector
  generated always as (to_tsvector('simple'::regconfig, coalesce(content, ''))) stored;
create index if not exists messages_search_vector_gin_idx
  on public.messages using gin(search_vector);
create index if not exists message_semantic_index_embedding_hnsw_idx
  on public.message_semantic_index using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;
create index if not exists message_semantic_index_profile_thread_idx
  on public.message_semantic_index(profile_id, thread_id, indexed_at desc);

insert into public.profile_memory_state(profile_id)
select id from public.profiles on conflict (profile_id) do nothing;

create or replace function public.ensure_profile_memory_state()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profile_memory_state(profile_id) values (new.id) on conflict (profile_id) do nothing;
  return new;
end;
$$;
drop trigger if exists profiles_memory_state_after_insert on public.profiles;
create trigger profiles_memory_state_after_insert after insert on public.profiles
for each row execute function public.ensure_profile_memory_state();

create or replace function public.search_messages(
  p_profile_id text, p_query text default '', p_query_embedding extensions.vector(1536) default null,
  p_thread_id uuid default null, p_from timestamptz default null, p_to timestamptz default null,
  p_limit integer default 20
)
returns table (message_id uuid, thread_id uuid, profile_id text, role text, content text,
  created_at timestamptz, lexical_score real, semantic_score real, combined_score double precision)
language plpgsql security definer set search_path = public, extensions as $$
declare bounded_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
begin
  if not exists (select 1 from public.profiles p where p.id = p_profile_id) then raise exception 'Unknown profile scope'; end if;
  if nullif(trim(coalesce(p_query, '')), '') is null and p_query_embedding is null then return; end if;
  return query
  with query_terms as (
    select case when nullif(trim(coalesce(p_query, '')), '') is null then null::tsquery
      else websearch_to_tsquery('simple'::regconfig, p_query) end as query
  ), candidates as (
    select m.id as message_id, m.thread_id, m.profile_id, m.role, m.content, m.created_at,
      case when query_terms.query is not null then ts_rank_cd(m.search_vector, query_terms.query) else 0::real end as lexical_score,
      case when p_query_embedding is not null and si.embedding is not null then (1 - (si.embedding <=> p_query_embedding))::real else null::real end as semantic_score
    from public.messages m cross join query_terms
    left join public.message_semantic_index si on si.message_id = m.id and si.profile_id = m.profile_id and si.thread_id = m.thread_id
    where m.profile_id = p_profile_id and (p_thread_id is null or m.thread_id = p_thread_id)
      and (p_from is null or m.created_at >= p_from) and (p_to is null or m.created_at < p_to)
      and ((query_terms.query is not null and m.search_vector @@ query_terms.query) or (p_query_embedding is not null and si.embedding is not null))
  ), ranked as (
    select candidates.*, row_number() over (order by candidates.lexical_score desc, candidates.created_at desc, candidates.message_id) as lexical_rank,
      row_number() over (order by candidates.semantic_score desc nulls last, candidates.created_at desc, candidates.message_id) as semantic_rank
    from candidates
  )
  select ranked.message_id, ranked.thread_id, ranked.profile_id, ranked.role, ranked.content, ranked.created_at,
    ranked.lexical_score, ranked.semantic_score,
    (case when ranked.lexical_score > 0 then 0.55::double precision / (60::double precision + ranked.lexical_rank::double precision) else 0::double precision end)
    + (case when ranked.semantic_score is not null then 0.45::double precision / (60::double precision + ranked.semantic_rank::double precision) else 0::double precision end)
  from ranked order by combined_score desc, ranked.created_at desc, ranked.message_id limit bounded_limit;
end;
$$;

create or replace function public.apply_memory_item_revision(
  p_profile_id text, p_canonical_key text, p_content text,
  p_category public.memory_item_category default 'other', p_value_scope public.memory_item_value_scope default 'single',
  p_origin public.memory_item_origin default 'inferred', p_confidence numeric default 0.5, p_importance numeric default 0.5,
  p_sensitivity text default 'normal', p_status public.memory_item_status default 'active', p_mutation_kind text default 'create',
  p_expected_item_revision bigint default null, p_source_kind text default 'manual', p_source_thread_id uuid default null,
  p_source_message_id uuid default null, p_source_agent_event_id uuid default null, p_source_agent_run_id uuid default null,
  p_source_excerpt text default null, p_source_metadata jsonb default '{}'::jsonb, p_idempotency_key text default null,
  p_superseded_by_item_id uuid default null
)
returns table (profile_id text, item_id uuid, canonical_key text, item_revision bigint, profile_global_revision bigint,
  revision_id uuid, source_id uuid, content_hash text)
language plpgsql security definer set search_path = public, extensions as $$
declare
  state_revision bigint; current_item public.memory_items%rowtype; existing_revision record;
  next_item_revision bigint; next_global_revision bigint; new_item_id uuid; new_revision_id uuid; new_source_id uuid;
  normalized_key text := trim(coalesce(p_canonical_key, '')); normalized_content text := trim(coalesce(p_content, ''));
  normalized_hash text := encode(digest(normalized_content, 'sha256'), 'hex');
  normalized_idempotency text := nullif(trim(coalesce(p_idempotency_key, '')), '');
begin
  if not exists (select 1 from public.profiles p where p.id = p_profile_id) then raise exception 'Unknown profile scope'; end if;
  if normalized_key = '' or char_length(normalized_key) > 200 or normalized_key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' then raise exception 'Invalid memory canonical key'; end if;
  if normalized_content = '' or char_length(normalized_content) > 500000 or normalized_content ~ E'\\u0000' then raise exception 'Memory content must be non-empty natural language'; end if;
  if p_confidence is null or p_confidence < 0 or p_confidence > 1 or p_importance is null or p_importance < 0 or p_importance > 1 then raise exception 'Memory confidence and importance must be between 0 and 1'; end if;
  if p_sensitivity not in ('normal', 'sensitive', 'highly_sensitive') then raise exception 'Invalid memory sensitivity'; end if;
  if p_mutation_kind not in ('create', 'update', 'supersede', 'archive', 'restore', 'delete', 'merge') then raise exception 'Invalid memory mutation'; end if;
  if normalized_idempotency is not null and char_length(normalized_idempotency) > 240 then raise exception 'Memory idempotency key is too long'; end if;
  if p_source_kind not in ('message', 'thread', 'agent_event', 'manual', 'system') then raise exception 'Invalid memory provenance source'; end if;
  if p_source_kind = 'message' and (p_source_message_id is null or p_source_thread_id is null) then raise exception 'Message provenance requires message and thread ownership'; end if;
  if p_source_kind = 'thread' and p_source_thread_id is null then raise exception 'Thread provenance requires thread ownership'; end if;
  if p_source_kind = 'agent_event' and (p_source_agent_event_id is null or p_source_agent_run_id is null or p_source_thread_id is null) then raise exception 'Agent-event provenance requires event, run, and thread ownership'; end if;
  if p_source_kind in ('manual', 'system') and (p_source_message_id is not null or p_source_agent_event_id is not null) then raise exception 'Manual/system provenance cannot claim a message or event'; end if;
  if p_source_excerpt is not null and char_length(p_source_excerpt) > 2000 then raise exception 'Memory source excerpts are limited to 2,000 characters'; end if;
  if p_superseded_by_item_id is not null and not exists (select 1 from public.memory_items target where target.id = p_superseded_by_item_id and target.profile_id = p_profile_id) then raise exception 'Superseded memory target is outside the active profile'; end if;

  if normalized_idempotency is not null then
    select r.profile_id, r.item_id, i.canonical_key, r.item_revision, r.profile_global_revision,
      r.id as revision_id, s.id as source_id, r.content_hash, r.category, r.value_scope, r.origin,
      r.confidence, r.importance, r.sensitivity, r.status, r.superseded_by_item_id, r.mutation_kind,
      s.source_kind, s.source_thread_id, s.source_message_id, s.source_agent_event_id, s.source_agent_run_id,
      s.source_excerpt, s.metadata
    into existing_revision
    from public.memory_item_revisions r
    join public.memory_items i on i.id = r.item_id and i.profile_id = r.profile_id
    join public.memory_item_sources s on s.revision_id = r.id and s.profile_id = r.profile_id
    where r.profile_id = p_profile_id and r.idempotency_key = normalized_idempotency limit 1;
    if found then
      if existing_revision.canonical_key is distinct from normalized_key
        or existing_revision.content_hash is distinct from normalized_hash
        or existing_revision.category is distinct from p_category
        or existing_revision.value_scope is distinct from p_value_scope
        or existing_revision.origin is distinct from p_origin
        or existing_revision.confidence is distinct from p_confidence
        or existing_revision.importance is distinct from p_importance
        or existing_revision.sensitivity is distinct from p_sensitivity
        or existing_revision.status is distinct from p_status
        or existing_revision.superseded_by_item_id is distinct from p_superseded_by_item_id
        or existing_revision.mutation_kind is distinct from p_mutation_kind
        or existing_revision.source_kind is distinct from p_source_kind
        or existing_revision.source_thread_id is distinct from p_source_thread_id
        or existing_revision.source_message_id is distinct from p_source_message_id
        or existing_revision.source_agent_event_id is distinct from p_source_agent_event_id
        or existing_revision.source_agent_run_id is distinct from p_source_agent_run_id
        or existing_revision.source_excerpt is distinct from left(p_source_excerpt, 2000)
        or existing_revision.metadata is distinct from coalesce(p_source_metadata, '{}'::jsonb)
      then raise exception 'Memory idempotency key replay mismatch'; end if;
      return query select existing_revision.profile_id, existing_revision.item_id, existing_revision.canonical_key, existing_revision.item_revision,
        existing_revision.profile_global_revision, existing_revision.revision_id, existing_revision.source_id, existing_revision.content_hash;
      return;
    end if;
  end if;

  insert into public.profile_memory_state(profile_id) values (p_profile_id) on conflict do nothing;
  select state.current_revision into state_revision from public.profile_memory_state as state where state.profile_id = p_profile_id for update;
  select * into current_item from public.memory_items i
  where i.profile_id = p_profile_id and i.canonical_key = normalized_key and i.status in ('active', 'superseded', 'archived')
  order by case when i.status = 'active' then 0 else 1 end, i.updated_at desc limit 1 for update;

  if not found then
    if p_mutation_kind not in ('create', 'restore') or p_expected_item_revision is not null then raise exception 'Stale memory item revision'; end if;
    new_item_id := gen_random_uuid(); next_item_revision := 1;
    insert into public.memory_items(id, profile_id, canonical_key, content, item_revision, category, value_scope, origin, confidence, importance, sensitivity, status, last_confirmed_at, superseded_by_item_id, archived_at, deleted_at)
    values (new_item_id, p_profile_id, normalized_key, normalized_content, next_item_revision, p_category, p_value_scope, p_origin, p_confidence, p_importance, p_sensitivity, p_status,
      case when p_origin = 'explicit' then now() else null end, p_superseded_by_item_id, case when p_status = 'archived' then now() else null end, case when p_status = 'deleted' then now() else null end);
  else
    if p_mutation_kind = 'create' then raise exception 'Memory item already exists'; end if;
    if p_expected_item_revision is null or p_expected_item_revision <> current_item.item_revision then raise exception 'Stale memory item revision'; end if;
    new_item_id := current_item.id; next_item_revision := current_item.item_revision + 1;
    update public.memory_items i set canonical_key = normalized_key, content = normalized_content, category = p_category,
      value_scope = p_value_scope, origin = p_origin, confidence = p_confidence, importance = p_importance, sensitivity = p_sensitivity,
      item_revision = next_item_revision, status = p_status, updated_at = now(), archived_at = case when p_status = 'archived' then coalesce(i.archived_at, now()) else null end,
      deleted_at = case when p_status = 'deleted' then coalesce(i.deleted_at, now()) else null end,
      last_confirmed_at = case when p_origin = 'explicit' then now() else i.last_confirmed_at end,
      superseded_by_item_id = p_superseded_by_item_id
    where i.id = current_item.id and i.profile_id = p_profile_id;
  end if;

  next_global_revision := state_revision + 1;
  update public.profile_memory_state as state set current_revision = next_global_revision, updated_at = now() where state.profile_id = p_profile_id;
  insert into public.memory_item_revisions(profile_id, item_id, item_revision, profile_global_revision, canonical_key, content, content_hash,
    category, value_scope, origin, confidence, importance, sensitivity, status, superseded_by_item_id, mutation_kind, idempotency_key)
  values (p_profile_id, new_item_id, next_item_revision, next_global_revision, normalized_key, normalized_content, normalized_hash,
    p_category, p_value_scope, p_origin, p_confidence, p_importance, p_sensitivity, p_status, p_superseded_by_item_id, p_mutation_kind, normalized_idempotency)
  returning id into new_revision_id;
  insert into public.memory_item_sources(profile_id, item_id, revision_id, source_kind, source_thread_id, source_message_id,
    source_agent_event_id, source_agent_run_id, source_excerpt, metadata)
  values (p_profile_id, new_item_id, new_revision_id, p_source_kind, p_source_thread_id, p_source_message_id,
    p_source_agent_event_id, p_source_agent_run_id, left(p_source_excerpt, 2000), coalesce(p_source_metadata, '{}'::jsonb))
  returning id into new_source_id;
  if p_status = 'archived' then
    update public.memory_suppressions as suppression set reason = left(coalesce(nullif(trim(p_source_excerpt), ''), 'User requested this memory be forgotten'), 500), item_id = new_item_id
    where suppression.profile_id = p_profile_id and suppression.canonical_key = normalized_key
      and suppression.content_hash = normalized_hash and suppression.lifted_at is null;
    if not found then
      insert into public.memory_suppressions(profile_id, canonical_key, content_hash, item_id, reason)
      values (p_profile_id, normalized_key, normalized_hash, new_item_id, left(coalesce(nullif(trim(p_source_excerpt), ''), 'User requested this memory be forgotten'), 500));
    end if;
  elsif p_origin = 'explicit' and p_status = 'active' then
    update public.memory_suppressions set lifted_at = now()
    where public.memory_suppressions.profile_id = p_profile_id and public.memory_suppressions.canonical_key = normalized_key and public.memory_suppressions.lifted_at is null;
  end if;
  return query select p_profile_id, new_item_id, normalized_key, next_item_revision, next_global_revision, new_revision_id, new_source_id, normalized_hash;
end;
$$;

create or replace function public.create_memory_suppression(
  p_profile_id text, p_canonical_key text, p_content_hash text default null, p_item_id uuid default null,
  p_reason text default 'User requested this memory be forgotten'
)
returns uuid language plpgsql security definer set search_path = public as $$
declare suppression_id uuid;
begin
  if not exists (select 1 from public.profiles p where p.id = p_profile_id) then raise exception 'Unknown profile scope'; end if;
  if trim(coalesce(p_canonical_key, '')) = '' or char_length(trim(p_canonical_key)) > 200 then raise exception 'Invalid suppression canonical key'; end if;
  if p_content_hash is not null and p_content_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid suppression content hash'; end if;
  insert into public.memory_suppressions(profile_id, canonical_key, content_hash, item_id, reason)
  values (p_profile_id, trim(p_canonical_key), p_content_hash, p_item_id, left(coalesce(nullif(trim(p_reason), ''), 'User requested this memory be forgotten'), 500))
  on conflict (profile_id, canonical_key, coalesce(content_hash, '')) where lifted_at is null do update set reason = excluded.reason
  returning id into suppression_id;
  return suppression_id;
end;
$$;

create or replace function public.lift_memory_suppression(p_profile_id text, p_canonical_key text, p_content_hash text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare updated_count integer;
begin
  update public.memory_suppressions set lifted_at = now()
  where profile_id = p_profile_id and canonical_key = trim(p_canonical_key) and lifted_at is null
    and (p_content_hash is null or content_hash is null or content_hash = p_content_hash);
  get diagnostics updated_count = row_count; return updated_count;
end;
$$;

alter table public.profile_memory_state enable row level security;
alter table public.memory_items enable row level security;
alter table public.memory_item_revisions enable row level security;
alter table public.memory_item_sources enable row level security;
alter table public.memory_suppressions enable row level security;
alter table public.message_semantic_index enable row level security;
revoke all on table public.profile_memory_state from public, anon, authenticated;
revoke all on table public.memory_items from public, anon, authenticated;
revoke all on table public.memory_item_revisions from public, anon, authenticated;
revoke all on table public.memory_item_sources from public, anon, authenticated;
revoke all on table public.memory_suppressions from public, anon, authenticated;
revoke all on table public.message_semantic_index from public, anon, authenticated;
revoke all on function public.search_messages(text, text, extensions.vector, uuid, timestamptz, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.apply_memory_item_revision(text, text, text, public.memory_item_category, public.memory_item_value_scope, public.memory_item_origin, numeric, numeric, text, public.memory_item_status, text, bigint, text, uuid, uuid, uuid, uuid, text, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.create_memory_suppression(text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.lift_memory_suppression(text, text, text) from public, anon, authenticated;
grant execute on function public.search_messages(text, text, extensions.vector, uuid, timestamptz, timestamptz, integer) to service_role;
grant execute on function public.apply_memory_item_revision(text, text, text, public.memory_item_category, public.memory_item_value_scope, public.memory_item_origin, numeric, numeric, text, public.memory_item_status, text, bigint, text, uuid, uuid, uuid, uuid, text, jsonb, text, uuid) to service_role;
grant execute on function public.create_memory_suppression(text, text, text, uuid, text) to service_role;
grant execute on function public.lift_memory_suppression(text, text, text) to service_role;
