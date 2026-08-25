-- Phase 1 — Layer 1: Database Foundation
-- MealLog, MealItem.
-- MealLog holds no independent status field — status is owned solely by
-- MealItem (00_Master.md §6, 29_Data_Model.md §3) to avoid a dual source of truth.

create table meal_log (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profile (id) on delete cascade,
  meal_type meal_type not null,
  logged_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_meal_log_profile_date on meal_log (profile_id, logged_date);

create trigger trg_meal_log_set_updated_at
  before update on meal_log
  for each row execute function set_updated_at();

create table meal_item (
  id uuid primary key default gen_random_uuid(),
  meal_log_id uuid not null references meal_log (id) on delete cascade,
  profile_id uuid not null references profile (id) on delete cascade, -- denormalized for direct RLS filtering
  recipe_version_id uuid references recipe_version (id) on delete restrict,
  recipe_personalized_variant_id uuid references recipe_personalized_variant (id) on delete restrict,
  food_id uuid references food (id) on delete restrict,
  food_serving_id uuid references food_serving (id) on delete restrict,
  quantity numeric not null check (quantity > 0),
  status meal_item_status not null default 'draft',
  confirmed_at timestamptz,
  consumed_at timestamptz,
  status_changed_by_actor_type meal_item_actor_type not null default 'user',
  status_changed_by_account_id uuid references account (id) on delete set null,
  corrects_meal_item_id uuid references meal_item (id) on delete set null,
  superseded_by_meal_item_id uuid references meal_item (id) on delete set null,
  correction_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meal_item_status_changed_by_user_requires_account
    check (status_changed_by_actor_type <> 'user' or status_changed_by_account_id is not null),
  constraint meal_item_correction_requires_reason
    check (corrects_meal_item_id is null or correction_reason is not null)
);

create index idx_meal_item_profile_meal_log on meal_item (profile_id, meal_log_id);
create index idx_meal_item_status on meal_item (status);

create trigger trg_meal_item_set_updated_at
  before update on meal_item
  for each row execute function set_updated_at();

-- Enforces the meal lifecycle state machine (00_Master.md §6, 29_Data_Model.md §3.2-3.3):
--   draft -> planned -> confirmed -> consumed, with skipped/cancelled branches,
--   no backward transitions, and a consumed row is immutable except for the one
--   field a correction sets (superseded_by_meal_item_id, once).
create function enforce_meal_item_status_transition()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'consumed' then
    if new.superseded_by_meal_item_id is distinct from old.superseded_by_meal_item_id then
      if old.superseded_by_meal_item_id is not null then
        raise exception 'meal_item %: superseded_by_meal_item_id already set, cannot change', old.id;
      end if;
      if new.status is distinct from old.status
        or new.recipe_version_id is distinct from old.recipe_version_id
        or new.recipe_personalized_variant_id is distinct from old.recipe_personalized_variant_id
        or new.food_id is distinct from old.food_id
        or new.food_serving_id is distinct from old.food_serving_id
        or new.quantity is distinct from old.quantity
        or new.consumed_at is distinct from old.consumed_at
        or new.confirmed_at is distinct from old.confirmed_at
      then
        raise exception 'meal_item %: consumed items are immutable except for superseded_by_meal_item_id', old.id;
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

create trigger trg_meal_item_status_transition
  before update on meal_item
  for each row execute function enforce_meal_item_status_transition();
