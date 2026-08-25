-- Phase 1 — Layer 1: Database Foundation
-- Account, AuthIdentity, DeviceSession, Profile, ChildProfileExtension, GuardianAuthorization.
-- Per 37_Authentication_and_Login.md: Supabase Auth is the sole credential/token
-- authority. `account.id` is intended to equal the corresponding Supabase Auth
-- `auth.users.id` in the deployed environment; that table is managed by Supabase
-- Auth itself and is not created by these application migrations, so no live FK
-- to `auth.users` is declared here (documented, not a silent omission).

create table account (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  display_name text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table auth_identity (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references account (id) on delete cascade,
  provider auth_identity_provider not null,
  provider_subject_id text not null,
  linked_at timestamptz not null default now(),
  unlinked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, provider_subject_id)
);

create index idx_auth_identity_account_id on auth_identity (account_id);

create table device_session (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references account (id) on delete cascade,
  device_name text,
  device_type device_type,
  supabase_session_reference text not null,
  biometric_enabled boolean not null default false,
  trusted boolean not null default false,
  last_active_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason device_session_revoked_reason,
  constraint device_session_revoked_reason_requires_revoked_at
    check (revoked_reason is null or revoked_at is not null)
);

create index idx_device_session_account_revoked on device_session (account_id, revoked_at);

create table profile (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references account (id) on delete cascade,
  display_name text not null,
  is_child boolean not null default false,
  date_of_birth date,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint profile_child_requires_dob check (is_child = false or date_of_birth is not null)
);

create index idx_profile_account_id on profile (account_id);

create table child_profile_extension (
  profile_id uuid primary key references profile (id) on delete cascade,
  guardian_pediatric_workflow_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

-- Enforces that ChildProfileExtension only ever attaches to a Profile with
-- is_child = true (not expressible as a plain CHECK constraint since it spans
-- two tables) — a genuine cross-row invariant, per Master §20 "enforce
-- invariants in the database where practical".
create function enforce_child_profile_extension_requires_child()
returns trigger
language plpgsql
as $$
declare
  profile_is_child boolean;
begin
  select is_child into profile_is_child from profile where id = new.profile_id;
  if profile_is_child is distinct from true then
    raise exception 'child_profile_extension.profile_id % must reference a profile with is_child = true', new.profile_id;
  end if;
  return new;
end;
$$;

create trigger trg_child_profile_extension_requires_child
  before insert or update on child_profile_extension
  for each row execute function enforce_child_profile_extension_requires_child();

create table guardian_authorization (
  id uuid primary key default gen_random_uuid(),
  guardian_account_id uuid not null references account (id) on delete restrict,
  child_profile_id uuid not null references profile (id) on delete cascade,
  authorization_scope guardian_authorization_scope not null,
  granted_by_account_id uuid not null references account (id) on delete restrict,
  consented_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by_account_id uuid references account (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint guardian_authorization_revoked_by_requires_revoked_at
    check (revoked_at is null or revoked_by_account_id is not null)
);

create index idx_guardian_authorization_guardian on guardian_authorization (guardian_account_id);
create index idx_guardian_authorization_child on guardian_authorization (child_profile_id);

-- At most one active (revoked_at IS NULL) authorization per guardian/child pair.
create unique index uq_guardian_authorization_active
  on guardian_authorization (guardian_account_id, child_profile_id)
  where revoked_at is null;
