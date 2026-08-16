-- Milestone 3, Slice 6: deterministic historical search contract.
-- The original search_messages function remains stable for older callers.
-- v2 adds exact phrases, explicit roles, and an observable match strategy.

create or replace function public.search_messages_v2(
  p_profile_id text,
  p_query text default '',
  p_exact_phrase text default null,
  p_match_type text default 'hybrid',
  p_roles text[] default null,
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
  combined_score double precision,
  match_type text
)
language plpgsql security definer set search_path = public, extensions as $$
declare
  bounded_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  normalized_query text := nullif(trim(coalesce(p_query, '')), '');
  normalized_phrase text := nullif(trim(coalesce(p_exact_phrase, '')), '');
  requested_match text := lower(trim(coalesce(p_match_type, 'hybrid')));
  effective_match text := requested_match;
begin
  if not exists (select 1 from public.profiles p where p.id = p_profile_id) then
    raise exception 'Unknown profile scope';
  end if;
  if requested_match not in ('exact_phrase', 'hybrid', 'semantic') then
    raise exception 'Invalid historical search match type';
  end if;
  if p_roles is not null and exists (select 1 from unnest(p_roles) role_name where role_name not in ('user', 'assistant', 'tool')) then
    raise exception 'Invalid historical search role';
  end if;
  if normalized_query is null and normalized_phrase is null and p_query_embedding is null then
    return;
  end if;
  if requested_match = 'exact_phrase' and normalized_phrase is null then
    effective_match := 'hybrid';
  elsif requested_match = 'semantic' and p_query_embedding is null then
    -- Semantic indexing is optional. A lexical result is safer than a silent
    -- no-match when the embedding provider is unavailable.
    effective_match := 'hybrid';
  end if;

  return query
  with query_terms as (
    select case when normalized_query is null then null::tsquery
      else websearch_to_tsquery('simple'::regconfig, normalized_query) end as query
  ), candidates as (
    select
      m.id as message_id,
      m.thread_id,
      m.profile_id,
      m.role,
      m.content,
      m.created_at,
      case
        when normalized_phrase is not null and m.content ilike '%' || normalized_phrase || '%' then 1::real
        when query_terms.query is not null then ts_rank_cd(m.search_vector, query_terms.query)
        else 0::real
      end as lexical_score,
      case when p_query_embedding is not null and si.embedding is not null
        then (1 - (si.embedding <=> p_query_embedding))::real
        else null::real
      end as semantic_score
    from public.messages m
    cross join query_terms
    left join public.message_semantic_index si
      on si.message_id = m.id and si.profile_id = m.profile_id and si.thread_id = m.thread_id
    where m.profile_id = p_profile_id
      and (p_thread_id is null or m.thread_id = p_thread_id)
      and (p_from is null or m.created_at >= p_from)
      and (p_to is null or m.created_at < p_to)
      and (p_roles is null or cardinality(p_roles) = 0 or m.role = any(p_roles))
      and (
        (effective_match = 'exact_phrase' and normalized_phrase is not null and m.content ilike '%' || normalized_phrase || '%')
        or (effective_match = 'semantic' and p_query_embedding is not null and si.embedding is not null)
        or (effective_match = 'hybrid' and (
          (normalized_phrase is not null and m.content ilike '%' || normalized_phrase || '%')
          or (query_terms.query is not null and m.search_vector @@ query_terms.query)
          or (p_query_embedding is not null and si.embedding is not null)
        ))
      )
  ), ranked as (
    select candidates.*,
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
      + (case when ranked.semantic_score is not null then 0.45::double precision / (60::double precision + ranked.semantic_rank::double precision) else 0::double precision end),
    effective_match
  from ranked
  order by combined_score desc, ranked.created_at desc, ranked.message_id
  limit bounded_limit;
end;
$$;

revoke all on function public.search_messages_v2(text, text, text, text, text[], extensions.vector, uuid, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.search_messages_v2(text, text, text, text, text[], extensions.vector, uuid, timestamptz, timestamptz, integer) to service_role;
