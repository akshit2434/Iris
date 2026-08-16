-- Milestone 3 upgrade bridge.
-- Replays the structured memory/runtime shape for databases that applied the
-- pre-structured-memory migrations before the migration files were rewritten.
-- Legacy tables are retained for audit/recovery; current runtime tables become
-- available without resetting raw history.
create table if not exists public.memory_migration_markers (
  key text primary key check (char_length(key) between 1 and 120),
  completed_at timestamptz not null default now()
);
alter table public.memory_migration_markers enable row level security;
revoke all on table public.memory_migration_markers from public, anon, authenticated;

do $$
declare
  index_name text;
  renamed_name text;
begin
  if to_regclass('public.memory_mutation_proposals') is not null
     and not exists (
       select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = 'memory_mutation_proposals'
         and column_name = 'canonical_key'
     ) then
    for index_name in
      select indexname
      from pg_indexes
      where schemaname = 'public' and tablename = 'memory_mutation_proposals'
    loop
      renamed_name := left('legacy_memory_mutation_proposals_' || md5(index_name), 63);
      execute format('alter index public.%I rename to %I', index_name, renamed_name);
    end loop;
    drop function if exists public.apply_memory_mutation_proposal(text, uuid, uuid, text);
    alter table public.memory_mutation_proposals rename to memory_mutation_proposals_legacy;
  end if;
end
$$;
drop function if exists public.apply_memory_mutation_proposal(text, uuid, uuid, text);

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

do $$
begin
  create type public.memory_item_category as enum (
    'personal_fact', 'preference', 'instruction', 'project', 'goal',
    'relationship', 'active_state', 'pattern', 'other'
  );
exception when duplicate_object then null;
end
$$;
do $$
begin
  create type public.memory_item_value_scope as enum ('single', 'multi');
exception when duplicate_object then null;
end
$$;
do $$
begin
  create type public.memory_item_origin as enum ('explicit', 'inferred', 'system');
exception when duplicate_object then null;
end
$$;
do $$
begin
  create type public.memory_item_status as enum ('active', 'superseded', 'archived', 'deleted');
exception when duplicate_object then null;
end
$$;

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

-- Keep the current six-argument token-triggered enqueue function.
drop function if exists public.enqueue_memory_consolidation_job(text, uuid, uuid);
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

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.thread_context'::regclass
      and conname = 'thread_context_active_continuity_fkey'
  ) then
    alter table public.thread_context
      add constraint thread_context_active_continuity_fkey
      foreign key (active_continuity_checkpoint_id)
      references public.thread_continuity_checkpoints(id)
      on delete set null;
  end if;
end
$$;

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



-- Copy pre-rewrite Markdown memory into structured items once. Raw legacy
-- tables stay in place and remain available for forensic migration recovery.
do $$
declare
  row_count integer;
begin
  if to_regclass('public.memory_documents') is null
     or exists (select 1 from public.memory_migration_markers where key = 'structured-memory-v1') then
    return;
  end if;

  create temp table _legacy_memory_item_map (
    old_document_id uuid primary key,
    item_id uuid not null
  ) on commit drop;

  insert into _legacy_memory_item_map(old_document_id, item_id)
  select d.id, gen_random_uuid()
  from public.memory_documents d;

  insert into public.memory_items(
    id, profile_id, canonical_key, content, item_revision, category,
    value_scope, origin, confidence, importance, sensitivity, status,
    valid_from, valid_until, last_confirmed_at, superseded_by_item_id,
    created_at, updated_at, archived_at, deleted_at
  )
  select map.item_id, d.profile_id, d.logical_key, d.content_markdown,
    greatest(d.document_revision, 1), 'other'::public.memory_item_category,
    'single'::public.memory_item_value_scope, 'system'::public.memory_item_origin,
    0.5, 0.5, 'normal',
    case when d.archived_at is null then 'active'::public.memory_item_status else 'archived'::public.memory_item_status end,
    null, null, null, null, d.created_at, d.updated_at, d.archived_at, null
  from public.memory_documents d
  join _legacy_memory_item_map map on map.old_document_id = d.id
  on conflict (id) do nothing;

  insert into public.memory_item_revisions(
    profile_id, item_id, item_revision, profile_global_revision,
    canonical_key, content, content_hash, category, value_scope, origin,
    confidence, importance, sensitivity, status, valid_from, valid_until,
    last_confirmed_at, superseded_by_item_id, mutation_kind, idempotency_key,
    created_at
  )
  select d.profile_id, map.item_id, greatest(r.document_revision, 1),
    coalesce(state.current_revision, 0)
      + row_number() over (partition by d.profile_id order by r.created_at, r.id),
    d.logical_key, r.content_markdown, r.content_hash,
    'other'::public.memory_item_category, 'single'::public.memory_item_value_scope,
    'system'::public.memory_item_origin, 0.5, 0.5, 'normal',
    case when d.archived_at is null then 'active'::public.memory_item_status else 'archived'::public.memory_item_status end,
    null, null, null, null,
    case when r.mutation_kind in ('create', 'update', 'supersede', 'archive', 'restore', 'delete', 'merge')
      then r.mutation_kind else 'update' end,
    null, r.created_at
  from public.memory_document_revisions r
  join public.memory_documents d
    on d.id = r.document_id and d.profile_id = r.profile_id
  join _legacy_memory_item_map map on map.old_document_id = d.id
  left join public.profile_memory_state state on state.profile_id = d.profile_id
  on conflict (item_id, profile_id, item_revision) do nothing;

  insert into public.memory_item_sources(
    profile_id, item_id, revision_id, source_kind, source_thread_id,
    source_message_id, source_agent_event_id, source_agent_run_id,
    source_excerpt, metadata, created_at
  )
  select p.profile_id, map.item_id, migrated.id, p.source_kind, p.source_thread_id,
    p.source_message_id, p.source_agent_event_id, p.source_agent_run_id,
    p.source_excerpt,
    coalesce(p.metadata, '{}'::jsonb)
      || jsonb_build_object('legacy_document_id', p.document_id::text,
        'legacy_revision_id', p.document_revision_id::text),
    p.created_at
  from public.memory_provenance p
  join public.memory_document_revisions legacy_revision
    on legacy_revision.id = p.document_revision_id
    and legacy_revision.profile_id = p.profile_id
  join public.memory_documents d
    on d.id = legacy_revision.document_id and d.profile_id = legacy_revision.profile_id
  join _legacy_memory_item_map map on map.old_document_id = d.id
  join public.memory_item_revisions migrated
    on migrated.profile_id = p.profile_id
    and migrated.item_id = map.item_id
    and migrated.item_revision = greatest(legacy_revision.document_revision, 1)
  on conflict do nothing;

  update public.profile_memory_state state
  set current_revision = greatest(
    state.current_revision,
    coalesce((
      select max(revision.profile_global_revision)
      from public.memory_item_revisions revision
      where revision.profile_id = state.profile_id
    ), state.current_revision)
  ), updated_at = now();

  insert into public.memory_migration_markers(key)
  values ('structured-memory-v1')
  on conflict (key) do nothing;
end
$$;
