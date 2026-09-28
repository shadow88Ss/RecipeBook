// Layer 7A — Food & Meal Logging: actual consumption.
//
// Allowed scopes transcribed from 20260825121600_rls_meals.sql and
// 20260825121900_rls_pediatric_weight_management.sql (never broadened):
//   read  — full_management, view_only, pediatric_weight_management
//   write — full_management, pediatric_weight_management (logging and
//           corrections); view_only is read-only.
// No scope -> 404; scope without the operation -> 403. Every query runs as
// the caller under RLS.
//
// Logging: the server computes each item's nutrition FIRST (Layer 5B for a
// Food, Layer 6A per-serving x servings for an exact RecipeVersion), stores
// it as the item's immutable snapshot, and writes the MealLog and items
// atomically via log_meal_items() — directly as `consumed` (the
// draft -> planned -> confirmed path is for planning, not recording what
// was already eaten). Corrections go through correct_meal_item(). There is
// no update/delete of consumed items and no void/remove (deferred).
//
// History is read only from snapshots (meal.snapshot.ts): nothing here
// reloads food reference data or recipes to answer "what was recorded".

import { requireProfileScope } from '../../lib/authorize';
import { AppError } from '../../lib/errors';
import { IN_MEMORY_PAGE_FETCH_CAP, paginateInMemory, type PaginationQuery } from '../../lib/pagination';
import type { ScopedDbClient, ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import { calculateItem, NUTRITION_CALCULATION_VERSION } from '../nutrition/nutrition.engine';
import { loadNutritionReference } from '../nutrition/nutrition.service';
import { loadRecipe, loadVersionContent, recipeVersionNutrition } from '../recipes/recipe.service';
import {
  MEAL_ITEM_COLUMNS,
  MEAL_LOG_COLUMNS,
  toMealItemDto,
  toMealLogDto,
  toMealLogListItemDto,
  toMealNutritionDto,
  type MealItemRow,
  type MealLogRow,
} from './meal.dto';
import type { MealCreateInput, MealItemCorrectInput, MealItemInput, MealItemsAddInput, MealListQuery } from './meal.schemas';
import { buildFoodSnapshot, buildRecipeSnapshot, type MealItemSnapshot } from './meal.snapshot';
import { isInFuture, localDateOf } from './meal.time';

export const MEAL_READ_SCOPES = ['full_management', 'view_only', 'pediatric_weight_management'] as const;
export const MEAL_WRITE_SCOPES = ['full_management', 'pediatric_weight_management'] as const;

/** One item as passed to log_meal_items() / correct_meal_item(). */
interface PreparedItem {
  food_id: string | null;
  food_serving_id: string | null;
  unit: string | null;
  recipe_version_id: string | null;
  quantity: number;
  consumed_at: string;
  nutrition_snapshot: MealItemSnapshot;
  nutrition_calculation_version: string;
}

interface MealDay {
  logged_date: string;
  local_timezone: string;
}

type Issue = { path: string; message: string };

export class MealService {
  constructor(private readonly dbFactory: ScopedDbFactory) {}

  async list(auth: AuthContext, profileId: string, query: MealListQuery) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, MEAL_READ_SCOPES);
    const logs = (
      await db.select<MealLogRow>('meal_log', {
        columns: MEAL_LOG_COLUMNS,
        eq: { profile_id: profileId },
        order: { column: 'logged_date', ascending: false },
        limit: IN_MEMORY_PAGE_FETCH_CAP,
      })
    )
      .filter((l) => (query.from === undefined || l.logged_date >= query.from) && (query.to === undefined || l.logged_date <= query.to))
      // Newest local day first, then newest created, id as tie-breaker.
      .sort((a, b) =>
        a.logged_date !== b.logged_date
          ? a.logged_date < b.logged_date
            ? 1
            : -1
          : a.created_at !== b.created_at
            ? a.created_at < b.created_at
              ? 1
              : -1
            : a.id < b.id
              ? -1
              : 1,
      );
    const items = logs.length
      ? await db.select<MealItemRow>('meal_item', {
          columns: 'id, meal_log_id, status, superseded_by_meal_item_id',
          in: { meal_log_id: logs.map((l) => l.id) },
        })
      : [];
    return paginateInMemory(
      logs.map((l) => toMealLogListItemDto(l, items.filter((i) => i.meal_log_id === l.id))),
      query as PaginationQuery,
    );
  }

  async get(auth: AuthContext, profileId: string, mealLogId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, MEAL_READ_SCOPES);
    return this.detail(db, profileId, mealLogId);
  }

  async nutrition(auth: AuthContext, profileId: string, mealLogId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, MEAL_READ_SCOPES);
    const log = await loadMealLog(db, profileId, mealLogId);
    const items = await loadItems(db, log.id);
    return {
      meal_log_id: log.id,
      ...toMealNutritionDto(items, { includeNutrients: true }),
      items: items.map((i) => {
        const dto = toMealItemDto(i);
        return { meal_item_id: i.id, is_active: dto.is_active, source_type: dto.source_type, nutrition: dto.nutrition };
      }),
    };
  }

  async getItem(auth: AuthContext, profileId: string, mealLogId: string, itemId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, MEAL_READ_SCOPES);
    const log = await loadMealLog(db, profileId, mealLogId);
    return toMealItemDto(await loadItem(db, log.id, itemId), { detail: true });
  }

  async create(auth: AuthContext, profileId: string, input: MealCreateInput) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, MEAL_WRITE_SCOPES);
    const day: MealDay = { logged_date: input.logged_date, local_timezone: input.local_timezone };
    const prepared = await prepareItems(db, profileId, input.items, day, input.consumed_at, 'items');
    const written = await callWrite(() =>
      db.rpc<{ meal_log_id: string }>('log_meal_items', {
        p_profile_id: profileId,
        p_meal_log_id: null,
        p_payload: {
          meal: { meal_type: input.meal_type, logged_date: input.logged_date, local_timezone: input.local_timezone, notes: input.notes ?? null },
          items: prepared,
        },
      }),
    );
    return this.detail(db, profileId, written.meal_log_id);
  }

  async addItems(auth: AuthContext, profileId: string, mealLogId: string, input: MealItemsAddInput) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, MEAL_WRITE_SCOPES);
    const log = await loadMealLog(db, profileId, mealLogId);
    const prepared = await prepareItems(db, profileId, input.items, mealDay(log), input.consumed_at, 'items');
    await callWrite(() =>
      db.rpc('log_meal_items', { p_profile_id: profileId, p_meal_log_id: log.id, p_payload: { meal: null, items: prepared } }),
    );
    return this.detail(db, profileId, log.id);
  }

  /** Atomic correction: a new consumed item with its own snapshot, the
   * original superseded, an AuditEvent written — or nothing at all. */
  async correct(auth: AuthContext, profileId: string, mealLogId: string, itemId: string, input: MealItemCorrectInput) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, MEAL_WRITE_SCOPES);
    const log = await loadMealLog(db, profileId, mealLogId);
    const original = await loadItem(db, log.id, itemId);
    if (original.status !== 'consumed') throw AppError.conflict('Only a consumed meal item can be corrected.');
    if (original.superseded_by_meal_item_id !== null) throw AppError.conflict('This meal item has already been corrected.');

    const [prepared] = await prepareItems(db, profileId, [input.item], mealDay(log), original.consumed_at ?? undefined, 'item', false);
    if (!prepared) throw AppError.internal();
    const written = await callWrite(() =>
      db.rpc<{ meal_item_id: string }>('correct_meal_item', {
        p_profile_id: profileId,
        p_meal_log_id: log.id,
        p_original_id: original.id,
        p_item: prepared,
        p_correction_reason: input.correction_reason,
      }),
    );
    return toMealItemDto(await loadItem(db, log.id, written.meal_item_id), { detail: true });
  }

  private async detail(db: ScopedDbClient, profileId: string, mealLogId: string) {
    const log = await loadMealLog(db, profileId, mealLogId);
    return toMealLogDto(log, await loadItems(db, log.id));
  }
}

function mealDay(log: MealLogRow): MealDay {
  if (!log.local_timezone) throw AppError.conflict('This meal has no local_timezone; items cannot be logged to it.');
  return { logged_date: log.logged_date, local_timezone: log.local_timezone };
}

/**
 * Validates every item and computes its snapshot BEFORE anything is
 * written. All problems are reported together as one 400.
 */
async function prepareItems(
  db: ScopedDbClient,
  profileId: string,
  inputs: readonly MealItemInput[],
  day: MealDay,
  defaultConsumedAt: string | undefined,
  path: string,
  indexed = true,
): Promise<PreparedItem[]> {
  const at = (i: number, field: string) => (indexed ? `${path}.${i}.${field}` : `${path}.${field}`);
  const issues: Issue[] = [];

  // Time: explicit per item or the request default; not in the future; on
  // the meal's local day.
  const consumedAt = inputs.map((input, i) => {
    const value = input.consumed_at ?? defaultConsumedAt;
    if (!value) {
      issues.push({ path: at(i, 'consumed_at'), message: 'consumed_at is required (on the item or the request).' });
      return '';
    }
    if (isInFuture(value)) issues.push({ path: at(i, 'consumed_at'), message: 'consumed_at must not be in the future.' });
    else if (localDateOf(value, day.local_timezone) !== day.logged_date) {
      issues.push({ path: at(i, 'consumed_at'), message: `consumed_at is not on ${day.logged_date} in ${day.local_timezone}.` });
    }
    return value;
  });

  const foodIds = inputs.flatMap((input) => (input.type === 'food' ? [input.food_id] : []));
  const { foods, vocabulary } = await loadNutritionReference(db, foodIds);

  const prepared: Array<PreparedItem | null> = [];
  for (const [i, input] of inputs.entries()) {
    if (input.type === 'food') {
      const food = foods.get(input.food_id);
      if (!food) {
        issues.push({ path: at(i, 'food_id'), message: 'Food not found.' });
        prepared.push(null);
        continue;
      }
      const serving = input.serving_id !== undefined ? food.servings.find((s) => s.id === input.serving_id) : undefined;
      if (input.serving_id !== undefined && !serving) {
        issues.push({ path: at(i, 'serving_id'), message: 'serving_id does not exist for this food.' });
        prepared.push(null);
        continue;
      }
      const amount = serving ? { serving_id: serving.id } : { unit: input.unit ?? '' };
      const calculation = calculateItem(i, { food, quantity: input.quantity, amount }, vocabulary);
      prepared.push({
        food_id: food.food_id,
        food_serving_id: serving?.id ?? null,
        unit: serving ? null : (input.unit ?? null),
        recipe_version_id: null,
        quantity: input.quantity,
        consumed_at: consumedAt[i] ?? '',
        nutrition_calculation_version: NUTRITION_CALCULATION_VERSION,
        nutrition_snapshot: buildFoodSnapshot(calculation, {
          type: 'food',
          food_id: food.food_id,
          canonical_name: food.canonical_name,
          quantity: input.quantity,
          unit: serving ? null : (input.unit ?? null),
          serving: serving
            ? {
                serving_id: serving.id,
                description: serving.serving_description,
                canonical_quantity: serving.canonical_quantity,
                canonical_unit: serving.canonical_unit,
                source: serving.source,
              }
            : null,
        }),
      });
      continue;
    }

    // Recipe item: an exact version of a recipe in THIS Profile's book.
    const recipe = await loadRecipe(db, profileId, input.recipe_id).catch(() => null);
    if (!recipe) {
      issues.push({ path: at(i, 'recipe_id'), message: "Recipe not found in this profile's Recipe Book." });
      prepared.push(null);
      continue;
    }
    const content = await loadVersionContent(db, recipe.id, input.recipe_version_id).catch(() => null);
    if (!content) {
      issues.push({ path: at(i, 'recipe_version_id'), message: 'recipe_version_id is not a version of this recipe.' });
      prepared.push(null);
      continue;
    }
    if (content.version.servings === null) {
      issues.push({ path: at(i, 'recipe_version_id'), message: 'This recipe version has no yield, so servings cannot be calculated.' });
      prepared.push(null);
      continue;
    }
    const recipeNutrition = await recipeVersionNutrition(db, content);
    prepared.push({
      food_id: null,
      food_serving_id: null,
      unit: null,
      recipe_version_id: content.version.id,
      quantity: input.servings,
      consumed_at: consumedAt[i] ?? '',
      nutrition_calculation_version: NUTRITION_CALCULATION_VERSION,
      nutrition_snapshot: buildRecipeSnapshot(recipeNutrition, {
        type: 'recipe',
        recipe_id: recipe.id,
        recipe_version_id: content.version.id,
        version_number: content.version.version_number,
        title: content.version.title,
        yield_servings: content.version.servings,
        servings_consumed: input.servings,
      }),
    });
  }

  if (issues.length) throw AppError.validation('Invalid meal item.', { issues });
  return prepared.filter((p): p is PreparedItem => p !== null);
}

/** Maps database refusals to safe API errors — never the SQL message. */
async function callWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'P0002') throw AppError.notFound('Meal not found.');
    if (code === '55000') throw AppError.conflict('Only a consumed meal item can be corrected.');
    if (code === '55006' || code === '23505') throw AppError.conflict('This meal item has already been corrected.');
    if (code === '23514' || code === '22023' || code === '23503' || code === '23502') {
      throw AppError.validation('The meal item violates a meal logging rule.');
    }
    if (code === '42501') throw AppError.forbidden('This operation is not permitted for this profile.');
    throw err;
  }
}

/** (id, profile_id) together keeps every route inside its Profile. */
async function loadMealLog(db: ScopedDbClient, profileId: string, mealLogId: string): Promise<MealLogRow> {
  const rows = await db.select<MealLogRow>('meal_log', { columns: MEAL_LOG_COLUMNS, eq: { id: mealLogId, profile_id: profileId }, limit: 1 });
  const row = rows[0];
  if (!row) throw AppError.notFound('Meal not found.');
  return row;
}

async function loadItems(db: ScopedDbClient, mealLogId: string): Promise<MealItemRow[]> {
  // Ordered in the database at full timestamp precision: items logged
  // together get strictly increasing created_at (log_meal_items), so this is
  // the order they were logged in.
  return db.select<MealItemRow>('meal_item', {
    columns: MEAL_ITEM_COLUMNS,
    eq: { meal_log_id: mealLogId },
    order: { column: 'created_at', ascending: true },
    limit: IN_MEMORY_PAGE_FETCH_CAP,
  });
}

async function loadItem(db: ScopedDbClient, mealLogId: string, itemId: string): Promise<MealItemRow> {
  const rows = await db.select<MealItemRow>('meal_item', { columns: MEAL_ITEM_COLUMNS, eq: { id: itemId, meal_log_id: mealLogId }, limit: 1 });
  const row = rows[0];
  if (!row) throw AppError.notFound('Meal item not found.');
  return row;
}
