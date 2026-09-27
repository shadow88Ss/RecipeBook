-- Phase 1 — Layer 2 (corrective): pediatric_weight_management scope resolution.
--
-- Resolves the specification gap flagged in the Phase 1 RLS Security Report:
-- the approved specifications previously described what data the pediatric
-- weight-management carve-out may store (Master §10.2) but never mapped
-- that to specific tables/operations for access control. This migration
-- implements the access matrix now approved and recorded in
-- 33_Security_and_Privacy.md §9.
--
-- Approach: purely additive. Every policy below is NEW (a distinct policy
-- name), granted specifically `= 'pediatric_weight_management'`. PostgreSQL
-- combines multiple permissive policies for the same command with OR, so
-- these coexist with the existing full_management/view_only policies
-- without altering their behavior in any way. No existing policy, function,
-- grant, or table is modified, dropped, or replaced by this file.
--
-- Two tables need NO new policy here, and that is a finding, not an
-- omission — see the Pediatric RLS Gap Resolution Report for detail:
--   - `profile`: the existing profile_select_authorized policy uses a
--     blanket `profile_access_scope(id) IS NOT NULL` check (not restricted
--     to specific scopes), so it already grants pediatric_weight_management
--     the read-only access the approved matrix requires. This was not
--     previously understood to be the case and is a correction to the
--     Phase 1 RLS Security Report's claim that this scope had "zero access."
--   - `recipe`, `recipe_version`, `recipe_ingredient`, `recipe_instruction`:
--     the existing can_read_recipe() helper (20260825121000_rls_helpers.sql)
--     also uses a blanket `profile_access_scope(...) IS NOT NULL` check, so
--     these are already readable under the approved "access only where
--     required to use recipes legitimately available to the child Profile."
--
-- Tables the approved matrix explicitly excludes (Sleep, Recovery, Account,
-- AuthIdentity, DeviceSession, UrlSource, ImportJob, RawContent,
-- AiExtraction, AuditEvent, and GuardianAuthorization management of another
-- guardian) already have no path to this scope under the existing policies
-- and are left untouched, verified by the Pediatric RLS Gap Resolution
-- Report's negative tests rather than assumed.

-- ============================================================
-- child_profile_extension: READ only
-- ============================================================
create policy child_profile_extension_select_pediatric on child_profile_extension
  for select to authenticated
  using (profile_access_scope(profile_id) = 'pediatric_weight_management');

-- ============================================================
-- goal: SELECT + INSERT + permitted UPDATE/management
-- ============================================================
create policy goal_select_pediatric on goal
  for select to authenticated
  using (profile_access_scope(profile_id) = 'pediatric_weight_management');

create policy goal_insert_pediatric on goal
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'pediatric_weight_management');

create policy goal_update_pediatric on goal
  for update to authenticated
  using (profile_access_scope(profile_id) = 'pediatric_weight_management')
  with check (profile_access_scope(profile_id) = 'pediatric_weight_management');

-- ============================================================
-- nutrition_target: SELECT + INSERT per existing supersession rules
-- (no UPDATE grant exists for any scope; is_active/superseded_at remain
-- trigger-managed only, unchanged by this migration)
-- ============================================================
create policy nutrition_target_select_pediatric on nutrition_target
  for select to authenticated
  using (profile_access_scope(profile_id) = 'pediatric_weight_management');

create policy nutrition_target_insert_pediatric on nutrition_target
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'pediatric_weight_management');

-- ============================================================
-- clinician_target: SELECT only.
-- Deliberately NO insert policy for this scope: the approved definition is
-- explicit that this scope alone must not create clinician-target rows at
-- all (not even unverified ones) or in any way represent the guardian as a
-- verified clinician. The existing clinician_target_insert_managed policy
-- (full_management, verification_status = 'unverified' only) is untouched
-- and remains the only INSERT path.
-- ============================================================
create policy clinician_target_select_pediatric on clinician_target
  for select to authenticated
  using (profile_access_scope(profile_id) = 'pediatric_weight_management');

-- ============================================================
-- weight_measurement: SELECT + INSERT.
-- Existing rows remain immutable regardless of scope (Layer 1's
-- prevent_update() trigger; no UPDATE grant exists for any scope).
-- ============================================================
create policy weight_measurement_select_pediatric on weight_measurement
  for select to authenticated
  using (profile_access_scope(profile_id) = 'pediatric_weight_management');

create policy weight_measurement_insert_pediatric on weight_measurement
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'pediatric_weight_management');

-- ============================================================
-- effective_target_snapshot: SELECT only.
-- Deliberately NO insert policy: unlike full_management, this scope does
-- not create resolved-target snapshots itself.
-- ============================================================
create policy effective_target_snapshot_select_pediatric on effective_target_snapshot
  for select to authenticated
  using (profile_access_scope(profile_id) = 'pediatric_weight_management');

-- ============================================================
-- meal_log: SELECT + INSERT + permitted management for nutrition logging
-- ============================================================
create policy meal_log_select_pediatric on meal_log
  for select to authenticated
  using (profile_access_scope(profile_id) = 'pediatric_weight_management');

create policy meal_log_insert_pediatric on meal_log
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'pediatric_weight_management');

create policy meal_log_update_pediatric on meal_log
  for update to authenticated
  using (profile_access_scope(profile_id) = 'pediatric_weight_management')
  with check (profile_access_scope(profile_id) = 'pediatric_weight_management');

-- ============================================================
-- meal_item: SELECT + INSERT + lifecycle-permitted operations.
-- Layer 1's enforce_meal_item_status_transition() trigger and consumed-item
-- immutability are unchanged and apply identically regardless of which
-- scope's policy admitted the write.
-- ============================================================
create policy meal_item_select_pediatric on meal_item
  for select to authenticated
  using (profile_access_scope(profile_id) = 'pediatric_weight_management');

create policy meal_item_insert_pediatric on meal_item
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'pediatric_weight_management');

create policy meal_item_update_pediatric on meal_item
  for update to authenticated
  using (profile_access_scope(profile_id) = 'pediatric_weight_management')
  with check (profile_access_scope(profile_id) = 'pediatric_weight_management');

-- ============================================================
-- recipe_personalized_variant: SELECT + permitted creation/management for
-- variants belonging to the child Profile. Unlike Recipe/RecipeVersion/
-- RecipeIngredient/RecipeInstruction, this table does not route through
-- can_read_recipe() and was NOT already implicitly covered — a genuine new
-- grant, not a documentation-only finding.
-- ============================================================
create policy recipe_personalized_variant_select_pediatric on recipe_personalized_variant
  for select to authenticated
  using (profile_access_scope(profile_id) = 'pediatric_weight_management');

create policy recipe_personalized_variant_insert_pediatric on recipe_personalized_variant
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'pediatric_weight_management');

create policy recipe_personalized_variant_update_pediatric on recipe_personalized_variant
  for update to authenticated
  using (profile_access_scope(profile_id) = 'pediatric_weight_management')
  with check (profile_access_scope(profile_id) = 'pediatric_weight_management');

-- ============================================================
-- activity, workout: SELECT only.
-- ============================================================
create policy activity_select_pediatric on activity
  for select to authenticated
  using (profile_access_scope(profile_id) = 'pediatric_weight_management');

create policy workout_select_pediatric on workout
  for select to authenticated
  using (profile_access_scope(profile_id) = 'pediatric_weight_management');

-- ============================================================
-- wearable_connection: "NO management access" per the approved definition,
-- which is worded differently from Sleep/Recovery's explicit "NO ACCESS
-- initially" — read here as permitting SELECT (the guardian can see that a
-- connection exists, needed to make sense of visible Activity/Workout rows)
-- while withholding INSERT/UPDATE/DELETE (connect, disconnect, and sync-
-- field writes remain full_management/worker-only, unchanged). This is an
-- interpretive judgment call on wording, not a re-litigation of the
-- explicitly-settled Sleep/Recovery exclusion — flagged for confirmation in
-- the Pediatric RLS Gap Resolution Report.
-- ============================================================
create policy wearable_connection_select_pediatric on wearable_connection
  for select to authenticated
  using (profile_access_scope(profile_id) = 'pediatric_weight_management');

-- Sleep and Recovery intentionally receive NO new policy: the approved
-- definition states "NO ACCESS initially" for both, and no existing policy
-- already granted this scope access to them (verified negative test, not
-- an oversight).

-- No policy is added anywhere for: Account, AuthIdentity, DeviceSession
-- (not profile-scoped; a guardian's own account rows are visible to them as
-- themselves, independent of any child-guardian scope), GuardianAuthorization
-- (self-revocation is already available to every guardian regardless of
-- scope via the existing guardian_account_id = auth.uid() branch; managing
-- another guardian's row remains full_management-only, unchanged and
-- correctly excluding this scope), UrlSource/ImportJob/RawContent/
-- AiExtraction (already service-role/owning-Account-only, unrelated to
-- guardian scope), AuditEvent (already fully locked to service_role).
