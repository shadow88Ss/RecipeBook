-- Phase 1 — Layer 1: Database Foundation
-- Food, FoodAlias, FoodServing, Nutrient, FoodNutrient.
-- Global, language-neutral reference data — never profile-scoped (Master §13, §20).

create table food (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null unique,
  category text,
  source food_data_source not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_food_set_updated_at
  before update on food
  for each row execute function set_updated_at();

create table food_alias (
  id uuid primary key default gen_random_uuid(),
  food_id uuid not null references food (id) on delete cascade,
  locale text not null,
  alias_text text not null,
  is_primary boolean not null default false,
  source food_alias_serving_source not null,
  created_at timestamptz not null default now(),
  unique (food_id, locale, alias_text)
);

create index idx_food_alias_locale_text on food_alias (locale, alias_text);

-- At most one primary alias per (food_id, locale).
create unique index uq_food_alias_primary on food_alias (food_id, locale) where is_primary = true;

create table food_serving (
  id uuid primary key default gen_random_uuid(),
  food_id uuid not null references food (id) on delete cascade,
  serving_description text not null,
  region text,
  canonical_quantity numeric not null check (canonical_quantity > 0),
  canonical_unit text not null,
  source food_alias_serving_source not null,
  created_at timestamptz not null default now(),
  unique (food_id, serving_description, region)
);

-- Standard NULL-distinct uniqueness above does not catch duplicate region-agnostic
-- rows (multiple rows with region IS NULL are not caught by a plain UNIQUE
-- constraint); this partial index closes that gap explicitly.
create unique index uq_food_serving_region_agnostic
  on food_serving (food_id, serving_description)
  where region is null;

create table nutrient (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  unit text not null,
  created_at timestamptz not null default now()
);

create table food_nutrient (
  id uuid primary key default gen_random_uuid(),
  food_id uuid not null references food (id) on delete cascade,
  nutrient_id uuid not null references nutrient (id) on delete restrict,
  amount_per_canonical_unit numeric not null check (amount_per_canonical_unit >= 0),
  source food_data_source not null,
  created_at timestamptz not null default now(),
  unique (food_id, nutrient_id, source)
);

create index idx_food_nutrient_food_id on food_nutrient (food_id);
create index idx_food_nutrient_nutrient_id on food_nutrient (nutrient_id);
