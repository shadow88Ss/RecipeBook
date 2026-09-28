-- Phase 2 — Layer 6A: Recipe Book core.
--
-- Additive only. No existing migration is edited; no Recipe/RecipeVersion/
-- RecipeIngredient/RecipeInstruction column is removed or redefined, and no
-- RLS policy is broadened.
--
-- 1. RecipeIngredient -> FoodServing. A recipe ingredient's amount is either
--    `quantity` + a Layer 5A unit code, or `quantity` x a FoodServing of the
--    ingredient's own Food ("2 x 1 slice"). The Layer 1 table had no way to
--    reference a FoodServing, so `food_serving_id` is added. The serving must
--    belong to the ingredient's Food (composite FK), requires a Food, and is
--    exclusive with `unit`. The quantity itself is recipe-specific input: it
--    never creates or modifies a global FoodServing.
-- 2. Recipe.current_version_id must point to a version of the SAME recipe
--    (Data Dictionary §19 "must point to a version of this Recipe" — stated
--    but previously unenforced).
-- 3. create_recipe_version(): writes one complete, immutable RecipeVersion
--    (and, for a new recipe, its Recipe) with its ingredients and
--    instructions, then moves current_version_id, in ONE transaction.
--    SECURITY INVOKER — every statement runs as the caller under the
--    existing Recipe-family RLS policies (recipe_insert_own,
--    recipe_version_insert_managed, recipe_ingredient_insert_managed,
--    recipe_instruction_insert_managed, recipe_update_managed). It grants
--    nothing the caller could not already do statement by statement; it only
--    makes the multi-row write atomic and serializes version numbering.

-- ------------------------------------------------------------------
-- 1. RecipeIngredient.food_serving_id
-- ------------------------------------------------------------------
alter table food_serving
  add constraint uq_food_serving_id_food unique (id, food_id);

alter table recipe_ingredient
  add column food_serving_id uuid,
  add constraint fk_recipe_ingredient_food_serving
    foreign key (food_serving_id, food_id) references food_serving (id, food_id),
  add constraint recipe_ingredient_serving_requires_food
    check (food_serving_id is null or food_id is not null),
  add constraint recipe_ingredient_unit_xor_serving
    check (not (food_serving_id is not null and unit is not null)),
  add constraint recipe_ingredient_amount_requires_quantity
    check ((unit is null and food_serving_id is null) or quantity is not null);

create index idx_recipe_ingredient_food_serving_id on recipe_ingredient (food_serving_id) where food_serving_id is not null;

-- ------------------------------------------------------------------
-- 2. current_version_id belongs to this recipe
-- ------------------------------------------------------------------
create or replace function recipe_current_version_belongs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.current_version_id is not null and not exists (
    select 1 from recipe_version rv where rv.id = new.current_version_id and rv.recipe_id = new.id
  ) then
    raise exception 'current_version_id must reference a version of this recipe'
      using errcode = '23514', constraint = 'recipe_current_version_belongs';
  end if;
  return new;
end;
$$;

revoke all on function recipe_current_version_belongs() from public;

create trigger trg_recipe_current_version_belongs
  before insert or update of current_version_id on recipe
  for each row execute function recipe_current_version_belongs();

-- ------------------------------------------------------------------
-- 3. create_recipe_version()
-- ------------------------------------------------------------------
-- p_recipe_id null   -> new private Recipe owned by p_profile_id, version 1.
-- p_recipe_id given  -> next version of that Recipe, which must be managed
--                       by the caller AND attributed to p_profile_id.
-- p_expected_current_version_id (optional) -> optimistic concurrency: the
--                       write is refused (40001) if another version became
--                       current in the meantime.
-- p_content: { title, description, servings,
--              ingredients: [{ raw_ingredient_text, food_id, food_serving_id,
--                              quantity, unit, match_status, match_confidence }],
--              instructions: [text, ...] }
-- Array order is authoritative: sort_order / step_number are 1..n.
create or replace function create_recipe_version(
  p_profile_id uuid,
  p_recipe_id uuid,
  p_expected_current_version_id uuid,
  p_content jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_recipe_id uuid := p_recipe_id;
  v_version_id uuid := gen_random_uuid();
  v_current uuid;
  v_profile uuid;
  v_number integer;
  v_ingredient jsonb;
  v_position integer := 0;
  v_step text;
begin
  if v_recipe_id is null then
    -- Ids are generated here rather than via INSERT ... RETURNING: RETURNING
    -- would evaluate recipe_select_readable against a row the same statement
    -- just wrote.
    v_recipe_id := gen_random_uuid();
    insert into recipe (id, canonical_title, created_by_account_id, created_by_profile_id, visibility)
    values (v_recipe_id, p_content->>'title', auth.uid(), p_profile_id, 'private');
    v_number := 1;
  else
    -- FOR UPDATE applies recipe_update_managed (can_manage_recipe) and
    -- serializes concurrent edits of one recipe.
    select r.current_version_id, r.created_by_profile_id
      into v_current, v_profile
      from recipe r
     where r.id = v_recipe_id
       for update;
    if not found or v_profile is distinct from p_profile_id then
      raise exception 'recipe not found' using errcode = 'P0002';
    end if;
    if p_expected_current_version_id is not null and v_current is distinct from p_expected_current_version_id then
      raise exception 'recipe has a newer current version' using errcode = '40001';
    end if;
    select coalesce(max(rv.version_number), 0) + 1 into v_number from recipe_version rv where rv.recipe_id = v_recipe_id;
  end if;

  insert into recipe_version (id, recipe_id, version_number, title, description, servings, created_by_account_id)
  values (
    v_version_id,
    v_recipe_id,
    v_number,
    p_content->>'title',
    p_content->>'description',
    (p_content->>'servings')::numeric,
    auth.uid()
  );

  for v_ingredient in select value from jsonb_array_elements(coalesce(p_content->'ingredients', '[]'::jsonb)) loop
    v_position := v_position + 1;
    insert into recipe_ingredient
      (recipe_version_id, food_id, food_serving_id, raw_ingredient_text, quantity, unit, match_confidence, match_status, sort_order)
    values (
      v_version_id,
      (v_ingredient->>'food_id')::uuid,
      (v_ingredient->>'food_serving_id')::uuid,
      v_ingredient->>'raw_ingredient_text',
      (v_ingredient->>'quantity')::numeric,
      v_ingredient->>'unit',
      (v_ingredient->>'match_confidence')::numeric,
      (v_ingredient->>'match_status')::recipe_ingredient_match_status,
      v_position
    );
  end loop;

  v_position := 0;
  for v_step in select value from jsonb_array_elements_text(coalesce(p_content->'instructions', '[]'::jsonb)) loop
    v_position := v_position + 1;
    insert into recipe_instruction (recipe_version_id, step_number, instruction_text)
    values (v_version_id, v_position, v_step);
  end loop;

  update recipe
     set current_version_id = v_version_id,
         canonical_title = p_content->>'title'
   where id = v_recipe_id;

  return jsonb_build_object('recipe_id', v_recipe_id, 'recipe_version_id', v_version_id, 'version_number', v_number);
end;
$$;

revoke all on function create_recipe_version(uuid, uuid, uuid, jsonb) from public;
grant execute on function create_recipe_version(uuid, uuid, uuid, jsonb) to authenticated;
