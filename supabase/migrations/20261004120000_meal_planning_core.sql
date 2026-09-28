-- Phase 2 — Layer 8A: Meal Planning core (planned INTENT, separate from
-- actual consumption).
--
-- Additive. MealLog/MealItem (Layer 7A actual consumption) are not touched;
-- their unused draft/planned/confirmed enum values stay in place (no
-- destructive terminology migration). No existing policy is broadened.
--
--   meal_plan -> meal_plan_day -> planned_meal -> planned_meal_item
--
-- Plan lifecycle:   draft -> active | cancelled;  active -> completed |
--                   cancelled;  completed | cancelled -> archived.
-- Item lifecycle:   draft -> planned | confirmed | cancelled;
--                   planned -> confirmed | cancelled.  No consumed state.
-- A confirmed item is immutable; changing it = a new (draft) replacement
-- item with supersedes_planned_meal_item_id, which confirm_meal_plan()
-- confirms while marking the original superseded (both kept).
-- Confirmation state is per item: nothing here requires all items of a
-- plan to be confirmed together (narrower confirmation can be added later).

create type meal_plan_status as enum ('draft', 'active', 'completed', 'cancelled', 'archived');
create type planned_meal_item_status as enum ('draft', 'planned', 'confirmed', 'cancelled');

-- recipe_version (id, recipe_id) as a composite FK target, so a planned
-- recipe item's version provably belongs to its recipe.
alter table recipe_version add constraint uq_recipe_version_id_recipe unique (id, recipe_id);

-- ------------------------------------------------------------------
-- Tables
-- ------------------------------------------------------------------
create table meal_plan (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profile (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  description text check (description is null or char_length(description) <= 2000),
  start_date date not null,
  end_date date not null,
  local_timezone text not null,
  status meal_plan_status not null default 'draft',
  created_by_account_id uuid references account (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meal_plan_date_range check (start_date <= end_date),
  constraint uq_meal_plan_id_profile unique (id, profile_id)
);

create index idx_meal_plan_profile on meal_plan (profile_id, start_date);

create trigger trg_meal_plan_set_updated_at
  before update on meal_plan
  for each row execute function set_updated_at();

create table meal_plan_day (
  id uuid primary key default gen_random_uuid(),
  meal_plan_id uuid not null,
  profile_id uuid not null,
  plan_date date not null,
  created_at timestamptz not null default now(),
  constraint fk_meal_plan_day_plan foreign key (meal_plan_id, profile_id) references meal_plan (id, profile_id) on delete cascade,
  constraint uq_meal_plan_day_date unique (meal_plan_id, plan_date),
  constraint uq_meal_plan_day_id_profile unique (id, profile_id)
);

create table planned_meal (
  id uuid primary key default gen_random_uuid(),
  meal_plan_day_id uuid not null,
  profile_id uuid not null,
  meal_type meal_type not null,
  scheduled_local_time time,
  notes text check (notes is null or char_length(notes) <= 2000),
  position integer not null default 0 check (position >= 0),
  created_by_account_id uuid references account (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint fk_planned_meal_day foreign key (meal_plan_day_id, profile_id) references meal_plan_day (id, profile_id) on delete cascade,
  constraint uq_planned_meal_id_profile unique (id, profile_id)
);

create index idx_planned_meal_day on planned_meal (meal_plan_day_id);

create table planned_meal_item (
  id uuid primary key default gen_random_uuid(),
  planned_meal_id uuid not null,
  profile_id uuid not null,
  food_id uuid references food (id) on delete restrict,
  food_serving_id uuid,
  unit text,
  recipe_id uuid,
  recipe_version_id uuid,
  -- Food: amount in unit, or number of servings. Recipe: servings of the version's yield.
  quantity numeric not null check (quantity > 0),
  position integer not null default 0 check (position >= 0),
  status planned_meal_item_status not null default 'draft',
  confirmed_at timestamptz,
  supersedes_planned_meal_item_id uuid references planned_meal_item (id),
  superseded_by_planned_meal_item_id uuid references planned_meal_item (id),
  nutrition_snapshot jsonb,
  nutrition_calculation_version text,
  nutrition_calculated_at timestamptz,
  created_by_account_id uuid references account (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_planned_meal_item_meal foreign key (planned_meal_id, profile_id) references planned_meal (id, profile_id) on delete cascade,
  constraint fk_planned_meal_item_food_serving foreign key (food_serving_id, food_id) references food_serving (id, food_id),
  constraint fk_planned_meal_item_recipe_version foreign key (recipe_version_id, recipe_id) references recipe_version (id, recipe_id),
  -- exactly one source: a Food or an exact RecipeVersion
  constraint planned_meal_item_single_source check (
    (food_id is not null and recipe_id is null and recipe_version_id is null)
    or (food_id is null and recipe_id is not null and recipe_version_id is not null)
  ),
  -- Food amount: exactly one of unit / serving. Recipe: neither.
  constraint planned_meal_item_amount check (
    (food_id is not null and num_nonnulls(unit, food_serving_id) = 1)
    or (recipe_version_id is not null and unit is null and food_serving_id is null)
  ),
  -- A snapshot exists exactly when the item is confirmed (server-computed at confirmation).
  constraint planned_meal_item_confirmed_snapshot check (
    status <> 'confirmed'
    or (nutrition_snapshot is not null and nutrition_calculation_version is not null and nutrition_calculated_at is not null and confirmed_at is not null)
  ),
  constraint planned_meal_item_unconfirmed_no_snapshot check (
    status = 'confirmed'
    or (nutrition_snapshot is null and nutrition_calculation_version is null and nutrition_calculated_at is null and confirmed_at is null)
  ),
  constraint planned_meal_item_superseded_only_confirmed check (superseded_by_planned_meal_item_id is null or status = 'confirmed')
);

create index idx_planned_meal_item_meal on planned_meal_item (planned_meal_id);
-- at most one live (non-cancelled) replacement per original
create unique index uq_planned_meal_item_supersedes on planned_meal_item (supersedes_planned_meal_item_id)
  where supersedes_planned_meal_item_id is not null and status <> 'cancelled';

create trigger trg_planned_meal_item_set_updated_at
  before update on planned_meal_item
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------
-- Integrity triggers (definer: they only read related rows to decide;
-- every write still passes the caller's RLS).
-- ------------------------------------------------------------------
create or replace function meal_plan_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.local_timezone !~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$|^UTC$'
     or not exists (select 1 from pg_timezone_names where name = new.local_timezone) then
    raise exception 'local_timezone must be an IANA time zone identifier'
      using errcode = '22023', constraint = 'meal_plan_local_timezone_valid';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a meal plan starts as draft' using errcode = '23514', constraint = 'meal_plan_status_transition';
    end if;
    return new;
  end if;

  if new.profile_id <> old.profile_id then
    raise exception 'profile_id is immutable' using errcode = '23514', constraint = 'meal_plan_profile_immutable';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'draft' and new.status in ('active', 'cancelled'))
    or (old.status = 'active' and new.status in ('completed', 'cancelled'))
    or (old.status in ('completed', 'cancelled') and new.status = 'archived')
  ) then
    raise exception 'invalid meal plan status transition % -> %', old.status, new.status
      using errcode = '23514', constraint = 'meal_plan_status_transition';
  end if;
  if new.local_timezone is distinct from old.local_timezone and old.status <> 'draft' then
    raise exception 'local_timezone is fixed once the plan is no longer draft'
      using errcode = '23514', constraint = 'meal_plan_timezone_fixed';
  end if;
  if new.start_date is distinct from old.start_date or new.end_date is distinct from old.end_date then
    if old.status not in ('draft', 'active') then
      raise exception 'the date range of a % plan cannot change', old.status
        using errcode = '23514', constraint = 'meal_plan_date_range_change';
    end if;
    if old.status = 'active' and (new.start_date > old.start_date or new.end_date < old.end_date) then
      raise exception 'an active plan can only be extended'
        using errcode = '23514', constraint = 'meal_plan_date_range_change';
    end if;
    if exists (select 1 from meal_plan_day d where d.meal_plan_id = old.id and (d.plan_date < new.start_date or d.plan_date > new.end_date)) then
      raise exception 'planned days would fall outside the new date range'
        using errcode = '23514', constraint = 'meal_plan_date_range_change';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function meal_plan_integrity() from public;

create trigger trg_meal_plan_integrity
  before insert or update on meal_plan
  for each row execute function meal_plan_integrity();

-- Days, meals and items can only be added while the plan is draft/active,
-- and a day must fall inside the plan's range.
create or replace function meal_plan_content_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan meal_plan%rowtype;
begin
  if tg_table_name = 'meal_plan_day' then
    select * into v_plan from meal_plan where id = new.meal_plan_id;
    if new.plan_date < v_plan.start_date or new.plan_date > v_plan.end_date then
      raise exception 'plan_date is outside the meal plan date range'
        using errcode = '23514', constraint = 'meal_plan_day_in_range';
    end if;
  elsif tg_table_name = 'planned_meal' then
    select p.* into v_plan from meal_plan p join meal_plan_day d on d.meal_plan_id = p.id where d.id = new.meal_plan_day_id;
  else
    select p.* into v_plan from meal_plan p
      join meal_plan_day d on d.meal_plan_id = p.id
      join planned_meal m on m.meal_plan_day_id = d.id
     where m.id = new.planned_meal_id;
  end if;
  if v_plan.status not in ('draft', 'active') then
    raise exception 'a % plan cannot be changed', v_plan.status
      using errcode = '23514', constraint = 'meal_plan_editable';
  end if;
  return new;
end;
$$;

revoke all on function meal_plan_content_integrity() from public;

create trigger trg_meal_plan_day_integrity
  before insert on meal_plan_day
  for each row execute function meal_plan_content_integrity();

create trigger trg_planned_meal_integrity
  before insert on planned_meal
  for each row execute function meal_plan_content_integrity();

create trigger trg_planned_meal_item_content_integrity
  before insert or update on planned_meal_item
  for each row execute function meal_plan_content_integrity();

-- Insert rules for items: start unconfirmed; same-Profile recipe; a
-- replacement targets a confirmed, not-yet-superseded item of the same
-- planned meal.
create or replace function planned_meal_item_insert_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original planned_meal_item%rowtype;
begin
  if new.status not in ('draft', 'planned') or new.superseded_by_planned_meal_item_id is not null then
    raise exception 'planned items are created as draft or planned; confirmation happens through confirm_meal_plan'
      using errcode = '23514', constraint = 'planned_meal_item_initial_status';
  end if;
  if new.recipe_id is not null and not exists (select 1 from recipe r where r.id = new.recipe_id and r.created_by_profile_id = new.profile_id) then
    raise exception 'recipe_id must belong to a recipe of the same profile'
      using errcode = '23514', constraint = 'planned_meal_item_recipe_same_profile';
  end if;
  if new.supersedes_planned_meal_item_id is not null then
    select * into v_original from planned_meal_item where id = new.supersedes_planned_meal_item_id;
    if not found or v_original.planned_meal_id <> new.planned_meal_id or v_original.status <> 'confirmed'
       or v_original.superseded_by_planned_meal_item_id is not null then
      raise exception 'a replacement must target a confirmed, not yet superseded item of the same planned meal'
        using errcode = '23514', constraint = 'planned_meal_item_replacement_target';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function planned_meal_item_insert_integrity() from public;

create trigger trg_planned_meal_item_insert_integrity
  before insert on planned_meal_item
  for each row execute function planned_meal_item_insert_integrity();

-- Item lifecycle and confirmed immutability.
create or replace function planned_meal_item_transition()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'confirmed' then
    if new.superseded_by_planned_meal_item_id is distinct from old.superseded_by_planned_meal_item_id then
      if old.superseded_by_planned_meal_item_id is not null then
        raise exception 'planned_meal_item %: already superseded', old.id;
      end if;
      if (to_jsonb(new) - 'superseded_by_planned_meal_item_id' - 'updated_at') is distinct from (to_jsonb(old) - 'superseded_by_planned_meal_item_id' - 'updated_at') then
        raise exception 'planned_meal_item %: confirmed items are immutable except for superseded_by_planned_meal_item_id', old.id;
      end if;
      if not exists (
        select 1 from planned_meal_item r
         where r.id = new.superseded_by_planned_meal_item_id and r.supersedes_planned_meal_item_id = old.id and r.status = 'confirmed'
      ) then
        raise exception 'planned_meal_item %: superseded_by must reference a confirmed replacement of this item', old.id;
      end if;
      return new;
    end if;
    raise exception 'planned_meal_item %: confirmed items are immutable', old.id;
  end if;
  if old.status = 'cancelled' then
    raise exception 'planned_meal_item %: cancelled items are immutable', old.id;
  end if;

  -- draft / planned
  if new.id <> old.id or new.planned_meal_id <> old.planned_meal_id or new.profile_id <> old.profile_id
     or new.supersedes_planned_meal_item_id is distinct from old.supersedes_planned_meal_item_id
     or new.created_by_account_id is distinct from old.created_by_account_id or new.created_at <> old.created_at
     or new.food_id is distinct from old.food_id or new.recipe_id is distinct from old.recipe_id then
    raise exception 'planned_meal_item %: identity and source are fixed (cancel and add a new item instead)', old.id;
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'draft' and new.status in ('planned', 'confirmed', 'cancelled'))
    or (old.status = 'planned' and new.status in ('confirmed', 'cancelled'))
  ) then
    raise exception 'planned_meal_item %: invalid status transition % -> %', old.id, old.status, new.status;
  end if;
  if new.status = 'confirmed' and new.confirmed_at is null then
    new.confirmed_at = now();
  end if;
  return new;
end;
$$;

create trigger trg_planned_meal_item_transition
  before update on planned_meal_item
  for each row execute function planned_meal_item_transition();

-- ------------------------------------------------------------------
-- RLS — the approved Meal Planning scope (33_Security_and_Privacy.md §9.1):
-- read: full_management, view_only, pediatric_weight_management;
-- write: full_management, pediatric_weight_management. No DELETE anywhere.
-- Days and planned meals are insert-only (no UPDATE grant).
-- ------------------------------------------------------------------
alter table meal_plan enable row level security;
alter table meal_plan_day enable row level security;
alter table planned_meal enable row level security;
alter table planned_meal_item enable row level security;

grant select, insert, update on meal_plan to authenticated;
grant select, insert on meal_plan_day to authenticated;
grant select, insert on planned_meal to authenticated;
grant select, insert, update on planned_meal_item to authenticated;

create policy meal_plan_select_authorized on meal_plan for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only', 'pediatric_weight_management'));
create policy meal_plan_insert_managed on meal_plan for insert to authenticated
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));
create policy meal_plan_update_managed on meal_plan for update to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'))
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));

create policy meal_plan_day_select_authorized on meal_plan_day for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only', 'pediatric_weight_management'));
create policy meal_plan_day_insert_managed on meal_plan_day for insert to authenticated
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));

create policy planned_meal_select_authorized on planned_meal for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only', 'pediatric_weight_management'));
create policy planned_meal_insert_managed on planned_meal for insert to authenticated
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));

create policy planned_meal_item_select_authorized on planned_meal_item for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only', 'pediatric_weight_management'));
create policy planned_meal_item_insert_managed on planned_meal_item for insert to authenticated
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));
create policy planned_meal_item_update_managed on planned_meal_item for update to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'))
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));

-- ------------------------------------------------------------------
-- Atomic writes (SECURITY INVOKER — existing/new RLS applies to every
-- statement; they add atomicity, not privileges).
-- ------------------------------------------------------------------

-- Adds items to a planned meal — or creates the planned meal (payload.meal)
-- in the given day first. payload.items: [{ food_id, food_serving_id, unit,
-- recipe_id, recipe_version_id, quantity, position,
-- supersedes_planned_meal_item_id }]. Items start as draft.
create or replace function write_planned_meal_items(
  p_profile_id uuid,
  p_meal_plan_id uuid,
  p_meal_plan_day_id uuid,
  p_planned_meal_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_meal_id uuid := p_planned_meal_id;
  v_item jsonb;
  v_item_id uuid;
  v_ids jsonb := '[]'::jsonb;
  v_created_at timestamptz;
begin
  if v_meal_id is null then
    if not exists (select 1 from meal_plan_day d where d.id = p_meal_plan_day_id and d.meal_plan_id = p_meal_plan_id and d.profile_id = p_profile_id) then
      raise exception 'meal plan day not found' using errcode = 'P0002';
    end if;
    v_meal_id := gen_random_uuid();
    insert into planned_meal (id, meal_plan_day_id, profile_id, meal_type, scheduled_local_time, notes, position, created_by_account_id)
    values (
      v_meal_id, p_meal_plan_day_id, p_profile_id,
      (p_payload->'meal'->>'meal_type')::meal_type,
      (p_payload->'meal'->>'scheduled_local_time')::time,
      p_payload->'meal'->>'notes',
      coalesce((p_payload->'meal'->>'position')::integer, 0),
      auth.uid()
    );
  elsif not exists (
    select 1 from planned_meal m join meal_plan_day d on d.id = m.meal_plan_day_id
     where m.id = v_meal_id and d.meal_plan_id = p_meal_plan_id and m.profile_id = p_profile_id
  ) then
    raise exception 'planned meal not found' using errcode = 'P0002';
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_payload->'items', '[]'::jsonb)) loop
    v_item_id := gen_random_uuid();
    v_created_at := greatest(clock_timestamp(), coalesce(v_created_at + interval '1 microsecond', clock_timestamp()));
    insert into planned_meal_item (
      id, planned_meal_id, profile_id, food_id, food_serving_id, unit, recipe_id, recipe_version_id,
      quantity, position, status, supersedes_planned_meal_item_id, created_by_account_id, created_at
    ) values (
      v_item_id, v_meal_id, p_profile_id,
      (v_item->>'food_id')::uuid,
      (v_item->>'food_serving_id')::uuid,
      v_item->>'unit',
      (v_item->>'recipe_id')::uuid,
      (v_item->>'recipe_version_id')::uuid,
      (v_item->>'quantity')::numeric,
      coalesce((v_item->>'position')::integer, 0),
      'draft',
      (v_item->>'supersedes_planned_meal_item_id')::uuid,
      auth.uid(),
      v_created_at
    );
    v_ids := v_ids || to_jsonb(v_item_id);
  end loop;

  return jsonb_build_object('planned_meal_id', v_meal_id, 'planned_meal_item_ids', v_ids);
end;
$$;

revoke all on function write_planned_meal_items(uuid, uuid, uuid, uuid, jsonb) from public;
grant execute on function write_planned_meal_items(uuid, uuid, uuid, uuid, jsonb) to authenticated;

-- Whole-plan confirmation. p_payload.items must be EXACTLY the plan's
-- eligible (draft/planned) items, each with the content the server
-- calculated its snapshot from: [{ id, food_id, food_serving_id, unit,
-- recipe_version_id, quantity, nutrition_snapshot,
-- nutrition_calculation_version }].
-- A changed set or changed content -> 40001 and nothing is written.
create or replace function confirm_meal_plan(p_profile_id uuid, p_meal_plan_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status meal_plan_status;
  v_eligible uuid[];
  v_given uuid[];
  v_entry jsonb;
  v_row planned_meal_item%rowtype;
  v_ids uuid[] := '{}';
begin
  select status into v_status from meal_plan where id = p_meal_plan_id and profile_id = p_profile_id for update;
  if not found then
    raise exception 'meal plan not found' using errcode = 'P0002';
  end if;
  if v_status not in ('draft', 'active') then
    raise exception 'a % plan cannot be confirmed', v_status using errcode = '55000';
  end if;

  perform 1 from planned_meal_item i
    join planned_meal m on m.id = i.planned_meal_id
    join meal_plan_day d on d.id = m.meal_plan_day_id
   where d.meal_plan_id = p_meal_plan_id and i.status in ('draft', 'planned')
     for update of i;
  select coalesce(array_agg(i.id order by i.id), '{}') into v_eligible
    from planned_meal_item i
    join planned_meal m on m.id = i.planned_meal_id
    join meal_plan_day d on d.id = m.meal_plan_day_id
   where d.meal_plan_id = p_meal_plan_id and i.status in ('draft', 'planned');
  select coalesce(array_agg((e->>'id')::uuid order by (e->>'id')::uuid), '{}') into v_given from jsonb_array_elements(coalesce(p_payload->'items', '[]'::jsonb)) e;

  if cardinality(v_eligible) = 0 then
    raise exception 'nothing to confirm' using errcode = '22023';
  end if;
  if v_eligible <> v_given then
    raise exception 'the plan changed while it was being confirmed' using errcode = '40001';
  end if;

  for v_entry in select value from jsonb_array_elements(coalesce(p_payload->'items', '[]'::jsonb)) loop
    select * into v_row from planned_meal_item where id = (v_entry->>'id')::uuid;
    if v_row.food_id is distinct from (v_entry->>'food_id')::uuid
       or v_row.food_serving_id is distinct from (v_entry->>'food_serving_id')::uuid
       or v_row.unit is distinct from (v_entry->>'unit')
       or v_row.recipe_version_id is distinct from (v_entry->>'recipe_version_id')::uuid
       or v_row.quantity <> (v_entry->>'quantity')::numeric then
      raise exception 'the plan changed while it was being confirmed' using errcode = '40001';
    end if;
    update planned_meal_item
       set status = 'confirmed',
           nutrition_snapshot = v_entry->'nutrition_snapshot',
           nutrition_calculation_version = v_entry->>'nutrition_calculation_version',
           nutrition_calculated_at = now()
     where id = v_row.id;
    v_ids := v_ids || v_row.id;
  end loop;

  -- accepted replacements supersede their originals
  for v_row in select * from planned_meal_item where id = any (v_ids) and supersedes_planned_meal_item_id is not null loop
    update planned_meal_item set superseded_by_planned_meal_item_id = v_row.id where id = v_row.supersedes_planned_meal_item_id;
  end loop;

  if v_status = 'draft' then
    update meal_plan set status = 'active' where id = p_meal_plan_id;
  end if;

  return jsonb_build_object('confirmed_item_ids', to_jsonb(v_ids), 'status', case when v_status = 'draft' then 'active' else v_status::text end);
end;
$$;

revoke all on function confirm_meal_plan(uuid, uuid, jsonb) from public;
grant execute on function confirm_meal_plan(uuid, uuid, jsonb) to authenticated;
