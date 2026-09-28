-- Phase 2 — Layer 7C: canonical nutrition target vocabulary.
--
-- Additive. No earlier migration is edited, no existing target row is
-- rewritten, no RLS policy changes.
--
-- 1. target_field_alias — the approved INPUT aliases (identical to
--    api/src/domain/nutritionTargets/targetVocabulary.ts; a test compares
--    them). An alias is never a stored identity.
-- 2. New nutrition_target / clinician_target rows must use a canonical
--    nutrient key (Layer 5C `nutrient.canonical_key`) as field_name and that
--    nutrient's reporting unit exactly. The API normalizes aliases/units
--    before insert; this trigger is the backstop for any other writer.
--    It fires on INSERT only: rows written before this layer keep their
--    stored field_name/unit (never silently rewritten); the resolver
--    interprets them through the same alias map or reports them as
--    unresolved.
-- 3. The supersede triggers (last redefined by
--    20260825121350_rls_fix_supersede_triggers.sql, SECURITY DEFINER) now
--    also supersede the Profile's active rows stored under an ALIAS of the
--    new canonical key — so a new `energy` target replaces a legacy active
--    `calories` row instead of coexisting with it. Supersession only sets
--    is_active/superseded_at, as before; values are untouched.

-- ------------------------------------------------------------------
-- 1. Alias map
-- ------------------------------------------------------------------
create table target_field_alias (
  alias text primary key,
  canonical_key text not null references nutrient (canonical_key),
  implied_unit text,
  constraint target_field_alias_not_canonical check (alias <> canonical_key)
);

alter table target_field_alias enable row level security;
-- No grants: read only by the SECURITY DEFINER trigger functions below.

insert into target_field_alias (alias, canonical_key, implied_unit)
select n.canonical_key || '_' || n.unit, n.canonical_key, n.unit
  from nutrient n
 where n.canonical_key in (
   'energy', 'protein', 'carbohydrate', 'fat', 'fiber',
   'sodium', 'potassium', 'calcium', 'iron', 'magnesium', 'zinc',
   'vitamin_a', 'vitamin_c', 'vitamin_d', 'vitamin_e', 'vitamin_k',
   'thiamin', 'riboflavin', 'niacin', 'vitamin_b6', 'folate', 'vitamin_b12'
 );

insert into target_field_alias (alias, canonical_key, implied_unit) values
  ('calories', 'energy', 'kcal'),
  ('calorie', 'energy', 'kcal'),
  ('carbs', 'carbohydrate', null),
  ('carbohydrates', 'carbohydrate', null);

-- ------------------------------------------------------------------
-- 2. Canonical key + unit on new rows
-- ------------------------------------------------------------------
create or replace function enforce_canonical_target()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit text;
begin
  select n.unit into v_unit from nutrient n where n.canonical_key = new.field_name;
  if not found then
    raise exception 'field_name must be a canonical target key'
      using errcode = '23514', constraint = 'target_canonical_key';
  end if;
  if new.unit is distinct from v_unit then
    raise exception 'unit must be the canonical reporting unit of %', new.field_name
      using errcode = '23514', constraint = 'target_canonical_unit';
  end if;
  return new;
end;
$$;

revoke all on function enforce_canonical_target() from public;

-- Named to sort before trg_*_supersede so validation runs first.
create trigger trg_nutrition_target_canonical
  before insert on nutrition_target
  for each row execute function enforce_canonical_target();

create trigger trg_clinician_target_canonical
  before insert on clinician_target
  for each row execute function enforce_canonical_target();

-- ------------------------------------------------------------------
-- 3. Supersession covers legacy alias-named rows of the same key
-- ------------------------------------------------------------------
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
        and (field_name = new.field_name
             or field_name in (select a.alias from target_field_alias a where a.canonical_key = new.field_name))
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
        and (field_name = new.field_name
             or field_name in (select a.alias from target_field_alias a where a.canonical_key = new.field_name))
        and id <> new.id
        and is_active = true;
  end if;
  return new;
end;
$$;
