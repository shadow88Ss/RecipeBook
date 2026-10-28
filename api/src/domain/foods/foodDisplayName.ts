// Layer 12F correction — the human-readable name of a Food, for read models
// that name foods (meal plan items, logged meal items, grocery items).
//
// A Food's display name comes only from FoodAlias, ranked exactly as
// GET /v1/foods/{id} ranks it; `canonical_name` is an internal key (for USDA
// foods `usda-fdc:<fdcId>`) and is never used as a display label. Read only,
// through the caller's RLS-scoped client: FoodAlias is global reference data
// every authenticated Account may read (20260825121200_rls_food_reference_data.sql).
// Nothing stored is changed; a Food without an alias has no display name (null).

import type { ScopedDbClient } from '../../lib/scopedDb';
import { DEFAULT_LOCALE, localeFallbackChain, localeRank } from './locale';

export interface AliasForRanking {
  id: string;
  locale: string;
  alias_text: string;
  is_primary: boolean;
  source: string;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The Food API's alias order: caller's locale chain, not AI-matched, primary, text, id. */
export function compareAliases(chain: readonly string[]) {
  return (a: AliasForRanking, b: AliasForRanking): number =>
    localeRank(a.locale, chain) - localeRank(b.locale, chain) ||
    Number(a.source === 'ai_matched') - Number(b.source === 'ai_matched') ||
    Number(b.is_primary) - Number(a.is_primary) ||
    compareText(a.alias_text, b.alias_text) ||
    compareText(a.id, b.id);
}

export type FoodDisplayNames = ReadonlyMap<string, string | null>;

/** Each Food's best alias text (null when it has none), in one query. */
export async function loadFoodDisplayNames(db: ScopedDbClient, foodIds: Iterable<string | null | undefined>, locale: string = DEFAULT_LOCALE): Promise<FoodDisplayNames> {
  const ids = [...new Set([...foodIds].filter((id): id is string => !!id))];
  if (!ids.length) return new Map();
  const aliases = await db.select<AliasForRanking & { food_id: string }>('food_alias', { columns: 'id, food_id, locale, alias_text, is_primary, source', in: { food_id: ids } });
  const order = compareAliases(localeFallbackChain(locale));
  const names = new Map<string, string | null>(ids.map((id) => [id, null]));
  for (const id of ids) {
    const best = aliases.filter((a) => a.food_id === id).sort(order)[0];
    if (best) names.set(id, best.alias_text);
  }
  return names;
}

/** The display name for a Food reference in a DTO; null when unknown or not loaded. */
export const displayNameOf = (names: FoodDisplayNames | undefined, foodId: string): string | null => names?.get(foodId) ?? null;
