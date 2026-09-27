-- Phase 1 — Layer 2 (corrective): remove cross-guardian administration
-- capability from full_management.
--
-- Approved principle (33_Security_and_Privacy.md §2.5): managing the CHILD
-- does not imply authority to manage ANOTHER GUARDIAN. The Phase 1 RLS
-- Security Report and the Pediatric RLS Gap Resolution Report both
-- confirmed, by direct test, that the previously committed policies let a
-- full_management guardian revoke a co-guardian's grant and grant new
-- authorizations to other accounts (delegation). Both capabilities are now
-- removed. This migration does not edit the original policy definitions in
-- 20260825121100_rls_account_auth_profile.sql — it DROPs and re-CREATEs the
-- same three named policies on guardian_authorization, which is the
-- supported way to correct an already-committed policy without editing the
-- file that first defined it.
--
-- What changes:
--   1. SELECT: narrows visibility to a caller's OWN grant row only
--      (guardian_account_id = auth.uid()). This removes both the
--      full_management branch (which existed only to make the now-removed
--      cross-guardian UPDATE possible — Postgres requires SELECT-visibility
--      before a row is even a candidate for UPDATE) AND the original
--      granted_by_account_id / revoked_by_account_id "provenance" branches.
--      Testing this correction surfaced that those provenance branches were
--      an independent, narrower instance of the same problem: whoever
--      historically granted or revoked a co-guardian's authorization could
--      still see whether that co-guardian's row was active or revoked —
--      relationship information about ANOTHER GUARDIAN, not information
--      about the child. Left in place, that would have silently reopened
--      exactly the visibility this correction is meant to close. Removing
--      it now, in this same uncommitted migration, rather than shipping a
--      known residual gap.
--   2. INSERT: removes the delegation branch entirely
--      ("profile_access_scope(child_profile_id) = 'full_management'").
--      The only remaining path for an ordinary authenticated client to
--      create a guardian_authorization row is the bootstrap self-grant
--      (the account that created the child Profile granting its own first
--      authorization). Adding a second or subsequent guardian is no longer
--      an ordinary full_management capability — per §2.5, that requires a
--      future, separately designed and explicitly authorized workflow
--      (e.g. service-role-mediated), which is out of scope for this RLS
--      layer. Multiple simultaneously-active guardians remain fully
--      supported at the data/RLS level; only client-side self-service
--      delegation is removed.
--   3. UPDATE: removes the "OR profile_access_scope(...) = 'full_management'"
--      branch from the USING clause. A guardian may only revoke (or,
--      per the existing column-immutability trigger, only ever touch
--      revoked_at/revoked_by_account_id on) their OWN grant
--      (guardian_account_id = auth.uid()). granted_by_account_id is never
--      used here as an implicit administrative capability, per §2.5.
--
-- What is unchanged: bootstrap self-grant, self-revocation, reauthorization
-- after revocation, independent authorization scopes, and the column-
-- immutability trigger (20260825121100) all remain exactly as committed.

drop policy guardian_authorization_select_involved on guardian_authorization;

create policy guardian_authorization_select_involved on guardian_authorization
  for select to authenticated
  using (
    guardian_account_id = auth.uid()
  );

drop policy guardian_authorization_insert_bootstrap_or_delegated on guardian_authorization;

create policy guardian_authorization_insert_bootstrap on guardian_authorization
  for insert to authenticated
  with check (
    granted_by_account_id = auth.uid()
    and is_child_profile_created_by_caller(child_profile_id)
  );

drop policy guardian_authorization_update_revoke on guardian_authorization;

create policy guardian_authorization_update_revoke on guardian_authorization
  for update to authenticated
  using (
    guardian_account_id = auth.uid()
  )
  with check (
    revoked_by_account_id = auth.uid()
  );
