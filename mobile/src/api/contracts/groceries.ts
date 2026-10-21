// Layer 12C — Grocery DTOs, written from docs/30_API.md §23–24 (no backend
// runtime code is imported). Only the fields the app renders are validated;
// unknown fields are dropped. Every quantity is the server's (exact rationals
// rounded at output, base units g / ml / count); the app never adds,
// subtracts or converts one.

import { z } from 'zod';

import { pageSchema } from './common';

/** GET /v1/profiles/{id}/grocery-lists — one generation of a plan's list. */
export const groceryListSummarySchema = z.object({
  id: z.string(),
  meal_plan_id: z.string(),
  generation_number: z.number(),
  /** active | superseded (a newer generation replaced it). */
  status: z.string(),
  generated_at: z.string(),
  plan_context: z.object({ start_date: z.string(), end_date: z.string() }),
});
export type GroceryListSummary = z.infer<typeof groceryListSummarySchema>;
export const groceryListPageSchema = pageSchema(groceryListSummarySchema);
export type GroceryListPage = z.infer<typeof groceryListPageSchema>;

const amountSchema = z.object({ quantity: z.number(), unit: z.string() });
export type ShoppingAmount = z.infer<typeof amountSchema>;

const purchaseRecordSchema = z.object({ id: z.string(), recorded_at: z.string(), revoked_at: z.string().nullable() });

const progressFields = {
  shopping_target: amountSchema.nullable(),
  purchased: z.object({ quantity: z.number().nullable(), unit: z.string().nullable(), checked_off: z.boolean() }),
  remaining_to_purchase: amountSchema.nullable(),
  over_purchased: amountSchema.nullable(),
  /** need_to_buy | partially_purchased | purchased | already_have_sufficient | no_purchase_needed | comparison_unresolved */
  status: z.string(),
  /** quantity: a purchase needs quantity + unit; check_off: a purchase is a plain check-off. */
  purchase_mode: z.enum(['quantity', 'check_off']),
};

export const shoppingItemSchema = z.object({
  grocery_list_item_id: z.string(),
  display_name: z.string(),
  generation_resolution_status: z.string(),
  generation_unresolved_reason: z.string().nullable(),
  generated_quantity: amountSchema.extend({ quantity_exact: z.string().nullable().optional() }).nullable(),
  already_have: z.object({ input: z.object({ quantity: z.number(), unit: z.string() }) }).nullable(),
  ...progressFields,
  history: z.object({ purchases: z.array(purchaseRecordSchema) }),
});
export type ShoppingItem = z.infer<typeof shoppingItemSchema>;

export const manualShoppingItemSchema = z.object({
  grocery_manual_item_id: z.string(),
  name: z.string(),
  notes: z.string().nullable(),
  ...progressFields,
  purchases: z.array(purchaseRecordSchema),
});
export type ManualShoppingItem = z.infer<typeof manualShoppingItemSchema>;

/** GET /v1/profiles/{id}/grocery-lists/{list}/shopping, and the body of every shopping write. */
export const shoppingViewSchema = z.object({
  grocery_list: z.object({
    id: z.string(),
    generation_number: z.number(),
    status: z.string(),
    is_current_generation: z.boolean(),
    is_stale: z.boolean(),
    generated_at: z.string(),
    plan_context: z.object({ start_date: z.string(), end_date: z.string() }),
  }),
  /** The server's answer to "can state be recorded on this generation now". */
  state_writable: z.boolean(),
  items: z.array(shoppingItemSchema),
  manual_items: z.array(manualShoppingItemSchema),
});
export type ShoppingView = z.infer<typeof shoppingViewSchema>;

// ---- Layer 12F — a plan's grocery preview and list generation ---------------

/** One derived requirement; quantity/unit are null when the server could not resolve them. */
export const groceryRequirementSchema = z.object({
  display_name: z.string(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  resolution_status: z.string(),
  unresolved_reason: z.string().nullable(),
});
export type GroceryRequirement = z.infer<typeof groceryRequirementSchema>;

/**
 * GET …/meal-plans/{plan}/grocery-preview — nothing is stored. A draft plan
 * previews its unconfirmed intent; an active plan previews exactly what a new
 * generation would store, and names its current list.
 */
export const groceryPreviewSchema = z.object({
  preview_type: z.string(),
  includes_unconfirmed: z.boolean(),
  current_grocery_list: z.object({ id: z.string(), generation_number: z.number(), is_stale: z.boolean() }).nullable(),
  excluded_unconfirmed_sources: z.array(z.unknown()),
  items: z.array(groceryRequirementSchema),
});
export type GroceryPreview = z.infer<typeof groceryPreviewSchema>;

/** POST …/grocery-lists answers with the new generation; the app opens it by id. */
export const groceryListCreatedSchema = z.object({ id: z.string(), generation_number: z.number() });
