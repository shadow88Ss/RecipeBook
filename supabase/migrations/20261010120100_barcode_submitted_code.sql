-- Layer 11A (approval audit): preserve the submitted barcode representation.
--
-- Additive. `barcode_type` already records the submitted format; the
-- digits as submitted (e.g. the 8-digit UPC-E, or a UPC-A written as a
-- 13-digit EAN) are now kept as provenance beside the canonical GTIN.
-- Nullable so any earlier row stays valid; identity is still `gtin` only.

alter table barcode
  add column submitted_code text
    constraint barcode_submitted_code_digits check (submitted_code is null or submitted_code ~ '^[0-9]{8,14}$');

alter table barcode
  add constraint barcode_submitted_code_length check (
    submitted_code is null
    or length(submitted_code) = case barcode_type when 'ean_13' then 13 when 'ean_8' then 8 when 'upc_a' then 12 when 'upc_e' then 8 else 14 end
  );

-- the update guard must also keep the submitted representation immutable
create or replace function barcode_before_update()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'active' and new.status = 'retired'
     and new.id = old.id and new.product_id = old.product_id and new.gtin = old.gtin
     and new.barcode_type = old.barcode_type and new.source = old.source
     and new.submitted_code is not distinct from old.submitted_code
     and new.provenance_reference is not distinct from old.provenance_reference
     and new.created_at = old.created_at then
    return new;
  end if;
  raise exception 'barcode identity is immutable; only retirement is permitted'
    using errcode = '55000', constraint = 'barcode_immutable';
end;
$$;
