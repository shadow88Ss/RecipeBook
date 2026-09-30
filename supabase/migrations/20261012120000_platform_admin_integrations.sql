-- Phase 3 — Layer 11C: Platform administration & extensible integration
-- foundation.
--
-- Additive. No earlier migration is edited; no core domain table (Food,
-- Product, Nutrition, Recipe, Meal, MealPlan, Grocery, Progress, Account,
-- WearableConnection) changes.
--
--  1. Platform authorization is a SEPARATE security domain from Profile
--     access: platform_role_assignment (Account -> platform_role), checked
--     by is_platform_admin(). profile_access_scope() is untouched, so
--     Profile ownership/guardianship never grants platform authority and
--     platform_admin never grants Profile data access. Role assignments are
--     written by trusted operators only (no client grant).
--  2. Provider registry: external_provider (one row per stable
--     provider_key; family, connection model, credential model, enabled,
--     environment, validated non-secret configuration, secret REFERENCE,
--     health) and external_provider_capability (explicit capabilities per
--     provider with enabled/priority). provider_capability_definition is
--     the family-scoped capability vocabulary; a composite FK makes a
--     capability of another family impossible (family isolation).
--  3. Secrets are never stored: secret_reference is a pointer in an
--     approved scheme (`env:NAME` — the deployment/environment secret
--     system; other schemes need a separate approval).
--  4. User connections stay in WearableConnection: a provider may name the
--     existing wearable_provider value it corresponds to; nothing about the
--     connection model changes.
--  5. Audit: every admin change writes AuditEvent through SECURITY DEFINER
--     triggers (existing AuditEvent architecture; no second audit system).
--  6. Read paths for non-admin code: enabled_provider_routes() exposes only
--     routable provider keys/priorities — never configuration or secret
--     references.
--  7. Seeded provider DEFINITIONS (all disabled, health unknown) — no
--     adapter exists for any of them, so none can be enabled or claimed as
--     connected.

-- ------------------------------------------------------------------
-- 1. Platform roles
-- ------------------------------------------------------------------
create type platform_role as enum ('platform_admin');

create table platform_role_assignment (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references account (id) on delete cascade,
  role platform_role not null,
  granted_at timestamptz not null default now(),
  granted_by_account_id uuid references account (id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index uq_platform_role_active on platform_role_assignment (account_id, role) where revoked_at is null;

create or replace function is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from platform_role_assignment
     where account_id = auth.uid() and role = 'platform_admin' and revoked_at is null
  );
$$;

revoke all on function is_platform_admin() from public;
grant execute on function is_platform_admin() to authenticated;

alter table platform_role_assignment enable row level security;
grant select on platform_role_assignment to authenticated;
-- An Account sees only its own assignments; nobody writes through the API.
create policy platform_role_assignment_select_own on platform_role_assignment
  for select to authenticated using (account_id = auth.uid());

-- ------------------------------------------------------------------
-- 2. Provider registry
-- ------------------------------------------------------------------
create type provider_family as enum ('product_data', 'wearable', 'device_health', 'commerce', 'identity');
-- How the integration is used: platform (server-to-server, platform
-- credentials), user_authorized (each user connects their own account),
-- device_native (on-device framework + OS consent), supabase_auth
-- (authentication stays with Supabase Auth).
create type provider_connection_model as enum ('platform', 'user_authorized', 'device_native', 'supabase_auth');
-- The PLATFORM credential. User OAuth tokens are never here: they belong to
-- the user's connection (WearableConnection for wearables).
create type provider_credential_model as enum ('none', 'api_key', 'oauth_client', 'service_account', 'device_native');
create type provider_environment as enum ('sandbox', 'production');
create type provider_health_status as enum ('unknown', 'healthy', 'degraded', 'unavailable', 'authentication_failed', 'rate_limited');
create type provider_failure_code as enum (
  'authentication_failed', 'rate_limited', 'timeout', 'provider_unavailable', 'invalid_provider_response', 'capability_not_supported'
);

create table provider_capability_definition (
  provider_family provider_family not null,
  capability text not null check (capability ~ '^[a-z][a-z0-9_]{1,62}$'),
  primary key (provider_family, capability)
);

insert into provider_capability_definition (provider_family, capability) values
  ('product_data', 'food_search'), ('product_data', 'product_search'), ('product_data', 'barcode_lookup'), ('product_data', 'nutrition_lookup'),
  ('wearable', 'activity_sync'), ('wearable', 'workout_sync'), ('wearable', 'sleep_sync'), ('wearable', 'recovery_sync'),
  ('device_health', 'activity_read'), ('device_health', 'workout_read'), ('device_health', 'sleep_read'), ('device_health', 'health_metrics_read'),
  ('commerce', 'product_search'), ('commerce', 'price'), ('commerce', 'availability'), ('commerce', 'shopping_list'),
  ('commerce', 'basket'), ('commerce', 'checkout'), ('commerce', 'order_status'),
  ('identity', 'authentication');

create table external_provider (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null unique check (provider_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  provider_family provider_family not null,
  connection_model provider_connection_model not null,
  credential_model provider_credential_model not null,
  enabled boolean not null default false,
  environment provider_environment not null default 'sandbox',
  -- Non-secret settings only, validated per adapter by the API.
  configuration jsonb not null default '{}'::jsonb check (jsonb_typeof(configuration) = 'object' and pg_column_size(configuration) <= 16384),
  -- A pointer to a server-side secret, never the secret itself.
  secret_reference text check (secret_reference is null or secret_reference ~ '^env:[A-Z][A-Z0-9_]{0,127}$'),
  -- The existing WearableConnection provider this integration corresponds to.
  wearable_provider wearable_provider unique,
  health_status provider_health_status not null default 'unknown',
  health_failure_code provider_failure_code,
  health_checked_at timestamptz,
  last_successful_health_check_at timestamptz,
  created_by_account_id uuid references account (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, provider_family),
  constraint external_provider_no_secret_for_credentialless check (credential_model not in ('none', 'device_native') or secret_reference is null),
  constraint external_provider_device_native check ((connection_model = 'device_native') = (credential_model = 'device_native')),
  constraint external_provider_device_health_native check (provider_family <> 'device_health' or connection_model = 'device_native'),
  constraint external_provider_identity_supabase check ((provider_family = 'identity') = (connection_model = 'supabase_auth')),
  constraint external_provider_identity_not_enabled check (provider_family <> 'identity' or enabled = false),
  constraint external_provider_wearable_link check (wearable_provider is null or provider_family in ('wearable', 'device_health')),
  constraint external_provider_health_failure check ((health_status in ('unknown', 'healthy')) = (health_failure_code is null))
);

create trigger trg_external_provider_set_updated_at
  before update on external_provider
  for each row execute function set_updated_at();

create table external_provider_capability (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null,
  provider_family provider_family not null,
  capability text not null,
  enabled boolean not null default true,
  -- Lower = tried first; ties are ordered by provider_key.
  priority int not null default 100 check (priority between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, capability),
  foreign key (provider_id, provider_family) references external_provider (id, provider_family),
  -- Family isolation: only a capability defined for the provider's family.
  foreign key (provider_family, capability) references provider_capability_definition (provider_family, capability)
);

create index idx_external_provider_capability_route on external_provider_capability (provider_family, capability, priority);

create trigger trg_external_provider_capability_set_updated_at
  before update on external_provider_capability
  for each row execute function set_updated_at();

-- Identity is stable: key, family and models never change after creation.
create or replace function external_provider_identity_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id or new.provider_key <> old.provider_key or new.provider_family <> old.provider_family
     or new.connection_model <> old.connection_model or new.credential_model <> old.credential_model
     or new.created_at <> old.created_at or new.created_by_account_id is distinct from old.created_by_account_id then
    raise exception 'provider identity is immutable'
      using errcode = '55000', constraint = 'external_provider_identity_immutable';
  end if;
  return new;
end;
$$;

create trigger trg_external_provider_identity_immutable
  before update on external_provider
  for each row execute function external_provider_identity_immutable();

create or replace function external_provider_capability_identity_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id or new.provider_id <> old.provider_id or new.provider_family <> old.provider_family or new.capability <> old.capability then
    raise exception 'capability identity is immutable'
      using errcode = '55000', constraint = 'external_provider_capability_identity_immutable';
  end if;
  return new;
end;
$$;

create trigger trg_external_provider_capability_identity_immutable
  before update on external_provider_capability
  for each row execute function external_provider_capability_identity_immutable();

-- Registry history is never deleted (disable instead).
create trigger trg_external_provider_no_delete before delete on external_provider for each row execute function prevent_mutation();
create trigger trg_external_provider_capability_no_delete before delete on external_provider_capability for each row execute function prevent_mutation();
create trigger trg_provider_capability_definition_no_delete before delete on provider_capability_definition for each row execute function prevent_mutation();

-- ------------------------------------------------------------------
-- RLS: platform_admin only; Profile scopes are irrelevant here.
-- ------------------------------------------------------------------
alter table external_provider enable row level security;
alter table external_provider_capability enable row level security;
alter table provider_capability_definition enable row level security;

grant select, insert, update on external_provider to authenticated;
grant select, insert, update on external_provider_capability to authenticated;
grant select on provider_capability_definition to authenticated;

create policy external_provider_admin_select on external_provider for select to authenticated using (is_platform_admin());
create policy external_provider_admin_insert on external_provider for insert to authenticated with check (is_platform_admin() and created_by_account_id = auth.uid());
create policy external_provider_admin_update on external_provider for update to authenticated using (is_platform_admin()) with check (is_platform_admin());

create policy external_provider_capability_admin_select on external_provider_capability for select to authenticated using (is_platform_admin());
create policy external_provider_capability_admin_insert on external_provider_capability for insert to authenticated with check (is_platform_admin());
create policy external_provider_capability_admin_update on external_provider_capability for update to authenticated using (is_platform_admin()) with check (is_platform_admin());

-- The capability vocabulary is not sensitive.
create policy provider_capability_definition_select on provider_capability_definition for select to authenticated using (true);

-- ------------------------------------------------------------------
-- 5. Audit (existing AuditEvent; ids and field names only — never
-- configuration values or secret references).
-- ------------------------------------------------------------------
create or replace function audit_external_provider_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event text;
  v_changed text[] := '{}';
begin
  if tg_op = 'INSERT' then
    v_event := 'external_provider_registered';
  else
    if new.enabled is distinct from old.enabled then
      insert into audit_event (actor_account_id, actor_type, event_type, subject_type, subject_id, event_payload, occurred_at)
      values (auth.uid(), case when auth.uid() is null then 'system'::audit_actor_type else 'user'::audit_actor_type end,
              case when new.enabled then 'external_provider_enabled' else 'external_provider_disabled' end,
              'external_provider', new.id, jsonb_build_object('provider_key', new.provider_key, 'enabled', new.enabled), now());
    end if;
    if new.secret_reference is distinct from old.secret_reference then
      insert into audit_event (actor_account_id, actor_type, event_type, subject_type, subject_id, event_payload, occurred_at)
      values (auth.uid(), case when auth.uid() is null then 'system'::audit_actor_type else 'user'::audit_actor_type end,
              'external_provider_secret_reference_changed', 'external_provider', new.id,
              jsonb_build_object('provider_key', new.provider_key, 'secret_reference_configured', new.secret_reference is not null), now());
    end if;
    if new.health_checked_at is distinct from old.health_checked_at then
      insert into audit_event (actor_account_id, actor_type, event_type, subject_type, subject_id, event_payload, occurred_at)
      values (auth.uid(), case when auth.uid() is null then 'system'::audit_actor_type else 'user'::audit_actor_type end,
              'external_provider_health_checked', 'external_provider', new.id,
              jsonb_build_object('provider_key', new.provider_key, 'health_status', new.health_status, 'health_failure_code', new.health_failure_code), now());
    end if;
    if new.configuration is distinct from old.configuration then v_changed := array_append(v_changed, 'configuration'); end if;
    if new.display_name is distinct from old.display_name then v_changed := array_append(v_changed, 'display_name'); end if;
    if new.environment is distinct from old.environment then v_changed := array_append(v_changed, 'environment'); end if;
    if new.wearable_provider is distinct from old.wearable_provider then v_changed := array_append(v_changed, 'wearable_provider'); end if;
    if array_length(v_changed, 1) is null then
      return null;
    end if;
    v_event := 'external_provider_configuration_changed';
  end if;
  insert into audit_event (actor_account_id, actor_type, event_type, subject_type, subject_id, event_payload, occurred_at)
  values (auth.uid(), case when auth.uid() is null then 'system'::audit_actor_type else 'user'::audit_actor_type end,
          v_event, 'external_provider', new.id,
          jsonb_build_object('provider_key', new.provider_key, 'changed_fields', to_jsonb(v_changed)), now());
  return null;
end;
$$;

revoke all on function audit_external_provider_change() from public;

create trigger trg_external_provider_audit
  after insert or update on external_provider
  for each row execute function audit_external_provider_change();

create or replace function audit_external_provider_capability_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
begin
  select provider_key into v_key from external_provider where id = new.provider_id;
  if tg_op = 'UPDATE' and new.enabled is not distinct from old.enabled and new.priority is not distinct from old.priority then
    return null;
  end if;
  insert into audit_event (actor_account_id, actor_type, event_type, subject_type, subject_id, event_payload, occurred_at)
  values (auth.uid(), case when auth.uid() is null then 'system'::audit_actor_type else 'user'::audit_actor_type end,
          case when tg_op = 'INSERT' then 'external_provider_capability_added'
               when new.priority is distinct from old.priority then 'external_provider_priority_changed'
               else 'external_provider_capability_changed' end,
          'external_provider', new.provider_id,
          jsonb_build_object('provider_key', v_key, 'capability', new.capability, 'enabled', new.enabled, 'priority', new.priority,
                             'previous_priority', case when tg_op = 'UPDATE' then to_jsonb(old.priority) else 'null'::jsonb end), now());
  return null;
end;
$$;

revoke all on function audit_external_provider_capability_change() from public;

create trigger trg_external_provider_capability_audit
  after insert or update on external_provider_capability
  for each row execute function audit_external_provider_capability_change();

-- Admin-only audit history for one provider (AuditEvent itself stays
-- ungranted to clients).
create or replace function external_provider_audit_history(p_provider_id uuid)
returns table (id uuid, event_type text, actor_account_id uuid, actor_type audit_actor_type, event_payload jsonb, occurred_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then
    raise exception 'platform_admin required' using errcode = '42501';
  end if;
  return query
    select a.id, a.event_type, a.actor_account_id, a.actor_type, a.event_payload, a.occurred_at
      from audit_event a
     where a.subject_type = 'external_provider' and a.subject_id = p_provider_id
     order by a.occurred_at desc, a.created_at desc, a.id
     limit 500;
end;
$$;

revoke all on function external_provider_audit_history(uuid) from public;
grant execute on function external_provider_audit_history(uuid) to authenticated;

-- Admin-only AGGREGATE of user connections per wearable provider: counts
-- only — no Profile, Account, token, sync payload or health value.
create or replace function external_provider_connection_counts()
returns table (wearable_provider wearable_provider, active_connections bigint, failing_connections bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then
    raise exception 'platform_admin required' using errcode = '42501';
  end if;
  return query
    select w.provider,
           count(*) filter (where w.disconnected_at is null),
           count(*) filter (where w.disconnected_at is null and w.last_sync_status in ('retryable_failure', 'permanent_failure'))
      from wearable_connection w
     group by w.provider;
end;
$$;

revoke all on function external_provider_connection_counts() from public;
grant execute on function external_provider_connection_counts() to authenticated;

-- ------------------------------------------------------------------
-- 6. Runtime routing read path for ordinary server code (the API always
-- runs as the calling user): enabled routes for one family + capability,
-- with the NON-SECRET settings an adapter call needs (environment,
-- configuration, secret reference name). Never health, audit, disabled
-- providers or any secret value.
-- ------------------------------------------------------------------
create or replace function enabled_provider_routes(p_family provider_family, p_capability text)
returns table (provider_key text, priority int, environment provider_environment, configuration jsonb, secret_reference text)
language sql
stable
security definer
set search_path = public
as $$
  select p.provider_key, c.priority, p.environment, p.configuration, p.secret_reference
    from external_provider p
    join external_provider_capability c on c.provider_id = p.id
   where p.enabled and c.enabled and p.provider_family = p_family and c.provider_family = p_family and c.capability = p_capability
   order by c.priority, p.provider_key;
$$;

revoke all on function enabled_provider_routes(provider_family, text) from public;
grant execute on function enabled_provider_routes(provider_family, text) to authenticated;

-- ------------------------------------------------------------------
-- Atomic admin writes (SECURITY INVOKER: the platform_admin RLS policies
-- above apply to every statement; these add atomicity, not privilege).
-- ------------------------------------------------------------------

-- p_provider: { provider_key, display_name, provider_family, connection_model,
-- credential_model, environment?, wearable_provider?, capabilities: [{ capability, enabled?, priority? }] }
create or replace function admin_register_external_provider(p_provider jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid := gen_random_uuid();
  v_cap jsonb;
begin
  insert into external_provider (id, provider_key, display_name, provider_family, connection_model, credential_model, environment, wearable_provider, created_by_account_id)
  values (
    v_id,
    p_provider->>'provider_key',
    p_provider->>'display_name',
    (p_provider->>'provider_family')::provider_family,
    (p_provider->>'connection_model')::provider_connection_model,
    (p_provider->>'credential_model')::provider_credential_model,
    coalesce((p_provider->>'environment')::provider_environment, 'sandbox'),
    (p_provider->>'wearable_provider')::wearable_provider,
    auth.uid()
  );
  for v_cap in select value from jsonb_array_elements(coalesce(p_provider->'capabilities', '[]'::jsonb)) loop
    insert into external_provider_capability (provider_id, provider_family, capability, enabled, priority)
    values (v_id, (p_provider->>'provider_family')::provider_family, v_cap->>'capability',
            coalesce((v_cap->>'enabled')::boolean, true), coalesce((v_cap->>'priority')::int, 100));
  end loop;
  return v_id;
end;
$$;

revoke all on function admin_register_external_provider(jsonb) from public;
grant execute on function admin_register_external_provider(jsonb) to authenticated;

-- p_change: any of { display_name, enabled, environment, configuration,
-- secret_reference (null clears), capabilities: [{ capability, enabled?, priority? }] }.
-- Capabilities are applied before the provider row, so enabling and its
-- capabilities land together; everything commits or nothing does.
create or replace function admin_update_external_provider(p_provider_key text, p_change jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_provider external_provider%rowtype;
  v_cap jsonb;
begin
  select * into v_provider from external_provider where provider_key = p_provider_key for update;
  if not found then
    raise exception 'provider not found' using errcode = 'P0002';
  end if;

  for v_cap in select value from jsonb_array_elements(coalesce(p_change->'capabilities', '[]'::jsonb)) loop
    insert into external_provider_capability (provider_id, provider_family, capability, enabled, priority)
    values (v_provider.id, v_provider.provider_family, v_cap->>'capability',
            coalesce((v_cap->>'enabled')::boolean, true), coalesce((v_cap->>'priority')::int, 100))
    on conflict (provider_id, capability) do update
      set enabled = coalesce((v_cap->>'enabled')::boolean, external_provider_capability.enabled),
          priority = coalesce((v_cap->>'priority')::int, external_provider_capability.priority);
  end loop;

  update external_provider set
    display_name = coalesce(p_change->>'display_name', display_name),
    enabled = coalesce((p_change->>'enabled')::boolean, enabled),
    environment = coalesce((p_change->>'environment')::provider_environment, environment),
    configuration = coalesce(p_change->'configuration', configuration),
    secret_reference = case when p_change ? 'secret_reference' then p_change->>'secret_reference' else secret_reference end
  where id = v_provider.id;

  return v_provider.id;
end;
$$;

revoke all on function admin_update_external_provider(text, jsonb) from public;
grant execute on function admin_update_external_provider(text, jsonb) to authenticated;

-- ------------------------------------------------------------------
-- 7. Provider definitions (disabled; no adapter exists for any of them).
-- ------------------------------------------------------------------
insert into external_provider (provider_key, display_name, provider_family, connection_model, credential_model, wearable_provider) values
  ('fatsecret', 'FatSecret', 'product_data', 'platform', 'oauth_client', null),
  ('open_food_facts', 'Open Food Facts', 'product_data', 'platform', 'none', null),
  ('usda', 'USDA FoodData Central', 'product_data', 'platform', 'api_key', null),
  ('whoop', 'WHOOP', 'wearable', 'user_authorized', 'oauth_client', 'whoop'),
  ('apple_health', 'Apple Health', 'device_health', 'device_native', 'device_native', 'apple_healthkit'),
  ('health_connect', 'Google Health Connect', 'device_health', 'device_native', 'device_native', 'android_health_connect'),
  ('instacart', 'Instacart', 'commerce', 'platform', 'api_key', null),
  ('google_sign_in', 'Google Sign-In', 'identity', 'supabase_auth', 'none', null),
  ('apple_sign_in', 'Sign in with Apple', 'identity', 'supabase_auth', 'none', null);

insert into external_provider_capability (provider_id, provider_family, capability, priority)
select p.id, p.provider_family, c.capability, c.priority
  from external_provider p
  join (values
    ('fatsecret', 'food_search', 20), ('fatsecret', 'product_search', 20), ('fatsecret', 'barcode_lookup', 20), ('fatsecret', 'nutrition_lookup', 20),
    ('open_food_facts', 'product_search', 30), ('open_food_facts', 'barcode_lookup', 30), ('open_food_facts', 'nutrition_lookup', 30),
    ('usda', 'food_search', 10), ('usda', 'nutrition_lookup', 10),
    ('whoop', 'activity_sync', 10), ('whoop', 'workout_sync', 10), ('whoop', 'sleep_sync', 10), ('whoop', 'recovery_sync', 10),
    ('apple_health', 'activity_read', 10), ('apple_health', 'workout_read', 10), ('apple_health', 'sleep_read', 10), ('apple_health', 'health_metrics_read', 10),
    ('health_connect', 'activity_read', 10), ('health_connect', 'workout_read', 10), ('health_connect', 'sleep_read', 10), ('health_connect', 'health_metrics_read', 10),
    ('instacart', 'product_search', 10), ('instacart', 'shopping_list', 10),
    ('google_sign_in', 'authentication', 10), ('apple_sign_in', 'authentication', 10)
  ) as c(provider_key, capability, priority) on c.provider_key = p.provider_key;
