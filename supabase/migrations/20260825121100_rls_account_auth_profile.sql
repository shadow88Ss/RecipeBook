-- Phase 1 — Layer 2: Row Level Security — Account, AuthIdentity, DeviceSession,
-- Profile, ChildProfileExtension, GuardianAuthorization.

-- ============================================================
-- account
-- ============================================================
alter table account enable row level security;

grant select, insert, update on account to authenticated;

create policy account_select_own on account
  for select to authenticated
  using (id = auth.uid());

-- Self-provisioning: a client may create the account row matching their own
-- authenticated identity (id = auth.uid()) — this is safe because the row is
-- always keyed to the server-verified identity, never a client-chosen id.
create policy account_insert_self on account
  for insert to authenticated
  with check (id = auth.uid());

create policy account_update_own on account
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- No DELETE policy: account deletion goes through a verified deletion
-- workflow (33_Security_and_Privacy.md §4), never a raw client DELETE.

-- ============================================================
-- auth_identity
-- ============================================================
alter table auth_identity enable row level security;

grant select, insert, update on auth_identity to authenticated;

create policy auth_identity_select_own on auth_identity
  for select to authenticated
  using (account_id = auth.uid());

create policy auth_identity_insert_own on auth_identity
  for insert to authenticated
  with check (account_id = auth.uid());

create policy auth_identity_update_own on auth_identity
  for update to authenticated
  using (account_id = auth.uid())
  with check (account_id = auth.uid());

-- No DELETE policy: unlinking is represented by unlinked_at (an UPDATE), not
-- row removal, per 37_Authentication_and_Login.md §7.

-- ============================================================
-- device_session
-- ============================================================
alter table device_session enable row level security;

grant select, insert, update on device_session to authenticated;

create policy device_session_select_own on device_session
  for select to authenticated
  using (account_id = auth.uid());

create policy device_session_insert_own on device_session
  for insert to authenticated
  with check (account_id = auth.uid());

-- UPDATE covers revocation (revoked_at/revoked_reason) and metadata
-- (device_name, biometric_enabled, last_active_at) — all self-service.
create policy device_session_update_own on device_session
  for update to authenticated
  using (account_id = auth.uid())
  with check (account_id = auth.uid());

-- No DELETE policy: revocation is soft (revoked_at), matching
-- 37_Authentication_and_Login.md §4/§8.

-- ============================================================
-- profile
-- ============================================================
alter table profile enable row level security;

grant select, insert, update, delete on profile to authenticated;

create policy profile_select_authorized on profile
  for select to authenticated
  using (profile_access_scope(id) is not null);

-- A caller may create a Profile attributed to themselves. This is also the
-- only way a child Profile comes into existence; the creator does not
-- thereby gain ongoing access — that requires a separate GuardianAuthorization
-- row (see guardian_authorization_insert_bootstrap below), by design.
create policy profile_insert_self on profile
  for insert to authenticated
  with check (account_id = auth.uid());

create policy profile_update_managed on profile
  for update to authenticated
  using (profile_access_scope(id) = 'full_management')
  with check (profile_access_scope(id) = 'full_management');

create policy profile_delete_managed on profile
  for delete to authenticated
  using (profile_access_scope(id) = 'full_management');

-- ============================================================
-- child_profile_extension
-- ============================================================
alter table child_profile_extension enable row level security;

grant select, insert, update on child_profile_extension to authenticated;

create policy child_profile_extension_select_authorized on child_profile_extension
  for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only'));

create policy child_profile_extension_insert_managed on child_profile_extension
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'full_management');

create policy child_profile_extension_update_managed on child_profile_extension
  for update to authenticated
  using (profile_access_scope(profile_id) = 'full_management')
  with check (profile_access_scope(profile_id) = 'full_management');

-- No DELETE policy: removed only via cascade from profile deletion.

-- ============================================================
-- guardian_authorization
-- ============================================================
alter table guardian_authorization enable row level security;

grant select, insert, update on guardian_authorization to authenticated;

-- A caller sees grants they hold, granted, or revoked, OR every grant for a
-- child they hold full_management on. The full_management branch is
-- required, not merely convenient: PostgreSQL RLS requires a row to satisfy
-- an applicable SELECT policy before it is even a candidate for UPDATE (this
-- table's UPDATE policy's USING clause is ANDed with this SELECT policy's
-- USING clause) — so without it, a full_management guardian could never
-- revoke a co-guardian's grant, contradicting "full_management: may perform
-- the management operations allowed by the specifications," which includes
-- managing who else holds guardian access. A narrower scope (view_only,
-- pediatric_weight_management) still sees only its own grant row — nothing
-- in the specifications requires or forbids co-guardian visibility for
-- full_management specifically, and this is the reading that makes the
-- already-approved multi-guardian model actually operable. Found and
-- resolved during Layer 2 RLS verification testing (see the RLS Security
-- Report, Attack 8/6).
create policy guardian_authorization_select_involved on guardian_authorization
  for select to authenticated
  using (
    guardian_account_id = auth.uid()
    or granted_by_account_id = auth.uid()
    or revoked_by_account_id = auth.uid()
    or profile_access_scope(child_profile_id) = 'full_management'
  );

-- Two, and only two, legitimate ways to create a grant:
--  1) Bootstrap: the account that created the child Profile self-grants its
--     own first authorization for it. This is the one place profile.account_id
--     is used as a trust anchor for a child profile, and only at this single
--     bootstrap moment — every subsequent access check goes through this
--     table, not profile.account_id.
--  2) Delegation: an account that already holds full_management on the child
--     grants a *new* authorization to another account (e.g. inviting a
--     second guardian).
-- In both cases granted_by_account_id must be the caller — no one may record
-- a grant as having been made by someone else.
create policy guardian_authorization_insert_bootstrap_or_delegated on guardian_authorization
  for insert to authenticated
  with check (
    granted_by_account_id = auth.uid()
    and (
      is_child_profile_created_by_caller(child_profile_id)
      or profile_access_scope(child_profile_id) = 'full_management'
    )
  );

-- UPDATE is restricted to revocation only (revoked_at/revoked_by_account_id);
-- every other column is frozen by the trigger below regardless of this
-- policy passing. A guardian may revoke their own grant (step down), or a
-- full_management guardian may revoke anyone's grant for that child.
create policy guardian_authorization_update_revoke on guardian_authorization
  for update to authenticated
  using (
    guardian_account_id = auth.uid()
    or profile_access_scope(child_profile_id) = 'full_management'
  )
  with check (
    revoked_by_account_id = auth.uid()
  );

-- No DELETE policy: a GuardianAuthorization row is retained as an audit
-- record even after revocation (33_Security_and_Privacy.md §4), removed only
-- with full child-profile deletion (a cascade, not a client DELETE).

-- Column-immutability backstop: RLS is row-level, not column-level, so the
-- UPDATE policy above cannot itself restrict *which* columns change. This
-- trigger closes that gap for a security-critical table: only revoked_at and
-- revoked_by_account_id may ever change after insert.
create function enforce_guardian_authorization_immutable_columns()
returns trigger
language plpgsql
as $$
begin
  if new.guardian_account_id is distinct from old.guardian_account_id
    or new.child_profile_id is distinct from old.child_profile_id
    or new.authorization_scope is distinct from old.authorization_scope
    or new.granted_by_account_id is distinct from old.granted_by_account_id
    or new.consented_at is distinct from old.consented_at
  then
    raise exception 'guardian_authorization %: only revoked_at/revoked_by_account_id may be updated', old.id;
  end if;
  return new;
end;
$$;

create trigger trg_guardian_authorization_immutable_columns
  before update on guardian_authorization
  for each row execute function enforce_guardian_authorization_immutable_columns();
