-- Integration-test-only (NEVER applied to a real Supabase project, which
-- already has these). Applied before the FIRST migration so the local chain
-- is built under the same default privileges a hosted Supabase project
-- gives the `postgres` role that runs migrations:
--   every new public table, sequence and function is automatically granted
--   ALL to anon, authenticated and service_role.
-- Without this, the harness hid the drift found on the first DEV deployment
-- (Layer 12A.1; fixed by 20261014120000_align_supabase_default_privileges).
-- The roles are created here, before auth-shim.sql, which keeps its own
-- if-not-exists guards.
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

alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
