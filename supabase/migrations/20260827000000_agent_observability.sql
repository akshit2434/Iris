-- Milestone 3, observability: durable provider-call and assistant lifecycle
-- events. Payloads contain identifiers, counts, hashes and bounded metadata;
-- hidden prompts and duplicate assistant text are intentionally excluded.

alter table public.agent_events
  drop constraint if exists agent_events_type_check;

alter table public.agent_events
  add constraint agent_events_type_check
  check (type in (
    'run_started',
    'run_completed',
    'run_failed',
    'tool_call',
    'tool_result',
    'model_call_started',
    'model_call_completed',
    'model_call_failed',
    'assistant_completed',
    'assistant_partial'
  ));

create index if not exists agent_events_run_type_sequence_idx
  on public.agent_events(run_id, type, sequence asc);
