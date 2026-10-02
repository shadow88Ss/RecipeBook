// Layer 12A §28 / 12B — barcode lookup.
//
//   camera / manual entry  ->  raw scanned string  ->  API lookup
//
// The app never normalizes, validates check digits or guesses the barcode
// type: the raw string goes to the API, which applies the Layer 11A rules and
// the Layer 11D internal-first provider lookup. The app never calls a product
// provider (FatSecret, Open Food Facts, retailers) directly.
//
// An external candidate is NOT a Product: it is unconfirmed provider data,
// never loggable (the API marks it `loggable: false`). There is no approved
// candidate -> Product confirmation workflow yet, so the app only shows it,
// with the provider's attribution, and offers no way to log it.

import { z } from 'zod';

import type { ApiClient } from '../api/client';
import { productDetailSchema } from '../api/contracts/catalog';

/** A source of scanned codes (camera scanner, or manual entry). */
export interface BarcodeSource {
  /** Resolves with the raw scanned text, or null if the user cancelled. */
  scan(): Promise<string | null>;
}

export const externalCandidateSchema = z.object({
  status: z.literal('unconfirmed_external_candidate'),
  loggable: z.literal(false),
  provider_key: z.string(),
  external_product_id: z.string(),
  brand_name: z.string().nullable(),
  product_name: z.string().nullable(),
  variant_name: z.string().nullable().optional(),
  barcode: z.object({ canonical_gtin: z.string() }).nullable(),
  provenance: z.object({
    provider_record_url: z.string().nullable(),
    attribution: z.object({ required: z.boolean(), text: z.string().nullable(), link: z.string().nullable(), licence: z.string().nullable() }),
  }),
  completeness: z.object({ nutrition: z.string() }),
});
export type ExternalCandidate = z.infer<typeof externalCandidateSchema>;

/** The fields the app needs to decide what to show; the rest stays server-side. */
export const barcodeLookupSchema = z.object({
  submitted: z.object({ canonical_gtin: z.string() }).partial().optional(),
  source: z.enum(['internal', 'external_candidate', 'none']),
  product: productDetailSchema.nullable(),
  candidates: z.array(externalCandidateSchema),
  external_lookup: z.object({ status: z.string() }).nullable().optional(),
  next_step: z.string().nullable().optional(),
});
export type BarcodeLookup = z.infer<typeof barcodeLookupSchema>;

export function lookupBarcode(api: ApiClient, rawCode: string, options: { type?: string; signal?: AbortSignal } = {}): Promise<BarcodeLookup> {
  return api.request(`/v1/products/barcode/${encodeURIComponent(rawCode)}/lookup`, {
    query: { type: options.type, mode: 'first' },
    schema: barcodeLookupSchema,
    signal: options.signal,
  });
}
