// Layer 5A — Food / FoodAlias / FoodServing / Nutrient / FoodNutrient
// request and response contracts (30_API.md §5). Every endpoint here is
// read-only: food reference data is written only by a trusted
// data-ingestion workflow (33_Security_and_Privacy.md §6), never by an API
// client.

import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination';
import { canonicalizeLocale, canonicalizeRegion, DEFAULT_LOCALE, normalizeSearchTerm } from './locale';

const foodDataSourceSchema = z.enum(['trusted_database', 'manufacturer_label', 'user_entered', 'ai_matched']);
const aliasServingSourceSchema = z.enum(['trusted_database', 'user_entered', 'ai_matched']);

export const localeQuerySchema = z
  .string()
  .max(35)
  .transform((value, ctx) => {
    const canonical = canonicalizeLocale(value);
    if (!canonical) {
      ctx.addIssue({ code: 'custom', message: 'locale must be a BCP 47 tag of the form language[-Script][-REGION].' });
      return z.NEVER;
    }
    return canonical;
  });

export const regionQuerySchema = z.string().max(3).transform((value, ctx) => {
  const canonical = canonicalizeRegion(value);
  if (!canonical) {
    ctx.addIssue({ code: 'custom', message: 'region must be a 2-letter ISO 3166 or 3-digit UN M.49 code.' });
    return z.NEVER;
  }
  return canonical;
});

export const foodIdParamSchema = z.object({
  food_id: z.uuid({ message: 'food_id must be a valid UUID.' }),
});

export const foodSearchQuerySchema = paginationQuerySchema.extend({
  q: z
    .string()
    .max(100)
    .transform((value) => normalizeSearchTerm(value))
    .refine((value) => value.length > 0, 'q must contain at least one non-whitespace character.'),
  locale: localeQuerySchema.default(DEFAULT_LOCALE),
});
export type FoodSearchQuery = z.infer<typeof foodSearchQuerySchema>;

export const foodDetailQuerySchema = z.object({
  locale: localeQuerySchema.default(DEFAULT_LOCALE),
  region: regionQuerySchema.optional(),
});
export type FoodDetailQuery = z.infer<typeof foodDetailQuerySchema>;

export const foodSearchResultSchema = z.object({
  id: z.uuid(),
  canonical_name: z.string(),
  category: z.string().nullable(),
  source: foodDataSourceSchema,
  display_name: z.string(),
  display_locale: z.string().nullable(),
  match: z.object({
    alias_text: z.string(),
    locale: z.string(),
    kind: z.enum(['exact', 'prefix', 'contains']),
  }),
});
export type FoodSearchResult = z.infer<typeof foodSearchResultSchema>;

export const foodAliasDtoSchema = z.object({
  id: z.uuid(),
  locale: z.string(),
  alias_text: z.string(),
  is_primary: z.boolean(),
  source: aliasServingSourceSchema,
});
export type FoodAliasDto = z.infer<typeof foodAliasDtoSchema>;

export const foodServingDtoSchema = z.object({
  id: z.uuid(),
  serving_description: z.string(),
  region: z.string().nullable(),
  canonical_quantity: z.number(),
  canonical_unit: z.enum(['g', 'ml']),
  source: aliasServingSourceSchema,
});
export type FoodServingDto = z.infer<typeof foodServingDtoSchema>;

export const nutrientDtoSchema = z.object({
  id: z.uuid(),
  canonical_key: z.string(),
  unit: z.string(),
});
export type NutrientDto = z.infer<typeof nutrientDtoSchema>;

export const foodNutrientDtoSchema = z.object({
  id: z.uuid(),
  nutrient_id: z.uuid(),
  nutrient_key: z.string(),
  nutrient_unit: z.string(),
  amount: z.number(),
  basis_quantity: z.number(),
  basis_unit: z.enum(['g', 'ml']),
  source: foodDataSourceSchema,
});
export type FoodNutrientDto = z.infer<typeof foodNutrientDtoSchema>;

export const foodDetailDtoSchema = z.object({
  id: z.uuid(),
  canonical_name: z.string(),
  category: z.string().nullable(),
  source: foodDataSourceSchema,
  display_name: z.string(),
  display_locale: z.string().nullable(),
  locale: z.string(),
  region: z.string().nullable(),
  density: z.object({ g_per_ml: z.number(), source: foodDataSourceSchema }).nullable(),
  aliases: z.array(foodAliasDtoSchema),
  servings: z.array(foodServingDtoSchema),
  nutrients: z.array(foodNutrientDtoSchema),
});
export type FoodDetailDto = z.infer<typeof foodDetailDtoSchema>;
