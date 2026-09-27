// Layer 5B — deterministic nutrient-source resolution (one Food + one
// Nutrient -> at most one authoritative FoodNutrient record).
//
// Policy, derived from what the current schema can actually distinguish:
//
// 1. Only `trusted_database` and `manufacturer_label` values can be
//    authoritative (Master §16).
// 2. `ai_matched` values are never authoritative (Layer 5A final alignment,
//    rule 8). They are excluded and reported, never used and never
//    averaged in.
// 3. `user_entered` values are excluded too: Master §16 allows explicit
//    user-entered label data only within a product/user-data workflow that
//    permits it, and no such workflow exists yet. They stay identifiable in
//    the exclusion list.
// 4. Exactly one authoritative candidate -> selected.
// 5. BOTH a trusted_database and a manufacturer_label value -> ambiguous.
//    The general principle (label wins for the exact branded product, the
//    database wins for a generic food) needs to know whether this Food row
//    is a generic food or an exact product. The schema cannot tell: Food is
//    "canonical food/product identity", Product/Barcode are not modeled yet,
//    and Food.source records the identity row's provenance, not its kind.
//    So the engine reports `ambiguous_nutrient_source` with both candidates
//    instead of picking one, even when the two amounts agree.
//
// Competing values are never summed and never averaged: the output is one
// record, or none.

import type { ReferenceSource } from '../conversion/conversion.engine';
import { authorityOf, type AuthorityClass } from '../authority/authority';

export const AUTHORITATIVE_NUTRIENT_SOURCES: readonly ReferenceSource[] = ['trusted_database', 'manufacturer_label'];

export interface FoodNutrientRecord {
  id: string;
  nutrient_id: string;
  amount: number;
  basis_quantity: number;
  basis_unit: string;
  source: ReferenceSource;
}

export interface ExcludedRecord {
  food_nutrient_id: string;
  source: ReferenceSource;
  authority: AuthorityClass;
  reason: 'ai_matched_not_authoritative' | 'user_entered_not_permitted';
}

export type SourceResolution =
  | { status: 'selected'; record: FoodNutrientRecord; excluded: ExcludedRecord[] }
  | { status: 'no_data'; excluded: [] }
  | { status: 'not_authoritative'; excluded: ExcludedRecord[] }
  | { status: 'ambiguous_nutrient_source'; candidates: FoodNutrientRecord[]; excluded: ExcludedRecord[] };

export function resolveNutrientSource(records: readonly FoodNutrientRecord[]): SourceResolution {
  if (records.length === 0) return { status: 'no_data', excluded: [] };

  const ordered = [...records].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.id < b.id ? -1 : 1));
  const excluded: ExcludedRecord[] = [];
  const candidates: FoodNutrientRecord[] = [];
  for (const record of ordered) {
    if (AUTHORITATIVE_NUTRIENT_SOURCES.includes(record.source)) {
      candidates.push(record);
    } else {
      excluded.push({
        food_nutrient_id: record.id,
        source: record.source,
        authority: authorityOf(record.source),
        reason: record.source === 'ai_matched' ? 'ai_matched_not_authoritative' : 'user_entered_not_permitted',
      });
    }
  }

  const [only, ...rest] = candidates;
  if (!only) return { status: 'not_authoritative', excluded };
  if (rest.length === 0) return { status: 'selected', record: only, excluded };
  return { status: 'ambiguous_nutrient_source', candidates, excluded };
}
