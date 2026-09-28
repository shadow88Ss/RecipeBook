// Layer 6A — recipe nutrition, entirely through the Layer 5B engine.
//
//   RecipeVersion -> its RecipeIngredients (in sort_order)
//     -> each confirmed Food + quantity + unit|FoodServing
//     -> calculateItem (Layer 5A normalization, 5B source resolution/scaling)
//     -> aggregateNutrients           = whole recipe
//     -> divideAggregate(servings)    = per serving
//     -> projectAggregateSummary      = Layer 5C summary for each
//
// Pure: no I/O. There is no recipe-specific nutrient arithmetic here — every
// value comes from the engine, and per-serving is the engine's exact
// division of the whole-recipe result, so a partial total stays partial and
// an unavailable one stays null.
//
// An ingredient that cannot be calculated (no confirmed Food, no quantity,
// no unit/serving, or its Food is unreadable) is NOT dropped: it enters the
// aggregate with every nutrient `item_unresolved`, which makes the affected
// totals partial/unavailable. Nothing is estimated or force-matched.

import {
  aggregateNutrients,
  calculateItem,
  divideAggregate,
  unresolvedContributions,
  type AggregateContribution,
  type AggregateNutrient,
  type FoodNutritionData,
  type ItemCalculation,
  type NutrientDefinition,
} from '../nutrition/nutrition.engine';

export type IngredientMatchStatus = 'matched' | 'needs_confirmation' | 'unmatched';

export interface IngredientForNutrition {
  id: string;
  sort_order: number;
  food_id: string | null;
  food_serving_id: string | null;
  quantity: number | null;
  unit: string | null;
  match_status: IngredientMatchStatus;
}

export type IngredientNutritionStatus =
  /** Calculated by the engine (individual nutrients may still be unresolved). */
  | 'calculated'
  /** No canonical Food — stored as text only. */
  | 'food_unmatched'
  /** A Food is proposed but not confirmed (e.g. a future import match):
   * low-confidence matches never count toward totals (Master §18). */
  | 'food_needs_confirmation'
  /** The referenced Food is not readable/present. */
  | 'food_unavailable'
  /** No quantity ("salt to taste"). */
  | 'quantity_missing'
  /** A quantity without a unit or serving ("2 eggs"). */
  | 'unit_missing';

export function ingredientNutritionStatus(ingredient: IngredientForNutrition, foods: ReadonlyMap<string, FoodNutritionData>): IngredientNutritionStatus {
  if (ingredient.food_id === null || ingredient.match_status === 'unmatched') return 'food_unmatched';
  if (ingredient.match_status !== 'matched') return 'food_needs_confirmation';
  if (!foods.has(ingredient.food_id)) return 'food_unavailable';
  if (ingredient.quantity === null) return 'quantity_missing';
  if (ingredient.unit === null && ingredient.food_serving_id === null) return 'unit_missing';
  return 'calculated';
}

export interface IngredientNutrition {
  ingredient_id: string;
  /** 0-based position; the `index` used in aggregate `missing[]`. */
  index: number;
  status: IngredientNutritionStatus;
  calculation: ItemCalculation | null;
}

export interface RecipeNutrition {
  servings: number | null;
  ingredients: IngredientNutrition[];
  whole_recipe: AggregateNutrient[];
  /** null when the version defines no yield. */
  per_serving: AggregateNutrient[] | null;
}

export function calculateRecipeNutrition(
  ingredients: readonly IngredientForNutrition[],
  foods: ReadonlyMap<string, FoodNutritionData>,
  vocabulary: readonly NutrientDefinition[],
  servings: number | null,
): RecipeNutrition {
  const ordered = [...ingredients].sort((a, b) => a.sort_order - b.sort_order);
  const perIngredient: IngredientNutrition[] = [];
  const contributions: Array<{ index: number; nutrients: AggregateContribution[] }> = [];

  ordered.forEach((ingredient, index) => {
    const status = ingredientNutritionStatus(ingredient, foods);
    const food = ingredient.food_id !== null ? foods.get(ingredient.food_id) : undefined;
    if (status !== 'calculated' || !food || ingredient.quantity === null) {
      perIngredient.push({ ingredient_id: ingredient.id, index, status, calculation: null });
      contributions.push({ index, nutrients: unresolvedContributions(vocabulary) });
      return;
    }
    const amount = ingredient.food_serving_id !== null ? { serving_id: ingredient.food_serving_id } : { unit: ingredient.unit ?? '' };
    const calculation = calculateItem(index, { food, quantity: ingredient.quantity, amount }, vocabulary);
    perIngredient.push({ ingredient_id: ingredient.id, index, status, calculation });
    contributions.push({
      index,
      nutrients: calculation.nutrients.map((n) => ({ nutrient_id: n.nutrient.id, status: n.status, value: n.value, unit: n.unit })),
    });
  });

  const wholeRecipe = aggregateNutrients(vocabulary, contributions);
  return {
    servings,
    ingredients: perIngredient,
    whole_recipe: wholeRecipe,
    per_serving: servings !== null ? divideAggregate(wholeRecipe, servings) : null,
  };
}
