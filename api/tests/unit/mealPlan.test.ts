// Layer 8A unit tests — current-plan view rules and request validation.
import { describe, expect, it } from 'vitest';
import { isCurrent, isEligibleForConfirmation, isPendingReplacement, type PlannedItemRow } from '../../src/domain/mealPlans/mealPlan.dto';
import { mealPlanCreateSchema, mealPlanPatchSchema, plannedItemInputSchema, plannedItemPatchSchema, plannedMealCreateSchema } from '../../src/domain/mealPlans/mealPlan.schemas';

const item = (partial: Partial<PlannedItemRow>): PlannedItemRow => ({
  id: 'i',
  planned_meal_id: 'm',
  profile_id: 'p',
  food_id: 'f',
  food_serving_id: null,
  unit: 'g',
  recipe_id: null,
  recipe_version_id: null,
  quantity: 100,
  position: 0,
  status: 'draft',
  confirmed_at: null,
  supersedes_planned_meal_item_id: null,
  superseded_by_planned_meal_item_id: null,
  nutrition_snapshot: null,
  nutrition_calculation_version: null,
  nutrition_calculated_at: null,
  created_at: '2026-10-01T00:00:00.000Z',
  ...partial,
});

describe('current plan view', () => {
  it('draft, planned and confirmed items are current; cancelled are not', () => {
    for (const status of ['draft', 'planned', 'confirmed'] as const) expect(isCurrent(item({ status }))).toBe(true);
    expect(isCurrent(item({ status: 'cancelled' }))).toBe(false);
  });

  it('a superseded confirmed item is history, not current', () => {
    expect(isCurrent(item({ status: 'confirmed', superseded_by_planned_meal_item_id: 'r' }))).toBe(false);
  });

  it('a pending (unconfirmed) replacement is not current until confirmed; the original stays current', () => {
    const pending = item({ status: 'draft', supersedes_planned_meal_item_id: 'o' });
    expect(isPendingReplacement(pending)).toBe(true);
    expect(isCurrent(pending)).toBe(false);
    expect(isEligibleForConfirmation(pending)).toBe(true);
    const accepted = item({ status: 'confirmed', supersedes_planned_meal_item_id: 'o' });
    expect(isPendingReplacement(accepted)).toBe(false);
    expect(isCurrent(accepted)).toBe(true);
  });

  it('only draft and planned items are eligible for confirmation', () => {
    expect(['draft', 'planned', 'confirmed', 'cancelled'].map((status) => isEligibleForConfirmation(item({ status: status as PlannedItemRow['status'] })))).toEqual([true, true, false, false]);
  });
});

describe('request validation', () => {
  const plan = { name: 'Week', start_date: '2026-10-10', end_date: '2026-10-12', local_timezone: 'Europe/London' };

  it('plans: date order, bounded length, IANA zone', () => {
    expect(mealPlanCreateSchema.safeParse(plan).success).toBe(true);
    expect(mealPlanCreateSchema.safeParse({ ...plan, end_date: '2026-10-09' }).success).toBe(false);
    expect(mealPlanCreateSchema.safeParse({ ...plan, end_date: '2027-10-11' }).success).toBe(false);
    expect(mealPlanCreateSchema.safeParse({ ...plan, local_timezone: 'GMT+4' }).success).toBe(false);
    expect(mealPlanCreateSchema.safeParse({ ...plan, name: ' ' }).success).toBe(false);
  });

  it('PATCH cannot set active (only /confirm) or unknown states', () => {
    for (const status of ['active', 'draft', 'consumed']) expect(mealPlanPatchSchema.safeParse({ status }).success).toBe(false);
    expect(mealPlanPatchSchema.safeParse({ status: 'completed' }).success).toBe(true);
    expect(mealPlanPatchSchema.safeParse({}).success).toBe(false);
  });

  it('items: exactly one Food amount form; recipes need version and positive servings; no NaN/Infinity', () => {
    const food = { type: 'food', food_id: '00000000-0000-4000-8000-000000000001', quantity: 150, unit: 'g' };
    expect(plannedItemInputSchema.safeParse(food).success).toBe(true);
    expect(plannedItemInputSchema.safeParse({ ...food, serving_id: '00000000-0000-4000-8000-000000000002' }).success).toBe(false);
    expect(plannedItemInputSchema.safeParse({ ...food, unit: undefined }).success).toBe(false);
    for (const quantity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(plannedItemInputSchema.safeParse({ ...food, quantity }).success).toBe(false);
    const recipe = { type: 'recipe', recipe_id: '00000000-0000-4000-8000-000000000001', recipe_version_id: '00000000-0000-4000-8000-000000000002', servings: 1.5 };
    expect(plannedItemInputSchema.safeParse(recipe).success).toBe(true);
    expect(plannedItemInputSchema.safeParse({ ...recipe, servings: 0 }).success).toBe(false);
    expect(plannedItemInputSchema.safeParse({ ...recipe, recipe_version_id: undefined }).success).toBe(false);
  });

  it('meals: approved meal types, HH:MM local time, bounded position', () => {
    expect(plannedMealCreateSchema.safeParse({ meal_type: 'dinner', scheduled_local_time: '19:45' }).success).toBe(true);
    expect(plannedMealCreateSchema.safeParse({ meal_type: 'pre_workout' }).success).toBe(false);
    expect(plannedMealCreateSchema.safeParse({ meal_type: 'lunch', scheduled_local_time: '25:00' }).success).toBe(false);
    expect(plannedMealCreateSchema.safeParse({ meal_type: 'lunch', position: -1 }).success).toBe(false);
  });

  it('item edits: planned/cancelled only; one amount form', () => {
    expect(plannedItemPatchSchema.safeParse({ status: 'confirmed' }).success).toBe(false);
    expect(plannedItemPatchSchema.safeParse({ unit: 'g', serving_id: '00000000-0000-4000-8000-000000000002' }).success).toBe(false);
    expect(plannedItemPatchSchema.safeParse({ status: 'cancelled' }).success).toBe(true);
  });
});
