-- Phase 1 — Layer 2: Row Level Security — MealLog, MealItem.

-- ============================================================
-- meal_log
-- ============================================================
alter table meal_log enable row level security;

grant select, insert, update on meal_log to authenticated;

create policy meal_log_select_authorized on meal_log
  for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only'));

create policy meal_log_insert_managed on meal_log
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'full_management');

create policy meal_log_update_managed on meal_log
  for update to authenticated
  using (profile_access_scope(profile_id) = 'full_management')
  with check (profile_access_scope(profile_id) = 'full_management');

-- No DELETE policy: not a documented client operation (meal_log has no
-- lifecycle state of its own — see 29_Data_Model.md §12).

-- ============================================================
-- meal_item
-- ============================================================
alter table meal_item enable row level security;

grant select, insert, update on meal_item to authenticated;

create policy meal_item_select_authorized on meal_item
  for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only'));

-- view_only cannot write, per 33_Security_and_Privacy.md §8's access-mode
-- column and this migration's consistent full_management-for-writes rule.
create policy meal_item_insert_managed on meal_item
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'full_management');

-- The Layer 1 state-machine trigger (enforce_meal_item_status_transition)
-- still gates *which* status changes are legal and freezes consumed rows
-- regardless of this policy — RLS only gates *who* may attempt an update at
-- all. The two layers are independent and both must pass.
create policy meal_item_update_managed on meal_item
  for update to authenticated
  using (profile_access_scope(profile_id) = 'full_management')
  with check (profile_access_scope(profile_id) = 'full_management');

-- No DELETE policy: items are cancelled/skipped via status update, never
-- deleted (00_Master.md §6).
