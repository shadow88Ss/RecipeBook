// Layer 5C — the platform data-authority model. Every reference value's
// `source` maps to exactly one authority class, and every downstream
// service reads this class instead of re-interpreting raw source strings.
//
//   global_reference              trusted_database — approved trusted
//                                 nutrition-database values; authoritative
//                                 for everyone.
//   exact_product                 manufacturer_label — authoritative for the
//                                 exact represented product. Until a
//                                 Product/Barcode model exists, a label value
//                                 that competes with a database value is
//                                 ambiguous (Layer 5B).
//   personal_user_confirmed       user_entered — user-confirmed personal
//                                 data. Usable only for that user's own
//                                 resolved food/meal inside an approved
//                                 personal/product workflow; never global
//                                 reference data, never authoritative for
//                                 other users. The global food tables
//                                 reject user-entered servings and density
//                                 (20260929120000).
//   non_authoritative_inference   ai_matched — AI match/estimate. May
//                                 suggest; never authoritative, and user
//                                 confirmation never promotes it into
//                                 global reference data.

import type { ReferenceSource } from '../conversion/conversion.engine';

export const AUTHORITY_CLASSES = ['global_reference', 'exact_product', 'personal_user_confirmed', 'non_authoritative_inference'] as const;
export type AuthorityClass = (typeof AUTHORITY_CLASSES)[number];

const BY_SOURCE: Record<ReferenceSource, AuthorityClass> = {
  trusted_database: 'global_reference',
  manufacturer_label: 'exact_product',
  user_entered: 'personal_user_confirmed',
  ai_matched: 'non_authoritative_inference',
};

export function authorityOf(source: ReferenceSource): AuthorityClass {
  return BY_SOURCE[source];
}

/** Whether a value read from the GLOBAL reference tables may be used as
 * authoritative reference data for any user. Personal data and inferences
 * never qualify, wherever they are found. */
export function isGlobalReferenceAuthority(source: ReferenceSource): boolean {
  const cls = authorityOf(source);
  return cls === 'global_reference' || cls === 'exact_product';
}
