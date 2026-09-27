// Layer 5A — Food reference data and food-aware conversion.
//
// Food, FoodAlias, FoodServing, Nutrient and FoodNutrient are global,
// language-neutral reference data, not profile data (Master §13; Data
// Dictionary §14-18). Every authenticated Account may read all of it
// (20260825121200_rls_food_reference_data.sql: `using (true)` SELECT
// policies for `authenticated`, no INSERT/UPDATE/DELETE policy or grant),
// so there is no profile_id and no requireProfileScope() here. Every query
// still runs through the caller's own RLS-scoped ScopedDbClient — never a
// service-role credential — so an unauthenticated or anon caller reads
// nothing even if the API-layer auth middleware were bypassed.
//
// No write path exists in this service: populating food data belongs to a
// trusted ingestion workflow that is not part of Layer 5A.

import { AppError } from '../../lib/errors';
import { paginateInMemory, IN_MEMORY_PAGE_FETCH_CAP, type Page, type PaginationQuery } from '../../lib/pagination';
import type { ScopedDbClient, ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import { convert, type ConversionResult, type FoodConversionData, type ReferenceSource } from '../conversion/conversion.engine';
import type { FoodConversionInput } from '../conversion/conversion.schemas';
import { localeFallbackChain, localeRank, regionOfLocale } from './locale';
import type {
  FoodAliasDto,
  FoodDetailDto,
  FoodDetailQuery,
  FoodNutrientDto,
  FoodSearchQuery,
  FoodSearchResult,
  FoodServingDto,
  NutrientDto,
} from './food.schemas';

interface FoodRow {
  id: string;
  canonical_name: string;
  category: string | null;
  source: ReferenceSource;
  density_g_per_ml: number | null;
  density_source: ReferenceSource | null;
}
const FOOD_COLUMNS = 'id, canonical_name, category, source, density_g_per_ml, density_source';

const ALIAS_COLUMNS = 'id, locale, alias_text, is_primary, source';
const SERVING_COLUMNS = 'id, serving_description, region, canonical_quantity, canonical_unit, source';
const NUTRIENT_COLUMNS = 'id, canonical_key, unit';

interface FoodNutrientRow {
  id: string;
  nutrient_id: string;
  amount_per_canonical_unit: number;
  basis_quantity: number;
  basis_unit: 'g' | 'ml';
  source: ReferenceSource;
}
const FOOD_NUTRIENT_COLUMNS = 'id, nutrient_id, amount_per_canonical_unit, basis_quantity, basis_unit, source';

interface SearchRow {
  food_id: string;
  canonical_name: string;
  category: string | null;
  source: ReferenceSource;
  display_name: string;
  display_locale: string | null;
  matched_alias: string;
  matched_locale: string;
  match_rank: number;
  locale_rank: number;
}

const MATCH_KIND = ['exact', 'prefix', 'contains'] as const;

/** Upper bound on rows the search function returns before in-memory
 * cursor pagination — the same documented soft ceiling every Layer 4B list
 * endpoint uses (lib/pagination.ts). */
const SEARCH_FETCH_CAP = IN_MEMORY_PAGE_FETCH_CAP;

export class FoodService {
  constructor(private readonly dbFactory: ScopedDbFactory) {}

  async search(auth: AuthContext, query: FoodSearchQuery): Promise<Page<FoodSearchResult>> {
    const db = this.dbFactory.forUser(auth);
    const rows = await db.rpcRows<SearchRow>('search_foods', {
      p_query: query.q,
      p_locales: localeFallbackChain(query.locale),
      p_limit: SEARCH_FETCH_CAP,
    });
    const results: Array<FoodSearchResult> = rows.map((row) => ({
      id: row.food_id,
      canonical_name: row.canonical_name,
      category: row.category,
      source: row.source,
      display_name: row.display_name,
      display_locale: row.display_locale,
      match: {
        alias_text: row.matched_alias,
        locale: row.matched_locale,
        kind: MATCH_KIND[row.match_rank] ?? 'contains',
      },
    }));
    return paginateInMemory(results, query);
  }

  async getFood(auth: AuthContext, foodId: string, query: FoodDetailQuery): Promise<FoodDetailDto> {
    const db = this.dbFactory.forUser(auth);
    const food = await this.requireFood(db, foodId);
    const chain = localeFallbackChain(query.locale);
    const region = query.region ?? regionOfLocale(query.locale);

    const [aliases, servings, foodNutrients] = await Promise.all([
      db.select<FoodAliasDto>('food_alias', { columns: ALIAS_COLUMNS, eq: { food_id: foodId } }),
      db.select<FoodServingDto>('food_serving', { columns: SERVING_COLUMNS, eq: { food_id: foodId } }),
      db.select<FoodNutrientRow>('food_nutrient', { columns: FOOD_NUTRIENT_COLUMNS, eq: { food_id: foodId } }),
    ]);

    const nutrientIds = [...new Set(foodNutrients.map((fn) => fn.nutrient_id))];
    const nutrients = nutrientIds.length
      ? await db.select<NutrientDto>('nutrient', { columns: NUTRIENT_COLUMNS, in: { id: nutrientIds } })
      : [];
    const nutrientById = new Map(nutrients.map((n) => [n.id, n]));

    const sortedAliases = [...aliases].sort(
      (a, b) =>
        localeRank(a.locale, chain) - localeRank(b.locale, chain) ||
        Number(a.source === 'ai_matched') - Number(b.source === 'ai_matched') ||
        Number(b.is_primary) - Number(a.is_primary) ||
        compareText(a.alias_text, b.alias_text) ||
        compareText(a.id, b.id),
    );
    const display = sortedAliases[0];

    // Region-specific servings for the caller's region first, then
    // region-agnostic ones; servings scoped to a different region are
    // omitted from the listing (still convertible by explicit serving_id).
    const visibleServings = servings
      .filter((s) => region === null || s.region === null || s.region === region)
      .sort(
        (a, b) =>
          Number(a.region === null) - Number(b.region === null) ||
          compareText(a.region ?? '', b.region ?? '') ||
          compareText(a.serving_description, b.serving_description) ||
          compareText(a.id, b.id),
      );

    const nutrientDtos: FoodNutrientDto[] = [];
    for (const row of foodNutrients) {
      const nutrient = nutrientById.get(row.nutrient_id);
      if (!nutrient) continue;
      nutrientDtos.push({
        id: row.id,
        nutrient_id: row.nutrient_id,
        nutrient_key: nutrient.canonical_key,
        nutrient_unit: nutrient.unit,
        amount: row.amount_per_canonical_unit,
        basis_quantity: row.basis_quantity,
        basis_unit: row.basis_unit,
        source: row.source,
      });
    }
    nutrientDtos.sort((a, b) => compareText(a.nutrient_key, b.nutrient_key) || compareText(a.source, b.source));

    return {
      id: food.id,
      canonical_name: food.canonical_name,
      category: food.category,
      source: food.source,
      display_name: display?.alias_text ?? food.canonical_name,
      display_locale: display?.locale ?? null,
      locale: query.locale,
      region,
      density: toDensity(food),
      aliases: sortedAliases,
      servings: visibleServings,
      nutrients: nutrientDtos,
    };
  }

  async convertForFood(auth: AuthContext, foodId: string, input: FoodConversionInput): Promise<ConversionResult> {
    const db = this.dbFactory.forUser(auth);
    const food = await this.requireFood(db, foodId);
    const servings = await db.select<FoodServingDto>('food_serving', { columns: SERVING_COLUMNS, eq: { food_id: foodId } });
    const data: FoodConversionData = { food_id: food.id, density: toDensity(food), servings };
    return convert({ quantity: input.quantity, from: toEndpoint(input.from), to: toEndpoint(input.to) }, data);
  }

  async listNutrients(auth: AuthContext, pagination: PaginationQuery): Promise<Page<NutrientDto>> {
    const db = this.dbFactory.forUser(auth);
    const rows = await db.select<NutrientDto>('nutrient', {
      columns: NUTRIENT_COLUMNS,
      order: { column: 'canonical_key', ascending: true },
      limit: IN_MEMORY_PAGE_FETCH_CAP,
    });
    return paginateInMemory(rows, pagination);
  }

  private async requireFood(db: ScopedDbClient, foodId: string): Promise<FoodRow> {
    const [food] = await db.select<FoodRow>('food', { columns: FOOD_COLUMNS, eq: { id: foodId }, limit: 1 });
    if (!food) throw AppError.notFound('Food not found.');
    return food;
  }
}

function toDensity(food: FoodRow): FoodDetailDto['density'] {
  return food.density_g_per_ml !== null && food.density_source !== null
    ? { g_per_ml: food.density_g_per_ml, source: food.density_source }
    : null;
}

function toEndpoint(endpoint: FoodConversionInput['from']): { unit: string } | { serving_id: string } {
  return endpoint.serving_id !== undefined ? { serving_id: endpoint.serving_id } : { unit: endpoint.unit ?? '' };
}

/** Code-point comparison — locale-independent, so ordering is identical on
 * every server regardless of its ICU/locale configuration. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
