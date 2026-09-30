// Layer 11A — Product & Barcode request contracts. Read-only reference data
// plus a deterministic nutrition calculation; no client write path exists
// (products, labels and barcodes are written only by trusted ingestion).

import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination';
import { quantitySchema } from '../conversion/conversion.schemas';
import { normalizeSearchTerm } from '../foods/locale';
import { unitCodeSchema } from '../nutrition/nutrition.schemas';
import { BARCODE_TYPES } from './barcode';

export const productIdParamSchema = z.object({ product_id: z.uuid({ message: 'product_id must be a valid UUID.' }) });

export const productSearchQuerySchema = paginationQuerySchema.extend({
  q: z
    .string()
    .max(200)
    .transform((v) => normalizeSearchTerm(v))
    .refine((v) => v.length > 0, 'q must not be blank.')
    .optional(),
  market: z.string().regex(/^[A-Za-z]{2}$/, 'market must be an ISO 3166-1 alpha-2 code.').transform((v) => v.toUpperCase()).optional(),
  status: z.enum(['active', 'discontinued']).optional(),
});
export type ProductSearchQuery = z.infer<typeof productSearchQuerySchema>;

export const barcodeParamSchema = z.object({ code: z.string().min(1).max(64) });
export const barcodeQuerySchema = z.object({ type: z.enum(BARCODE_TYPES).optional() });

export const productNutritionCalculateSchema = z
  .object({
    quantity: quantitySchema,
    unit: unitCodeSchema.optional(),
    product_serving_id: z.uuid().optional(),
    /** Defaults to the Product's current label version. */
    label_version_id: z.uuid().optional(),
  })
  .refine((b) => (b.unit === undefined) !== (b.product_serving_id === undefined), { message: 'Provide exactly one of unit or product_serving_id.' });
export type ProductNutritionCalculateRequest = z.infer<typeof productNutritionCalculateSchema>;
