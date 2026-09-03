-- Supabase Cron is the deployed heartbeat for worker reliability. The URL and
-- bearer secret are stored in Vault and are configured once after migration.
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault with schema vault;

create schema if not exists private;

create or replace function private.invoke_iris_worker()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  worker_url text;
  worker_secret text;
begin
  select decrypted_secret into worker_url
    from vault.decrypted_secrets
   where name = 'iris_cron_worker_url';
  select decrypted_secret into worker_secret
    from vault.decrypted_secrets
   where name = 'iris_cron_worker_secret';

  if worker_url is null or worker_secret is null then
    raise warning 'Iris worker cron is not configured; set iris_cron_worker_url and iris_cron_worker_secret in Vault.';
    return;
  end if;

  perform net.http_get(
    url := rtrim(worker_url, '/') || '/api/internal/cron/workers',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || worker_secret,
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 20_000
  );
end;
$$;

revoke all on function private.invoke_iris_worker() from public, anon, authenticated;

-- Keep configuration out of migration plaintext while allowing a one-time
-- service-role call from the deployment script. The function itself never
-- returns either secret and is not executable by browser roles.
create or replace function public.configure_iris_cron(
  p_worker_url text,
  p_worker_secret text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  url_id uuid;
  secret_id uuid;
begin
  if p_worker_url !~ '^https://[^[:space:]]+$' then
    raise exception 'Worker URL must be an HTTPS URL.';
  end if;
  if length(p_worker_secret) < 32 then
    raise exception 'Worker secret must be at least 32 characters.';
  end if;

  select id into url_id from vault.secrets where name = 'iris_cron_worker_url' limit 1;
  if url_id is null then
    perform vault.create_secret(p_worker_url, 'iris_cron_worker_url', 'Iris worker adapter URL');
  else
    perform vault.update_secret(url_id, p_worker_url, 'iris_cron_worker_url', 'Iris worker adapter URL');
  end if;

  select id into secret_id from vault.secrets where name = 'iris_cron_worker_secret' limit 1;
  if secret_id is null then
    perform vault.create_secret(p_worker_secret, 'iris_cron_worker_secret', 'Iris Supabase Cron bearer secret');
  else
    perform vault.update_secret(secret_id, p_worker_secret, 'iris_cron_worker_secret', 'Iris Supabase Cron bearer secret');
  end if;

  return jsonb_build_object('configured', true);
end;
$$;

revoke all on function public.configure_iris_cron(text, text) from public, anon, authenticated;
grant execute on function public.configure_iris_cron(text, text) to service_role;

do $migration$
declare
  existing_job_id bigint;
begin
  select jobid into existing_job_id from cron.job where jobname = 'iris-worker-heartbeat' limit 1;
  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;
  perform cron.schedule(
    'iris-worker-heartbeat',
    '*/5 * * * *',
    $cron$select private.invoke_iris_worker();$cron$
  );
end;
$migration$;
