-- Integration-test-only sandbox shim (NEVER applied to a real Supabase
-- project — a real project already has its own, real `auth` schema).
-- Reproduces just enough of Supabase Auth's schema/roles for the already-
-- migrated Layers 1-3 RLS policies and provisioning trigger to run locally:
-- `auth.uid()` reading the same per-claim GUC convention this project's
-- prior-layer verification scripts used, the three Supabase Postgres
-- roles, and minimal auth.users/auth.identities tables for the Layer 3
-- provisioning trigger to attach to.
create schema if not exists auth;

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);

create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  identity_data jsonb not null,
  provider_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_sign_in_at timestamptz not null default now()
);

grant all on auth.users, auth.identities to service_role, postgres;
