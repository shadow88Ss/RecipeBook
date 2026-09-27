-- Phase 1 — Layer 2: Row Level Security — Food, FoodAlias, FoodServing,
-- Nutrient, FoodNutrient.
--
-- Global, language-neutral reference data (33_Security_and_Privacy.md §6):
-- authenticated clients may read it; writes are restricted to a trusted
-- data-ingestion service workflow (service_role, which bypasses RLS in
-- Supabase by design — no policy is written for it here because none is
-- needed). No INSERT/UPDATE/DELETE policy exists for `authenticated` on any
-- of these five tables, and no privilege is granted for those operations
-- either — both layers deny it, not just RLS.

alter table food enable row level security;
alter table food_alias enable row level security;
alter table food_serving enable row level security;
alter table nutrient enable row level security;
alter table food_nutrient enable row level security;

grant select on food, food_alias, food_serving, nutrient, food_nutrient to authenticated;

create policy food_select_all on food
  for select to authenticated
  using (true);

create policy food_alias_select_all on food_alias
  for select to authenticated
  using (true);

create policy food_serving_select_all on food_serving
  for select to authenticated
  using (true);

create policy nutrient_select_all on nutrient
  for select to authenticated
  using (true);

create policy food_nutrient_select_all on food_nutrient
  for select to authenticated
  using (true);
