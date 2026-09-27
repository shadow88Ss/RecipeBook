-- Phase 2 — Layer 5C final: global nutrient data boundary.
--
-- food_nutrient is GLOBAL reference nutrition data: it has no owner column
-- and is readable by every authenticated account. It must never hold
-- personal user-entered nutrition values (user-confirmed personal data
-- belongs to a future profile/product-scoped storage model) or AI-generated
-- nutrition estimates (never global nutrition truth).
--
-- Permitted sources for new/updated global food_nutrient rows:
--   trusted_database    trusted ingestion/admin workflows
--   manufacturer_label  representable now; exact-product resolution stays
--                       deferred until Product/Barcode exists (Layer 5B
--                       reports label vs database as ambiguous)
-- Rejected: user_entered, ai_matched.
--
-- Historical rows are NOT deleted. The constraint is added NOT VALID, so it
-- binds every future INSERT and UPDATE while leaving any pre-existing
-- user_entered / ai_matched row in place (reported below) for explicit
-- review. The Layer 5B engine continues to exclude such rows from
-- calculations. Once reviewed and removed/migrated, run:
--   alter table food_nutrient validate constraint food_nutrient_global_source;

do $$
declare
  legacy_count integer;
begin
  select count(*) into legacy_count from food_nutrient where source in ('user_entered', 'ai_matched');
  if legacy_count > 0 then
    raise notice 'food_nutrient: % pre-existing user_entered/ai_matched row(s) retained for review; constraint food_nutrient_global_source left NOT VALID', legacy_count;
  end if;
end $$;

alter table food_nutrient
  add constraint food_nutrient_global_source
  check (source in ('trusted_database', 'manufacturer_label')) not valid;
