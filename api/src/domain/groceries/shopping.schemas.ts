// Layer 9B — shopping-state request contracts. Clients submit USER facts
// only (already-have, intended shopping quantity, purchases, manual items).
// Generated quantities, sources, fingerprints, versions and plan provenance
// are never accepted; undeclared fields are stripped (validate.ts).

import { z } from 'zod';
import { unitCodeSchema } from '../nutrition/nutrition.schemas';
import { groceryListParamSchema } from './grocery.schemas';

export const MAX_SHOPPING_QUANTITY = 1_000_000;

/** An exact Layer 5A unit code (ambiguous household units are not codes),
 * or `count`. */
export const shoppingUnitSchema = z.union([unitCodeSchema, z.literal('count')]);
const noteSchema = z
  .string()
  .trim()
  .max(500)
  .transform((v) => (v.length ? v : null));

/** Already-have / shopping quantity: zero allowed ("none" / "buy none"). */
export const userQuantitySchema = z.object({
  quantity: z.number().finite().min(0).max(MAX_SHOPPING_QUANTITY),
  unit: shoppingUnitSchema,
  note: noteSchema.nullable().optional(),
});
export type UserQuantityInput = z.infer<typeof userQuantitySchema>;

/** A purchase with a quantity, or a plain check-off (no quantity). */
export const purchaseSchema = z
  .object({
    quantity: z.number().finite().positive().max(MAX_SHOPPING_QUANTITY).optional(),
    unit: shoppingUnitSchema.optional(),
    note: noteSchema.nullable().optional(),
  })
  .refine((v) => (v.quantity === undefined) === (v.unit === undefined), { message: 'Provide both quantity and unit, or neither (a check-off).', path: ['unit'] });
export type PurchaseInput = z.infer<typeof purchaseSchema>;

export const manualItemSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    quantity: z.number().finite().positive().max(MAX_SHOPPING_QUANTITY).optional(),
    unit: shoppingUnitSchema.optional(),
    food_id: z.uuid().optional(),
    notes: z
      .string()
      .trim()
      .max(1000)
      .transform((v) => (v.length ? v : null))
      .nullable()
      .optional(),
  })
  .refine((v) => (v.quantity === undefined) === (v.unit === undefined), { message: 'Provide both quantity and unit, or neither.', path: ['unit'] });
export type ManualItemInput = z.infer<typeof manualItemSchema>;

export const shoppingItemParamSchema = groceryListParamSchema.extend({ grocery_list_item_id: z.uuid() });
export const manualItemParamSchema = groceryListParamSchema.extend({ grocery_manual_item_id: z.uuid() });
export const purchaseParamSchema = groceryListParamSchema.extend({ grocery_purchase_id: z.uuid() });
