// Layer 12A §28 — barcode architecture only (the scanner UI is Layer 12B).
//
//   camera / manual entry  ->  raw scanned string  ->  API lookup
//
// The app never normalizes, validates check digits or guesses the barcode
// type: the raw string goes to the API, which applies the Layer 11A rules and
// the Layer 11D internal-first provider lookup. The app never calls a product
// provider (FatSecret, Open Food Facts, retailers) directly.

import { z } from 'zod';

import type { ApiClient } from '../api/client';

/** A source of scanned codes (camera scanner in 12B, or manual entry). */
export interface BarcodeSource {
  /** Resolves with the raw scanned text, or null if the user cancelled. */
  scan(): Promise<string | null>;
}

/** The fields 12B needs to decide what to show; the rest stays server-side. */
export const barcodeLookupSchema = z.object({
  source: z.string(),
  match: z.unknown(),
  product: z.unknown(),
  candidates: z.array(z.unknown()),
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
