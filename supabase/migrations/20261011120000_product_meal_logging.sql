-- Phase 3 — Layer 11B: Product & Barcode meal logging.
--
-- Additive. No earlier migration is edited. A MealItem gains a third
-- consumption source — an exact commercial Product AND the exact
-- ProductLabelVersion whose label nutrition was used — beside Food and
-- RecipeVersion. There is still ONE consumption-history system (meal_item);
-- the Layer 7A snapshot, immutability and correction machinery apply
-- unchanged (the redefined enforce_meal_item_status_transition() already
-- freezes every column of a consumed row, including the new ones).
--
--  1. Composite keys so a MealItem can prove, in the database, that its
--     label version belongs to its Product, its ProductServing belongs to
--     that exact label version, and its provenance barcode belongs to the
--     Product.
--  2. meal_item: product_id, product_label_version_id, product_serving_id,
--     logged_via_barcode_id; the single-source invariant becomes
--     "exactly one of Food / RecipeVersion / Product" for consumed items
--     (never more than one for any item); amount-form rules per source.
--  3. Product insert integrity (definer trigger): the label version was not
--     already replaced before consumed_at — no newer version of the Product
--     was both published and in effect by then — so a client cannot pick an
--     arbitrary old label, even calling the RPC directly; except a
--     correction that keeps its original's exact label version (approved
--     G2). A provenance barcode must be active when logging.
--  4. log_meal_items() / correct_meal_item() redefined to write the new
--     columns (same signatures, still SECURITY INVOKER under RLS).
--
-- No RLS policy is added or broadened. Clients keep SELECT-only access to
-- Product reference tables; logging never writes them.

-- ------------------------------------------------------------------
-- 1. Composite keys on trusted reference tables (no data change)
-- ------------------------------------------------------------------
alter table product_serving add constraint uq_product_serving_id_label unique (id, label_version_id);
alter table barcode add constraint uq_barcode_id_product unique (id, product_id);

-- ------------------------------------------------------------------
-- 2. MealItem columns and invariants
-- ------------------------------------------------------------------
alter table meal_item
  add column product_id uuid references product (id) on delete restrict,
  add column product_label_version_id uuid,
  add column product_serving_id uuid,
  add column logged_via_barcode_id uuid,
  add constraint fk_meal_item_product_label_version
    foreign key (product_label_version_id, product_id) references product_label_version (id, product_id) on delete restrict,
  add constraint fk_meal_item_product_serving_label
    foreign key (product_serving_id, product_label_version_id) references product_serving (id, label_version_id) on delete restrict,
  add constraint fk_meal_item_logged_via_barcode
    foreign key (logged_via_barcode_id, product_id) references barcode (id, product_id) on delete restrict;

alter table meal_item
  drop constraint meal_item_single_source,
  drop constraint meal_item_consumed_has_source,
  drop constraint meal_item_amount_requires_food,
  -- Food vs Recipe vs Product: never more than one; a consumed item exactly one.
  add constraint meal_item_single_source check (num_nonnulls(food_id, recipe_version_id, product_id) <= 1),
  add constraint meal_item_consumed_has_source check (status <> 'consumed' or num_nonnulls(food_id, recipe_version_id, product_id) = 1),
  -- A Product item always names its exact label version (never only the Product).
  add constraint meal_item_product_label_version check ((product_id is null) = (product_label_version_id is null)),
  -- Food amount fields belong to Food items; product amount fields to Product items.
  add constraint meal_item_amount_requires_food check (food_serving_id is null or food_id is not null),
  add constraint meal_item_unit_requires_food_or_product check (unit is null or food_id is not null or product_id is not null),
  add constraint meal_item_product_serving_requires_product check (product_serving_id is null or product_id is not null),
  add constraint meal_item_barcode_requires_product check (logged_via_barcode_id is null or product_id is not null),
  -- Product amount: unit xor ProductServing (a consumed product item needs exactly one).
  add constraint meal_item_product_unit_xor_serving check (not (unit is not null and product_serving_id is not null)),
  add constraint meal_item_consumed_product_amount check (status <> 'consumed' or product_id is null or num_nonnulls(unit, product_serving_id) = 1);

create index idx_meal_item_product on meal_item (product_id) where product_id is not null;

-- ------------------------------------------------------------------
-- 3. Product insert integrity
-- ------------------------------------------------------------------
create or replace function meal_item_product_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label product_label_version%rowtype;
  v_local_date date;
  v_original_label uuid;
begin
  if new.product_id is null then
    return new;
  end if;

  if new.status = 'consumed' and new.consumed_at is not null then
    select * into v_label from product_label_version where id = new.product_label_version_id;
    select (new.consumed_at at time zone ml.local_timezone)::date into v_local_date from meal_log ml where ml.id = new.meal_log_id;
    -- A label is "replaced before the meal" when a newer version of the same
    -- Product was both published and in effect (effective_from, when set)
    -- by consumed_at. Such a label can no longer be chosen for that meal.
    if exists (
      select 1 from product_label_version later
       where later.product_id = v_label.product_id
         and later.version_number > v_label.version_number
         and later.created_at <= new.consumed_at
         and (later.effective_from is null or v_local_date is null or later.effective_from <= v_local_date)
    ) then
      if new.corrects_meal_item_id is not null then
        select product_label_version_id into v_original_label from meal_item where id = new.corrects_meal_item_id;
      end if;
      -- G2: a correction may keep its original's exact label version.
      if v_original_label is distinct from new.product_label_version_id then
        raise exception 'the product label version was replaced before consumed_at'
          using errcode = '23514', constraint = 'meal_item_product_label_applicable';
      end if;
    end if;
  end if;

  if new.logged_via_barcode_id is not null
     and not exists (select 1 from barcode where id = new.logged_via_barcode_id and status = 'active') then
    raise exception 'a retired barcode cannot be used to log'
      using errcode = '23514', constraint = 'meal_item_barcode_active';
  end if;
  return new;
end;
$$;

revoke all on function meal_item_product_integrity() from public;

create trigger trg_meal_item_product_integrity
  before insert on meal_item
  for each row execute function meal_item_product_integrity();

-- ------------------------------------------------------------------
-- 4. Atomic writes — same signatures and semantics as Layer 7A, now
-- writing the Product columns too.
-- ------------------------------------------------------------------
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
      id, meal_log_id, profile_id, food_id, food_serving_id, unit, recipe_version_id,
      product_id, product_label_version_id, product_serving_id, logged_via_barcode_id, quantity,
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
      (v_item->>'product_id')::uuid,
      (v_item->>'product_label_version_id')::uuid,
      (v_item->>'product_serving_id')::uuid,
      (v_item->>'logged_via_barcode_id')::uuid,
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
    id, meal_log_id, profile_id, food_id, food_serving_id, unit, recipe_version_id,
    product_id, product_label_version_id, product_serving_id, logged_via_barcode_id, quantity,
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
    (p_item->>'product_id')::uuid,
    (p_item->>'product_label_version_id')::uuid,
    (p_item->>'product_serving_id')::uuid,
    (p_item->>'logged_via_barcode_id')::uuid,
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
