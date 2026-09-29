-- Phase 2 — Layer 9A: Grocery Planning core — immutable GENERATED grocery
-- lists derived from a MealPlan's current confirmed intent.
--
-- Additive. MealPlan / PlannedMealItem (8A), links/skips (8B), MealLog /
-- MealItem (7A), recipes (6A) and Food reference data (5A/5C) are not
-- modified. No existing policy is broadened.
--
-- grocery_list               one generation of a plan's grocery requirements.
--                            generation_number 1..n per plan; exactly one
--                            `active` generation per plan, older ones
--                            `superseded` (never deleted). Plan context,
--                            source fingerprint and rule versions are
--                            recorded at generation.
-- grocery_list_item          a GENERATED requirement (Food x dimension, or an
--                            unresolved requirement). No user shopping state
--                            (already-have, purchased, manual, edited
--                            quantities) — Layer 9B adds that in separate
--                            tables that reference these rows.
-- grocery_list_item_source   traceability: one row per contributing planned
--                            Food item or scaled RecipeIngredient.
--
-- Generation is written by generate_grocery_list() in ONE transaction; the
-- insert trigger on grocery_list numbers the generation and supersedes the
-- previous active one, so a failed generation leaves it active. After that
-- transaction a list is sealed: no UPDATE/DELETE grants, items/sources may
-- only be inserted by the transaction that created the list.
--
-- Trust boundary (as 7A/8A): generated quantities are computed by the API's
-- deterministic engine — application-authoritative, not cryptographically
-- attested. The triggers still enforce, whatever the write path: Profile
-- consistency; an ACTIVE plan; every source is a current, confirmed,
-- non-skipped PlannedMealItem of that plan whose structured facts (Food,
-- serving/unit, quantity, exact RecipeVersion, servings, RecipeIngredient
-- identity and amount, yield) match the row.

create type grocery_list_status as enum ('active', 'superseded');
create type grocery_item_dimension as enum ('mass', 'volume', 'count');
create type grocery_resolution_status as enum (
  'resolved',
  'incompatible_units',
  'unresolved_quantity',
  'ambiguous_unit',
  'unresolved_conversion',
  'unresolved_food'
);
create type grocery_aggregation_status as enum ('aggregated', 'not_aggregated');
create type grocery_source_type as enum ('planned_food', 'recipe_ingredient');

create table grocery_list (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profile (id) on delete cascade,
  meal_plan_id uuid not null,
  generation_number integer not null check (generation_number > 0),
  status grocery_list_status not null default 'active',
  supersedes_grocery_list_id uuid,
  superseded_by_grocery_list_id uuid,
  superseded_at timestamptz,
  plan_status_at_generation meal_plan_status not null,
  plan_start_date date not null,
  plan_end_date date not null,
  plan_local_timezone text not null,
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_version text not null check (char_length(fingerprint_version) between 1 and 100),
  calculation_version text not null check (char_length(calculation_version) between 1 and 100),
  conversion_version text not null check (char_length(conversion_version) between 1 and 100),
  -- current plan items NOT included (unconfirmed / pending replacement /
  -- skipped), recorded for explanation only
  excluded_sources jsonb not null default '[]'::jsonb check (jsonb_typeof(excluded_sources) = 'array'),
  generated_at timestamptz not null default now(),
  generated_by_account_id uuid references account (id) on delete set null,
  constraint uq_grocery_list_id_profile unique (id, profile_id),
  constraint uq_grocery_list_generation unique (meal_plan_id, generation_number),
  constraint fk_grocery_list_plan foreign key (meal_plan_id, profile_id) references meal_plan (id, profile_id),
  constraint fk_grocery_list_supersedes foreign key (supersedes_grocery_list_id, profile_id) references grocery_list (id, profile_id),
  constraint fk_grocery_list_superseded_by foreign key (superseded_by_grocery_list_id, profile_id) references grocery_list (id, profile_id)
    deferrable initially deferred,
  constraint grocery_list_supersession_state check (
    (status = 'active') = (superseded_by_grocery_list_id is null)
    and (superseded_by_grocery_list_id is null) = (superseded_at is null)
  )
);

create unique index uq_grocery_list_active on grocery_list (meal_plan_id) where status = 'active';
create index idx_grocery_list_profile on grocery_list (profile_id, generated_at desc);

create table grocery_list_item (
  id uuid primary key default gen_random_uuid(),
  grocery_list_id uuid not null,
  profile_id uuid not null,
  position integer not null check (position >= 0),
  food_id uuid references food (id),
  display_name text not null check (char_length(display_name) between 1 and 1000),
  dimension grocery_item_dimension,
  -- exact rational "n/d" in the canonical grocery base (g, ml, count)
  quantity_exact text check (quantity_exact ~ '^[0-9]+/[0-9]+$'),
  -- quantity_exact rounded half-up to 6 decimal places
  quantity numeric,
  unit text check (unit in ('g', 'ml', 'count')),
  resolution_status grocery_resolution_status not null,
  aggregation_status grocery_aggregation_status not null,
  unresolved_reason text check (unresolved_reason is null or char_length(unresolved_reason) <= 200),
  source_count integer not null check (source_count > 0),
  created_at timestamptz not null default now(),
  constraint uq_grocery_list_item_id_profile unique (id, profile_id),
  constraint uq_grocery_list_item_position unique (grocery_list_id, position),
  constraint fk_grocery_list_item_list foreign key (grocery_list_id, profile_id) references grocery_list (id, profile_id) on delete cascade,
  constraint grocery_list_item_quantity_shape check (
    (quantity_exact is null) = (quantity is null)
    and (quantity is null) = (unit is null)
    and (unit is null) = (dimension is null)
    and (quantity is not null) = (resolution_status in ('resolved', 'incompatible_units'))
  ),
  constraint grocery_list_item_unit_dimension check (
    dimension is null
    or (dimension = 'mass' and unit = 'g')
    or (dimension = 'volume' and unit = 'ml')
    or (dimension = 'count' and unit = 'count')
  ),
  constraint grocery_list_item_food_identity check ((food_id is null) = (resolution_status = 'unresolved_food')),
  constraint grocery_list_item_reason check ((unresolved_reason is null) = (resolution_status = 'resolved')),
  constraint grocery_list_item_aggregation check ((aggregation_status = 'aggregated') = (quantity is not null))
);

create table grocery_list_item_source (
  id uuid primary key default gen_random_uuid(),
  grocery_list_item_id uuid not null,
  grocery_list_id uuid not null,
  profile_id uuid not null,
  position integer not null check (position >= 0),
  meal_plan_id uuid not null,
  meal_plan_day_id uuid not null,
  planned_meal_id uuid not null,
  planned_meal_item_id uuid not null,
  plan_date date not null,
  source_type grocery_source_type not null,
  food_id uuid references food (id),
  food_serving_id uuid references food_serving (id),
  recipe_id uuid,
  recipe_version_id uuid,
  recipe_ingredient_id uuid references recipe_ingredient (id),
  ingredient_text text check (ingredient_text is null or char_length(ingredient_text) <= 1000),
  ingredient_match_status recipe_ingredient_match_status,
  -- the structured amount as stored on the planned item / ingredient
  source_quantity numeric,
  source_unit text,
  planned_servings numeric,
  recipe_yield numeric,
  -- exact rationals: planned_servings / recipe_yield (1 for a planned Food);
  -- source_quantity x scale; and the contribution in the item's unit
  scale_factor_exact text not null check (scale_factor_exact ~ '^[0-9]+/[0-9]+$'),
  scaled_quantity_exact text check (scaled_quantity_exact ~ '^[0-9]+/[0-9]+$'),
  contribution_quantity_exact text check (contribution_quantity_exact ~ '^[0-9]+/[0-9]+$'),
  contribution_unit text check (contribution_unit in ('g', 'ml', 'count')),
  conversion jsonb,
  unresolved_reason text check (unresolved_reason is null or char_length(unresolved_reason) <= 200),
  created_at timestamptz not null default now(),
  constraint uq_grocery_list_item_source_position unique (grocery_list_item_id, position),
  constraint fk_grocery_source_item foreign key (grocery_list_item_id, profile_id) references grocery_list_item (id, profile_id) on delete cascade,
  constraint fk_grocery_source_list foreign key (grocery_list_id, profile_id) references grocery_list (id, profile_id) on delete cascade,
  constraint fk_grocery_source_plan foreign key (meal_plan_id, profile_id) references meal_plan (id, profile_id),
  constraint fk_grocery_source_day foreign key (meal_plan_day_id, profile_id) references meal_plan_day (id, profile_id),
  constraint fk_grocery_source_meal foreign key (planned_meal_id, profile_id) references planned_meal (id, profile_id),
  constraint fk_grocery_source_planned_item foreign key (planned_meal_item_id, profile_id) references planned_meal_item (id, profile_id),
  constraint fk_grocery_source_recipe_version foreign key (recipe_version_id, recipe_id) references recipe_version (id, recipe_id),
  constraint grocery_source_shape check (
    (source_type = 'planned_food' and food_id is not null and recipe_id is null and recipe_version_id is null
      and recipe_ingredient_id is null and planned_servings is null and recipe_yield is null)
    or (source_type = 'recipe_ingredient' and recipe_id is not null and recipe_version_id is not null
      and recipe_ingredient_id is not null and planned_servings is not null and recipe_yield is not null)
  ),
  constraint grocery_source_contribution check ((contribution_quantity_exact is null) = (contribution_unit is null))
);

create index idx_grocery_source_list on grocery_list_item_source (grocery_list_id);
create index idx_grocery_source_planned_item on grocery_list_item_source (planned_meal_item_id);

-- ------------------------------------------------------------------
-- grocery_list insert: number the generation, record plan context,
-- supersede the previous active generation (same transaction).
-- ------------------------------------------------------------------
create or replace function grocery_list_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan meal_plan%rowtype;
  v_previous uuid;
begin
  if profile_access_scope(new.profile_id) is null
     or profile_access_scope(new.profile_id) not in ('full_management', 'pediatric_weight_management') then
    raise exception 'not permitted to generate grocery lists for this profile' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('grocery_plan:' || new.meal_plan_id::text, 0));
  select * into v_plan from meal_plan where id = new.meal_plan_id and profile_id = new.profile_id;
  if not found then
    raise exception 'meal plan not found' using errcode = 'P0002';
  end if;
  if v_plan.status <> 'active' then
    raise exception 'grocery lists can only be generated from an active meal plan'
      using errcode = '23514', constraint = 'grocery_list_plan_active';
  end if;

  select coalesce(max(generation_number), 0) + 1 into new.generation_number from grocery_list where meal_plan_id = new.meal_plan_id;
  select id into v_previous from grocery_list where meal_plan_id = new.meal_plan_id and status = 'active';

  new.status := 'active';
  new.supersedes_grocery_list_id := v_previous;
  new.superseded_by_grocery_list_id := null;
  new.superseded_at := null;
  new.plan_status_at_generation := v_plan.status;
  new.plan_start_date := v_plan.start_date;
  new.plan_end_date := v_plan.end_date;
  new.plan_local_timezone := v_plan.local_timezone;
  new.generated_at := now();
  new.generated_by_account_id := auth.uid();

  if v_previous is not null then
    -- the new row is checked by the deferred FK at commit
    update grocery_list
       set status = 'superseded', superseded_by_grocery_list_id = new.id, superseded_at = now()
     where id = v_previous;
  end if;
  return new;
end;
$$;

revoke all on function grocery_list_insert() from public;

create trigger trg_grocery_list_insert
  before insert on grocery_list
  for each row execute function grocery_list_insert();

-- The only change ever made to a list: active -> superseded, once.
create or replace function grocery_list_supersede_only()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'active' or new.status <> 'superseded' or new.superseded_by_grocery_list_id is null
     or (to_jsonb(new) - 'status' - 'superseded_by_grocery_list_id' - 'superseded_at')
        is distinct from (to_jsonb(old) - 'status' - 'superseded_by_grocery_list_id' - 'superseded_at') then
    raise exception 'a generated grocery list is immutable; regenerate instead'
      using errcode = '55000', constraint = 'grocery_list_immutable';
  end if;
  return new;
end;
$$;

create trigger trg_grocery_list_supersede_only
  before update on grocery_list
  for each row execute function grocery_list_supersede_only();

-- Items and sources are written only by the transaction that created the
-- list (generated_at = now() is that transaction's start time) and actor.
create or replace function grocery_list_writable(p_grocery_list_id uuid, p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from grocery_list l
     where l.id = p_grocery_list_id and l.profile_id = p_profile_id
       and l.status = 'active' and l.generated_at = now()
       and l.generated_by_account_id is not distinct from auth.uid()
  ) then
    raise exception 'a generated grocery list is sealed; regenerate instead'
      using errcode = '55000', constraint = 'grocery_list_sealed';
  end if;
end;
$$;

revoke all on function grocery_list_writable(uuid, uuid) from public;

create or replace function grocery_list_item_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform grocery_list_writable(new.grocery_list_id, new.profile_id);
  new.created_at := now();
  return new;
end;
$$;

revoke all on function grocery_list_item_insert() from public;

create trigger trg_grocery_list_item_insert
  before insert on grocery_list_item
  for each row execute function grocery_list_item_insert();

create or replace function grocery_list_item_source_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list grocery_list%rowtype;
  v_item planned_meal_item%rowtype;
  v_day meal_plan_day%rowtype;
  v_meal planned_meal%rowtype;
  v_ing recipe_ingredient%rowtype;
  v_yield numeric;
begin
  perform grocery_list_writable(new.grocery_list_id, new.profile_id);
  select * into v_list from grocery_list where id = new.grocery_list_id;
  if not exists (select 1 from grocery_list_item i where i.id = new.grocery_list_item_id and i.grocery_list_id = new.grocery_list_id) then
    raise exception 'source item is not part of this grocery list' using errcode = '23514', constraint = 'grocery_source_list_item';
  end if;

  select * into v_item from planned_meal_item where id = new.planned_meal_item_id and profile_id = new.profile_id;
  select * into v_meal from planned_meal where id = v_item.planned_meal_id;
  select * into v_day from meal_plan_day where id = v_meal.meal_plan_day_id;
  if v_item.id is null
     or v_item.planned_meal_id <> new.planned_meal_id
     or v_meal.meal_plan_day_id <> new.meal_plan_day_id
     or v_day.meal_plan_id <> new.meal_plan_id
     or new.meal_plan_id <> v_list.meal_plan_id
     or v_day.plan_date <> new.plan_date then
    raise exception 'grocery source is not a planned item of this meal plan' using errcode = '23514', constraint = 'grocery_source_in_plan';
  end if;
  if v_item.status <> 'confirmed' or v_item.superseded_by_planned_meal_item_id is not null
     or exists (select 1 from planned_meal_item_skip s where s.planned_meal_item_id = v_item.id and s.revoked_at is null) then
    raise exception 'only current, confirmed, non-skipped planned items contribute to a grocery list'
      using errcode = '23514', constraint = 'grocery_source_confirmed_current';
  end if;

  if new.source_type = 'planned_food' then
    if v_item.food_id is distinct from new.food_id
       or v_item.food_serving_id is distinct from new.food_serving_id
       or v_item.unit is distinct from new.source_unit
       or v_item.quantity is distinct from new.source_quantity then
      raise exception 'grocery source does not match the planned Food item' using errcode = '23514', constraint = 'grocery_source_matches_plan';
    end if;
  else
    select * into v_ing from recipe_ingredient where id = new.recipe_ingredient_id;
    select servings into v_yield from recipe_version where id = new.recipe_version_id;
    if v_item.recipe_version_id is distinct from new.recipe_version_id
       or v_item.recipe_id is distinct from new.recipe_id
       or v_item.quantity is distinct from new.planned_servings
       or v_ing.recipe_version_id is distinct from new.recipe_version_id
       or v_ing.food_serving_id is distinct from new.food_serving_id
       or v_ing.quantity is distinct from new.source_quantity
       or v_ing.unit is distinct from new.source_unit
       or v_ing.match_status is distinct from new.ingredient_match_status
       or (new.food_id is not null and (v_ing.food_id is distinct from new.food_id or v_ing.match_status <> 'matched'))
       or v_yield is distinct from new.recipe_yield then
      raise exception 'grocery source does not match the planned RecipeVersion ingredient' using errcode = '23514', constraint = 'grocery_source_matches_plan';
    end if;
  end if;
  new.created_at := now();
  return new;
end;
$$;

revoke all on function grocery_list_item_source_insert() from public;

create trigger trg_grocery_list_item_source_insert
  before insert on grocery_list_item_source
  for each row execute function grocery_list_item_source_insert();

create trigger trg_grocery_list_item_prevent_update
  before update on grocery_list_item
  for each row execute function prevent_update();

create trigger trg_grocery_list_item_source_prevent_update
  before update on grocery_list_item_source
  for each row execute function prevent_update();

-- ------------------------------------------------------------------
-- Atomic generation (SECURITY INVOKER: RLS and the triggers above apply).
-- p_payload: { source_fingerprint, fingerprint_version, calculation_version,
--   conversion_version, excluded_sources: [...],
--   items: [ { position, food_id, display_name, dimension, quantity_exact,
--     quantity, unit, resolution_status, aggregation_status,
--     unresolved_reason, sources: [ { position, meal_plan_id, ... } ] } ] }
-- ------------------------------------------------------------------
create or replace function generate_grocery_list(p_profile_id uuid, p_meal_plan_id uuid, p_payload jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_list uuid;
  v_item_id uuid;
  v_item jsonb;
  v_source jsonb;
begin
  if jsonb_typeof(p_payload->'items') <> 'array' or jsonb_array_length(p_payload->'items') = 0 then
    raise exception 'a grocery list needs at least one requirement' using errcode = '22023';
  end if;

  insert into grocery_list (profile_id, meal_plan_id, source_fingerprint, fingerprint_version, calculation_version, conversion_version, excluded_sources)
  values (
    p_profile_id,
    p_meal_plan_id,
    p_payload->>'source_fingerprint',
    p_payload->>'fingerprint_version',
    p_payload->>'calculation_version',
    p_payload->>'conversion_version',
    coalesce(p_payload->'excluded_sources', '[]'::jsonb)
  )
  returning id into v_list;

  for v_item in select value from jsonb_array_elements(p_payload->'items') loop
    insert into grocery_list_item (
      grocery_list_id, profile_id, position, food_id, display_name, dimension, quantity_exact, quantity, unit,
      resolution_status, aggregation_status, unresolved_reason, source_count
    ) values (
      v_list,
      p_profile_id,
      (v_item->>'position')::int,
      (v_item->>'food_id')::uuid,
      v_item->>'display_name',
      (v_item->>'dimension')::grocery_item_dimension,
      v_item->>'quantity_exact',
      (v_item->>'quantity')::numeric,
      v_item->>'unit',
      (v_item->>'resolution_status')::grocery_resolution_status,
      (v_item->>'aggregation_status')::grocery_aggregation_status,
      v_item->>'unresolved_reason',
      jsonb_array_length(v_item->'sources')
    )
    returning id into v_item_id;

    for v_source in select value from jsonb_array_elements(v_item->'sources') loop
      insert into grocery_list_item_source (
        grocery_list_item_id, grocery_list_id, profile_id, position, meal_plan_id, meal_plan_day_id, planned_meal_id,
        planned_meal_item_id, plan_date, source_type, food_id, food_serving_id, recipe_id, recipe_version_id,
        recipe_ingredient_id, ingredient_text, ingredient_match_status, source_quantity, source_unit, planned_servings,
        recipe_yield, scale_factor_exact, scaled_quantity_exact, contribution_quantity_exact, contribution_unit,
        conversion, unresolved_reason
      ) values (
        v_item_id,
        v_list,
        p_profile_id,
        (v_source->>'position')::int,
        (v_source->>'meal_plan_id')::uuid,
        (v_source->>'meal_plan_day_id')::uuid,
        (v_source->>'planned_meal_id')::uuid,
        (v_source->>'planned_meal_item_id')::uuid,
        (v_source->>'plan_date')::date,
        (v_source->>'source_type')::grocery_source_type,
        (v_source->>'food_id')::uuid,
        (v_source->>'food_serving_id')::uuid,
        (v_source->>'recipe_id')::uuid,
        (v_source->>'recipe_version_id')::uuid,
        (v_source->>'recipe_ingredient_id')::uuid,
        v_source->>'ingredient_text',
        (v_source->>'ingredient_match_status')::recipe_ingredient_match_status,
        (v_source->>'source_quantity')::numeric,
        v_source->>'source_unit',
        (v_source->>'planned_servings')::numeric,
        (v_source->>'recipe_yield')::numeric,
        v_source->>'scale_factor_exact',
        v_source->>'scaled_quantity_exact',
        v_source->>'contribution_quantity_exact',
        v_source->>'contribution_unit',
        case when jsonb_typeof(v_source->'conversion') = 'object' then v_source->'conversion' else null end,
        v_source->>'unresolved_reason'
      );
    end loop;
  end loop;
  return v_list;
end;
$$;

revoke all on function generate_grocery_list(uuid, uuid, jsonb) from public;
grant execute on function generate_grocery_list(uuid, uuid, jsonb) to authenticated;

-- ------------------------------------------------------------------
-- RLS — the Meal Planning scopes (never broadened):
-- read: full_management, view_only, pediatric_weight_management;
-- generate (insert): full_management, pediatric_weight_management.
-- No UPDATE or DELETE grants: lists change only by supersession, performed
-- inside the generation trigger.
-- ------------------------------------------------------------------
alter table grocery_list enable row level security;
alter table grocery_list_item enable row level security;
alter table grocery_list_item_source enable row level security;

grant select, insert on grocery_list to authenticated;
grant select, insert on grocery_list_item to authenticated;
grant select, insert on grocery_list_item_source to authenticated;

create policy grocery_list_select_authorized on grocery_list for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only', 'pediatric_weight_management'));
create policy grocery_list_insert_managed on grocery_list for insert to authenticated
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));

create policy grocery_list_item_select_authorized on grocery_list_item for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only', 'pediatric_weight_management'));
create policy grocery_list_item_insert_managed on grocery_list_item for insert to authenticated
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));

create policy grocery_list_item_source_select_authorized on grocery_list_item_source for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only', 'pediatric_weight_management'));
create policy grocery_list_item_source_insert_managed on grocery_list_item_source for insert to authenticated
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));
