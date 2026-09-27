-- Phase 1 — Layer 2: Row Level Security — Recipe, RecipeVersion,
-- RecipeIngredient, RecipeInstruction, RecipePersonalizedVariant.

-- ============================================================
-- recipe
-- ============================================================
alter table recipe enable row level security;

grant select, insert, update, delete on recipe to authenticated;

create policy recipe_select_readable on recipe
  for select to authenticated
  using (can_read_recipe(id));

create policy recipe_insert_own on recipe
  for insert to authenticated
  with check (
    created_by_account_id = auth.uid()
    and (created_by_profile_id is null or profile_access_scope(created_by_profile_id) = 'full_management')
  );

-- Row-level only: this permits updating the row (e.g. visibility,
-- current_version_id) once the caller manages the recipe. It cannot itself
-- restrict which columns change — canonical_title is documented as edited
-- indirectly via a new RecipeVersion, not this row directly; see the RLS
-- Security Report's Outstanding Issues for this residual, low-severity gap
-- (self-inflicted data-quality risk only, not a cross-profile exposure).
create policy recipe_update_managed on recipe
  for update to authenticated
  using (can_manage_recipe(id))
  with check (can_manage_recipe(id));

create policy recipe_delete_managed on recipe
  for delete to authenticated
  using (can_manage_recipe(id));

-- ============================================================
-- recipe_version
-- ============================================================
alter table recipe_version enable row level security;

-- No UPDATE/DELETE grant: immutable once created (Layer 1 trigger blocks
-- UPDATE regardless); a new version is a new row, never an edited one.
grant select, insert on recipe_version to authenticated;

create policy recipe_version_select_readable on recipe_version
  for select to authenticated
  using (can_read_recipe(recipe_id));

create policy recipe_version_insert_managed on recipe_version
  for insert to authenticated
  with check (can_manage_recipe(recipe_id));

-- ============================================================
-- recipe_ingredient
-- ============================================================
alter table recipe_ingredient enable row level security;

grant select, insert on recipe_ingredient to authenticated;

create policy recipe_ingredient_select_readable on recipe_ingredient
  for select to authenticated
  using (
    can_read_recipe((select rv.recipe_id from recipe_version rv where rv.id = recipe_ingredient.recipe_version_id))
  );

create policy recipe_ingredient_insert_managed on recipe_ingredient
  for insert to authenticated
  with check (
    can_manage_recipe((select rv.recipe_id from recipe_version rv where rv.id = recipe_ingredient.recipe_version_id))
  );

-- ============================================================
-- recipe_instruction
-- ============================================================
alter table recipe_instruction enable row level security;

grant select, insert on recipe_instruction to authenticated;

create policy recipe_instruction_select_readable on recipe_instruction
  for select to authenticated
  using (
    can_read_recipe((select rv.recipe_id from recipe_version rv where rv.id = recipe_instruction.recipe_version_id))
  );

create policy recipe_instruction_insert_managed on recipe_instruction
  for insert to authenticated
  with check (
    can_manage_recipe((select rv.recipe_id from recipe_version rv where rv.id = recipe_instruction.recipe_version_id))
  );

-- ============================================================
-- recipe_personalized_variant
-- ============================================================
alter table recipe_personalized_variant enable row level security;

-- Never shared/public (00_Master.md §11.3) — Profile-scoped only, unlike the
-- base Recipe, which visibility can make broadly readable.
grant select, insert, update on recipe_personalized_variant to authenticated;

create policy recipe_personalized_variant_select_authorized on recipe_personalized_variant
  for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only'));

create policy recipe_personalized_variant_insert_managed on recipe_personalized_variant
  for insert to authenticated
  with check (profile_access_scope(profile_id) = 'full_management');

-- UPDATE covers accepting an AI-generated suggestion (setting
-- user_accepted_at) or adjusting adjustments_payload before acceptance.
create policy recipe_personalized_variant_update_managed on recipe_personalized_variant
  for update to authenticated
  using (profile_access_scope(profile_id) = 'full_management')
  with check (profile_access_scope(profile_id) = 'full_management');
