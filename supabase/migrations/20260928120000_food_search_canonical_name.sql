-- Phase 2 — Layer 5A final architecture alignment: canonical_name as a
-- deterministic search fallback.
--
-- Replaces search_foods() from 20260927120000_food_conversion_foundation.sql
-- (dropped and recreated because its result columns change). Nothing else
-- in that migration changes.
--
-- Matching now has two tiers:
--   1. FoodAlias (localized display names) — the primary search surface,
--      ranked exactly as before.
--   2. Food.canonical_name (language-neutral internal key) — a fallback.
--      Matched both as stored and with '_' read as a space, so
--      "chickpeas cooked" finds `chickpeas_cooked`.
-- Per food, an alias match always wins over a canonical_name match. Across
-- foods, every alias-matched food ranks ahead of every food matched only
-- through canonical_name.
--
-- display_name is still resolved only from FoodAlias. It is NULL when the
-- food has no alias at all — canonical_name is never returned as if it were
-- a translated display label just because it matched (it is still returned
-- in its own canonical_name column).

drop function search_foods(text, text[], integer);

create function search_foods(p_query text, p_locales text[], p_limit integer)
returns table (
  food_id uuid,
  canonical_name text,
  category text,
  source food_data_source,
  display_name text,
  display_locale text,
  match_source text,
  matched_text text,
  matched_locale text,
  matched_alias_source food_alias_serving_source,
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
  alias_scored as (
    select
      a.food_id,
      0 as source_tier,
      a.alias_text as matched_text,
      a.locale as matched_locale,
      a.source as matched_alias_source,
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
  canonical_scored as (
    select
      f.id as food_id,
      1 as source_tier,
      f.canonical_name as matched_text,
      null::text as matched_locale,
      null::food_alias_serving_source as matched_alias_source,
      false as is_primary,
      false as is_unvalidated,
      least(
        case
          when k.raw = p.term then 0
          when starts_with(k.raw, p.term) then 1
          when strpos(k.raw, p.term) > 0 then 2
          else 3
        end,
        case
          when k.spaced = p.term then 0
          when starts_with(k.spaced, p.term) then 1
          when strpos(k.spaced, p.term) > 0 then 2
          else 3
        end
      ) as match_rank,
      0 as locale_rank
    from food f
    cross join params p
    cross join lateral (
      select lower(f.canonical_name) as raw, replace(lower(f.canonical_name), '_', ' ') as spaced
    ) k
    where p.term <> ''
      and (strpos(k.raw, p.term) > 0 or strpos(k.spaced, p.term) > 0)
  ),
  scored as (
    select * from alias_scored
    union all
    select * from canonical_scored
  ),
  matches as (
    select distinct on (food_id) *
    from scored
    order by
      food_id,
      source_tier,
      match_rank,
      locale_rank,
      is_unvalidated,
      is_primary desc,
      length(matched_text),
      matched_text
  )
  select
    f.id,
    f.canonical_name,
    f.category,
    f.source,
    d.alias_text,
    d.locale,
    case when m.source_tier = 0 then 'alias' else 'canonical_name' end,
    m.matched_text,
    m.matched_locale,
    m.matched_alias_source,
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
    m.source_tier,
    m.match_rank,
    m.locale_rank,
    m.is_unvalidated,
    m.is_primary desc,
    length(m.matched_text),
    f.canonical_name,
    f.id
  limit (select row_cap from params);
$$;

revoke all on function search_foods(text, text[], integer) from public;
grant execute on function search_foods(text, text[], integer) to authenticated;
