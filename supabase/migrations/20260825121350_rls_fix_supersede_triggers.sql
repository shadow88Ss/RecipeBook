-- Phase 1 — Layer 2: Row Level Security — fix for the NutritionTarget /
-- ClinicianTarget supersede triggers.
--
-- Layer 1 (20260825120400_targets_and_goals.sql) defined
-- supersede_previous_nutrition_target() / supersede_previous_clinician_target()
-- as ordinary (SECURITY INVOKER) trigger functions. Layer 2 deliberately does
-- NOT grant UPDATE on nutrition_target/clinician_target to `authenticated` —
-- only SELECT and INSERT — because is_active/superseded_at must never be
-- client-writable directly (29_Data_Model_Data_Dictionary.md §8/§9).
--
-- Those two properties conflict: an ordinary trigger function executes its
-- body with the INVOKING role's privileges, so the trigger's own internal
-- UPDATE (which supersedes the prior active row) was being rejected with
-- "permission denied for table nutrition_target" — the authenticated client
-- correctly has no UPDATE grant, so even the trigger's on-their-behalf
-- correction was blocked. Found during Layer 2 RLS verification testing.
--
-- Per Master §20's migration rules, the already-approved Layer 1 migration
-- file is not edited. This new migration re-defines the same two functions
-- (CREATE OR REPLACE FUNCTION, not a schema change to any table) as
-- SECURITY DEFINER, so the internal correction UPDATE runs with the
-- function owner's privileges — while the client's own access is still
-- governed entirely by the INSERT-only grant and policy: nothing here gives
-- `authenticated` a new ability to issue its own manual UPDATE.
create or replace function supersede_previous_nutrition_target()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_active then
    update nutrition_target
      set is_active = false, superseded_at = now()
      where profile_id = new.profile_id
        and field_name = new.field_name
        and id <> new.id
        and is_active = true;
  end if;
  return new;
end;
$$;

create or replace function supersede_previous_clinician_target()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_active then
    update clinician_target
      set is_active = false, superseded_at = now()
      where profile_id = new.profile_id
        and field_name = new.field_name
        and id <> new.id
        and is_active = true;
  end if;
  return new;
end;
$$;
