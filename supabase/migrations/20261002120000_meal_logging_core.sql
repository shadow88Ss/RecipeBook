-- Phase 2 — Layer 7A: Food & Meal Logging core.
--
-- Additive. No earlier migration is edited. Layer 1's
-- enforce_meal_item_status_transition() is REDEFINED here (create or
-- replace) only to freeze every column of a consumed row, including the new
-- snapshot columns, during the one permitted supersession UPDATE. No RLS
-- policy is added or broadened; AuditEvent gains no client grant.
--
--  1. MealLog: local_timezone (IANA identifier; logged_date is the
--     Profile-local calendar date in it) and optional notes.
--  2. MealItem: unit; nutrition_snapshot / nutrition_calculation_version /
--     nutrition_calculated_at (required once consumed); Food-vs-Recipe
--     invariant; amount-form rules; serving belongs to its Food.
--  3. MealItem.profile_id = its MealLog's profile_id (composite FK).
--  4. A recipe MealItem references a RecipeVersion of a Recipe owned by the
--     SAME Profile.
--  5. consumed_at of a consumed item falls on the MealLog's logged_date in
--     its local_timezone; a MealLog's date/timezone freeze once it holds a
--     consumed item.
--  6. Corrections: one correction per original, targeting a consumed,
--     not-yet-superseded item of the same MealLog; the original must be
--     superseded by that correction in the same transaction (deferred
--     check); supersession writes an AuditEvent via a SECURITY DEFINER
--     trigger that derives every field itself.
--  7. log_meal_items() / correct_meal_item(): SECURITY INVOKER, atomic
--     writes under the caller's existing RLS.

-- ------------------------------------------------------------------
-- 1. MealLog
-- ------------------------------------------------------------------
alter table meal_log
  add column local_timezone text,
  add column notes text,
  add constraint meal_log_notes_length check (notes is null or char_length(notes) <= 2000),
  -- NOT VALID: binds every new/updated row, without rewriting any
  -- pre-existing row (none are written by any API before this layer).
  add constraint meal_log_local_timezone_required check (local_timezone is not null) not valid;

alter table meal_log
  add constraint uq_meal_log_id_profile unique (id, profile_id);

create or replace function meal_log_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.local_timezone is not null
     and (new.local_timezone !~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$|^UTC$'
          or not exists (select 1 from pg_timezone_names where name = new.local_timezone)) then
    raise exception 'local_timezone must be an IANA time zone identifier'
      using errcode = '22023', constraint = 'meal_log_local_timezone_valid';
  end if;
  if tg_op = 'UPDATE'
     and (new.logged_date is distinct from old.logged_date or new.local_timezone is distinct from old.local_timezone)
     and exists (select 1 from meal_item mi where mi.meal_log_id = old.id and mi.status = 'consumed') then
    raise exception 'logged_date and local_timezone are fixed once the meal holds consumed items'
      using errcode = '23514', constraint = 'meal_log_consumed_date_fixed';
  end if;
  return new;
end;
$$;

revoke all on function meal_log_integrity() from public;

create trigger trg_meal_log_integrity
  before insert or update on meal_log
  for each row execute function meal_log_integrity();

-- ------------------------------------------------------------------
-- 2/3. MealItem columns and invariants
-- ------------------------------------------------------------------
alter table meal_item
  add column unit text,
  add column nutrition_snapshot jsonb,
  add column nutrition_calculation_version text,
  add column nutrition_calculated_at timestamptz,
  -- Food vs Recipe: never both; a consumed item is exactly one.
  add constraint meal_item_single_source check (not (food_id is not null and recipe_version_id is not null)),
  add constraint meal_item_consumed_has_source check (status <> 'consumed' or num_nonnulls(food_id, recipe_version_id) = 1),
  -- Recipe item: quantity = servings of the version; no unit/serving.
  add constraint meal_item_recipe_amount check (recipe_version_id is null or (food_serving_id is null and unit is null)),
  -- Food amount: unit xor serving (a consumed food item needs exactly one).
  add constraint meal_item_unit_xor_serving check (not (unit is not null and food_serving_id is not null)),
  add constraint meal_item_amount_requires_food check ((unit is null and food_serving_id is null) or food_id is not null),
  add constraint meal_item_consumed_food_amount check (status <> 'consumed' or food_id is null or num_nonnulls(unit, food_serving_id) = 1),
  add constraint meal_item_variant_requires_version check (recipe_personalized_variant_id is null or recipe_version_id is not null),
  -- A consumed item always carries its historical nutrition record.
  add constraint meal_item_consumed_snapshot check (
    status <> 'consumed'
    or (nutrition_snapshot is not null and nutrition_calculation_version is not null and nutrition_calculated_at is not null and consumed_at is not null)
  ),
  add constraint fk_meal_item_food_serving_food
    foreign key (food_serving_id, food_id) references food_serving (id, food_id),
  add constraint fk_meal_item_meal_log_profile
    foreign key (meal_log_id, profile_id) references meal_log (id, profile_id) on delete cascade;

create unique index uq_meal_item_corrects on meal_item (corrects_meal_item_id) where corrects_meal_item_id is not null;
create index idx_meal_item_meal_log_status on meal_item (meal_log_id, status);

-- Insert-time invariants that need other rows (read with definer rights so
-- they hold regardless of what the caller can see; nothing is returned).
create or replace function meal_item_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_log meal_log%rowtype;
  v_original meal_item%rowtype;
begin
  -- 4. same-Profile Recipe Book only
  if new.recipe_version_id is not null and not exists (
    select 1 from recipe_version rv join recipe r on r.id = rv.recipe_id
     where rv.id = new.recipe_version_id and r.created_by_profile_id = new.profile_id
  ) then
    raise exception 'recipe_version_id must belong to a recipe of the same profile'
      using errcode = '23514', constraint = 'meal_item_recipe_same_profile';
  end if;

  if tg_op = 'INSERT' then
    -- 5. local day
    if new.status = 'consumed' then
      select * into v_log from meal_log where id = new.meal_log_id;
      if v_log.local_timezone is null then
        raise exception 'the meal has no local_timezone'
          using errcode = '23514', constraint = 'meal_item_consumed_local_day';
      end if;
      if (new.consumed_at at time zone v_log.local_timezone)::date <> v_log.logged_date then
        raise exception 'consumed_at is not on the meal''s logged_date in its local_timezone'
          using errcode = '23514', constraint = 'meal_item_consumed_local_day';
      end if;
    end if;

    -- 6. correction target
    if new.corrects_meal_item_id is not null then
      select * into v_original from meal_item where id = new.corrects_meal_item_id;
      if not found
         or v_original.meal_log_id <> new.meal_log_id
         or v_original.status <> 'consumed'
         or v_original.superseded_by_meal_item_id is not null
         or new.status <> 'consumed' then
        raise exception 'a correction must be consumed and target a consumed, not yet superseded item of the same meal'
          using errcode = '23514', constraint = 'meal_item_correction_target';
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function meal_item_integrity() from public;

create trigger trg_meal_item_integrity
  before insert or update of recipe_version_id, profile_id on meal_item
  for each row execute function meal_item_integrity();

-- 6. A correction must supersede its original before commit.
create or replace function meal_item_correction_completed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from meal_item o where o.id = new.corrects_meal_item_id and o.superseded_by_meal_item_id = new.id
  ) then
    raise exception 'a correction must supersede its original in the same transaction'
      using errcode = '23514', constraint = 'meal_item_correction_completed';
  end if;
  return null;
end;
$$;

revoke all on function meal_item_correction_completed() from public;

create constraint trigger trg_meal_item_correction_completed
  after insert on meal_item
  deferrable initially deferred
  for each row when (new.corrects_meal_item_id is not null)
  execute function meal_item_correction_completed();

-- ------------------------------------------------------------------
-- Consumed immutability (redefines the Layer 1 function; same trigger).
-- Identical to Layer 1 except the supersession branch: that one UPDATE may
-- change superseded_by_meal_item_id (once, to a correction of this row)
-- and nothing else — every other column, including snapshot, quantity,
-- source, unit, times and correction fields, is compared as a whole.
-- ------------------------------------------------------------------
create or replace function enforce_meal_item_status_transition()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'consumed' then
    if new.superseded_by_meal_item_id is distinct from old.superseded_by_meal_item_id then
      if old.superseded_by_meal_item_id is not null then
        raise exception 'meal_item %: superseded_by_meal_item_id already set, cannot change', old.id;
      end if;
      if (to_jsonb(new) - 'superseded_by_meal_item_id' - 'updated_at') is distinct from (to_jsonb(old) - 'superseded_by_meal_item_id' - 'updated_at') then
        raise exception 'meal_item %: consumed items are immutable except for superseded_by_meal_item_id', old.id;
      end if;
      if not exists (
        select 1 from meal_item c where c.id = new.superseded_by_meal_item_id and c.corrects_meal_item_id = old.id
      ) then
        raise exception 'meal_item %: superseded_by_meal_item_id must reference a correction of this item', old.id;
      end if;
      return new;
    else
      raise exception 'meal_item %: consumed items are immutable', old.id;
    end if;
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'draft' and new.status in ('planned', 'cancelled'))
      or (old.status = 'planned' and new.status in ('confirmed', 'cancelled', 'skipped'))
      or (old.status = 'confirmed' and new.status in ('consumed', 'cancelled', 'skipped'))
    ) then
      raise exception 'meal_item %: invalid status transition % -> %', old.id, old.status, new.status;
    end if;

    if new.status = 'confirmed' and new.confirmed_at is null then
      new.confirmed_at = now();
    end if;
    if new.status = 'consumed' and new.consumed_at is null then
      new.consumed_at = now();
    end if;
  end if;

  return new;
end;
$$;

-- ------------------------------------------------------------------
-- 6. Correction audit. Fires only on the one legitimate supersession of a
-- consumed item (checked above). Every field is derived here — the caller
-- supplies nothing. The payload is ids only: no quantities, nutrition,
-- notes or reason text (Data Dictionary §33: no health/child content).
-- ------------------------------------------------------------------
create or replace function audit_meal_item_correction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into audit_event (actor_account_id, actor_type, event_type, subject_type, subject_id, event_payload, occurred_at)
  values (
    auth.uid(),
    case when auth.uid() is null then 'system'::audit_actor_type else 'user'::audit_actor_type end,
    'meal_item_corrected',
    'meal_item',
    old.id,
    jsonb_build_object(
      'original_meal_item_id', old.id,
      'correction_meal_item_id', new.superseded_by_meal_item_id,
      'meal_log_id', old.meal_log_id,
      'profile_id', old.profile_id
    ),
    now()
  );
  return null;
end;
$$;

revoke all on function audit_meal_item_correction() from public;

create trigger trg_meal_item_correction_audit
  after update of superseded_by_meal_item_id on meal_item
  for each row
  when (old.status = 'consumed' and old.superseded_by_meal_item_id is null and new.superseded_by_meal_item_id is not null)
  execute function audit_meal_item_correction();

-- ------------------------------------------------------------------
-- 7. Atomic writes (SECURITY INVOKER — existing RLS applies to every
-- statement; they add atomicity, not privileges).
-- ------------------------------------------------------------------

-- p_payload: { meal: { meal_type, logged_date, local_timezone, notes },
-- items: [{ food_id, food_serving_id, unit, recipe_version_id, quantity,
-- consumed_at, nutrition_snapshot, nutrition_calculation_version }] }.
-- p_meal_log_id null -> new MealLog from payload.meal; otherwise items are
-- added to that MealLog, which must belong to p_profile_id. Every item is
-- written as consumed.
create or replace function log_meal_items(p_profile_id uuid, p_meal_log_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_meal_log_id uuid := p_meal_log_id;
  v_item jsonb;
  v_item_id uuid;
  v_ids jsonb := '[]'::jsonb;
  -- now() is fixed for the whole transaction, so items written together
  -- would tie on created_at; a strictly increasing value keeps their
  -- order (the order they were logged in) deterministic.
  v_created_at timestamptz;
begin
  if v_meal_log_id is null then
    v_meal_log_id := gen_random_uuid();
    insert into meal_log (id, profile_id, meal_type, logged_date, local_timezone, notes)
    values (
      v_meal_log_id,
      p_profile_id,
      (p_payload->'meal'->>'meal_type')::meal_type,
      (p_payload->'meal'->>'logged_date')::date,
      p_payload->'meal'->>'local_timezone',
      p_payload->'meal'->>'notes'
    );
  elsif not exists (select 1 from meal_log where id = v_meal_log_id and profile_id = p_profile_id) then
    raise exception 'meal log not found' using errcode = 'P0002';
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_payload->'items', '[]'::jsonb)) loop
    v_item_id := gen_random_uuid();
    v_created_at := greatest(clock_timestamp(), coalesce(v_created_at + interval '1 microsecond', clock_timestamp()));
    insert into meal_item (
      id, meal_log_id, profile_id, food_id, food_serving_id, unit, recipe_version_id, quantity,
      status, consumed_at, status_changed_by_actor_type, status_changed_by_account_id,
      nutrition_snapshot, nutrition_calculation_version, nutrition_calculated_at, created_at
    ) values (
      v_item_id,
      v_meal_log_id,
      p_profile_id,
      (v_item->>'food_id')::uuid,
      (v_item->>'food_serving_id')::uuid,
      v_item->>'unit',
      (v_item->>'recipe_version_id')::uuid,
      (v_item->>'quantity')::numeric,
      'consumed',
      (v_item->>'consumed_at')::timestamptz,
      'user',
      auth.uid(),
      v_item->'nutrition_snapshot',
      v_item->>'nutrition_calculation_version',
      now(),
      v_created_at
    );
    v_ids := v_ids || to_jsonb(v_item_id);
  end loop;

  return jsonb_build_object('meal_log_id', v_meal_log_id, 'meal_item_ids', v_ids);
end;
$$;

revoke all on function log_meal_items(uuid, uuid, jsonb) from public;
grant execute on function log_meal_items(uuid, uuid, jsonb) to authenticated;

-- Locks the original (FOR UPDATE applies the meal_item UPDATE policies),
-- inserts the consumed correction with its own snapshot, and supersedes the
-- original. The audit trigger fires on the supersession. All or nothing.
create or replace function correct_meal_item(
  p_profile_id uuid,
  p_meal_log_id uuid,
  p_original_id uuid,
  p_item jsonb,
  p_correction_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_original meal_item%rowtype;
  v_correction_id uuid := gen_random_uuid();
begin
  select * into v_original
    from meal_item
   where id = p_original_id and meal_log_id = p_meal_log_id and profile_id = p_profile_id
     for update;
  if not found then
    raise exception 'meal item not found' using errcode = 'P0002';
  end if;
  if v_original.status <> 'consumed' then
    raise exception 'only a consumed item can be corrected' using errcode = '55000';
  end if;
  if v_original.superseded_by_meal_item_id is not null then
    raise exception 'meal item has already been corrected' using errcode = '55006';
  end if;

  insert into meal_item (
    id, meal_log_id, profile_id, food_id, food_serving_id, unit, recipe_version_id, quantity,
    status, consumed_at, status_changed_by_actor_type, status_changed_by_account_id,
    corrects_meal_item_id, correction_reason,
    nutrition_snapshot, nutrition_calculation_version, nutrition_calculated_at, created_at
  ) values (
    v_correction_id,
    p_meal_log_id,
    p_profile_id,
    (p_item->>'food_id')::uuid,
    (p_item->>'food_serving_id')::uuid,
    p_item->>'unit',
    (p_item->>'recipe_version_id')::uuid,
    (p_item->>'quantity')::numeric,
    'consumed',
    (p_item->>'consumed_at')::timestamptz,
    'user',
    auth.uid(),
    p_original_id,
    p_correction_reason,
    p_item->'nutrition_snapshot',
    p_item->>'nutrition_calculation_version',
    now(),
    clock_timestamp()
  );

  update meal_item set superseded_by_meal_item_id = v_correction_id where id = p_original_id;

  return jsonb_build_object('meal_item_id', v_correction_id, 'corrects_meal_item_id', p_original_id);
end;
$$;

revoke all on function correct_meal_item(uuid, uuid, uuid, jsonb, text) from public;
grant execute on function correct_meal_item(uuid, uuid, uuid, jsonb, text) to authenticated;
