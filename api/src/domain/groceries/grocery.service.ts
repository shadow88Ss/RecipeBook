// Layer 9A — Grocery Planning: preview and immutable generated lists.
//
// Both the preview and persisted generation run deriveGroceryRequirements()
// (grocery.engine.ts) over the plan's structured quantities — there is no
// second calculation. Sources:
//   * draft plan  -> preview only, of the current intent (draft/planned
//                    items), labelled `unconfirmed_plan_preview`;
//   * active plan -> preview and generation, of current CONFIRMED,
//                    non-skipped items only; current unconfirmed items and
//                    pending replacements are reported as excluded;
//   * completed / cancelled / archived -> no new preview or generation;
//                    existing lists stay readable.
// Generation is one transaction (generate_grocery_list()): the new
// generation is inserted and the previous active one superseded together,
// or nothing changes. Generated lists are never edited; a changed plan makes
// a list `is_stale` (source fingerprint differs) until the user regenerates.
//
// Scopes (20261006120000_grocery_planning_core.sql; 33_Security_and_Privacy.md
// §8.0/§9.1) are the Meal Planning ones: read — full_management, view_only,
// pediatric_weight_management; generate — full_management,
// pediatric_weight_management. Nothing here writes MealPlan, MealLog/
// MealItem, links/skips, Food reference data or recipes.

import { requireProfileScope } from '../../lib/authorize';
import { AppError } from '../../lib/errors';
import { IN_MEMORY_PAGE_FETCH_CAP, paginateInMemory, type PaginationQuery } from '../../lib/pagination';
import type { ScopedDbClient, ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import type { ReferenceSource, ServingReference } from '../conversion/conversion.engine';
import { isCurrent, isPendingReplacement, type PlanTree } from '../mealPlans/mealPlan.dto';
import { loadTree, PLAN_READ_SCOPES, PLAN_WRITE_SCOPES } from '../mealPlans/mealPlan.service';
import { loadVersionContent } from '../recipes/recipe.service';
import {
  GROCERY_ITEM_COLUMNS,
  GROCERY_LIST_COLUMNS,
  GROCERY_SOURCE_COLUMNS,
  splitExcluded,
  summarize,
  toItemDto,
  toListSummaryDto,
  toSourceDto,
  type ExcludedSource,
  type GroceryItemRow,
  type GroceryListRow,
  type GrocerySourceRow,
} from './grocery.dto';
import {
  deriveGroceryRequirements,
  GROCERY_CALCULATION_VERSION,
  GROCERY_FINGERPRINT_VERSION,
  sourceFingerprint,
  type GroceryFood,
  type PlannedSource,
  type RecipeVersionData,
} from './grocery.engine';
import type { GroceryListQuery } from './grocery.schemas';

type Mode = 'current_intent' | 'confirmed_only';

export class GroceryService {
  constructor(private readonly dbFactory: ScopedDbFactory) {}

  async preview(auth: AuthContext, profileId: string, planId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_READ_SCOPES);
    const tree = await loadTree(db, profileId, planId);
    const { status } = tree.plan;
    if (status !== 'draft' && status !== 'active') throw AppError.conflict(`A ${status} plan has no grocery preview; its generated grocery lists remain readable.`);
    const mode: Mode = status === 'draft' ? 'current_intent' : 'confirmed_only';
    const planSources = await loadPlanSources(db, tree, mode);
    const derivation = await derive(db, planSources.sources);
    const fingerprint = sourceFingerprint(planSources.sources, derivation.recipeVersions);
    const active = status === 'active' ? await activeList(db, profileId, planId) : null;
    const items = derivation.result.items.map((i) => toItemDto(i, i.sources.map((s, n) => toSourceDto(s, n))));
    return {
      preview_type: status === 'draft' ? ('unconfirmed_plan_preview' as const) : ('active_plan_preview' as const),
      persisted: false as const,
      includes_unconfirmed: mode === 'current_intent' && planSources.sources.some((s) => s.status !== 'confirmed'),
      meal_plan_id: planId,
      plan_context: { status, start_date: tree.plan.start_date, end_date: tree.plan.end_date, local_timezone: tree.plan.local_timezone },
      calculation_version: GROCERY_CALCULATION_VERSION,
      conversion_version: derivation.result.conversion_version,
      fingerprint_version: GROCERY_FINGERPRINT_VERSION,
      source_fingerprint: fingerprint,
      current_grocery_list: active
        ? { id: active.id, generation_number: active.generation_number, generated_source_fingerprint: active.source_fingerprint, is_stale: active.source_fingerprint !== fingerprint }
        : null,
      ...splitExcluded(planSources.excluded),
      summary: summarize(items),
      items,
    };
  }

  async generate(auth: AuthContext, profileId: string, planId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_WRITE_SCOPES);
    const tree = await loadTree(db, profileId, planId);
    const { status } = tree.plan;
    if (status === 'draft') throw AppError.conflict('A draft plan has a grocery preview only; confirm the plan to generate a grocery list.');
    if (status !== 'active') throw AppError.conflict(`Grocery lists can only be generated from an active plan (this plan is ${status}).`);
    const planSources = await loadPlanSources(db, tree, 'confirmed_only');
    if (!planSources.sources.length) throw AppError.validation('Nothing to generate: the plan has no current, confirmed, non-skipped items.');
    const derivation = await derive(db, planSources.sources);
    if (!derivation.result.items.length) throw AppError.validation('Nothing to generate: the contributing items produce no grocery requirements.');
    const listId = await callGroceryWrite(() =>
      db.rpc<string>('generate_grocery_list', {
        p_profile_id: profileId,
        p_meal_plan_id: planId,
        p_payload: {
          source_fingerprint: sourceFingerprint(planSources.sources, derivation.recipeVersions),
          fingerprint_version: GROCERY_FINGERPRINT_VERSION,
          calculation_version: derivation.result.calculation_version,
          conversion_version: derivation.result.conversion_version,
          excluded_sources: planSources.excluded,
          items: derivation.result.items.map((item) => ({
            ...item,
            sources: item.sources.map((s, position) => ({ ...s, position })),
          })),
        },
      }),
    );
    return this.detail(db, profileId, listId);
  }

  async list(auth: AuthContext, profileId: string, query: GroceryListQuery, planId?: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_READ_SCOPES);
    const mealPlanId = planId ?? query.meal_plan_id;
    if (planId) await loadTree(db, profileId, planId); // 404 for a plan outside this profile
    const rows = await db.select<GroceryListRow>('grocery_list', {
      columns: GROCERY_LIST_COLUMNS,
      eq: { profile_id: profileId, ...(mealPlanId ? { meal_plan_id: mealPlanId } : {}), ...(query.status ? { status: query.status } : {}) },
      limit: IN_MEMORY_PAGE_FETCH_CAP,
    });
    rows.sort((a, b) => (a.generated_at !== b.generated_at ? (a.generated_at < b.generated_at ? 1 : -1) : b.generation_number - a.generation_number || (a.id < b.id ? -1 : 1)));
    return paginateInMemory(rows.map(toListSummaryDto), query as PaginationQuery);
  }

  async get(auth: AuthContext, profileId: string, listId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_READ_SCOPES);
    return this.detail(db, profileId, listId);
  }

  private async detail(db: ScopedDbClient, profileId: string, listId: string) {
    const list = (await db.select<GroceryListRow>('grocery_list', { columns: GROCERY_LIST_COLUMNS, eq: { id: listId, profile_id: profileId }, limit: 1 }))[0];
    if (!list) throw AppError.notFound('Grocery list not found.');
    const [itemRows, sourceRows, tree] = await Promise.all([
      db.select<GroceryItemRow>('grocery_list_item', { columns: GROCERY_ITEM_COLUMNS, eq: { grocery_list_id: list.id }, order: { column: 'position', ascending: true }, limit: IN_MEMORY_PAGE_FETCH_CAP }),
      db.select<GrocerySourceRow>('grocery_list_item_source', { columns: GROCERY_SOURCE_COLUMNS, eq: { grocery_list_id: list.id }, limit: 10 * IN_MEMORY_PAGE_FETCH_CAP }),
      loadTree(db, profileId, list.meal_plan_id),
    ]);
    // staleness: the fingerprint of what a generation would use NOW
    const current = await loadPlanSources(db, tree, 'confirmed_only');
    const currentFingerprint = sourceFingerprint(current.sources, await loadRecipeVersions(db, current.sources));
    const mealType = new Map(tree.meals.map((m) => [m.id, m.meal_type]));
    const items = [...itemRows]
      .sort((a, b) => a.position - b.position)
      .map((item) =>
        toItemDto(
          item,
          sourceRows
            .filter((s) => s.grocery_list_item_id === item.id)
            .sort((a, b) => a.position - b.position)
            .map((s) => toSourceDto({ ...s, meal_type: mealType.get(s.planned_meal_id) ?? null }, s.position)),
        ),
      );
    return {
      ...toListSummaryDto(list),
      is_current_generation: list.status === 'active',
      is_stale: currentFingerprint !== list.source_fingerprint,
      current_source_fingerprint: currentFingerprint,
      current_plan_status: tree.plan.status,
      ...splitExcluded(list.excluded_sources ?? []),
      summary: summarize(items),
      items,
    };
  }
}

interface PlanSources {
  sources: Array<PlannedSource & { status: string }>;
  excluded: ExcludedSource[];
}

/** Which planned items contribute (see the file comment). Cancelled and
 * superseded items are not current intent and are not reported. */
async function loadPlanSources(db: ScopedDbClient, tree: PlanTree, mode: Mode): Promise<PlanSources> {
  const itemIds = tree.items.map((i) => i.id);
  const skips = itemIds.length
    ? (
        await db.select<{ planned_meal_item_id: string; revoked_at: string | null }>('planned_meal_item_skip', {
          columns: 'planned_meal_item_id, revoked_at',
          in: { planned_meal_item_id: itemIds },
          limit: IN_MEMORY_PAGE_FETCH_CAP,
        })
      ).filter((s) => s.revoked_at === null)
    : [];
  const skipped = new Set(skips.map((s) => s.planned_meal_item_id));
  const meals = new Map(tree.meals.map((m) => [m.id, m]));
  const days = new Map(tree.days.map((d) => [d.id, d]));
  const sources: PlanSources['sources'] = [];
  const excluded: ExcludedSource[] = [];
  for (const item of tree.items) {
    const meal = meals.get(item.planned_meal_id);
    const day = meal ? days.get(meal.meal_plan_day_id) : undefined;
    if (!meal || !day) continue;
    const place = { planned_meal_item_id: item.id, planned_meal_id: meal.id, meal_plan_day_id: day.id, plan_date: day.plan_date, meal_type: meal.meal_type };
    const describe = (reason: ExcludedSource['reason']): ExcludedSource => ({
      ...place,
      status: item.status,
      reason,
      source_type: item.recipe_version_id !== null ? 'recipe' : 'food',
      food_id: item.food_id,
      recipe_version_id: item.recipe_version_id,
    });
    if (isPendingReplacement(item)) {
      excluded.push(describe('pending_replacement_not_confirmed'));
      continue;
    }
    if (!isCurrent(item)) continue;
    if (skipped.has(item.id)) {
      excluded.push(describe('skipped'));
      continue;
    }
    if (item.status !== 'confirmed' && mode === 'confirmed_only') {
      excluded.push(describe('unconfirmed'));
      continue;
    }
    sources.push({
      ...place,
      meal_plan_id: tree.plan.id,
      meal_position: meal.position,
      item_position: item.position,
      item_created_at: item.created_at,
      food_id: item.food_id,
      food_serving_id: item.food_serving_id,
      unit: item.unit,
      recipe_id: item.recipe_id,
      recipe_version_id: item.recipe_version_id,
      quantity: Number(item.quantity),
      status: item.status,
    });
  }
  const order = (e: { plan_date: string; planned_meal_item_id: string }) => `${e.plan_date}|${e.planned_meal_item_id}`;
  excluded.sort((a, b) => (order(a) < order(b) ? -1 : 1));
  return { sources, excluded };
}

/** The exact RecipeVersions referenced by the sources (never
 * Recipe.current_version_id). */
async function loadRecipeVersions(db: ScopedDbClient, sources: readonly PlannedSource[]): Promise<Map<string, RecipeVersionData>> {
  const out = new Map<string, RecipeVersionData>();
  for (const s of sources) {
    if (!s.recipe_version_id || !s.recipe_id || out.has(s.recipe_version_id)) continue;
    const content = await loadVersionContent(db, s.recipe_id, s.recipe_version_id);
    out.set(content.version.id, {
      id: content.version.id,
      recipe_id: content.version.recipe_id,
      title: content.version.title,
      version_number: content.version.version_number,
      servings: content.version.servings === null ? null : Number(content.version.servings),
      ingredients: content.ingredients.map((i) => ({
        id: i.id,
        food_id: i.food_id,
        food_serving_id: i.food_serving_id,
        raw_ingredient_text: i.raw_ingredient_text,
        quantity: i.quantity === null ? null : Number(i.quantity),
        unit: i.unit,
        match_status: i.match_status,
        sort_order: i.sort_order,
      })),
    });
  }
  return out;
}

/** Conversion reference data only (identity, density, servings) — grocery
 * derivation never reads nutrient data. */
export async function loadFoods(db: ScopedDbClient, foodIdList: readonly string[]): Promise<Map<string, GroceryFood>> {
  const foodIds = [...new Set(foodIdList)];
  if (!foodIds.length) return new Map();
  const [foods, servings] = await Promise.all([
    db.select<{ id: string; canonical_name: string; density_g_per_ml: number | null; density_source: ReferenceSource | null }>('food', {
      columns: 'id, canonical_name, density_g_per_ml, density_source',
      in: { id: foodIds },
    }),
    db.select<ServingReference & { food_id: string }>('food_serving', {
      columns: 'id, food_id, serving_description, region, canonical_quantity, canonical_unit, source',
      in: { food_id: foodIds },
    }),
  ]);
  return new Map(
    foods.map((f) => [
      f.id,
      {
        food_id: f.id,
        canonical_name: f.canonical_name,
        density: f.density_g_per_ml !== null && f.density_source !== null ? { g_per_ml: Number(f.density_g_per_ml), source: f.density_source } : null,
        servings: servings.filter((s) => s.food_id === f.id).map((s) => ({ ...s, canonical_quantity: Number(s.canonical_quantity) })),
      },
    ]),
  );
}

async function derive(db: ScopedDbClient, sources: readonly PlannedSource[]) {
  const recipeVersions = await loadRecipeVersions(db, sources);
  const foodIds = [
    ...sources.flatMap((s) => (s.food_id ? [s.food_id] : [])),
    ...[...recipeVersions.values()].flatMap((v) => v.ingredients.flatMap((i) => (i.food_id ? [i.food_id] : []))),
  ];
  const foods = await loadFoods(db, foodIds);
  return { recipeVersions, result: deriveGroceryRequirements({ sources, recipeVersions, foods }) };
}

async function activeList(db: ScopedDbClient, profileId: string, planId: string) {
  return (await db.select<GroceryListRow>('grocery_list', { columns: GROCERY_LIST_COLUMNS, eq: { profile_id: profileId, meal_plan_id: planId, status: 'active' }, limit: 1 }))[0] ?? null;
}

/** Database refusals -> safe API errors (never the SQL message). */
async function callGroceryWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'P0002') throw AppError.notFound('Meal plan not found.');
    if (code === '42501') throw AppError.forbidden('This operation is not permitted for this profile.');
    if (code === '23514' || code === '55000' || code === '23505' || code === '23503' || code === '40001') {
      throw AppError.conflict('The meal plan changed while the grocery list was being generated. Reload and retry.');
    }
    if (code === '22023') throw AppError.validation('Invalid grocery generation.');
    throw err;
  }
}
