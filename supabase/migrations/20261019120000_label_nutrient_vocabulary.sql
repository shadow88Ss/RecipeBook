-- Phase 4 — Layer 12B.3: nutrition label vocabulary (migration 49).
--
-- Additive. Four canonical nutrient identities for manufacturer labels in
-- the UAE, UK, EU and US (approved policy, Layer 12B.3):
--
--   available_carbohydrate  g  other  carbohydrate EXCLUDING dietary fibre, as
--                                     declared by EU/UK (Regulation 1169/2011)
--                                     and Codex-style labels. Never mapped to,
--                                     or computed from, `carbohydrate` (total,
--                                     including fibre), which keeps its meaning.
--   total_sugars            g  other  all mono- and disaccharides as declared
--                                     ("Total Sugars" / EU "sugars").
--   added_sugars            g  other  added sugars as declared; never inferred
--                                     from total sugars.
--   saturated_fat           g  other  saturated fatty acids as declared; never
--                                     derived from total fat.
--
-- Role `other`: these are sub-components of, or alternatives to, existing
-- macronutrients, so no projection that groups macronutrients can count them
-- twice. Units satisfy nutrient_role_reporting_unit.
--
-- Nothing existing changes: the 22 nutrient rows (ids, units, roles), every
-- food_nutrient / product_nutrient value, every label version and every
-- meal_item nutrition snapshot stay exactly as they are. Snapshots record
-- their own nutrient definitions, so a nutrient added here is "unknown" for
-- meals logged before it, never 0. No grant or policy changes: `nutrient` is
-- already readable reference data and not writable by clients.
--
-- Target vocabulary (Layer 7C): every canonical nutrient key is a canonical
-- target key, so these four become VALID target field names; each also gets
-- its generated `<key>_<unit>` input alias, exactly as 20261003120000 did for
-- the original 22 (code and database alias maps stay identical). No target
-- is created, no existing alias changes, and the carbohydrate target keeps
-- meaning total carbohydrate.

do $$
declare
  additions constant jsonb := '[
    ["available_carbohydrate", "other", "g"],
    ["total_sugars", "other", "g"],
    ["added_sugars", "other", "g"],
    ["saturated_fat", "other", "g"]
  ]';
  entry jsonb;
  existing record;
begin
  for entry in select * from jsonb_array_elements(additions) loop
    select canonical_key, unit, role::text as role into existing from nutrient where canonical_key = entry->>0;
    if found then
      -- Never reinterpret an existing identity.
      if existing.unit <> entry->>2 or existing.role <> entry->>1 then
        raise exception 'Nutrient % already exists as % (%), expected % (%)', entry->>0, existing.unit, existing.role, entry->>2, entry->>1;
      end if;
    else
      insert into nutrient (canonical_key, unit, role) values (entry->>0, entry->>2, (entry->>1)::nutrient_role);
    end if;
  end loop;
end $$;

insert into target_field_alias (alias, canonical_key, implied_unit)
select n.canonical_key || '_' || n.unit, n.canonical_key, n.unit
  from nutrient n
 where n.canonical_key in ('available_carbohydrate', 'total_sugars', 'added_sugars', 'saturated_fat')
on conflict (alias) do nothing;
