// Layer 9A — the deterministic grocery derivation engine.
//
// Pure functions only (no I/O, clock, randomness or AI). The single
// derivation used by BOTH the live preview and persisted generation:
//
//   current planned items
//   -> direct Food amounts and exact RecipeVersion ingredients
//   -> recipe scaling: ingredient quantity x planned servings / yield
//   -> Layer 5A normalization to a canonical grocery base (g, ml, count)
//   -> aggregation by canonical Food id + compatible dimension
//   -> generated items, each with its full source traceability.
//
// Grocery quantities come ONLY from structured plan/recipe quantities —
// never from nutrition snapshots, nutrition totals, actual consumption or
// adherence. Arithmetic is exact (rationals); rounding happens once, at the
// output (6 decimal places, half-up). Nothing is guessed:
//   * a RecipeIngredient is a Food only when `matched` with a readable Food;
//   * no quantity -> unresolved_quantity; ambiguous household unit ->
//     ambiguous_unit; a serving/density that is not global reference
//     authority, or unusable reference data -> unresolved_conversion;
//   * mass + volume of one Food merge (into g) only through that Food's
//     trusted density; count never merges with mass/volume; otherwise the
//     components stay separate as incompatible_units.
// Different Food ids are never merged, whatever their names.

import { createHash } from 'node:crypto';
import { CONVERSION_VERSION, convertExact, type ConversionStep, type FoodConversionData, type ProvenanceEntry } from '../conversion/conversion.engine';
import { add, div, fromNumber, mul, roundHalfUp, toFractionString, ZERO, type Rational } from '../conversion/decimal';
import { BASE_UNIT, resolveUnit } from '../conversion/units';

export const GROCERY_CALCULATION_VERSION = 'grocery-calculation-9a.1';
export const GROCERY_FINGERPRINT_VERSION = 'grocery-source-fingerprint-9a.1';
export const GROCERY_DECIMAL_PLACES = 6;

export type GroceryDimension = 'mass' | 'volume' | 'count';
export type GroceryUnit = 'g' | 'ml' | 'count';
export type ResolutionStatus = 'resolved' | 'incompatible_units' | 'unresolved_quantity' | 'ambiguous_unit' | 'unresolved_conversion' | 'unresolved_food';
export type IngredientMatchStatus = 'matched' | 'needs_confirmation' | 'unmatched';

const UNIT_OF: Record<GroceryDimension, GroceryUnit> = { mass: 'g', volume: 'ml', count: 'count' };
const DIMENSION_ORDER: Record<GroceryDimension, number> = { mass: 0, volume: 1, count: 2 };

/** One contributing planned item, with its place in the plan. */
export interface PlannedSource {
  meal_plan_id: string;
  meal_plan_day_id: string;
  planned_meal_id: string;
  planned_meal_item_id: string;
  plan_date: string;
  meal_type: string;
  /** Sort keys: meal position, item position, item created_at. */
  meal_position: number;
  item_position: number;
  item_created_at: string;
  food_id: string | null;
  food_serving_id: string | null;
  unit: string | null;
  recipe_id: string | null;
  recipe_version_id: string | null;
  /** Food quantity, or recipe servings. */
  quantity: number;
}

export interface RecipeIngredientData {
  id: string;
  food_id: string | null;
  food_serving_id: string | null;
  raw_ingredient_text: string;
  quantity: number | null;
  unit: string | null;
  match_status: IngredientMatchStatus;
  sort_order: number;
}

/** An exact RecipeVersion (immutable content). */
export interface RecipeVersionData {
  id: string;
  recipe_id: string;
  title: string;
  version_number: number;
  servings: number | null;
  ingredients: RecipeIngredientData[];
}

export interface GroceryFood extends FoodConversionData {
  canonical_name: string;
}

export interface DerivationInput {
  sources: readonly PlannedSource[];
  recipeVersions: ReadonlyMap<string, RecipeVersionData>;
  foods: ReadonlyMap<string, GroceryFood>;
}

export interface SourceConversion {
  steps: ConversionStep[];
  provenance: ProvenanceEntry[];
}

/** One traceability row. */
export interface GrocerySourceLine {
  meal_plan_id: string;
  meal_plan_day_id: string;
  planned_meal_id: string;
  planned_meal_item_id: string;
  plan_date: string;
  meal_type: string;
  source_type: 'planned_food' | 'recipe_ingredient';
  food_id: string | null;
  food_serving_id: string | null;
  recipe_id: string | null;
  recipe_version_id: string | null;
  recipe_version_number: number | null;
  recipe_title: string | null;
  recipe_ingredient_id: string | null;
  ingredient_text: string | null;
  ingredient_match_status: IngredientMatchStatus | null;
  source_quantity: number | null;
  source_unit: string | null;
  planned_servings: number | null;
  recipe_yield: number | null;
  scale_factor_exact: string;
  scaled_quantity_exact: string | null;
  contribution_quantity_exact: string | null;
  contribution_unit: GroceryUnit | null;
  conversion: SourceConversion | null;
  unresolved_reason: string | null;
}

export interface GroceryItem {
  position: number;
  food_id: string | null;
  display_name: string;
  dimension: GroceryDimension | null;
  quantity_exact: string | null;
  quantity: string | null;
  unit: GroceryUnit | null;
  resolution_status: ResolutionStatus;
  aggregation_status: 'aggregated' | 'not_aggregated';
  unresolved_reason: string | null;
  sources: GrocerySourceLine[];
}

export interface GroceryDerivation {
  calculation_version: typeof GROCERY_CALCULATION_VERSION;
  conversion_version: string;
  items: GroceryItem[];
  summary: {
    item_count: number;
    resolved_item_count: number;
    incompatible_unit_item_count: number;
    unresolved_item_count: number;
    source_line_count: number;
    contributing_planned_item_count: number;
    direct_food_source_count: number;
    recipe_ingredient_source_count: number;
    recipe_version_count: number;
  };
}

// ---------------------------------------------------------------------------

type Outcome =
  | { status: 'resolved'; dimension: GroceryDimension; value: Rational; conversion: SourceConversion | null }
  | { status: Exclude<ResolutionStatus, 'resolved' | 'incompatible_units'>; reason: string };

interface Line {
  sortKey: Array<string | number>;
  source: PlannedSource;
  recipe: RecipeVersionData | null;
  ingredient: RecipeIngredientData | null;
  food: GroceryFood | null;
  displayName: string;
  scale: Rational;
  scaled: Rational | null;
  outcome: Outcome;
}

const num = (value: number | string | null): Rational | null => {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? fromNumber(n) : null;
};

/** Converts one structured amount to its canonical grocery base. */
function normalize(food: GroceryFood | null, scaled: Rational | null, unit: string | null, servingId: string | null): Outcome {
  if (scaled === null) return { status: 'unresolved_quantity', reason: 'no_quantity' };
  if (servingId !== null) {
    const serving = food?.servings.find((s) => s.id === servingId);
    if (!serving) return { status: 'unresolved_conversion', reason: 'serving_not_found' };
    if (serving.canonical_unit !== 'g' && serving.canonical_unit !== 'ml') return { status: 'unresolved_conversion', reason: 'invalid_reference_data' };
    const per = convertExact({ quantity: 1, from: { serving_id: servingId }, to: { unit: serving.canonical_unit } }, food);
    if (per.status === 'unresolved') return { status: 'unresolved_conversion', reason: per.reason };
    if (!per.authoritative) return { status: 'unresolved_conversion', reason: 'serving_not_trusted_reference' };
    return {
      status: 'resolved',
      dimension: serving.canonical_unit === 'g' ? 'mass' : 'volume',
      value: mul(scaled, per.value),
      conversion: { steps: per.steps, provenance: per.provenance },
    };
  }
  if (unit === null) return { status: 'resolved', dimension: 'count', value: scaled, conversion: null };
  const resolution = resolveUnit(unit);
  if (!resolution.ok) {
    return resolution.reason === 'ambiguous_unit'
      ? { status: 'ambiguous_unit', reason: `ambiguous_unit:${resolution.candidates.join('|')}` }
      : { status: 'unresolved_conversion', reason: 'unknown_unit' };
  }
  const base = BASE_UNIT[resolution.unit.dimension];
  const per = convertExact({ quantity: 1, from: { unit: resolution.unit.code }, to: { unit: base } }, null);
  if (per.status === 'unresolved') return { status: 'unresolved_conversion', reason: per.reason };
  return {
    status: 'resolved',
    dimension: resolution.unit.dimension,
    value: mul(scaled, per.value),
    conversion: { steps: per.steps, provenance: per.provenance },
  };
}

function expand(input: DerivationInput): Line[] {
  const lines: Line[] = [];
  for (const source of input.sources) {
    const base = [source.plan_date, source.meal_position, source.planned_meal_id, source.item_position, source.item_created_at, source.planned_meal_item_id];
    if (source.recipe_version_id === null) {
      const food = source.food_id ? (input.foods.get(source.food_id) ?? null) : null;
      const scaled = num(source.quantity);
      lines.push({
        sortKey: [...base, 0],
        source,
        recipe: null,
        ingredient: null,
        food,
        displayName: food?.canonical_name ?? `Food ${source.food_id ?? ''}`.trim(),
        scale: fromNumber(1),
        scaled,
        outcome: food ? normalize(food, scaled, source.unit, source.food_serving_id) : { status: 'unresolved_food', reason: 'food_reference_missing' },
      });
      continue;
    }
    const recipe = input.recipeVersions.get(source.recipe_version_id);
    if (!recipe) throw new Error(`RecipeVersion ${source.recipe_version_id} of planned item ${source.planned_meal_item_id} is not loaded.`);
    const yieldServings = num(recipe.servings);
    const servings = num(source.quantity);
    if (!yieldServings || yieldServings.n === 0n || !servings) throw new Error(`RecipeVersion ${recipe.id} has no usable yield.`);
    const scale = div(servings, yieldServings);
    for (const ingredient of [...recipe.ingredients].sort((a, b) => a.sort_order - b.sort_order)) {
      const quantity = num(ingredient.quantity);
      const scaled = quantity ? mul(quantity, scale) : null;
      const food = ingredient.food_id !== null && ingredient.match_status === 'matched' ? (input.foods.get(ingredient.food_id) ?? null) : null;
      let outcome: Outcome;
      if (!food) {
        const reason =
          ingredient.match_status === 'needs_confirmation'
            ? 'ingredient_needs_confirmation'
            : ingredient.match_status === 'unmatched' || ingredient.food_id === null
              ? 'ingredient_unmatched'
              : 'food_reference_missing';
        outcome = { status: 'unresolved_food', reason };
      } else {
        outcome = normalize(food, scaled, ingredient.unit, ingredient.food_serving_id);
      }
      lines.push({
        sortKey: [...base, ingredient.sort_order],
        source,
        recipe,
        ingredient,
        food,
        displayName: food?.canonical_name ?? ingredient.raw_ingredient_text,
        scale,
        scaled,
        outcome,
      });
    }
  }
  return lines.sort((a, b) => compareKeys(a.sortKey, b.sortKey));
}

function compareKeys(a: ReadonlyArray<string | number>, b: ReadonlyArray<string | number>): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

function sourceLine(line: Line, contribution: { value: Rational; unit: GroceryUnit; conversion: SourceConversion | null } | null, reason: string | null): GrocerySourceLine {
  const { source, recipe, ingredient } = line;
  return {
    meal_plan_id: source.meal_plan_id,
    meal_plan_day_id: source.meal_plan_day_id,
    planned_meal_id: source.planned_meal_id,
    planned_meal_item_id: source.planned_meal_item_id,
    plan_date: source.plan_date,
    meal_type: source.meal_type,
    source_type: ingredient ? 'recipe_ingredient' : 'planned_food',
    food_id: ingredient ? (line.food ? ingredient.food_id : null) : source.food_id,
    food_serving_id: ingredient ? ingredient.food_serving_id : source.food_serving_id,
    recipe_id: recipe ? recipe.recipe_id : null,
    recipe_version_id: recipe ? recipe.id : null,
    recipe_version_number: recipe ? recipe.version_number : null,
    recipe_title: recipe ? recipe.title : null,
    recipe_ingredient_id: ingredient ? ingredient.id : null,
    ingredient_text: ingredient ? ingredient.raw_ingredient_text : null,
    ingredient_match_status: ingredient ? ingredient.match_status : null,
    source_quantity: ingredient ? ingredient.quantity : source.quantity,
    source_unit: ingredient ? ingredient.unit : source.unit,
    planned_servings: recipe ? source.quantity : null,
    recipe_yield: recipe ? recipe.servings : null,
    scale_factor_exact: toFractionString(line.scale),
    scaled_quantity_exact: line.scaled ? toFractionString(line.scaled) : null,
    contribution_quantity_exact: contribution ? toFractionString(contribution.value) : null,
    contribution_unit: contribution ? contribution.unit : null,
    conversion: contribution?.conversion ?? null,
    unresolved_reason: reason,
  };
}

const rounded = (value: Rational) => roundHalfUp(value, GROCERY_DECIMAL_PLACES);

export function deriveGroceryRequirements(input: DerivationInput): GroceryDerivation {
  const lines = expand(input);

  // Resolved quantities, grouped by canonical Food id (never by name).
  const byFood = new Map<string, Line[]>();
  const unresolved: Line[] = [];
  for (const line of lines) {
    if (line.outcome.status === 'resolved' && line.food) {
      const list = byFood.get(line.food.food_id) ?? [];
      list.push(line);
      byFood.set(line.food.food_id, list);
    } else {
      unresolved.push(line);
    }
  }

  const foodItems: Array<Omit<GroceryItem, 'position'>> = [];
  for (const [foodId, foodLines] of byFood) {
    const food = foodLines[0]?.food as GroceryFood;
    const components = new Map<GroceryDimension, Array<{ line: Line; value: Rational; conversion: SourceConversion | null }>>();
    for (const line of foodLines) {
      const outcome = line.outcome as Extract<Outcome, { status: 'resolved' }>;
      const list = components.get(outcome.dimension) ?? [];
      list.push({ line, value: outcome.value, conversion: outcome.conversion });
      components.set(outcome.dimension, list);
    }

    // mass + volume -> g, only through the Food's trusted density
    let densityReason: string | null = null;
    const volume = components.get('volume');
    if (components.has('mass') && volume) {
      const density = convertExact({ quantity: 1, from: { unit: 'ml' }, to: { unit: 'g' } }, food);
      if (density.status === 'converted' && density.authoritative) {
        const mass = components.get('mass') ?? [];
        for (const c of volume) {
          mass.push({
            line: c.line,
            value: mul(c.value, density.value),
            conversion: { steps: [...(c.conversion?.steps ?? []), ...density.steps.filter((s) => s.operation === 'density')], provenance: [...(c.conversion?.provenance ?? []), ...density.provenance.filter((p) => p.kind === 'food_density')] },
          });
        }
        components.delete('volume');
      } else {
        densityReason = density.status === 'unresolved' ? `mass_volume_${density.reason}` : 'mass_volume_density_not_trusted_reference';
      }
    }

    const separate = components.size > 1;
    const reasonFor = (dimension: GroceryDimension) => {
      if (!separate) return null;
      if (dimension === 'count' || components.has('count')) return 'count_not_convertible_to_mass_or_volume';
      return densityReason ?? 'incompatible_dimensions';
    };
    for (const [dimension, parts] of [...components].sort(([a], [b]) => DIMENSION_ORDER[a] - DIMENSION_ORDER[b])) {
      const total = parts.reduce((sum, p) => add(sum, p.value), ZERO);
      const unit = UNIT_OF[dimension];
      foodItems.push({
        food_id: foodId,
        display_name: food.canonical_name,
        dimension,
        quantity_exact: toFractionString(total),
        quantity: rounded(total),
        unit,
        resolution_status: separate ? 'incompatible_units' : 'resolved',
        aggregation_status: 'aggregated',
        unresolved_reason: reasonFor(dimension),
        sources: parts.sort((a, b) => compareKeys(a.line.sortKey, b.line.sortKey)).map((p) => sourceLine(p.line, { value: p.value, unit, conversion: p.conversion }, null)),
      });
    }
  }
  foodItems.sort(
    (a, b) =>
      (a.display_name < b.display_name ? -1 : a.display_name > b.display_name ? 1 : 0) ||
      ((a.food_id ?? '') < (b.food_id ?? '') ? -1 : (a.food_id ?? '') > (b.food_id ?? '') ? 1 : 0) ||
      DIMENSION_ORDER[a.dimension as GroceryDimension] - DIMENSION_ORDER[b.dimension as GroceryDimension],
  );

  // Every unresolved line stays visible as its own requirement.
  const unresolvedItems: Array<Omit<GroceryItem, 'position'>> = unresolved.map((line) => {
    const outcome = line.outcome as Exclude<Outcome, { status: 'resolved' }>;
    return {
      food_id: outcome.status === 'unresolved_food' ? null : (line.food?.food_id ?? null),
      display_name: line.displayName,
      dimension: null,
      quantity_exact: null,
      quantity: null,
      unit: null,
      resolution_status: outcome.status,
      aggregation_status: 'not_aggregated',
      unresolved_reason: outcome.reason,
      sources: [sourceLine(line, null, outcome.reason)],
    };
  });

  const items = [...foodItems, ...unresolvedItems].map((item, position) => ({ position, ...item }));
  return {
    calculation_version: GROCERY_CALCULATION_VERSION,
    conversion_version: CONVERSION_VERSION,
    items,
    summary: {
      item_count: items.length,
      resolved_item_count: items.filter((i) => i.resolution_status === 'resolved').length,
      incompatible_unit_item_count: items.filter((i) => i.resolution_status === 'incompatible_units').length,
      unresolved_item_count: unresolvedItems.length,
      source_line_count: lines.length,
      contributing_planned_item_count: input.sources.length,
      direct_food_source_count: lines.filter((l) => !l.ingredient).length,
      recipe_ingredient_source_count: lines.filter((l) => l.ingredient).length,
      recipe_version_count: new Set(input.sources.flatMap((s) => (s.recipe_version_id ? [s.recipe_version_id] : []))).size,
    },
  };
}

// ---------------------------------------------------------------------------
// Source fingerprint — the plan facts that determine a derivation.

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

const decimalText = (v: number | null) => (v === null ? null : String(Number(v)));

/**
 * SHA-256 over a canonical serialization of the contributing planned items
 * (id, place in the plan, Food / serving / unit / quantity, or Recipe +
 * exact RecipeVersion + servings) and of each referenced RecipeVersion's
 * yield and ingredient facts (id, Food, match status, serving, quantity,
 * unit). Membership encodes the current/confirmed/skipped state. Nutrition,
 * actual consumption, adherence and display text are not included.
 */
export function sourceFingerprint(sources: readonly PlannedSource[], recipeVersions: ReadonlyMap<string, RecipeVersionData>): string {
  const versionIds = [...new Set(sources.flatMap((s) => (s.recipe_version_id ? [s.recipe_version_id] : [])))].sort();
  const document = {
    version: GROCERY_FINGERPRINT_VERSION,
    items: [...sources]
      .sort((a, b) => (a.planned_meal_item_id < b.planned_meal_item_id ? -1 : 1))
      .map((s) => ({
        id: s.planned_meal_item_id,
        day: s.meal_plan_day_id,
        date: s.plan_date,
        meal: s.planned_meal_id,
        food: s.food_id,
        serving: s.food_serving_id,
        unit: s.unit,
        quantity: decimalText(s.quantity),
        recipe: s.recipe_id,
        recipe_version: s.recipe_version_id,
      })),
    recipe_versions: versionIds.map((id) => {
      const v = recipeVersions.get(id);
      return {
        id,
        yield: v ? decimalText(v.servings) : null,
        ingredients: v
          ? [...v.ingredients]
              .sort((a, b) => (a.id < b.id ? -1 : 1))
              .map((i) => ({ id: i.id, food: i.food_id, match: i.match_status, serving: i.food_serving_id, quantity: decimalText(i.quantity), unit: i.unit }))
          : null,
      };
    }),
  };
  return createHash('sha256').update(canonicalJson(document)).digest('hex');
}
