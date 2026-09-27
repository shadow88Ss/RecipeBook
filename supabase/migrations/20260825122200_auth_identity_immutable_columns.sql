-- Phase 1 — Layer 3: AuthIdentity column-immutability.
--
-- Found during Layer 3 attack testing ("client cannot change AuthIdentity
-- provider subject to take over another Account"): the existing
-- auth_identity_update_own RLS policy (20260825121100_rls_account_auth_profile.sql)
-- restricts *which row* an Account may UPDATE (account_id = auth.uid()) but,
-- being row-level, does not restrict *which columns* change. An Account
-- could therefore rewrite its own auth_identity row's provider/
-- provider_subject_id after creation — corrupting the record of what
-- Supabase Auth actually verified. This does not let one Account take over
-- another's row (the row-level restriction still holds — no RLS change is
-- made here), but it is a real integrity gap on a security-relevant table,
-- of the same class already closed on guardian_authorization
-- (20260825121100's trg_guardian_authorization_immutable_columns).
--
-- This migration adds an equivalent trigger: only unlinked_at may ever
-- change after insert. account_id, provider, provider_subject_id, and
-- linked_at are frozen — matching 37_Authentication_and_Login.md §7's model
-- that unlinking is represented by unlinked_at (an UPDATE), never a rewrite
-- of the identity fields themselves.
create or replace function enforce_auth_identity_immutable_columns()
returns trigger
language plpgsql
as $$
begin
  if new.account_id is distinct from old.account_id
    or new.provider is distinct from old.provider
    or new.provider_subject_id is distinct from old.provider_subject_id
    or new.linked_at is distinct from old.linked_at
  then
    raise exception 'auth_identity %: only unlinked_at may be updated', old.id;
  end if;
  return new;
end;
$$;

create trigger trg_auth_identity_immutable_columns
  before update on auth_identity
  for each row execute function enforce_auth_identity_immutable_columns();
