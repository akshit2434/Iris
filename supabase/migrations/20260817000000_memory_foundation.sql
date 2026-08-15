-- Milestone 3, Slice 1: canonical memory foundations and replaceable retrieval.
-- Raw messages remain the source history. The tables below are profile-scoped and
-- server-only; RLS is enabled without browser policies.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

create table if not exists public.profile_memory_state (
  profile_id text primary key references public.profiles(id) on delete cascade,
  current_revision bigint not null default 0 check (current_revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.memory_documents (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  logical_key text not null check (char_length(logical_key) between 1 and 200),
  content_markdown text not null check (char_length(content_markdown) <= 500000),
  document_revision bigint not null default 0 check (document_revision >= 0),
  content_hash text not null check (content_hash = encode(digest(content_markdown, 'sha256'), 'hex')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (id, profile_id)
);

create unique index if not exists memory_documents_profile_logical_active_idx
  on public.memory_documents(profile_id, logical_key)
  where archived_at is null;

create index if not exists memory_documents_profile_updated_idx
  on public.memory_documents(profile_id, updated_at desc);

create table if not exists public.memory_document_revisions (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  document_id uuid not null,
  document_revision bigint not null check (document_revision > 0),
  profile_global_revision bigint not null check (profile_global_revision > 0),
  content_markdown text not null check (char_length(content_markdown) <= 500000),
  content_hash text not null check (content_hash = encode(digest(content_markdown, 'sha256'), 'hex')),
  mutation_kind text not null check (mutation_kind in ('create', 'update', 'archive', 'restore', 'merge')),
  created_at timestamptz not null default now(),
  unique (id, profile_id),
  unique (document_id, profile_id, document_revision),
  unique (profile_id, profile_global_revision),
  constraint memory_document_revisions_document_fkey
    foreign key (document_id, profile_id)
    references public.memory_documents(id, profile_id)
    on delete restrict
);

create index if not exists memory_document_revisions_profile_created_idx
  on public.memory_document_revisions(profile_id, created_at desc);

create table if not exists public.memory_provenance (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  document_id uuid not null,
  document_revision_id uuid not null,
  source_kind text not null check (source_kind in ('message', 'thread', 'agent_event', 'manual', 'system')),
  source_thread_id uuid,
  source_message_id uuid,
  source_agent_event_id uuid,
  source_agent_run_id uuid,
  source_excerpt text check (source_excerpt is null or char_length(source_excerpt) <= 2000),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint memory_provenance_document_fkey
    foreign key (document_id, profile_id)
    references public.memory_documents(id, profile_id)
    on delete restrict,
  constraint memory_provenance_revision_fkey
    foreign key (document_revision_id, profile_id)
    references public.memory_document_revisions(id, profile_id)
    on delete restrict,
  constraint memory_provenance_thread_fkey
    foreign key (source_thread_id, profile_id)
    references public.threads(id, profile_id)
    on delete restrict,
  constraint memory_provenance_message_fkey
    foreign key (source_message_id, profile_id, source_thread_id)
    references public.messages(id, profile_id, thread_id)
    on delete restrict,
  constraint memory_provenance_agent_event_fkey
    foreign key (source_agent_event_id, profile_id, source_thread_id, source_agent_run_id)
    references public.agent_events(id, profile_id, thread_id, run_id)
    on delete restrict,
  check ((source_message_id is null) or source_thread_id is not null),
  check ((source_agent_event_id is null) = (source_agent_run_id is null)),
  check ((source_agent_event_id is null) or source_thread_id is not null)
);

create index if not exists memory_provenance_profile_document_idx
  on public.memory_provenance(profile_id, document_id, created_at desc);

-- This is derived and replaceable. It intentionally stores no message content.
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
    references public.messages(id, profile_id, thread_id)
    on delete cascade,
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
select id from public.profiles
on conflict (profile_id) do nothing;

create or replace function public.ensure_profile_memory_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profile_memory_state(profile_id)
  values (new.id)
  on conflict (profile_id) do nothing;
  return new;
end;
$$;

drop trigger if exists profiles_memory_state_after_insert on public.profiles;
create trigger profiles_memory_state_after_insert
after insert on public.profiles
for each row execute function public.ensure_profile_memory_state();

create or replace function public.search_messages(
  p_profile_id text,
  p_query text default '',
  p_query_embedding extensions.vector(1536) default null,
  p_thread_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit integer default 20
)
returns table (
  message_id uuid,
  thread_id uuid,
  profile_id text,
  role text,
  content text,
  created_at timestamptz,
  lexical_score real,
  semantic_score real,
  combined_score double precision
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  bounded_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
begin
  if not exists (select 1 from public.profiles p where p.id = p_profile_id) then
    raise exception 'Unknown profile scope';
  end if;

  if nullif(trim(coalesce(p_query, '')), '') is null and p_query_embedding is null then
    return;
  end if;

  return query
  with query_terms as (
    select case
      when nullif(trim(coalesce(p_query, '')), '') is null then null::tsquery
      else websearch_to_tsquery('simple'::regconfig, p_query)
    end as query
  ), candidates as (
    select
      m.id as message_id,
      m.thread_id,
      m.profile_id,
      m.role,
      m.content,
      m.created_at,
      case when query_terms.query is not null then ts_rank_cd(m.search_vector, query_terms.query) else 0::real end as lexical_score,
      case when p_query_embedding is not null and si.embedding is not null
        then (1 - (si.embedding <=> p_query_embedding))::real
        else null::real
      end as semantic_score
    from public.messages m
    cross join query_terms
    left join public.message_semantic_index si
      on si.message_id = m.id
      and si.profile_id = m.profile_id
      and si.thread_id = m.thread_id
    where m.profile_id = p_profile_id
      and (p_thread_id is null or m.thread_id = p_thread_id)
      and (p_from is null or m.created_at >= p_from)
      and (p_to is null or m.created_at < p_to)
      and (
        (query_terms.query is not null and m.search_vector @@ query_terms.query)
        or (p_query_embedding is not null and si.embedding is not null)
      )
  ), ranked as (
    select
      candidates.*,
      row_number() over (order by candidates.lexical_score desc, candidates.created_at desc, candidates.message_id) as lexical_rank,
      row_number() over (order by candidates.semantic_score desc nulls last, candidates.created_at desc, candidates.message_id) as semantic_rank
    from candidates
  )
  select
    ranked.message_id,
    ranked.thread_id,
    ranked.profile_id,
    ranked.role,
    ranked.content,
    ranked.created_at,
    ranked.lexical_score,
    ranked.semantic_score,
    (case when ranked.lexical_score > 0 then 0.55::double precision / (60::double precision + ranked.lexical_rank::double precision) else 0::double precision end)
      + (case when ranked.semantic_score is not null then 0.45::double precision / (60::double precision + ranked.semantic_rank::double precision) else 0::double precision end) as combined_score
  from ranked
  order by combined_score desc, ranked.created_at desc, ranked.message_id
  limit bounded_limit;
end;
$$;

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
  p_source_metadata jsonb default '{}'::jsonb
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
  next_document_revision bigint;
  next_global_revision bigint;
  new_document_id uuid;
  new_revision_id uuid;
  new_provenance_id uuid;
  normalized_key text := trim(coalesce(p_logical_key, ''));
  normalized_content text := coalesce(p_content_markdown, '');
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
  order by document.archived_at nulls first, document.updated_at desc
  for update;

  if not found then
    if p_expected_document_revision is not null and p_expected_document_revision <> 0 then
      raise exception 'Stale canonical memory document revision';
    end if;
    new_document_id := gen_random_uuid();
    next_document_revision := 1;
    insert into public.memory_documents(id, profile_id, logical_key, content_markdown, document_revision, content_hash, archived_at)
    values (new_document_id, p_profile_id, normalized_key, normalized_content, next_document_revision, encode(digest(normalized_content, 'sha256'), 'hex'), case when p_mutation_kind = 'archive' then now() else null end);
  else
    if p_expected_document_revision is not null and p_expected_document_revision <> current_document.document_revision then
      raise exception 'Stale canonical memory document revision';
    end if;
    new_document_id := current_document.id;
    next_document_revision := current_document.document_revision + 1;
    update public.memory_documents as memory_document
    set content_markdown = normalized_content,
        document_revision = next_document_revision,
        content_hash = encode(digest(normalized_content, 'sha256'), 'hex'),
        updated_at = now(),
        archived_at = case
          when p_mutation_kind = 'archive' then now()
          when p_mutation_kind = 'restore' then null
          else archived_at
        end
    where memory_document.id = current_document.id and memory_document.profile_id = p_profile_id;
  end if;

  next_global_revision := state_revision + 1;
  update public.profile_memory_state
  set current_revision = next_global_revision, updated_at = now()
  where public.profile_memory_state.profile_id = p_profile_id;

  insert into public.memory_document_revisions(
    profile_id, document_id, document_revision, profile_global_revision,
    content_markdown, content_hash, mutation_kind
  ) values (
    p_profile_id, new_document_id, next_document_revision, next_global_revision,
    normalized_content, encode(digest(normalized_content, 'sha256'), 'hex'), p_mutation_kind
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

alter table public.profile_memory_state enable row level security;
alter table public.memory_documents enable row level security;
alter table public.memory_document_revisions enable row level security;
alter table public.memory_provenance enable row level security;
alter table public.message_semantic_index enable row level security;

revoke all on table public.profile_memory_state from public, anon, authenticated;
revoke all on table public.memory_documents from public, anon, authenticated;
revoke all on table public.memory_document_revisions from public, anon, authenticated;
revoke all on table public.memory_provenance from public, anon, authenticated;
revoke all on table public.message_semantic_index from public, anon, authenticated;
revoke all on function public.search_messages(text, text, extensions.vector, uuid, timestamptz, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.apply_memory_document_revision(text, text, text, text, bigint, text, uuid, uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.search_messages(text, text, extensions.vector, uuid, timestamptz, timestamptz, integer) to service_role;
grant execute on function public.apply_memory_document_revision(text, text, text, text, bigint, text, uuid, uuid, uuid, uuid, text, jsonb) to service_role;
