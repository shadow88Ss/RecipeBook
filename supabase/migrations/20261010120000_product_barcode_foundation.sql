-- Phase 3 — Layer 11A: Product & Barcode foundation.
--
-- Additive. Approved decisions (Layer 11A gap report, G1–G6 = option A):
--
--   G1  Label revisions: a Product's manufacturer-label nutrition and label
--       servings belong to an immutable ProductLabelVersion. A new label
--       publishes version n+1 and supersedes n; superseded versions stay
--       readable. Children are written only by the transaction that created
--       the version (sealed afterwards).
--   G2  Generic Food scope: new/updated food_nutrient rows must be
--       trusted_database. Added NOT VALID — existing rows are kept, never
--       deleted (they cannot be updated in place).
--   G3  Product scope: only manufacturer_label nutrition is authoritative;
--       third_party_product_database values are storable with provenance but
--       not authoritative. No user-entered Product data exists (no ownership
--       or review model).
--   G4  Barcode identity: every code is stored as its canonical 14-digit
--       GTIN (UPC-A = EAN-13 with a leading 0; UPC-E expanded to UPC-A;
--       EAN-8 left-padded), GS1 mod-10 check digit validated, restricted-
--       circulation / variable-measure / coupon ranges rejected. One ACTIVE
--       barcode per GTIN (unique index).
--   G5  Barcodes are never deleted and product_id never changes. Retirement
--       (status active -> retired, with time and reason) preserves the row
--       and provenance; reuse of a GTIN for another Product happens only via
--       a future authorized trusted ingestion/admin workflow. No client
--       endpoint writes barcodes.
--   G6  No density on Product: mass <-> volume for a Product is unresolved
--       unless a label serving bridges it; the linked Food's density is never
--       borrowed.
--
-- Security: global reference data, like the food tables — SELECT for
-- `authenticated`, no INSERT/UPDATE/DELETE grant or policy. Writes belong to
-- trusted ingestion/admin workflows (service role / database owner).

-- ---------------------------------------------------------------- G2 ----
alter table food_nutrient
  add constraint food_nutrient_generic_reference_source
  check (source = 'trusted_database') not valid;

-- ---------------------------------------------------------------- enums --
create type product_status as enum ('active', 'discontinued');
-- provenance of identity/reference rows (never "user-confirmed" in 11A)
create type product_reference_source as enum ('manufacturer_data', 'approved_product_database', 'trusted_ingestion');
-- provenance of label nutrition; authority is decided per source (G3)
create type product_nutrition_source as enum ('manufacturer_label', 'third_party_product_database');
create type product_label_version_status as enum ('current', 'superseded');
create type barcode_type as enum ('ean_13', 'ean_8', 'upc_a', 'upc_e', 'gtin_14');
create type barcode_status as enum ('active', 'retired');

-- -------------------------------------------------------------- GTIN ----
-- GS1 mod-10 over a digit string whose last digit is the check digit.
create or replace function gtin_check_digit_valid(p_code text)
returns boolean
language plpgsql
immutable
strict
as $$
declare
  n int := length(p_code);
  total int := 0;
  weight int := 3;
begin
  if p_code !~ '^[0-9]+$' or n < 2 then
    return false;
  end if;
  for i in reverse n - 1 .. 1 loop
    total := total + (ascii(substr(p_code, i, 1)) - 48) * weight;
    weight := 4 - weight;
  end loop;
  return (10 - total % 10) % 10 = ascii(substr(p_code, n, 1)) - 48;
end;
$$;

-- A canonical GTIN-14 that may identify a product (mirrors barcode.ts).
create or replace function gtin_is_product_identity(p_gtin text)
returns boolean
language plpgsql
immutable
strict
as $$
declare
  body text;
begin
  if p_gtin !~ '^[0-9]{14}$' or not gtin_check_digit_valid(p_gtin) then
    return false;
  end if;
  if left(p_gtin, 1) = '9' then
    return false; -- variable-measure trade item
  end if;
  if left(p_gtin, 6) = '000000' then
    -- GTIN-8 origin: restricted-circulation EAN-8 starts with 0 or 2
    return substr(p_gtin, 7, 1) not in ('0', '2');
  end if;
  body := substr(p_gtin, 2); -- the 13-digit body
  return not (
    left(body, 2) in ('02', '04', '05', '99')
    or left(body, 1) = '2'
    or left(body, 3) in ('980', '981', '982', '983', '984')
  );
end;
$$;

-- ------------------------------------------------------------- tables ---
create table product (
  id uuid primary key default gen_random_uuid(),
  brand_name text not null check (length(btrim(brand_name)) between 1 and 200),
  product_name text not null check (length(btrim(product_name)) between 1 and 300),
  variant_name text check (variant_name is null or length(btrim(variant_name)) between 1 and 200),
  manufacturer_name text check (manufacturer_name is null or length(btrim(manufacturer_name)) between 1 and 200),
  -- ISO 3166-1 alpha-2; the same name in two markets is two Products
  market text check (market is null or market ~ '^[A-Z]{2}$'),
  -- package size is a separate fact from any label serving
  package_quantity numeric check (package_quantity is null or package_quantity > 0),
  package_unit text check (package_unit is null or package_unit in ('g', 'ml', 'count')),
  -- optional generic identity/category; never a nutrition source for the Product
  food_id uuid references food (id),
  status product_status not null default 'active',
  current_label_version_id uuid,
  source product_reference_source not null,
  provenance_reference text check (provenance_reference is null or length(provenance_reference) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_package_pairing check ((package_quantity is null) = (package_unit is null))
);

create index idx_product_food_id on product (food_id);

create trigger trg_product_set_updated_at
  before update on product
  for each row execute function set_updated_at();

create table product_label_version (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references product (id),
  version_number int not null,
  status product_label_version_status not null default 'current',
  nutrition_source product_nutrition_source not null,
  provenance_reference text check (provenance_reference is null or length(provenance_reference) <= 500),
  effective_from date,
  superseded_at timestamptz,
  superseded_by_label_version_id uuid references product_label_version (id) deferrable initially deferred,
  created_at timestamptz not null default now(),
  unique (product_id, version_number),
  unique (id, product_id),
  constraint product_label_version_supersession check (
    (status = 'current' and superseded_at is null and superseded_by_label_version_id is null)
    or (status = 'superseded' and superseded_at is not null and superseded_by_label_version_id is not null)
  )
);

create unique index uq_product_label_version_current on product_label_version (product_id) where status = 'current';

alter table product
  add constraint product_current_label_version_fk
  foreign key (current_label_version_id, id) references product_label_version (id, product_id)
  deferrable initially deferred;

create table product_nutrient (
  id uuid primary key default gen_random_uuid(),
  label_version_id uuid not null,
  product_id uuid not null,
  nutrient_id uuid not null references nutrient (id),
  -- amount in Nutrient.unit per basis_quantity basis_unit (never assumed per 100 g)
  amount numeric not null check (amount >= 0),
  basis_quantity numeric not null check (basis_quantity > 0),
  basis_unit text not null check (basis_unit in ('g', 'ml')),
  source product_nutrition_source not null,
  provenance_reference text check (provenance_reference is null or length(provenance_reference) <= 500),
  created_at timestamptz not null default now(),
  foreign key (label_version_id, product_id) references product_label_version (id, product_id),
  unique (label_version_id, nutrient_id)
);

create index idx_product_nutrient_product_id on product_nutrient (product_id);

create table product_serving (
  id uuid primary key default gen_random_uuid(),
  label_version_id uuid not null,
  product_id uuid not null,
  serving_description text not null check (length(btrim(serving_description)) between 1 and 200),
  -- the canonical amount of ONE serving as described
  canonical_quantity numeric not null check (canonical_quantity > 0),
  canonical_unit text not null check (canonical_unit in ('g', 'ml')),
  source product_nutrition_source not null,
  provenance_reference text check (provenance_reference is null or length(provenance_reference) <= 500),
  created_at timestamptz not null default now(),
  foreign key (label_version_id, product_id) references product_label_version (id, product_id)
);

create index idx_product_serving_product_id on product_serving (product_id);

create table barcode (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references product (id),
  gtin text not null check (gtin_is_product_identity(gtin)),
  barcode_type barcode_type not null,
  status barcode_status not null default 'active',
  retired_at timestamptz,
  retired_reason text check (retired_reason is null or length(btrim(retired_reason)) between 1 and 500),
  source product_reference_source not null,
  provenance_reference text check (provenance_reference is null or length(provenance_reference) <= 500),
  created_at timestamptz not null default now(),
  constraint barcode_retirement check (
    (status = 'active' and retired_at is null and retired_reason is null)
    or (status = 'retired' and retired_at is not null and retired_reason is not null)
  ),
  -- the declared format must be consistent with the canonical form
  constraint barcode_type_shape check (
    case barcode_type
      when 'ean_8' then left(gtin, 6) = '000000'
      when 'upc_a' then left(gtin, 2) = '00' and left(gtin, 6) <> '000000'
      when 'upc_e' then left(gtin, 2) = '00' and left(gtin, 6) <> '000000'
      when 'ean_13' then left(gtin, 1) = '0' and left(gtin, 6) <> '000000'
      else true
    end
  )
);

create unique index uq_barcode_active_gtin on barcode (gtin) where status = 'active';
create index idx_barcode_product_id on barcode (product_id);

-- ----------------------------------------------------------- triggers ---
-- Label versions: numbered 1..n per product; the new one becomes current
-- and supersedes the previous current version; product points to it.
create or replace function product_label_version_before_insert()
returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('product_label:' || new.product_id::text, 0));
  select coalesce(max(version_number), 0) + 1 into new.version_number
    from product_label_version where product_id = new.product_id;
  new.status := 'current';
  new.superseded_at := null;
  new.superseded_by_label_version_id := null;
  new.created_at := now();
  update product_label_version
     set status = 'superseded', superseded_at = now(), superseded_by_label_version_id = new.id
   where product_id = new.product_id and status = 'current';
  return new;
end;
$$;

create trigger trg_product_label_version_before_insert
  before insert on product_label_version
  for each row execute function product_label_version_before_insert();

create or replace function product_label_version_after_insert()
returns trigger
language plpgsql
as $$
begin
  update product set current_label_version_id = new.id where id = new.product_id;
  return null;
end;
$$;

create trigger trg_product_label_version_after_insert
  after insert on product_label_version
  for each row execute function product_label_version_after_insert();

-- The only permitted change to a version is the one-time supersession.
create or replace function product_label_version_before_update()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'current' and new.status = 'superseded'
     and new.id = old.id and new.product_id = old.product_id and new.version_number = old.version_number
     and new.nutrition_source = old.nutrition_source
     and new.provenance_reference is not distinct from old.provenance_reference
     and new.effective_from is not distinct from old.effective_from
     and new.created_at = old.created_at then
    return new;
  end if;
  raise exception 'product label versions are immutable; publish a new version'
    using errcode = '55000', constraint = 'product_label_version_immutable';
end;
$$;

create trigger trg_product_label_version_before_update
  before update on product_label_version
  for each row execute function product_label_version_before_update();

-- Label nutrients and servings are written only by the transaction that
-- created their version (created_at = now() is that transaction's start).
create or replace function product_label_child_insert()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from product_label_version v
     where v.id = new.label_version_id and v.product_id = new.product_id and v.created_at = now()
  ) then
    raise exception 'a published product label version is sealed; publish a new version'
      using errcode = '55000', constraint = 'product_label_version_sealed';
  end if;
  return new;
end;
$$;

create trigger trg_product_nutrient_sealed
  before insert on product_nutrient
  for each row execute function product_label_child_insert();
create trigger trg_product_serving_sealed
  before insert on product_serving
  for each row execute function product_label_child_insert();

create trigger trg_product_nutrient_prevent_update
  before update on product_nutrient
  for each row execute function prevent_update();
create trigger trg_product_serving_prevent_update
  before update on product_serving
  for each row execute function prevent_update();

-- Barcodes: product_id, gtin, type and provenance never change; the only
-- change is active -> retired (G5).
create or replace function barcode_before_update()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'active' and new.status = 'retired'
     and new.id = old.id and new.product_id = old.product_id and new.gtin = old.gtin
     and new.barcode_type = old.barcode_type and new.source = old.source
     and new.provenance_reference is not distinct from old.provenance_reference
     and new.created_at = old.created_at then
    return new;
  end if;
  raise exception 'barcode identity is immutable; only retirement is permitted'
    using errcode = '55000', constraint = 'barcode_immutable';
end;
$$;

create trigger trg_barcode_before_update
  before update on barcode
  for each row execute function barcode_before_update();

-- History is never deleted (any role).
create trigger trg_product_prevent_delete before delete on product for each row execute function prevent_mutation();
create trigger trg_product_label_version_prevent_delete before delete on product_label_version for each row execute function prevent_mutation();
create trigger trg_product_nutrient_prevent_delete before delete on product_nutrient for each row execute function prevent_mutation();
create trigger trg_product_serving_prevent_delete before delete on product_serving for each row execute function prevent_mutation();
create trigger trg_barcode_prevent_delete before delete on barcode for each row execute function prevent_mutation();

-- ------------------------------------------------ trusted publishing ----
-- Trusted ingestion/admin only (not granted to `authenticated`): publishes a
-- label version with its nutrients and servings atomically.
--   p_nutrients: [ { nutrient_id, amount, basis_quantity, basis_unit, provenance_reference? } ]
--   p_servings:  [ { serving_description, canonical_quantity, canonical_unit, provenance_reference? } ]
create or replace function publish_product_label_version(
  p_product_id uuid,
  p_nutrition_source product_nutrition_source,
  p_provenance_reference text,
  p_effective_from date,
  p_nutrients jsonb,
  p_servings jsonb
)
returns uuid
language plpgsql
as $$
declare
  v_id uuid := gen_random_uuid();
  v_row jsonb;
begin
  insert into product_label_version (id, product_id, version_number, nutrition_source, provenance_reference, effective_from)
  values (v_id, p_product_id, 0, p_nutrition_source, p_provenance_reference, p_effective_from);
  for v_row in select * from jsonb_array_elements(coalesce(p_nutrients, '[]'::jsonb)) loop
    insert into product_nutrient (label_version_id, product_id, nutrient_id, amount, basis_quantity, basis_unit, source, provenance_reference)
    values (v_id, p_product_id, (v_row->>'nutrient_id')::uuid, (v_row->>'amount')::numeric, (v_row->>'basis_quantity')::numeric,
            v_row->>'basis_unit', p_nutrition_source, coalesce(v_row->>'provenance_reference', p_provenance_reference));
  end loop;
  for v_row in select * from jsonb_array_elements(coalesce(p_servings, '[]'::jsonb)) loop
    insert into product_serving (label_version_id, product_id, serving_description, canonical_quantity, canonical_unit, source, provenance_reference)
    values (v_id, p_product_id, v_row->>'serving_description', (v_row->>'canonical_quantity')::numeric, v_row->>'canonical_unit',
            p_nutrition_source, coalesce(v_row->>'provenance_reference', p_provenance_reference));
  end loop;
  return v_id;
end;
$$;

revoke all on function publish_product_label_version(uuid, product_nutrition_source, text, date, jsonb, jsonb) from public;

-- ---------------------------------------------------------------- RLS ---
alter table product enable row level security;
alter table product_label_version enable row level security;
alter table product_nutrient enable row level security;
alter table product_serving enable row level security;
alter table barcode enable row level security;

grant select on product, product_label_version, product_nutrient, product_serving, barcode to authenticated;

create policy product_select_all on product for select to authenticated using (true);
create policy product_label_version_select_all on product_label_version for select to authenticated using (true);
create policy product_nutrient_select_all on product_nutrient for select to authenticated using (true);
create policy product_serving_select_all on product_serving for select to authenticated using (true);
create policy barcode_select_all on barcode for select to authenticated using (true);
