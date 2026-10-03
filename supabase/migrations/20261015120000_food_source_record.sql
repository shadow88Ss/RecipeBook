-- Layer 12B.1 — provenance for trusted reference Foods.
--
-- A Food written by trusted ingestion (first source: USDA FoodData Central,
-- SR Legacy) records exactly which external record it came from: the source
-- system and dataset, the source's own identifiers (FDC ID; SR NDB number),
-- the source release, the source description, the licence, and a SHA-256
-- of the normalized content that was ingested.
--
--   * One source record per Food, and one Food per source record
--     (unique (source_system, source_record_id)): re-running an ingestion
--     finds the existing Food instead of creating a duplicate.
--   * Rows are immutable once created. Refresh policy: an ingestion that
--     finds a source record whose content hash differs STOPS for review; it
--     never overwrites reference data in place. Logged meals are unaffected
--     either way (meal items carry their own nutrition snapshot, Layer 7A).
--   * Global reference data like the food tables: SELECT for authenticated
--     (provenance is not personal data), no INSERT/UPDATE/DELETE grant or
--     policy for any client role. Only trusted ingestion (the database owner,
--     operator-side) writes it. Explicit grants only (migration 46: no
--     automatic grants).

create type reference_source_system as enum ('usda_fdc');

create table food_source_record (
  id uuid primary key default gen_random_uuid(),
  food_id uuid not null unique references food (id) on delete restrict,
  source_system reference_source_system not null,
  source_dataset text not null check (source_dataset in ('sr_legacy')),
  source_record_id text not null check (source_record_id ~ '^[0-9]{1,12}$'),
  source_secondary_id text,
  source_release text not null check (length(source_release) between 1 and 200),
  source_description text not null check (length(source_description) between 1 and 500),
  licence text not null check (licence in ('CC0-1.0')),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  ingested_at timestamptz not null default now(),
  unique (source_system, source_record_id)
);

create trigger trg_food_source_record_immutable
  before update on food_source_record
  for each row execute function prevent_update();

alter table food_source_record enable row level security;

revoke all on food_source_record from public;
grant select on food_source_record to authenticated;

create policy food_source_record_select_all on food_source_record
  for select to authenticated
  using (true);
