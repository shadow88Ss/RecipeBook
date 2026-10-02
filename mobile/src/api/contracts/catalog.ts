// Layer 12B — Food, Product, nutrition-preview, unit and meal-logging DTOs,
// written from docs/30_API.md (no backend runtime code is imported). Only the
// fields the app renders are validated; unknown fields are dropped, so
// additive API changes never break the app. Every nutrition value comes from
// the server (Layer 5B engine); the app never calculates one.

import { z } from 'zod';

import { pageSchema } from './common';
import { nutritionSummarySchema } from './dailyTracker';

/** docs/30_API.md §7 — the meal type enum of POST /v1/profiles/{id}/meals. */
export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'other'] as const;
export type MealType = (typeof MEAL_TYPES)[number];

// ---- Food (generic reference data, Layer 5A) -------------------------------

export const foodSearchResultSchema = z.object({
  id: z.string(),
  canonical_name: z.string(),
  category: z.string().nullable(),
  display_name: z.string().nullable(),
  match: z.object({ identity_confirmation_required: z.boolean() }),
});
export type FoodSearchResult = z.infer<typeof foodSearchResultSchema>;
export const foodSearchPageSchema = pageSchema(foodSearchResultSchema);
export type FoodSearchPage = z.infer<typeof foodSearchPageSchema>;

export const servingSchema = z.object({
  id: z.string(),
  serving_description: z.string(),
  canonical_quantity: z.number(),
  canonical_unit: z.enum(['g', 'ml']),
});
export type Serving = z.infer<typeof servingSchema>;

export const foodDetailSchema = z.object({
  id: z.string(),
  canonical_name: z.string(),
  category: z.string().nullable(),
  display_name: z.string().nullable(),
  servings: z.array(servingSchema),
});
export type FoodDetail = z.infer<typeof foodDetailSchema>;

// ---- Product (exact commercial product, Layer 11A) -------------------------

const productSummaryFields = {
  id: z.string(),
  brand_name: z.string(),
  product_name: z.string(),
  variant_name: z.string().nullable(),
  display_name: z.string(),
  market: z.string().nullable(),
  package: z.object({ quantity: z.number(), unit: z.string().nullable() }).nullable(),
  status: z.string(),
};

export const productSearchResultSchema = z.object({ ...productSummaryFields, active_barcodes: z.array(z.string()) });
export type ProductSearchResult = z.infer<typeof productSearchResultSchema>;
export const productSearchPageSchema = pageSchema(productSearchResultSchema);
export type ProductSearchPage = z.infer<typeof productSearchPageSchema>;

export const productDetailSchema = z.object({
  ...productSummaryFields,
  current_label: z
    .object({
      id: z.string(),
      nutrition_source: z.string(),
      servings: z.array(servingSchema),
    })
    .nullable(),
});
export type ProductDetail = z.infer<typeof productDetailSchema>;

// ---- Nutrition preview (server-calculated, nothing persisted) --------------

/** POST /v1/nutrition/calculate — one Food item. */
export const foodPreviewSchema = z.object({
  items: z.array(z.object({ normalized_quantity: z.object({ status: z.string() }) })),
  summary: nutritionSummarySchema,
});
export type FoodPreview = z.infer<typeof foodPreviewSchema>;

/** POST /v1/products/{id}/nutrition/calculate */
export const PRODUCT_LABEL_STATUSES = ['authoritative_label', 'non_authoritative_label', 'no_label_version'] as const;
export const productPreviewSchema = z.object({
  label_status: z.enum(PRODUCT_LABEL_STATUSES),
  normalized_quantity: z.object({ status: z.string() }),
  summary: nutritionSummarySchema,
});
export type ProductPreview = z.infer<typeof productPreviewSchema>;

// ---- Units (the server's registry codes) -----------------------------------

export const unitListSchema = z.object({
  data: z.array(z.object({ code: z.string(), dimension: z.enum(['mass', 'volume']), label: z.string() })),
});
export type UnitList = z.infer<typeof unitListSchema>;

// ---- Meal logging (Layer 7A / 11B) -----------------------------------------

/** Exactly one of unit / serving; the server rejects anything else. */
export type ItemAmount = { kind: 'unit'; quantity: number; unit: string } | { kind: 'serving'; quantity: number; servingId: string };

export type MealItemInput =
  | { type: 'food'; food_id: string; quantity: number; unit?: string; serving_id?: string }
  | { type: 'product'; product_id?: string; barcode?: string; quantity: number; unit?: string; product_serving_id?: string };

export const mealCreatedSchema = z.object({
  id: z.string(),
  meal_type: z.string(),
  logged_date: z.string(),
  active_item_count: z.number(),
});
export type MealCreated = z.infer<typeof mealCreatedSchema>;
