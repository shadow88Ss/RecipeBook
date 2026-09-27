-- Phase 1 — Layer 4B: Profile column-immutability.
--
-- Found while implementing PATCH /v1/profiles/{profile_id} (Layer 4B spec §2:
-- "prevent changing account_id through API input; prevent child/adult state
-- changes that violate ChildProfileExtension invariants"): the existing
-- profile_update_managed RLS policy (20260825121100_rls_account_auth_profile.sql)
-- restricts *which row* a full_management caller may UPDATE
-- (profile_access_scope(id) = 'full_management') but, being row-level, does
-- not restrict *which columns* change. Without this trigger, the API's own
-- Zod whitelist (display_name/date_of_birth only) is the only thing
-- preventing a full_management caller from rewriting their own row's
-- account_id (reassigning a child profile to a different Account entirely)
-- or is_child (which 29_Data_Model_Data_Dictionary.md §4 documents as
-- "immutable after creation" and which child_profile_extension's
-- pediatric-workflow gating and every guardian-scope policy assume is
-- fixed at creation time).
--
-- This is the same class of gap already closed twice before, at the same
-- layer of the stack: auth_identity (20260825122200) and
-- guardian_authorization (20260825121100's trg_guardian_authorization_
-- immutable_columns). Adding the equivalent protection here, defense-in-
-- depth alongside (not instead of) the API-layer Zod whitelist.
--
-- created_at is also frozen (standard system_computed field, never
-- reassignable). deleted_at is frozen too: no deletion/anonymization
-- workflow is implemented by any layer yet, so there is currently no
-- legitimate write path for it at all; a future layer that implements
-- account/profile deletion adds its own new migration to relax this
-- specific column, rather than this trigger guessing at that workflow now.
--
-- display_name and date_of_birth remain fully mutable, for both an adult
-- editing their own profile and a full_management guardian editing a
-- child's profile — exactly the two cases profile_update_managed already
-- authorizes at the row level.
create function enforce_profile_immutable_columns()
returns trigger
language plpgsql
as $$
begin
  if new.account_id is distinct from old.account_id
    or new.is_child is distinct from old.is_child
    or new.created_at is distinct from old.created_at
    or new.deleted_at is distinct from old.deleted_at
  then
    raise exception 'profile %: account_id, is_child, created_at, and deleted_at may not be updated', old.id;
  end if;
  return new;
end;
$$;

create trigger trg_profile_immutable_columns
  before update on profile
  for each row execute function enforce_profile_immutable_columns();
