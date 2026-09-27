-- Phase 2 — Layer 5A: Food & Conversion Foundation.
--
-- Closes three gaps in the Layer 1 food reference schema
-- (20260825120300_food_reference_data.sql) that make deterministic
-- conversion impossible without guessing, and adds one read-only,
-- RLS-respecting search function. Nothing here grants any write path to
-- `authenticated`: the five food tables stay read-only for clients exactly
-- as 20260825121200_rls_food_reference_data.sql decided.
--
-- 1. Mass <-> volume density. Converting "1 cup of flour" to grams needs a
--    per-food density; no column held one, so the only alternatives were
--    assuming water (1 g/ml) or parsing free-text serving descriptions —
--    both forbidden guesses (Master §5: deterministic services calculate
--    from stored reference data). Density is nullable: a food without a
--    stored density simply cannot be converted across dimensions, and the
--    conversion service reports that as an unresolved outcome. Density
--    carries its own source so its provenance is never implied from the
--    food row's (Master §5, §16).
--
-- 2. Canonical units. `food_serving.canonical_unit` was free text ("e.g.
--    grams"). It is now restricted to the two canonical base units the
--    conversion service is defined over: 'g' (mass) and 'ml' (volume).
--
-- 3. FoodNutrient reference basis. `amount_per_canonical_unit` was
--    documented as "e.g. per 100g" with no column stating the basis, so
--    "per 1 g" vs "per 100 g" vs "per 100 ml" was undecidable from the row.
--    `basis_quantity` + `basis_unit` make it explicit; the defaults
--    (100, 'g') match the Data Dictionary's documented example. The amount
--    column keeps its Layer 1 name so no existing contract changes.

-- 1. Density ----------------------------------------------------------------

alter table food
  add column density_g_per_ml numeric check (density_g_per_ml > 0),
  add column density_source food_data_source,
  add constraint food_density_source_pairing
    check ((density_g_per_ml is null) = (density_source is null));

-- 2. Canonical serving unit ---------------------------------------------------

alter table food_serving
  add constraint food_serving_canonical_unit_base
    check (canonical_unit in ('g', 'ml'));

-- 3. Nutrient reference basis --------------------------------------------------

alter table food_nutrient
  add column basis_quantity numeric not null default 100 check (basis_quantity > 0),
  add column basis_unit text not null default 'g' check (basis_unit in ('g', 'ml'));

-- 4. Search ---------------------------------------------------------------------

-- Case-insensitive alias lookups (exact/prefix/contains all normalize with
-- lower()).
create index idx_food_alias_lower_text on food_alias (lower(alias_text));

-- Locale-aware alias search. SECURITY INVOKER (the default, stated
-- explicitly): it runs as the caller, so food/food_alias RLS applies exactly
-- as for a direct SELECT. The caller normalizes `p_query` (Unicode NFKC,
-- trimmed, whitespace collapsed, lower-cased) and computes the locale
-- fallback chain in `p_locales` (most specific first, ending in the default
-- 'en'); this function only filters and ranks, so the ranking rule lives in
-- one place and is covered by the API integration tests.
--
-- One row per matching food, ranked by:
--   match_rank   0 exact alias, 1 alias prefix, 2 alias substring;
--   locale_rank  position of the matched alias's locale in p_locales,
--                then "same language, other region", then any other locale
--                — a food is never hidden because its only alias is in
--                another locale, it just ranks lower;
--   source       ai_matched aliases rank below validated ones (Master §16);
--   primary, shorter alias, canonical_name, id — a total, deterministic order.
-- `display_name` is the food's best alias for the caller's locale chain
-- (independent of which alias matched), falling back to canonical_name.
create function search_foods(p_query text, p_locales text[], p_limit integer)
returns table (
  food_id uuid,
  canonical_name text,
  category text,
  source food_data_source,
  display_name text,
  display_locale text,
  matched_alias text,
  matched_locale text,
  match_rank integer,
  locale_rank integer
)
language sql
stable
security invoker
set search_path = public
as $$
  with params as (
    select
      p_query as term,
      (select array_agg(lower(l)) from unnest(p_locales) as l) as chain,
      lower(split_part(p_locales[1], '-', 1)) as language,
      least(greatest(coalesce(p_limit, 50), 1), 1000) as row_cap
  ),
  scored as (
    select
      a.food_id,
      a.alias_text,
      a.locale,
      a.is_primary,
      (a.source = 'ai_matched') as is_unvalidated,
      case
        when lower(a.alias_text) = p.term then 0
        when starts_with(lower(a.alias_text), p.term) then 1
        else 2
      end as match_rank,
      coalesce(
        array_position(p.chain, lower(a.locale)),
        case when lower(split_part(a.locale, '-', 1)) = p.language
          then cardinality(p.chain) + 1
          else cardinality(p.chain) + 2
        end
      ) as locale_rank
    from food_alias a
    cross join params p
    where p.term <> ''
      and strpos(lower(a.alias_text), p.term) > 0
  ),
  matches as (
    select distinct on (food_id) *
    from scored
    order by food_id, match_rank, locale_rank, is_unvalidated, is_primary desc, length(alias_text), alias_text
  )
  select
    f.id,
    f.canonical_name,
    f.category,
    f.source,
    coalesce(d.alias_text, f.canonical_name),
    d.locale,
    m.alias_text,
    m.locale,
    m.match_rank,
    m.locale_rank
  from matches m
  join food f on f.id = m.food_id
  cross join params p
  left join lateral (
    select a2.alias_text, a2.locale
    from food_alias a2
    where a2.food_id = f.id
    order by
      coalesce(
        array_position(p.chain, lower(a2.locale)),
        case when lower(split_part(a2.locale, '-', 1)) = p.language
          then cardinality(p.chain) + 1
          else cardinality(p.chain) + 2
        end
      ),
      (a2.source = 'ai_matched'),
      a2.is_primary desc,
      a2.alias_text
    limit 1
  ) d on true
  order by
    m.match_rank,
    m.locale_rank,
    m.is_unvalidated,
    m.is_primary desc,
    length(m.alias_text),
    f.canonical_name,
    f.id
  limit (select row_cap from params);
$$;

revoke all on function search_foods(text, text[], integer) from public;
grant execute on function search_foods(text, text[], integer) to authenticated;
