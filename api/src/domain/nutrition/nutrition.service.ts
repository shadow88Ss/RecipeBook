// Layer 5B — loads reference data for a calculation and shapes the output.
//
// Read-only. Every query runs through the caller's own RLS-scoped
// ScopedDbClient (food reference tables: SELECT-only for `authenticated`),
// never a service-role credential, and nothing is persisted — no MealLog,
// no Recipe, no snapshot. The arithmetic lives entirely in
// nutrition.engine.ts.
//
// Invalid input (unknown food, a serving that does not exist or belongs to
// another food) is a 400 VALIDATION_ERROR naming the item. Legitimately
// insufficient reference data (no density, no authoritative nutrient
// value, ambiguous sources) is not an error: it is reported per nutrient in
// a 200 response.

import { AppError } from '../../lib/errors';
import { IN_MEMORY_PAGE_FETCH_CAP } from '../../lib/pagination';
import type { ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import { CONVERSION_VERSION, ROUNDING_MODE, type ReferenceSource, type ServingReference } from '../conversion/conversion.engine';
import {
  calculateNutrition,
  NUTRITION_CALCULATION_VERSION,
  NUTRITION_DECIMAL_PLACES,
  roundedNumber,
  roundValue,
  type AggregateNutrient,
  type CalculationItemInput,
  type Coverage,
  type FoodNutritionData,
  type ItemCalculation,
  type NutrientDefinition,
} from './nutrition.engine';
import type { NutritionCalculateRequest } from './nutrition.schemas';
import type { FoodNutrientRecord } from './sourceResolution';

interface FoodRow {
  id: string;
  canonical_name: string;
  density_g_per_ml: number | null;
  density_source: ReferenceSource | null;
}
interface ServingRow extends ServingReference {
  food_id: string;
}
interface FoodNutrientRow {
  id: string;
  food_id: string;
  nutrient_id: string;
  amount_per_canonical_unit: number;
  basis_quantity: number;
  basis_unit: string;
  source: ReferenceSource;
}

export class NutritionService {
  constructor(private readonly dbFactory: ScopedDbFactory) {}

  async calculate(auth: AuthContext, request: NutritionCalculateRequest) {
    const db = this.dbFactory.forUser(auth);
    const foodIds = [...new Set(request.items.map((item) => item.food_id))];

    const [foods, servings, foodNutrients, vocabulary] = await Promise.all([
      db.select<FoodRow>('food', { columns: 'id, canonical_name, density_g_per_ml, density_source', in: { id: foodIds } }),
      db.select<ServingRow>('food_serving', {
        columns: 'id, food_id, serving_description, region, canonical_quantity, canonical_unit, source',
        in: { food_id: foodIds },
      }),
      db.select<FoodNutrientRow>('food_nutrient', {
        columns: 'id, food_id, nutrient_id, amount_per_canonical_unit, basis_quantity, basis_unit, source',
        in: { food_id: foodIds },
      }),
      db.select<NutrientDefinition>('nutrient', {
        columns: 'id, canonical_key, unit',
        order: { column: 'canonical_key', ascending: true },
        limit: IN_MEMORY_PAGE_FETCH_CAP,
      }),
    ]);

    const data = new Map<string, FoodNutritionData>();
    for (const food of foods) {
      data.set(food.id, {
        food_id: food.id,
        canonical_name: food.canonical_name,
        density:
          food.density_g_per_ml !== null && food.density_source !== null
            ? { g_per_ml: food.density_g_per_ml, source: food.density_source }
            : null,
        servings: servings.filter((s) => s.food_id === food.id),
        nutrients: foodNutrients
          .filter((fn) => fn.food_id === food.id)
          .map(
            (fn): FoodNutrientRecord => ({
              id: fn.id,
              nutrient_id: fn.nutrient_id,
              amount: fn.amount_per_canonical_unit,
              basis_quantity: fn.basis_quantity,
              basis_unit: fn.basis_unit,
              source: fn.source,
            }),
          ),
      });
    }

    const inputs: CalculationItemInput[] = request.items.map((item, index) => {
      const food = data.get(item.food_id);
      if (!food) {
        throw AppError.validation('Unknown food_id.', { issues: [{ path: `items.${index}.food_id`, message: 'Food not found.' }] });
      }
      if (item.serving_id !== undefined) {
        if (!food.servings.some((s) => s.id === item.serving_id)) {
          throw AppError.validation('Invalid serving_id.', {
            issues: [{ path: `items.${index}.serving_id`, message: 'serving_id does not exist for this food.' }],
          });
        }
        return { food, quantity: item.quantity, amount: { serving_id: item.serving_id } };
      }
      return { food, quantity: item.quantity, amount: { unit: item.unit ?? '' } };
    });

    const result = calculateNutrition(inputs, vocabulary);
    return {
      calculation_version: NUTRITION_CALCULATION_VERSION,
      conversion_version: CONVERSION_VERSION,
      precision: { decimal_places: NUTRITION_DECIMAL_PLACES, rounding: ROUNDING_MODE },
      items: result.items.map(toItemDto),
      aggregate: toAggregateDto(result.aggregate, result.items.length),
    };
  }
}

function toItemDto(item: ItemCalculation) {
  const normalized =
    item.normalized.status === 'converted'
      ? {
          status: 'converted' as const,
          quantity: roundedNumber(item.normalized.value),
          unit: item.normalized.unit,
          authoritative: item.normalized.authoritative,
          steps: item.normalized.steps,
          provenance: item.normalized.provenance,
        }
      : item.normalized;
  return {
    index: item.index,
    food_id: item.food_id,
    canonical_name: item.canonical_name,
    input: item.input,
    normalized_quantity: normalized,
    resolved_nutrient_count: item.nutrients.filter((n) => n.status === 'resolved').length,
    nutrients: item.nutrients.map((n) => ({
      nutrient_id: n.nutrient.id,
      nutrient_key: n.nutrient.canonical_key,
      unit: n.unit,
      status: n.status,
      ...(n.value !== null ? roundValue(n.value) : { value: null, is_zero: false, below_output_precision: false }),
      source: n.selected
        ? {
            food_nutrient_id: n.selected.food_nutrient_id,
            source: n.selected.source,
            amount_per_basis: n.selected.amount_per_basis,
            basis_quantity: n.selected.basis_quantity,
            basis_unit: n.selected.basis_unit,
            quantity_in_basis_unit: roundedNumber(n.selected.quantity_in_basis_unit),
          }
        : null,
      candidates: n.status === 'ambiguous_nutrient_source' ? n.candidates : [],
      excluded: n.excluded,
      conversion_reason: n.conversion_reason,
    })),
  };
}

function toAggregateDto(aggregate: AggregateNutrient[], itemCount: number) {
  const coverageSummary: Record<Coverage, number> = { complete: 0, partial: 0, unavailable: 0 };
  for (const n of aggregate) coverageSummary[n.coverage] += 1;
  return {
    item_count: itemCount,
    coverage_summary: coverageSummary,
    nutrients: aggregate.map((n) => ({
      nutrient_id: n.nutrient.id,
      nutrient_key: n.nutrient.canonical_key,
      unit: n.nutrient.unit,
      coverage: n.coverage,
      ...(n.value !== null ? roundValue(n.value) : { value: null, is_zero: false, below_output_precision: false }),
      resolved_item_count: n.resolved_item_count,
      item_count: n.item_count,
      missing: n.missing,
    })),
  };
}
