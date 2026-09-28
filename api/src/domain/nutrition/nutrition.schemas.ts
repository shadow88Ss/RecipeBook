// Layer 5B — request contract for POST /v1/nutrition/calculate.
//
// The deterministic engine accepts only already-resolved input: a food_id
// plus a quantity in an exact registry unit code (e.g. g, ml, kg, cup_us)
// or a FoodServing of that food. Natural-language amounts ("a handful"),
// unit synonyms ("grams") and regionally ambiguous measures ("cup") are
// rejected as invalid input here — interpreting them belongs to a later
// input/AI layer, which must resolve them to one of these forms first.

import { z } from 'zod';
import { quantitySchema } from '../conversion/conversion.schemas';
import { UNITS } from '../conversion/units';

export const MAX_CALCULATION_ITEMS = 50;

const unitCodes = [...UNITS.keys()] as [string, ...string[]];

/** An exact Layer 5A registry unit code. Shared with Layer 6A recipe
 * ingredients so both accept exactly the same units. */
export const unitCodeSchema = z.enum(unitCodes, { message: `unit must be one of: ${unitCodes.join(', ')}.` });

export const calculationItemSchema = z
  .object({
    food_id: z.uuid(),
    quantity: quantitySchema,
    unit: unitCodeSchema.optional(),
    serving_id: z.uuid().optional(),
  })
  .refine((item) => (item.unit === undefined) !== (item.serving_id === undefined), {
    message: 'Provide exactly one of unit or serving_id.',
  });
export type CalculationItemRequest = z.infer<typeof calculationItemSchema>;

export const nutritionCalculateSchema = z.object({
  items: z.array(calculationItemSchema).min(1).max(MAX_CALCULATION_ITEMS),
});
export type NutritionCalculateRequest = z.infer<typeof nutritionCalculateSchema>;
