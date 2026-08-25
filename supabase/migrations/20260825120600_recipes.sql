-- Phase 1 — Layer 1: Database Foundation
-- Recipe, RecipeVersion, RecipeIngredient, RecipeInstruction, RecipePersonalizedVariant.
-- Base Recipe / RecipeVersion / RecipePersonalizedVariant are three distinct
-- concepts per 00_Master.md §11 — never conflated.

create table recipe (
  id uuid primary key default gen_random_uuid(),
  canonical_title text not null,
  created_by_account_id uuid references account (id) on delete set null,
  created_by_profile_id uuid references profile (id) on delete set null,
  visibility recipe_visibility not null default 'private',
  current_version_id uuid, -- FK added below once recipe_version exists (circular reference)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_recipe_set_updated_at
  before update on recipe
  for each row execute function set_updated_at();

create table recipe_version (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references recipe (id) on delete cascade,
  version_number integer not null check (version_number > 0),
  title text not null,
  description text,
  servings numeric check (servings is null or servings > 0),
  -- Traceability back to both the source and the specific import/extraction
  -- operation (29_Data_Model.md §7.4) — null for a manually authored version.
  origin_url_source_id uuid references url_source (id) on delete set null,
  origin_import_job_id uuid references import_job (id) on delete set null,
  origin_ai_extraction_id uuid references ai_extraction (id) on delete set null,
  created_by_account_id uuid references account (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (recipe_id, version_number)
);

create index idx_recipe_version_recipe_id on recipe_version (recipe_id);

-- Immutable: a change to a recipe's canonical representation produces a new
-- version, never an in-place edit (00_Master.md §11.2).
create trigger trg_recipe_version_prevent_update
  before update on recipe_version
  for each row execute function prevent_update();

alter table recipe
  add constraint fk_recipe_current_version
  foreign key (current_version_id) references recipe_version (id) on delete set null;

create table recipe_ingredient (
  id uuid primary key default gen_random_uuid(),
  recipe_version_id uuid not null references recipe_version (id) on delete cascade,
  food_id uuid references food (id) on delete set null,
  raw_ingredient_text text not null,
  quantity numeric check (quantity is null or quantity > 0),
  unit text,
  match_confidence numeric check (match_confidence is null or (match_confidence >= 0 and match_confidence <= 1)),
  match_status recipe_ingredient_match_status not null default 'needs_confirmation',
  sort_order integer not null,
  created_at timestamptz not null default now()
);

create index idx_recipe_ingredient_recipe_version_id on recipe_ingredient (recipe_version_id);

create trigger trg_recipe_ingredient_prevent_update
  before update on recipe_ingredient
  for each row execute function prevent_update();

create table recipe_instruction (
  id uuid primary key default gen_random_uuid(),
  recipe_version_id uuid not null references recipe_version (id) on delete cascade,
  step_number integer not null check (step_number > 0),
  instruction_text text not null,
  created_at timestamptz not null default now(),
  unique (recipe_version_id, step_number)
);

create trigger trg_recipe_instruction_prevent_update
  before update on recipe_instruction
  for each row execute function prevent_update();

create table recipe_personalized_variant (
  id uuid primary key default gen_random_uuid(),
  base_recipe_id uuid not null references recipe (id) on delete restrict,
  base_recipe_version_id uuid not null references recipe_version (id) on delete restrict,
  profile_id uuid not null references profile (id) on delete cascade,
  adjustments_payload jsonb not null,
  ai_generated boolean not null default false,
  source_confidence numeric check (source_confidence is null or (source_confidence >= 0 and source_confidence <= 1)),
  user_accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- source_confidence present only when ai_generated (29_Data_Model_Data_Dictionary.md §23).
  constraint recipe_personalized_variant_confidence_requires_ai
    check (ai_generated = true or source_confidence is null)
);

create index idx_recipe_personalized_variant_base_recipe on recipe_personalized_variant (base_recipe_id);
create index idx_recipe_personalized_variant_profile on recipe_personalized_variant (profile_id);

create trigger trg_recipe_personalized_variant_set_updated_at
  before update on recipe_personalized_variant
  for each row execute function set_updated_at();
