// Layer 12A — the /v1 endpoints the alpha app calls. Nothing here computes
// nutrition or authorization; the profile id is a path parameter and the
// server decides whether the caller may use it.

import type { ApiClient } from './client';
import {
  foodDetailSchema,
  foodPreviewSchema,
  foodSearchPageSchema,
  mealCreatedSchema,
  productDetailSchema,
  productPreviewSchema,
  productSearchPageSchema,
  unitListSchema,
  type FoodDetail,
  type FoodSearchPage,
  type FoodPreview,
  type ItemAmount,
  type MealCreated,
  type MealItemInput,
  type MealType,
  type ProductDetail,
  type ProductPreview,
  type ProductSearchPage,
  type UnitList,
} from './contracts/catalog';
import { dailyTrackerSchema, type DailyTracker } from './contracts/dailyTracker';
import { profilePageSchema, type Profile, type ProfilePage } from './contracts/profile';
import { progressSchema, type Progress } from './contracts/progress';

/** Upper bound on profile pages followed; a household has far fewer. */
export const MAX_PROFILE_PAGES = 10;

export async function listAllProfiles(api: ApiClient, signal?: AbortSignal): Promise<Profile[]> {
  const out: Profile[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PROFILE_PAGES; page++) {
    const res: ProfilePage = await api.request('/v1/profiles', { query: { limit: 100, cursor }, schema: profilePageSchema, signal });
    out.push(...res.data);
    cursor = res.pagination.nextCursor;
    if (!cursor) break;
  }
  return out;
}

export function getDailyTracker(api: ApiClient, profileId: string, date: string, timezone: string, signal?: AbortSignal): Promise<DailyTracker> {
  return api.request(`/v1/profiles/${encodeURIComponent(profileId)}/daily-tracker`, { query: { date, timezone }, schema: dailyTrackerSchema, signal });
}

// ---- Layer 12B — search, server nutrition preview and meal logging ----------

export const SEARCH_PAGE_SIZE = 20;

export function searchFoods(api: ApiClient, q: string, signal?: AbortSignal): Promise<FoodSearchPage> {
  return api.request('/v1/foods', { query: { q, limit: SEARCH_PAGE_SIZE }, schema: foodSearchPageSchema, signal });
}

export function getFood(api: ApiClient, foodId: string, signal?: AbortSignal): Promise<FoodDetail> {
  return api.request(`/v1/foods/${encodeURIComponent(foodId)}`, { schema: foodDetailSchema, signal });
}

export function searchProducts(api: ApiClient, q: string, signal?: AbortSignal): Promise<ProductSearchPage> {
  return api.request('/v1/products', { query: { q, limit: SEARCH_PAGE_SIZE }, schema: productSearchPageSchema, signal });
}

export function getProduct(api: ApiClient, productId: string, signal?: AbortSignal): Promise<ProductDetail> {
  return api.request(`/v1/products/${encodeURIComponent(productId)}`, { schema: productDetailSchema, signal });
}

export function listUnits(api: ApiClient, signal?: AbortSignal): Promise<UnitList> {
  return api.request('/v1/units', { schema: unitListSchema, signal });
}

const amountFields = (amount: ItemAmount, servingKey: 'serving_id' | 'product_serving_id') =>
  amount.kind === 'unit' ? { quantity: amount.quantity, unit: amount.unit } : { quantity: amount.quantity, [servingKey]: amount.servingId };

/** Server-side calculation for one Food amount; nothing is stored. */
export function previewFoodNutrition(api: ApiClient, foodId: string, amount: ItemAmount, signal?: AbortSignal): Promise<FoodPreview> {
  return api.request('/v1/nutrition/calculate', {
    method: 'POST',
    body: { items: [{ food_id: foodId, ...amountFields(amount, 'serving_id') }] },
    schema: foodPreviewSchema,
    signal,
  });
}

/** Server-side calculation for one Product amount (current label); nothing is stored. */
export function previewProductNutrition(api: ApiClient, productId: string, amount: ItemAmount, signal?: AbortSignal): Promise<ProductPreview> {
  return api.request(`/v1/products/${encodeURIComponent(productId)}/nutrition/calculate`, {
    method: 'POST',
    body: amountFields(amount, 'product_serving_id'),
    schema: productPreviewSchema,
    signal,
  });
}

export function foodItem(foodId: string, amount: ItemAmount): MealItemInput {
  return { type: 'food', food_id: foodId, ...amountFields(amount, 'serving_id') };
}

/** By barcode when the Product was found by scanning, so the server records it. */
export function productItem(ref: { productId: string; barcode?: string | null }, amount: ItemAmount): MealItemInput {
  return { type: 'product', ...(ref.barcode ? { barcode: ref.barcode } : { product_id: ref.productId }), ...amountFields(amount, 'product_serving_id') };
}

/** POST /v1/profiles/{id}/meals — the server computes and stores each item's nutrition snapshot. */
export function logMeal(
  api: ApiClient,
  profileId: string,
  meal: { mealType: MealType; loggedDate: string; timeZone: string; consumedAt: string; items: MealItemInput[] },
): Promise<MealCreated> {
  return api.request(`/v1/profiles/${encodeURIComponent(profileId)}/meals`, {
    method: 'POST',
    // consumed_at: when it was eaten (the server selects a Product's label by it); loggedDate is its local day.
    body: { meal_type: meal.mealType, logged_date: meal.loggedDate, local_timezone: meal.timeZone, consumed_at: meal.consumedAt, items: meal.items },
    schema: mealCreatedSchema,
  });
}

export function getProgress(api: ApiClient, profileId: string, range: { from: string; to: string; timezone: string }, signal?: AbortSignal): Promise<Progress> {
  return api.request(`/v1/profiles/${encodeURIComponent(profileId)}/progress`, { query: range, schema: progressSchema, signal });
}
