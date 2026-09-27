-- Phase 1 — Layer 2: Row Level Security — WearableConnection, Activity,
-- Workout, Sleep, Recovery.

-- ============================================================
-- wearable_connection
-- ============================================================
alter table wearable_connection enable row level security;

grant select, insert, update on wearable_connection to authenticated;

create policy wearable_connection_select_authorized on wearable_connection
  for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only'));

create policy wearable_connection_insert_managed on wearable_connection
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'full_management');

-- Covers disconnect (setting disconnected_at). sync_cursor/last_sync_status/
-- retry_count are intended to be worker-written only; RLS's row-level grain
-- cannot itself restrict which columns a legitimate row-owner changes — see
-- the RLS Security Report's Outstanding Issues (self-inflicted sync-state
-- risk only if a client writes garbage here, not a cross-profile exposure).
create policy wearable_connection_update_managed on wearable_connection
  for update to authenticated
  using (profile_access_scope(profile_id) = 'full_management')
  with check (profile_access_scope(profile_id) = 'full_management');

-- No DELETE policy: disconnection is soft (disconnected_at), not row removal.

-- ============================================================
-- activity / workout / sleep / recovery
-- ============================================================
-- Identical policy shape on all four: readable by full_management/view_only,
-- and INSERT-only for full_management (per 29_Data_Model_Data_Dictionary.md
-- §29-32: "not user-editable except via an explicit user_override record
-- (never an in-place edit of a wearable_direct/wearable_derived row)" — so a
-- correction is always a *new* row with provenance = 'user_override', never
-- an UPDATE of an existing synced record). No UPDATE/DELETE grant on any of
-- the four: ordinary synced rows are worker-written only, and even a
-- user-initiated correction is expressed as a new INSERT, not an UPDATE.

alter table activity enable row level security;
grant select, insert on activity to authenticated;
create policy activity_select_authorized on activity
  for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only'));
create policy activity_insert_managed on activity
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'full_management');

alter table workout enable row level security;
grant select, insert on workout to authenticated;
create policy workout_select_authorized on workout
  for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only'));
create policy workout_insert_managed on workout
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'full_management');

alter table sleep enable row level security;
grant select, insert on sleep to authenticated;
create policy sleep_select_authorized on sleep
  for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only'));
create policy sleep_insert_managed on sleep
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'full_management');

alter table recovery enable row level security;
grant select, insert on recovery to authenticated;
create policy recovery_select_authorized on recovery
  for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only'));
create policy recovery_insert_managed on recovery
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'full_management');
