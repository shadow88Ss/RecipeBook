// Layer 8A — Meal Planning (planned INTENT; never actual consumption).
//
// Scopes (20261004120000_meal_planning_core.sql; 33_Security_and_Privacy.md
// §9.1): read — full_management, view_only, pediatric_weight_management;
// write — full_management, pediatric_weight_management. No scope -> 404;
// scope without the operation -> 403. Every query runs as the caller.
//
// Nutrition: a draft/planned item is calculated LIVE through the Layer 5B
// engine (Food) or Layer 6A recipe nutrition x servings (RecipeVersion) —
// the same snapshot builders as Layer 7A, so there is no planning-specific
// arithmetic — and that live value is not historical truth. At /confirm the
// server computes each eligible item's snapshot and confirm_meal_plan()
// stores it immutably, atomically for the whole plan. Confirmed items are
// read from their snapshots only.
//
// Planning never writes MealLog/MealItem, Food/FoodServing/FoodNutrient,
// recipes or EffectiveTargetSnapshots.

import { requireProfileScope } from '../../lib/authorize';
import { AppError } from '../../lib/errors';
import { IN_MEMORY_PAGE_FETCH_CAP, paginateInMemory, type PaginationQuery } from '../../lib/pagination';
import type { ScopedDbClient, ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import { compareToTarget, mapTargets } from '../dailyTracker/dailyTracker.comparison';
import type { EffectiveTargetService } from '../effectiveTarget/effectiveTarget.service';
import { buildFoodSnapshot, buildRecipeSnapshot, readSnapshot, type MealItemSnapshot } from '../meals/meal.snapshot';
import { calculateItem, NUTRITION_CALCULATION_VERSION } from '../nutrition/nutrition.engine';
import { loadNutrientVocabulary, loadNutritionReference, toAggregateDto } from '../nutrition/nutrition.service';
import { projectAggregateSummary } from '../nutrition/nutritionSummary';
import { loadRecipe, loadVersionContent, recipeVersionNutrition } from '../recipes/recipe.service';
import {
  aggregatePlanned,
  isCurrent,
  isEligibleForConfirmation,
  MEAL_PLAN_COLUMNS,
  MEAL_PLAN_DAY_COLUMNS,
  PLANNED_ITEM_COLUMNS,
  PLANNED_MEAL_COLUMNS,
  toMealPlanDetailDto,
  toMealPlanSummaryDto,
  toPlannedItemDto,
  type MealPlanDayRow,
  type MealPlanRow,
  type MealPlanStatus,
  type PlannedItemRow,
  type PlannedMealRow,
  type PlanTree,
} from './mealPlan.dto';
import type {
  MealPlanCreateInput,
  MealPlanListQuery,
  MealPlanPatchInput,
  PlannedItemInput,
  PlannedItemPatchInput,
  PlannedMealCreateInput,
} from './mealPlan.schemas';

export const PLAN_READ_SCOPES = ['full_management', 'view_only', 'pediatric_weight_management'] as const;
export const PLAN_WRITE_SCOPES = ['full_management', 'pediatric_weight_management'] as const;
export const PLANNED_ITEM_SNAPSHOT_VERSION = 'planned-item-snapshot-8a.1';

const TRANSITIONS: Record<MealPlanStatus, readonly MealPlanStatus[]> = {
  draft: ['active', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: ['archived'],
  cancelled: ['archived'],
  archived: [],
};

/** Item content as written by write_planned_meal_items(). */
interface ItemWrite {
  food_id: string | null;
  food_serving_id: string | null;
  unit: string | null;
  recipe_id: string | null;
  recipe_version_id: string | null;
  quantity: number;
  position: number;
  supersedes_planned_meal_item_id?: string;
}

export class MealPlanService {
  constructor(
    private readonly dbFactory: ScopedDbFactory,
    private readonly targets: EffectiveTargetService,
  ) {}

  async list(auth: AuthContext, profileId: string, query: MealPlanListQuery) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_READ_SCOPES);
    const plans = await db.select<MealPlanRow>('meal_plan', {
      columns: MEAL_PLAN_COLUMNS,
      eq: { profile_id: profileId, ...(query.status ? { status: query.status } : {}) },
      order: { column: 'start_date', ascending: false },
      limit: IN_MEMORY_PAGE_FETCH_CAP,
    });
    plans.sort((a, b) => (a.start_date !== b.start_date ? (a.start_date < b.start_date ? 1 : -1) : a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? -1 : 1));
    return paginateInMemory(plans.map(toMealPlanSummaryDto), query as PaginationQuery);
  }

  async create(auth: AuthContext, profileId: string, input: MealPlanCreateInput) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_WRITE_SCOPES);
    const row = await callWrite(() =>
      db.insert<MealPlanRow>(
        'meal_plan',
        {
          profile_id: profileId,
          name: input.name,
          description: input.description ?? null,
          start_date: input.start_date,
          end_date: input.end_date,
          local_timezone: input.local_timezone,
          created_by_account_id: auth.accountId,
        },
        MEAL_PLAN_COLUMNS,
      ),
    );
    return this.detail(db, profileId, row.id);
  }

  async get(auth: AuthContext, profileId: string, planId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_READ_SCOPES);
    return this.detail(db, profileId, planId);
  }

  async days(auth: AuthContext, profileId: string, planId: string) {
    const detail = await this.get(auth, profileId, planId);
    return { meal_plan_id: detail.id, start_date: detail.start_date, end_date: detail.end_date, local_timezone: detail.local_timezone, days: detail.days };
  }

  async update(auth: AuthContext, profileId: string, planId: string, patch: MealPlanPatchInput) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_WRITE_SCOPES);
    const tree = await loadTree(db, profileId, planId);
    const plan = tree.plan;
    if (patch.status !== undefined && patch.status !== plan.status && !TRANSITIONS[plan.status].includes(patch.status)) {
      throw AppError.conflict(`A ${plan.status} plan cannot become ${patch.status}.`);
    }
    const start = patch.start_date ?? plan.start_date;
    const end = patch.end_date ?? plan.end_date;
    if (start > end) throw AppError.validation('start_date must not be after end_date.', { issues: [{ path: 'end_date', message: 'Before start_date.' }] });
    if (start !== plan.start_date || end !== plan.end_date) {
      if (plan.status !== 'draft' && plan.status !== 'active') throw AppError.conflict(`The date range of a ${plan.status} plan cannot change.`);
      if (plan.status === 'active' && (start > plan.start_date || end < plan.end_date)) throw AppError.conflict('An active plan can only be extended.');
      const outside = tree.days.filter((d) => d.plan_date < start || d.plan_date > end).map((d) => d.plan_date);
      if (outside.length) throw AppError.conflict('Planned days would fall outside the new date range; remove or keep them explicitly.', { plan_dates: outside });
    }
    if (patch.local_timezone !== undefined && patch.local_timezone !== plan.local_timezone && plan.status !== 'draft') {
      throw AppError.conflict('local_timezone is fixed once the plan is no longer draft.');
    }
    const values: Record<string, unknown> = {};
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.start_date !== undefined) values.start_date = patch.start_date;
    if (patch.end_date !== undefined) values.end_date = patch.end_date;
    if (patch.local_timezone !== undefined) values.local_timezone = patch.local_timezone;
    if (patch.status !== undefined) values.status = patch.status;
    const updated = await callWrite(() => db.update<MealPlanRow>('meal_plan', { id: plan.id, profile_id: profileId }, values, MEAL_PLAN_COLUMNS));
    if (!updated) throw AppError.notFound('Meal plan not found.');
    return this.detail(db, profileId, plan.id);
  }

  async addDay(auth: AuthContext, profileId: string, planId: string, planDate: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_WRITE_SCOPES);
    const tree = await loadTree(db, profileId, planId);
    requireEditable(tree.plan);
    if (planDate < tree.plan.start_date || planDate > tree.plan.end_date) {
      throw AppError.validation('plan_date is outside the plan date range.', {
        issues: [{ path: 'plan_date', message: `Must be between ${tree.plan.start_date} and ${tree.plan.end_date}.` }],
      });
    }
    if (tree.days.some((d) => d.plan_date === planDate)) throw AppError.conflict('This plan already has that day.');
    await callWrite(() =>
      db.insert<MealPlanDayRow>('meal_plan_day', { meal_plan_id: planId, profile_id: profileId, plan_date: planDate }, MEAL_PLAN_DAY_COLUMNS),
    );
    return this.detail(db, profileId, planId);
  }

  async addMeal(auth: AuthContext, profileId: string, planId: string, dayId: string, input: PlannedMealCreateInput) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_WRITE_SCOPES);
    const tree = await loadTree(db, profileId, planId);
    requireEditable(tree.plan);
    if (!tree.days.some((d) => d.id === dayId)) throw AppError.notFound('Meal plan day not found.');
    const items = await prepareItems(db, profileId, input.items, 'items');
    await callWrite(() =>
      db.rpc('write_planned_meal_items', {
        p_profile_id: profileId,
        p_meal_plan_id: planId,
        p_meal_plan_day_id: dayId,
        p_planned_meal_id: null,
        p_payload: {
          meal: { meal_type: input.meal_type, scheduled_local_time: input.scheduled_local_time ?? null, notes: input.notes ?? null, position: input.position ?? 0 },
          items,
        },
      }),
    );
    return this.detail(db, profileId, planId);
  }

  async addItems(auth: AuthContext, profileId: string, planId: string, plannedMealId: string, inputs: readonly PlannedItemInput[]) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_WRITE_SCOPES);
    const tree = await loadTree(db, profileId, planId);
    requireEditable(tree.plan);
    if (!tree.meals.some((m) => m.id === plannedMealId)) throw AppError.notFound('Planned meal not found.');
    const items = await prepareItems(db, profileId, inputs, 'items');
    await callWrite(() =>
      db.rpc('write_planned_meal_items', {
        p_profile_id: profileId,
        p_meal_plan_id: planId,
        p_meal_plan_day_id: null,
        p_planned_meal_id: plannedMealId,
        p_payload: { meal: null, items },
      }),
    );
    return this.detail(db, profileId, planId);
  }

  /** Draft/planned items only: amount, position, planned/cancelled. */
  async updateItem(auth: AuthContext, profileId: string, planId: string, itemId: string, patch: PlannedItemPatchInput) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_WRITE_SCOPES);
    const tree = await loadTree(db, profileId, planId);
    requireEditable(tree.plan);
    const item = tree.items.find((i) => i.id === itemId);
    if (!item) throw AppError.notFound('Planned item not found.');
    if (!isEligibleForConfirmation(item)) {
      throw AppError.conflict(`A ${item.status} planned item cannot be edited${item.status === 'confirmed' ? '; create a replacement instead' : ''}.`);
    }
    const values: Record<string, unknown> = {};
    const issues: Array<{ path: string; message: string }> = [];
    if (item.recipe_version_id !== null) {
      if (patch.unit !== undefined || patch.serving_id !== undefined || patch.quantity !== undefined) {
        issues.push({ path: 'servings', message: 'A recipe item is changed through servings.' });
      }
      if (patch.servings !== undefined) values.quantity = patch.servings;
    } else {
      if (patch.servings !== undefined) issues.push({ path: 'servings', message: 'A food item is changed through quantity and unit/serving_id.' });
      if (patch.quantity !== undefined) values.quantity = patch.quantity;
      if (patch.unit !== undefined) Object.assign(values, { unit: patch.unit, food_serving_id: null });
      if (patch.serving_id !== undefined) {
        const serving = await db.select<{ id: string }>('food_serving', { columns: 'id', eq: { id: patch.serving_id, food_id: item.food_id ?? '' }, limit: 1 });
        if (!serving.length) issues.push({ path: 'serving_id', message: 'serving_id does not exist for this food.' });
        Object.assign(values, { food_serving_id: patch.serving_id, unit: null });
      }
    }
    if (issues.length) throw AppError.validation('Invalid planned item change.', { issues });
    if (patch.position !== undefined) values.position = patch.position;
    if (patch.status !== undefined) values.status = patch.status;
    const updated = await callWrite(() => db.update<PlannedItemRow>('planned_meal_item', { id: item.id, profile_id: profileId }, values, PLANNED_ITEM_COLUMNS));
    if (!updated) throw AppError.notFound('Planned item not found.');
    return this.itemDetail(db, profileId, planId, item.id);
  }

  /** Creates a draft replacement for a confirmed, current item. /confirm
   * confirms it and supersedes the original atomically. */
  async replaceItem(auth: AuthContext, profileId: string, planId: string, itemId: string, input: PlannedItemInput) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_WRITE_SCOPES);
    const tree = await loadTree(db, profileId, planId);
    requireEditable(tree.plan);
    const original = tree.items.find((i) => i.id === itemId);
    if (!original) throw AppError.notFound('Planned item not found.');
    if (original.status !== 'confirmed' || original.superseded_by_planned_meal_item_id !== null) {
      throw AppError.conflict('Only a current confirmed item can be replaced; edit draft/planned items directly.');
    }
    if (tree.items.some((i) => i.supersedes_planned_meal_item_id === original.id && i.status !== 'cancelled')) {
      throw AppError.conflict('This item already has a pending replacement; confirm or cancel it first.');
    }
    const [item] = await prepareItems(db, profileId, [input], 'item', false);
    if (!item) throw AppError.internal();
    const written = await callWrite(() =>
      db.rpc<{ planned_meal_item_ids: string[] }>('write_planned_meal_items', {
        p_profile_id: profileId,
        p_meal_plan_id: planId,
        p_meal_plan_day_id: null,
        p_planned_meal_id: original.planned_meal_id,
        p_payload: { meal: null, items: [{ ...item, position: input.position ?? original.position, supersedes_planned_meal_item_id: original.id }] },
      }),
    );
    const newId = written.planned_meal_item_ids[0];
    if (!newId) throw AppError.internal();
    return this.itemDetail(db, profileId, planId, newId);
  }

  async itemDetailPublic(auth: AuthContext, profileId: string, planId: string, itemId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_READ_SCOPES);
    return this.itemDetail(db, profileId, planId, itemId);
  }

  /** Whole-plan confirmation: every draft/planned item gets its server
   * snapshot and becomes confirmed, replacements supersede their originals,
   * a draft plan becomes active — in one transaction, or not at all. */
  async confirm(auth: AuthContext, profileId: string, planId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_WRITE_SCOPES);
    const tree = await loadTree(db, profileId, planId);
    if (tree.plan.status !== 'draft' && tree.plan.status !== 'active') throw AppError.conflict(`A ${tree.plan.status} plan cannot be confirmed.`);
    const eligible = tree.items.filter(isEligibleForConfirmation);
    if (!eligible.length) throw AppError.validation('Nothing to confirm: the plan has no draft or planned items.');
    const snapshots = await computeSnapshots(db, eligible, PLANNED_ITEM_SNAPSHOT_VERSION);
    await callWrite(() =>
      db.rpc('confirm_meal_plan', {
        p_profile_id: profileId,
        p_meal_plan_id: planId,
        // wrapped in an object so every client serializes it as JSON
        p_payload: {
          items: eligible.map((i) => ({
            id: i.id,
            food_id: i.food_id,
            food_serving_id: i.food_serving_id,
            unit: i.unit,
            recipe_version_id: i.recipe_version_id,
            quantity: i.quantity,
            nutrition_snapshot: snapshots.get(i.id),
            nutrition_calculation_version: NUTRITION_CALCULATION_VERSION,
          })),
        },
      }),
    );
    return this.detail(db, profileId, planId);
  }

  /** Planned nutrition per day and for the whole plan (current items), with
   * a comparison against the CURRENT effective target — planning assistance,
   * not a future-day target. */
  async nutrition(auth: AuthContext, profileId: string, planId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, PLAN_READ_SCOPES);
    const tree = await loadTree(db, profileId, planId);
    const [snapshots, vocabulary, target] = await Promise.all([viewSnapshots(db, tree.items), loadNutrientVocabulary(db), this.targets.resolve(auth, profileId)]);
    const { mapped, unmapped } = mapTargets(target.resolved, target.unresolved_fields, vocabulary);
    const current = tree.items.filter(isCurrent);
    const snap = (i: PlannedItemRow) => snapshots.get(i.id) as MealItemSnapshot;

    const view = (items: readonly PlannedItemRow[], withComparison: boolean) => {
      const aggregate = aggregatePlanned(items.map(snap), vocabulary);
      const dto = toAggregateDto(aggregate, items.length);
      const byId = new Map(aggregate.map((a) => [a.nutrient.id, a]));
      return {
        basis: items.length ? ('planned_items' as const) : ('no_planned_items' as const),
        includes_unconfirmed: items.some((i) => i.status !== 'confirmed'),
        summary: projectAggregateSummary(aggregate, items.length),
        item_count: dto.item_count,
        coverage_summary: dto.coverage_summary,
        nutrients: dto.nutrients,
        ...(withComparison ? { comparison: mapped.map((t) => compareToTarget(byId.get(t.nutrient.id), t)).sort((a, b) => (a.nutrient_key < b.nutrient_key ? -1 : 1)) } : {}),
      };
    };

    return {
      meal_plan_id: tree.plan.id,
      status: tree.plan.status,
      local_timezone: tree.plan.local_timezone,
      target_context: 'current_target_at_request_time' as const,
      target: {
        resolver_version: target.resolver_version,
        resolved_at: target.resolved_at,
        implemented_sources: target.implemented_sources,
        fields: Object.entries(target.resolved)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([field_name, f]) => ({ field_name, value: f.value, unit: f.unit, source: f.source, source_reference: f.source_reference })),
        unmapped_targets: unmapped,
      },
      days: [...tree.days]
        .sort((a, b) => (a.plan_date < b.plan_date ? -1 : 1))
        .map((day) => {
          const mealIds = new Set(tree.meals.filter((m) => m.meal_plan_day_id === day.id).map((m) => m.id));
          return { meal_plan_day_id: day.id, plan_date: day.plan_date, ...view(current.filter((i) => mealIds.has(i.planned_meal_id)), true) };
        }),
      // A whole-plan total spans several days, so it is not compared with a daily target.
      whole_plan: view(current, false),
    };
  }

  private async detail(db: ScopedDbClient, profileId: string, planId: string) {
    const tree = await loadTree(db, profileId, planId);
    const [snapshots, vocabulary] = await Promise.all([viewSnapshots(db, tree.items), loadNutrientVocabulary(db)]);
    return toMealPlanDetailDto(tree, snapshots, vocabulary);
  }

  private async itemDetail(db: ScopedDbClient, profileId: string, planId: string, itemId: string) {
    const tree = await loadTree(db, profileId, planId);
    const item = tree.items.find((i) => i.id === itemId);
    if (!item) throw AppError.notFound('Planned item not found.');
    const snapshots = await viewSnapshots(db, [item]);
    return toPlannedItemDto(item, snapshots.get(item.id) as MealItemSnapshot, { detail: true });
  }
}

function requireEditable(plan: MealPlanRow) {
  if (plan.status !== 'draft' && plan.status !== 'active') throw AppError.conflict(`A ${plan.status} plan cannot be changed.`);
}

/** Confirmed items: their stored snapshot. Others (draft, planned,
 * cancelled): calculated live, never stored. */
async function viewSnapshots(db: ScopedDbClient, items: readonly PlannedItemRow[]): Promise<Map<string, MealItemSnapshot>> {
  const confirmed = items.filter((i) => i.status === 'confirmed');
  const live = await computeSnapshots(
    db,
    items.filter((i) => i.status !== 'confirmed'),
    PLANNED_ITEM_SNAPSHOT_VERSION,
  );
  for (const i of confirmed) live.set(i.id, readSnapshot(i.nutrition_snapshot));
  return live;
}

/** The single path from planned item content to nutrition: Layer 5B for
 * Foods, Layer 6A recipe nutrition x servings for RecipeVersions, shaped by
 * the Layer 7A snapshot builders. */
async function computeSnapshots(db: ScopedDbClient, items: readonly PlannedItemRow[], version: string): Promise<Map<string, MealItemSnapshot>> {
  const out = new Map<string, MealItemSnapshot>();
  if (!items.length) return out;
  const { foods, vocabulary } = await loadNutritionReference(
    db,
    items.flatMap((i) => (i.food_id ? [i.food_id] : [])),
  );
  const recipeCache = new Map<string, Awaited<ReturnType<typeof loadRecipeNutrition>>>();
  for (const item of items) {
    if (item.food_id) {
      const food = foods.get(item.food_id);
      if (!food) throw new Error(`Food ${item.food_id} of planned item ${item.id} is not readable.`);
      const serving = item.food_serving_id ? food.servings.find((s) => s.id === item.food_serving_id) : undefined;
      const amount = serving ? { serving_id: serving.id } : { unit: item.unit ?? '' };
      const calc = calculateItem(0, { food, quantity: item.quantity, amount }, vocabulary);
      out.set(
        item.id,
        buildFoodSnapshot(
          calc,
          {
            type: 'food',
            food_id: food.food_id,
            canonical_name: food.canonical_name,
            quantity: item.quantity,
            unit: serving ? null : item.unit,
            serving: serving
              ? { serving_id: serving.id, description: serving.serving_description, canonical_quantity: serving.canonical_quantity, canonical_unit: serving.canonical_unit, source: serving.source }
              : null,
          },
          version,
        ),
      );
      continue;
    }
    const key = `${item.recipe_id}:${item.recipe_version_id}`;
    let recipe = recipeCache.get(key);
    if (!recipe) {
      recipe = await loadRecipeNutrition(db, item.recipe_id ?? '', item.recipe_version_id ?? '');
      recipeCache.set(key, recipe);
    }
    out.set(
      item.id,
      buildRecipeSnapshot(
        recipe.nutrition,
        {
          type: 'recipe',
          recipe_id: recipe.content.version.recipe_id,
          recipe_version_id: recipe.content.version.id,
          version_number: recipe.content.version.version_number,
          title: recipe.content.version.title,
          yield_servings: recipe.content.version.servings ?? 0,
          servings_consumed: item.quantity,
        },
        version,
      ),
    );
  }
  return out;
}

async function loadRecipeNutrition(db: ScopedDbClient, recipeId: string, versionId: string) {
  const content = await loadVersionContent(db, recipeId, versionId);
  return { content, nutrition: await recipeVersionNutrition(db, content) };
}

/** Validates new item content (references, same-Profile recipe, version
 * belongs to recipe, yield) before anything is written. */
async function prepareItems(db: ScopedDbClient, profileId: string, inputs: readonly PlannedItemInput[], path: string, indexed = true): Promise<ItemWrite[]> {
  const at = (i: number, field: string) => (indexed ? `${path}.${i}.${field}` : `${path}.${field}`);
  const issues: Array<{ path: string; message: string }> = [];
  const foodIds = [...new Set(inputs.flatMap((i) => (i.type === 'food' ? [i.food_id] : [])))];
  const servingIds = [...new Set(inputs.flatMap((i) => (i.type === 'food' && i.serving_id ? [i.serving_id] : [])))];
  const [foods, servings] = await Promise.all([
    foodIds.length ? db.select<{ id: string }>('food', { columns: 'id', in: { id: foodIds } }) : Promise.resolve([]),
    servingIds.length ? db.select<{ id: string; food_id: string }>('food_serving', { columns: 'id, food_id', in: { id: servingIds } }) : Promise.resolve([]),
  ]);
  const knownFoods = new Set(foods.map((f) => f.id));
  const servingFood = new Map(servings.map((s) => [s.id, s.food_id]));

  const out: ItemWrite[] = [];
  for (const [i, input] of inputs.entries()) {
    if (input.type === 'food') {
      if (!knownFoods.has(input.food_id)) issues.push({ path: at(i, 'food_id'), message: 'Food not found.' });
      else if (input.serving_id && servingFood.get(input.serving_id) !== input.food_id) issues.push({ path: at(i, 'serving_id'), message: 'serving_id does not exist for this food.' });
      out.push({
        food_id: input.food_id,
        food_serving_id: input.serving_id ?? null,
        unit: input.serving_id ? null : (input.unit ?? null),
        recipe_id: null,
        recipe_version_id: null,
        quantity: input.quantity,
        position: input.position ?? i,
      });
      continue;
    }
    const recipe = await loadRecipe(db, profileId, input.recipe_id).catch(() => null);
    if (!recipe) {
      issues.push({ path: at(i, 'recipe_id'), message: "Recipe not found in this profile's Recipe Book." });
      continue;
    }
    const content = await loadVersionContent(db, recipe.id, input.recipe_version_id).catch(() => null);
    if (!content) issues.push({ path: at(i, 'recipe_version_id'), message: 'recipe_version_id is not a version of this recipe.' });
    else if (content.version.servings === null) issues.push({ path: at(i, 'recipe_version_id'), message: 'This recipe version has no yield.' });
    out.push({ food_id: null, food_serving_id: null, unit: null, recipe_id: recipe.id, recipe_version_id: input.recipe_version_id, quantity: input.servings, position: input.position ?? i });
  }
  if (issues.length) throw AppError.validation('Invalid planned item.', { issues });
  return out;
}

async function loadTree(db: ScopedDbClient, profileId: string, planId: string): Promise<PlanTree> {
  const plans = await db.select<MealPlanRow>('meal_plan', { columns: MEAL_PLAN_COLUMNS, eq: { id: planId, profile_id: profileId }, limit: 1 });
  const plan = plans[0];
  if (!plan) throw AppError.notFound('Meal plan not found.');
  const days = await db.select<MealPlanDayRow>('meal_plan_day', { columns: MEAL_PLAN_DAY_COLUMNS, eq: { meal_plan_id: plan.id }, limit: IN_MEMORY_PAGE_FETCH_CAP });
  const meals = days.length
    ? await db.select<PlannedMealRow>('planned_meal', { columns: PLANNED_MEAL_COLUMNS, in: { meal_plan_day_id: days.map((d) => d.id) }, limit: IN_MEMORY_PAGE_FETCH_CAP })
    : [];
  const items = meals.length
    ? await db.select<PlannedItemRow>('planned_meal_item', {
        columns: PLANNED_ITEM_COLUMNS,
        in: { planned_meal_id: meals.map((m) => m.id) },
        order: { column: 'created_at', ascending: true },
        limit: IN_MEMORY_PAGE_FETCH_CAP,
      })
    : [];
  return { plan, days, meals, items };
}

/** Database refusals -> safe API errors (never the SQL message). */
async function callWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'P0002') throw AppError.notFound('Meal plan content not found.');
    if (code === '40001') throw AppError.conflict('The plan changed while it was being confirmed. Reload and retry.');
    if (code === '55000' || code === '23514') throw AppError.conflict('The change violates a meal planning rule.');
    if (code === '23505') throw AppError.conflict('This already exists in the plan.');
    if (code === '22023') throw AppError.validation('Invalid meal planning request.');
    if (code === '23503') throw AppError.validation('A referenced food, serving or recipe version does not exist.');
    if (code === '42501') throw AppError.forbidden('This operation is not permitted for this profile.');
    throw err;
  }
}
