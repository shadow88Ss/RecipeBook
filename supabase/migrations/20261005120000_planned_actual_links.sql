-- Phase 2 — Layer 8B: planned vs actual — explicit links and skips.
--
-- Additive. PlannedMealItem (8A intent) and MealItem (7A consumption) are
-- not modified; their lifecycles, triggers and correction behaviour are
-- unchanged. No existing policy is broadened.
--
-- planned_actual_link      an explicit, user-asserted relationship between
--                          a current confirmed PlannedMealItem and an active
--                          consumed MealItem: `same_item` (same Food / exact
--                          RecipeVersion) or `substitution` (a different
--                          one). exact/partial/fulfilled are DERIVED at read
--                          time, never stored. Active or revoked; no DELETE.
-- planned_meal_item_skip   "confirmed intent that was explicitly not
--                          consumed" — separate from `cancelled` (intent
--                          removed). Active or revoked; no DELETE.
--
-- Invariants enforced here (not only in the API), serialized with
-- transaction-scoped advisory locks:
--   * a planned item never has an active skip and an active link together;
--   * an actual correction CHAIN (identified by its root MealItem) actively
--     fulfils at most one CURRENT planned item;
--   * profile consistency via composite (id, profile_id) keys;
--   * the actual item is consumed and active at link time, and its
--     consumed_at falls on the plan day's date in the PLAN's time zone;
--   * links/skips are created only on active or completed plans.

create type planned_actual_relationship as enum ('same_item', 'substitution');

alter table planned_meal_item add constraint uq_planned_meal_item_id_profile unique (id, profile_id);
alter table meal_item add constraint uq_meal_item_id_profile unique (id, profile_id);

-- The root (original) MealItem of a Layer 7A correction chain. Stable:
-- corrects_meal_item_id is immutable once written.
create or replace function meal_item_chain_root(p_meal_item_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  with recursive up(id, corrects) as (
    select m.id, m.corrects_meal_item_id from meal_item m where m.id = p_meal_item_id
    union all
    select m.id, m.corrects_meal_item_id from meal_item m join up on m.id = up.corrects
  )
  select id from up where corrects is null limit 1;
$$;

revoke all on function meal_item_chain_root(uuid) from public;

create table planned_actual_link (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  planned_meal_item_id uuid not null,
  meal_item_id uuid not null,
  relationship_type planned_actual_relationship not null,
  -- set by trigger: root MealItem of the linked item's correction chain
  meal_item_chain_root_id uuid not null,
  created_at timestamptz not null default now(),
  created_by_account_id uuid references account (id) on delete set null,
  revoked_at timestamptz,
  revoked_by_account_id uuid references account (id) on delete set null,
  constraint fk_planned_actual_link_planned foreign key (planned_meal_item_id, profile_id) references planned_meal_item (id, profile_id),
  constraint fk_planned_actual_link_actual foreign key (meal_item_id, profile_id) references meal_item (id, profile_id),
  constraint fk_planned_actual_link_chain_root foreign key (meal_item_chain_root_id, profile_id) references meal_item (id, profile_id),
  constraint planned_actual_link_revocation_pair check ((revoked_at is null) = (revoked_by_account_id is null))
);

create unique index uq_planned_actual_link_active on planned_actual_link (planned_meal_item_id, meal_item_id) where revoked_at is null;
create index idx_planned_actual_link_planned on planned_actual_link (planned_meal_item_id);
create index idx_planned_actual_link_chain on planned_actual_link (meal_item_chain_root_id) where revoked_at is null;

create table planned_meal_item_skip (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  planned_meal_item_id uuid not null,
  reason text check (reason is null or char_length(reason) <= 500),
  skipped_at timestamptz not null default now(),
  skipped_by_account_id uuid references account (id) on delete set null,
  revoked_at timestamptz,
  revoked_by_account_id uuid references account (id) on delete set null,
  constraint fk_planned_meal_item_skip_planned foreign key (planned_meal_item_id, profile_id) references planned_meal_item (id, profile_id),
  constraint planned_meal_item_skip_revocation_pair check ((revoked_at is null) = (revoked_by_account_id is null))
);

create unique index uq_planned_meal_item_skip_active on planned_meal_item_skip (planned_meal_item_id) where revoked_at is null;

-- Serializes skip/link creation per planned item and link creation per
-- actual chain (always in this order: planned item, then chain).
create or replace function lock_planning_key(p_kind text, p_id uuid)
returns void
language sql
as $$
  select pg_advisory_xact_lock(hashtextextended(p_kind || ':' || p_id::text, 0));
$$;

revoke all on function lock_planning_key(text, uuid) from public;

-- The caller must hold a write scope on the row's Profile and the planned
-- item must belong to it (checked FIRST, so these definer functions never
-- reveal another Profile's rows); the planned item must be confirmed and
-- current, on an active/completed plan.
create or replace function planned_item_linkable(p_profile_id uuid, p_planned_meal_item_id uuid)
returns table (plan_date date, local_timezone text, food_id uuid, recipe_version_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item planned_meal_item%rowtype;
  v_status meal_plan_status;
  v_tz text;
  v_date date;
begin
  if profile_access_scope(p_profile_id) is null
     or profile_access_scope(p_profile_id) not in ('full_management', 'pediatric_weight_management') then
    raise exception 'not permitted to change plan fulfillment for this profile'
      using errcode = '42501';
  end if;
  select * into v_item from planned_meal_item where id = p_planned_meal_item_id and profile_id = p_profile_id;
  if not found or v_item.status <> 'confirmed' or v_item.superseded_by_planned_meal_item_id is not null then
    raise exception 'only a current confirmed planned item can be linked or skipped'
      using errcode = '23514', constraint = 'planned_item_current_confirmed';
  end if;
  select p.status, p.local_timezone, d.plan_date into v_status, v_tz, v_date
    from meal_plan p
    join meal_plan_day d on d.meal_plan_id = p.id
    join planned_meal m on m.meal_plan_day_id = d.id
   where m.id = v_item.planned_meal_id;
  if v_status not in ('active', 'completed') then
    raise exception 'links and skips can only be created on an active or completed plan'
      using errcode = '23514', constraint = 'planned_item_plan_status';
  end if;
  return query select v_date, v_tz, v_item.food_id, v_item.recipe_version_id;
end;
$$;

revoke all on function planned_item_linkable(uuid, uuid) from public;

-- ------------------------------------------------------------------
-- Link insert
-- ------------------------------------------------------------------
create or replace function planned_actual_link_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_planned record;
  v_actual meal_item%rowtype;
begin
  new.created_by_account_id := auth.uid();
  new.created_at := now();
  new.revoked_at := null;
  new.revoked_by_account_id := null;

  perform lock_planning_key('planned_item', new.planned_meal_item_id);
  select * into v_planned from planned_item_linkable(new.profile_id, new.planned_meal_item_id);

  select * into v_actual from meal_item where id = new.meal_item_id and profile_id = new.profile_id;
  if not found or v_actual.status <> 'consumed' or v_actual.superseded_by_meal_item_id is not null then
    raise exception 'only an active consumed meal item can be linked'
      using errcode = '23514', constraint = 'planned_actual_link_actual_active';
  end if;
  if (v_actual.consumed_at at time zone v_planned.local_timezone)::date <> v_planned.plan_date then
    raise exception 'the meal item was not consumed on the planned day in the plan''s time zone'
      using errcode = '23514', constraint = 'planned_actual_link_same_plan_day';
  end if;
  if new.relationship_type = 'same_item' and not (
    (v_planned.food_id is not null and v_planned.food_id = v_actual.food_id)
    or (v_planned.recipe_version_id is not null and v_planned.recipe_version_id = v_actual.recipe_version_id)
  ) then
    raise exception 'a same_item link needs the same Food or exact RecipeVersion'
      using errcode = '23514', constraint = 'planned_actual_link_same_identity';
  end if;
  if new.relationship_type = 'substitution' and (
    (v_planned.food_id is not null and v_planned.food_id = v_actual.food_id)
    or (v_planned.recipe_version_id is not null and v_planned.recipe_version_id = v_actual.recipe_version_id)
  ) then
    raise exception 'a substitution link needs a different Food or RecipeVersion'
      using errcode = '23514', constraint = 'planned_actual_link_substitution_identity';
  end if;
  if exists (select 1 from planned_meal_item_skip s where s.planned_meal_item_id = new.planned_meal_item_id and s.revoked_at is null) then
    raise exception 'the planned item is skipped'
      using errcode = '23514', constraint = 'planned_actual_link_not_skipped';
  end if;

  new.meal_item_chain_root_id := meal_item_chain_root(new.meal_item_id);
  perform lock_planning_key('meal_chain', new.meal_item_chain_root_id);
  -- the same consumption (any record of its chain) is linked to this planned item at most once
  if exists (
    select 1 from planned_actual_link l
     where l.meal_item_chain_root_id = new.meal_item_chain_root_id
       and l.revoked_at is null
       and l.planned_meal_item_id = new.planned_meal_item_id
  ) then
    raise exception 'this actual consumption is already linked to the planned item'
      using errcode = '23505', constraint = 'uq_planned_actual_link_active';
  end if;
  if exists (
    select 1 from planned_actual_link l
      join planned_meal_item p on p.id = l.planned_meal_item_id
     where l.meal_item_chain_root_id = new.meal_item_chain_root_id
       and l.revoked_at is null
       and l.planned_meal_item_id <> new.planned_meal_item_id
       and p.status = 'confirmed' and p.superseded_by_planned_meal_item_id is null
  ) then
    raise exception 'this actual consumption already fulfils another current planned item'
      using errcode = '23514', constraint = 'planned_actual_link_one_current_plan_item';
  end if;
  return new;
end;
$$;

revoke all on function planned_actual_link_insert() from public;

create trigger trg_planned_actual_link_insert
  before insert on planned_actual_link
  for each row execute function planned_actual_link_insert();

-- ------------------------------------------------------------------
-- Skip insert
-- ------------------------------------------------------------------
create or replace function planned_meal_item_skip_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.skipped_by_account_id := auth.uid();
  new.skipped_at := now();
  new.revoked_at := null;
  new.revoked_by_account_id := null;

  perform lock_planning_key('planned_item', new.planned_meal_item_id);
  perform 1 from planned_item_linkable(new.profile_id, new.planned_meal_item_id);
  if exists (select 1 from planned_actual_link l where l.planned_meal_item_id = new.planned_meal_item_id and l.revoked_at is null) then
    raise exception 'a planned item with active actual links cannot be skipped'
      using errcode = '23514', constraint = 'planned_meal_item_skip_no_links';
  end if;
  return new;
end;
$$;

revoke all on function planned_meal_item_skip_insert() from public;

create trigger trg_planned_meal_item_skip_insert
  before insert on planned_meal_item_skip
  for each row execute function planned_meal_item_skip_insert();

-- ------------------------------------------------------------------
-- Revocation is the only permitted update (once); rows are never deleted.
-- ------------------------------------------------------------------
-- Revocation, like creation, happens only on an active or completed plan:
-- a draft/cancelled/archived plan's links and skips are left as they are.
create or replace function planning_record_revoke_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status meal_plan_status;
begin
  if old.revoked_at is not null then
    raise exception '%: a revoked record is immutable', tg_table_name;
  end if;
  select p.status into v_status
    from planned_meal_item i
    join planned_meal m on m.id = i.planned_meal_id
    join meal_plan_day d on d.id = m.meal_plan_day_id
    join meal_plan p on p.id = d.meal_plan_id
   where i.id = old.planned_meal_item_id;
  if v_status is null or v_status not in ('active', 'completed') then
    raise exception 'links and skips can only be revoked on an active or completed plan'
      using errcode = '23514', constraint = 'planned_item_plan_status';
  end if;
  if new.revoked_at is null then
    raise exception '%: the only permitted change is revocation', tg_table_name;
  end if;
  new.revoked_at := now();
  new.revoked_by_account_id := auth.uid();
  if (to_jsonb(new) - 'revoked_at' - 'revoked_by_account_id') is distinct from (to_jsonb(old) - 'revoked_at' - 'revoked_by_account_id') then
    raise exception '%: the only permitted change is revocation', tg_table_name;
  end if;
  return new;
end;
$$;

create trigger trg_planned_actual_link_revoke_only
  before update on planned_actual_link
  for each row execute function planning_record_revoke_only();

create trigger trg_planned_meal_item_skip_revoke_only
  before update on planned_meal_item_skip
  for each row execute function planning_record_revoke_only();

revoke all on function planning_record_revoke_only() from public;

-- ------------------------------------------------------------------
-- RLS — Meal Planning + Meal Logging scopes (never broadened):
-- read: full_management, view_only, pediatric_weight_management;
-- write (create / revoke): full_management, pediatric_weight_management.
-- ------------------------------------------------------------------
alter table planned_actual_link enable row level security;
alter table planned_meal_item_skip enable row level security;

grant select, insert, update on planned_actual_link to authenticated;
grant select, insert, update on planned_meal_item_skip to authenticated;

create policy planned_actual_link_select_authorized on planned_actual_link for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only', 'pediatric_weight_management'));
create policy planned_actual_link_insert_managed on planned_actual_link for insert to authenticated
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));
create policy planned_actual_link_update_managed on planned_actual_link for update to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'))
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));

create policy planned_meal_item_skip_select_authorized on planned_meal_item_skip for select to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'view_only', 'pediatric_weight_management'));
create policy planned_meal_item_skip_insert_managed on planned_meal_item_skip for insert to authenticated
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));
create policy planned_meal_item_skip_update_managed on planned_meal_item_skip for update to authenticated
  using (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'))
  with check (profile_access_scope(profile_id) in ('full_management', 'pediatric_weight_management'));
