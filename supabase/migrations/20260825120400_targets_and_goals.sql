-- Phase 1 — Layer 1: Database Foundation
-- Goal, NutritionTarget, ClinicianTarget, WeightMeasurement, EffectiveTargetSnapshot.
-- EffectiveTargetResolver itself is a computed-on-read service, not a table
-- (00_Master.md §8, approved design) — only its immutable snapshot is persisted.

create table goal (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profile (id) on delete cascade,
  goal_type goal_type not null,
  target_weight_kg numeric check (target_weight_kg is null or target_weight_kg > 0),
  target_date date,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_goal_profile_id on goal (profile_id);

create trigger trg_goal_set_updated_at
  before update on goal
  for each row execute function set_updated_at();

-- NutritionTarget and ClinicianTarget are modeled as narrow per-field rows
-- (profile_id, field_name, value) rather than wide objects, so the
-- EffectiveTargetResolver can merge sources field-by-field per 00_Master.md §8.1.
-- field_name is intentionally `text`, not an enum: the full resolvable-field
-- vocabulary (calories, macros, fiber, each micronutrient, ...) belongs to
-- 02_Nutrition_Targets.md / 06_Nutrition_Database.md (Phase 2), not Phase 1.
create table nutrition_target (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profile (id) on delete cascade,
  field_name text not null check (length(field_name) > 0),
  value numeric not null,
  unit text not null,
  is_active boolean not null default true,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_nutrition_target_profile_id on nutrition_target (profile_id);

create unique index uq_nutrition_target_active_field
  on nutrition_target (profile_id, field_name)
  where is_active = true;

create trigger trg_nutrition_target_set_updated_at
  before update on nutrition_target
  for each row execute function set_updated_at();

-- Automatically supersedes the previously active row for the same
-- (profile_id, field_name) rather than relying on the application to sequence
-- two writes correctly — works alongside uq_nutrition_target_active_field.
-- Must run BEFORE INSERT: the partial unique index is checked at insert time,
-- so the prior active row has to be superseded before the new row lands, not
-- after (an AFTER INSERT trigger fires too late and the index check fails first).
create function supersede_previous_nutrition_target()
returns trigger
language plpgsql
as $$
begin
  if new.is_active then
    update nutrition_target
      set is_active = false, superseded_at = now()
      where profile_id = new.profile_id
        and field_name = new.field_name
        and id <> new.id
        and is_active = true;
  end if;
  return new;
end;
$$;

create trigger trg_nutrition_target_supersede
  before insert on nutrition_target
  for each row execute function supersede_previous_nutrition_target();

create table clinician_target (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profile (id) on delete cascade,
  field_name text not null check (length(field_name) > 0),
  value numeric not null,
  unit text not null,
  source_type clinician_target_source_type not null,
  verification_status clinician_target_verification_status not null default 'unverified',
  provided_by_account_id uuid not null references account (id) on delete restrict,
  entered_at timestamptz not null,
  is_active boolean not null default true,
  superseded_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_clinician_target_profile_id on clinician_target (profile_id);

create unique index uq_clinician_target_active_field
  on clinician_target (profile_id, field_name)
  where is_active = true;

create function supersede_previous_clinician_target()
returns trigger
language plpgsql
as $$
begin
  if new.is_active then
    update clinician_target
      set is_active = false, superseded_at = now()
      where profile_id = new.profile_id
        and field_name = new.field_name
        and id <> new.id
        and is_active = true;
  end if;
  return new;
end;
$$;

create trigger trg_clinician_target_supersede
  before insert on clinician_target
  for each row execute function supersede_previous_clinician_target();

create table weight_measurement (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profile (id) on delete cascade,
  measured_at timestamptz not null,
  value_kg numeric not null check (value_kg > 0),
  source weight_measurement_source not null,
  provenance_reference uuid,
  corrects_measurement_id uuid references weight_measurement (id) on delete set null,
  created_at timestamptz not null default now()
);

create index idx_weight_measurement_profile_id on weight_measurement (profile_id);

-- Immutable historical fact; a correction is a new row referencing this one
-- via corrects_measurement_id, never an in-place edit (29_Data_Model_Data_Dictionary.md §10).
create trigger trg_weight_measurement_prevent_update
  before update on weight_measurement
  for each row execute function prevent_update();

create table effective_target_snapshot (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profile (id) on delete cascade,
  snapshot_payload jsonb not null,
  resolver_version text not null,
  resolved_at timestamptz not null,
  snapshot_reason effective_target_snapshot_reason not null,
  linked_event_type effective_target_linked_event_type,
  linked_event_id uuid,
  created_at timestamptz not null default now(),
  constraint effective_target_snapshot_linked_event_pair
    check (linked_event_type is null or linked_event_id is not null)
);

create index idx_effective_target_snapshot_profile_id on effective_target_snapshot (profile_id, resolved_at);

-- Write-once per approved design: never the current source of truth, never
-- rewritten by a later target/profile/safety-rule change (00_Master.md §8, approved design).
create trigger trg_effective_target_snapshot_prevent_update
  before update on effective_target_snapshot
  for each row execute function prevent_update();
