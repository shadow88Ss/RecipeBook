// Layer 6A — RecipePersonalizedVariant, READ ONLY.
//
// A variant references its base Recipe and base RecipeVersion, belongs to one
// Profile, and never overwrites the base (Master §11.3; Data Model §6).
// Creation/editing is deferred: `adjustments_payload` is specified only as
// "structured substitutions/portion/ingredient changes" (Data Dictionary
// §23) with no approved structure, so the API cannot validate or apply one
// without inventing it. Variant nutrition is deferred for the same reason.
//
// Scopes transcribed from 20260825121500_rls_recipes.sql
// (recipe_personalized_variant_select_authorized: full_management,
// view_only) and 20260825121900_rls_pediatric_weight_management.sql
// (recipe_personalized_variant_select_pediatric).

import { requireProfileScope } from '../../lib/authorize';
import { AppError } from '../../lib/errors';
import { IN_MEMORY_PAGE_FETCH_CAP, paginateInMemory, type PaginationQuery } from '../../lib/pagination';
import type { ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import { RECIPE_VARIANT_COLUMNS, toRecipeVariantDto, type RecipeVariantRow } from './recipe.dto';
import type { RecipeVariantListQuery } from './recipe.schemas';

const READ_SCOPES = ['full_management', 'view_only', 'pediatric_weight_management'] as const;

export class RecipeVariantService {
  constructor(private readonly dbFactory: ScopedDbFactory) {}

  async list(auth: AuthContext, profileId: string, query: RecipeVariantListQuery) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, READ_SCOPES);
    const rows = await db.select<RecipeVariantRow>('recipe_personalized_variant', {
      columns: RECIPE_VARIANT_COLUMNS,
      eq: { profile_id: profileId, ...(query.base_recipe_id ? { base_recipe_id: query.base_recipe_id } : {}) },
      order: { column: 'created_at', ascending: false },
      limit: IN_MEMORY_PAGE_FETCH_CAP,
    });
    return paginateInMemory(rows.map(toRecipeVariantDto), query as PaginationQuery);
  }

  async get(auth: AuthContext, profileId: string, variantId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, READ_SCOPES);
    const rows = await db.select<RecipeVariantRow>('recipe_personalized_variant', {
      columns: RECIPE_VARIANT_COLUMNS,
      eq: { id: variantId, profile_id: profileId },
      limit: 1,
    });
    const row = rows[0];
    if (!row) throw AppError.notFound('Recipe variant not found.');
    return toRecipeVariantDto(row);
  }
}
