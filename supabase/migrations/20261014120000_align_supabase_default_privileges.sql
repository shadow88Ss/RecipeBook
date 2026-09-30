-- Layer 12A.1 — align a hosted Supabase project's privileges with the
-- validated privilege model (docs/40_Development_Environment.md §2).
--
-- A hosted Supabase project ships with
--   alter default privileges for role postgres in schema public
--     grant all on tables | functions | sequences to anon, authenticated, service_role;
-- so every object created by migrations 1-45 was also granted ALL to `anon`
-- and `authenticated`, on top of the explicit, per-object grants each
-- migration makes. Those migrations only `revoke ... from public`, which does
-- not remove a direct role grant. Found on the first DEV deployment:
-- `anon` could SELECT/INSERT/UPDATE/DELETE every table (still filtered by
-- RLS; every policy is `to authenticated`) and could EXECUTE internal
-- helpers such as meal_item_chain_root and enabled_provider_routes.
--
-- This migration changes privileges only. No table, policy, trigger,
-- function body, or row changes. It:
--   1. stops the automatic grants for objects that later migrations create;
--   2. removes every direct privilege `anon` and `authenticated` hold on
--      public tables, sequences and routines;
--   3. re-grants exactly the set that the migration chain grants explicitly
--      (generated mechanically from a clean build without Supabase default
--      privileges: 117 table privileges and 18 function grants to
--      `authenticated`; nothing to `anon`).
-- Routines that the chain leaves executable by PUBLIC (the two gtin_*
-- helpers and the trigger functions) are untouched. `service_role` is not
-- touched: no feature uses it and the API never holds its key.
--
-- On a database without Supabase default privileges (the local test
-- harness before it emulated them), steps 1-2 are no-ops and step 3 re-grants
-- what already exists, so the result is identical everywhere.

-- 1. Future objects: no automatic grants to anon/authenticated.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

-- 2. Existing objects: drop every direct grant to anon/authenticated.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all routines in schema public from anon, authenticated;

-- 3. Re-grant the validated set (unchanged from migrations 1-45).
grant select, insert, update on public.account to authenticated;
grant select, insert on public.activity to authenticated;
grant select on public.ai_extraction to authenticated;
grant select, insert, update on public.auth_identity to authenticated;
grant select on public.barcode to authenticated;
grant select, insert, update on public.child_profile_extension to authenticated;
grant select, insert on public.clinician_target to authenticated;
grant select, insert, update on public.device_session to authenticated;
grant select, insert on public.effective_target_snapshot to authenticated;
grant select, insert, update on public.external_provider to authenticated;
grant select, insert, update on public.external_provider_capability to authenticated;
grant select on public.food to authenticated;
grant select on public.food_alias to authenticated;
grant select on public.food_nutrient to authenticated;
grant select on public.food_serving to authenticated;
grant select, insert, update, delete on public.goal to authenticated;
grant select, insert, update on public.grocery_item_already_have to authenticated;
grant select, insert, update on public.grocery_item_shopping_adjustment to authenticated;
grant select, insert on public.grocery_list to authenticated;
grant select, insert on public.grocery_list_item to authenticated;
grant select, insert on public.grocery_list_item_source to authenticated;
grant select, insert, update on public.grocery_manual_item to authenticated;
grant select, insert, update on public.grocery_purchase to authenticated;
grant select, insert, update on public.guardian_authorization to authenticated;
grant select, insert on public.import_job to authenticated;
grant select, insert, update on public.meal_item to authenticated;
grant select, insert, update on public.meal_log to authenticated;
grant select, insert, update on public.meal_plan to authenticated;
grant select, insert on public.meal_plan_day to authenticated;
grant select on public.nutrient to authenticated;
grant select, insert on public.nutrition_target to authenticated;
grant select, insert, update on public.planned_actual_link to authenticated;
grant select, insert on public.planned_meal to authenticated;
grant select, insert, update on public.planned_meal_item to authenticated;
grant select, insert, update on public.planned_meal_item_skip to authenticated;
grant select on public.platform_role_assignment to authenticated;
grant select on public.product to authenticated;
grant select on public.product_label_version to authenticated;
grant select on public.product_nutrient to authenticated;
grant select on public.product_serving to authenticated;
grant select, insert, update, delete on public.profile to authenticated;
grant select on public.provider_capability_definition to authenticated;
grant select on public.raw_content to authenticated;
grant select, insert, update, delete on public.recipe to authenticated;
grant select, insert on public.recipe_ingredient to authenticated;
grant select, insert on public.recipe_instruction to authenticated;
grant select, insert, update on public.recipe_personalized_variant to authenticated;
grant select, insert on public.recipe_version to authenticated;
grant select, insert on public.recovery to authenticated;
grant select, insert on public.sleep to authenticated;
grant select, insert, update on public.wearable_connection to authenticated;
grant select, insert on public.weight_measurement to authenticated;
grant select, insert on public.workout to authenticated;

grant execute on function public.current_account_id() to authenticated;
grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.profile_access_scope(uuid) to authenticated;
grant execute on function public.can_read_recipe(uuid) to authenticated;
grant execute on function public.can_manage_recipe(uuid) to authenticated;
grant execute on function public.is_child_profile_created_by_caller(uuid) to authenticated;
grant execute on function public.search_foods(text, text[], integer) to authenticated;
grant execute on function public.create_recipe_version(uuid, uuid, uuid, jsonb) to authenticated;
grant execute on function public.correct_meal_item(uuid, uuid, uuid, jsonb, text) to authenticated;
grant execute on function public.write_planned_meal_items(uuid, uuid, uuid, uuid, jsonb) to authenticated;
grant execute on function public.confirm_meal_plan(uuid, uuid, jsonb) to authenticated;
grant execute on function public.generate_grocery_list(uuid, uuid, jsonb) to authenticated;
grant execute on function public.log_meal_items(uuid, uuid, jsonb) to authenticated;
grant execute on function public.external_provider_audit_history(uuid) to authenticated;
grant execute on function public.external_provider_connection_counts() to authenticated;
grant execute on function public.admin_register_external_provider(jsonb) to authenticated;
grant execute on function public.admin_update_external_provider(text, jsonb) to authenticated;
grant execute on function public.enabled_provider_routes(public.provider_family, text) to authenticated;
