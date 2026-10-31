// Layer 13A — finding recipes by the import they came from.

import type { ScopedDbClient } from '../../lib/scopedDb';

/** The newest recipe of this Profile whose versions name `value` in the
 * given origin column. RLS limits the versions to readable recipes; the
 * Profile filter limits them to this Profile's own. */
export async function recipeFromOrigin(
  db: ScopedDbClient,
  profileId: string,
  column: 'origin_import_job_id' | 'origin_url_source_id',
  value: string,
): Promise<string | null> {
  const versions = await db.select<{ recipe_id: string }>('recipe_version', { columns: 'recipe_id', eq: { [column]: value }, limit: 100 });
  const ids = [...new Set(versions.map((v) => v.recipe_id))];
  if (ids.length === 0) return null;
  const recipes = await db.select<{ id: string; updated_at: string }>('recipe', {
    columns: 'id, updated_at',
    eq: { created_by_profile_id: profileId },
    in: { id: ids },
    order: { column: 'updated_at', ascending: false },
    limit: 1,
  });
  return recipes[0]?.id ?? null;
}
