-- Phase 2 — Layer 5C: nutrient vocabulary & data authority.
--
-- 1. Nutrient.role — explicit, deterministic classification (energy /
--    macronutrient / fiber / micronutrient / other) so no feature ever infers
--    a nutrient's role from a display string. The nutrition engine itself
--    stays key-agnostic; role is metadata for projections and analytics.
-- 2. Role <-> reporting-unit consistency: energy is reported in kcal only,
--    macronutrients and fiber in g, micronutrients in mg or mcg. IU is not a
--    permitted micronutrient reporting unit (no approved IU <-> mass
--    conversion exists), and kJ is not a permitted energy unit (no approved
--    kcal <-> kJ policy exists).
-- 3. Exactly one canonical energy identity.
-- 4. The canonical platform vocabulary, seeded here as platform metadata
--    (not food data). Keys are language-independent; translated labels
--    belong to a separate (nutrient_id, locale) lookup, never new rows.
--    Must stay identical to api/src/domain/nutrition/vocabulary.ts — a test
--    compares the two.
-- 5. Global reference tables may not hold personal data: a user-entered
--    serving weight or density is user-confirmed personal data, but
--    food_serving and food have no owner column, so such a row would be
--    readable by, and reused for, every account. Both are now rejected.
--    A profile-scoped serving/measurement mechanism is future work.

create type nutrient_role as enum ('energy', 'macronutrient', 'fiber', 'micronutrient', 'other');

alter table nutrient
  add column role nutrient_role not null default 'other',
  add constraint nutrient_role_reporting_unit check (
    (role = 'energy' and unit = 'kcal')
    or (role in ('macronutrient', 'fiber') and unit = 'g')
    or (role = 'micronutrient' and unit in ('mg', 'mcg'))
    or role = 'other'
  );

create unique index uq_nutrient_single_energy on nutrient (role) where role = 'energy';

do $$
declare
  vocabulary constant jsonb := '[
    ["energy", "energy", "kcal"],
    ["protein", "macronutrient", "g"],
    ["carbohydrate", "macronutrient", "g"],
    ["fat", "macronutrient", "g"],
    ["fiber", "fiber", "g"],
    ["sodium", "micronutrient", "mg"],
    ["potassium", "micronutrient", "mg"],
    ["calcium", "micronutrient", "mg"],
    ["iron", "micronutrient", "mg"],
    ["magnesium", "micronutrient", "mg"],
    ["zinc", "micronutrient", "mg"],
    ["vitamin_a", "micronutrient", "mcg"],
    ["vitamin_c", "micronutrient", "mg"],
    ["vitamin_d", "micronutrient", "mcg"],
    ["vitamin_e", "micronutrient", "mg"],
    ["vitamin_k", "micronutrient", "mcg"],
    ["thiamin", "micronutrient", "mg"],
    ["riboflavin", "micronutrient", "mg"],
    ["niacin", "micronutrient", "mg"],
    ["vitamin_b6", "micronutrient", "mg"],
    ["folate", "micronutrient", "mcg"],
    ["vitamin_b12", "micronutrient", "mcg"]
  ]';
  entry jsonb;
  existing record;
begin
  for entry in select * from jsonb_array_elements(vocabulary) loop
    select canonical_key, unit into existing from nutrient where canonical_key = entry->>0;
    if found and existing.unit <> entry->>2 then
      -- Never silently re-unit existing data: every FoodNutrient amount is
      -- expressed in its Nutrient's unit.
      raise exception 'Nutrient % already exists with unit %, vocabulary requires %', entry->>0, existing.unit, entry->>2;
    end if;
    insert into nutrient (canonical_key, unit, role)
    values (entry->>0, entry->>2, (entry->>1)::nutrient_role)
    on conflict (canonical_key) do update set role = excluded.role;
  end loop;
end $$;

alter table food_serving
  add constraint food_serving_no_personal_source check (source <> 'user_entered');

alter table food
  add constraint food_density_no_personal_source check (density_source is distinct from 'user_entered');
