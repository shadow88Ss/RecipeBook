-- Phase 1 — Layer 2: Row Level Security — Goal, NutritionTarget,
-- ClinicianTarget, WeightMeasurement, EffectiveTargetSnapshot.

-- ============================================================
-- goal
-- ============================================================
alter table goal enable row level security;

grant select, insert, update, delete on goal to authenticated;

create policy goal_select_authorized on goal
  for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only'));

create policy goal_insert_managed on goal
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'full_management');

create policy goal_update_managed on goal
  for update to authenticated
  using (profile_access_scope(profile_id) = 'full_management')
  with check (profile_access_scope(profile_id) = 'full_management');

create policy goal_delete_managed on goal
  for delete to authenticated
  using (profile_access_scope(profile_id) = 'full_management');

-- ============================================================
-- nutrition_target
-- ============================================================
alter table nutrition_target enable row level security;

-- No UPDATE grant: clients only ever INSERT a new row (the supersede
-- trigger, unaffected by RLS, deactivates the prior one). is_active and
-- superseded_at are never client-writable.
grant select, insert on nutrition_target to authenticated;

create policy nutrition_target_select_authorized on nutrition_target
  for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only'));

create policy nutrition_target_insert_managed on nutrition_target
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'full_management');

-- ============================================================
-- clinician_target
-- ============================================================
alter table clinician_target enable row level security;

grant select, insert on clinician_target to authenticated;

create policy clinician_target_select_authorized on clinician_target
  for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only'));

-- verification_status = 'unverified' is enforced here, not just as a column
-- default: an ordinary authenticated client must never be able to insert a
-- row claiming platform verification (Master §9) — that requires a separate,
-- not-yet-built, approved verified-clinician-integration workflow.
create policy clinician_target_insert_managed on clinician_target
  for insert to authenticated
  with check (
    profile_access_scope(profile_id) = 'full_management'
    and verification_status = 'unverified'
  );

-- ============================================================
-- weight_measurement
-- ============================================================
alter table weight_measurement enable row level security;

-- No UPDATE grant: rows are immutable historical fact (Layer 1 trigger
-- blocks UPDATE regardless); corrections are new rows via corrects_measurement_id.
grant select, insert on weight_measurement to authenticated;

create policy weight_measurement_select_authorized on weight_measurement
  for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only'));

create policy weight_measurement_insert_managed on weight_measurement
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'full_management');

-- ============================================================
-- effective_target_snapshot
-- ============================================================
alter table effective_target_snapshot enable row level security;

-- No UPDATE grant: write-once by approved design (00_Master.md §8); the
-- Layer 1 trigger also blocks UPDATE unconditionally regardless of RLS.
grant select, insert on effective_target_snapshot to authenticated;

create policy effective_target_snapshot_select_authorized on effective_target_snapshot
  for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only'));

-- RLS can authorize *who* may create a snapshot for a Profile; it cannot
-- verify that snapshot_payload actually matches what EffectiveTargetResolver
-- would compute — that correctness guarantee belongs to the API layer
-- (30_API.md §9), not to this security boundary.
create policy effective_target_snapshot_insert_managed on effective_target_snapshot
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'full_management');
