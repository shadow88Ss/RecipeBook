// Layer 12F — which name to show for a Food in plan and grocery lines.
//
// The server sends a Food's display name (its alias) next to the stored or
// canonical name. A canonical name can be an internal key such as
// `usda-fdc:169228`: it is provenance, never a label, and no name is derived
// from it. Without a display name, a readable stored name is shown, and an
// internal key falls back to the caller's generic word.

/** `source:id` keys, as the USDA ingestion writes them (`usda-fdc:<fdcId>`). */
const INTERNAL_KEY = /^[a-z][a-z0-9-]*:[^\s]+$/;

export function isInternalFoodKey(name: string): boolean {
  return INTERNAL_KEY.test(name);
}

export function readableFoodName(displayName: string | null | undefined, stored: string | null | undefined, generic: string): string {
  if (displayName) return displayName;
  if (stored && !isInternalFoodKey(stored)) return stored;
  return generic;
}
