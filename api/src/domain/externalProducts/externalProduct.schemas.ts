// Layer 11D — consumer request contracts for external product candidates.

import { z } from 'zod';
import { normalizeSearchTerm } from '../foods/locale';
import { BARCODE_TYPES } from '../products/barcode';
import { providerKeySchema } from '../integrations/integration.schemas';

/** 'first' stops at the highest-priority provider with an answer; 'all'
 * asks every routed provider (sequentially) and returns provider-distinct,
 * unmerged candidates with their disagreements. */
export const lookupModeSchema = z.enum(['first', 'all']).default('first');

export const externalSearchQuerySchema = z.object({
  q: z
    .string()
    .max(200)
    .transform((v) => normalizeSearchTerm(v))
    .refine((v) => v.length >= 2, 'q must have at least 2 characters.'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  mode: lookupModeSchema,
});
export type ExternalSearchQuery = z.infer<typeof externalSearchQuerySchema>;

export const externalCandidateParamSchema = z.object({
  provider_key: providerKeySchema,
  external_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'external_id must be a provider identifier.'),
});

export const barcodeLookupQuerySchema = z.object({
  type: z.enum(BARCODE_TYPES).optional(),
  mode: lookupModeSchema,
});
export type BarcodeLookupQuery = z.infer<typeof barcodeLookupQuerySchema>;
