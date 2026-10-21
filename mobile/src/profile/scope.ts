import { KNOWN_ACCESS_SCOPES } from '../api/contracts/profile';
import { t } from '../i18n';

/** Display label for the access_scope the API returned. Display only — never a permission check. */
export function scopeLabel(scope: string): string {
  return (KNOWN_ACCESS_SCOPES as readonly string[]).includes(scope) ? t(`scope.${scope as (typeof KNOWN_ACCESS_SCOPES)[number]}`) : t('scope.unknown', { scope });
}

/**
 * Scopes the API documents as allowed to log meals (docs/30_API.md §7:
 * full_management, pediatric_weight_management; view_only is read-only).
 * Hides write UI only — the server still decides every request, and an
 * unknown scope gets no write UI.
 */
const MEAL_LOGGING_SCOPES: readonly string[] = ['full_management', 'pediatric_weight_management'];

export function canLogMeals(scope: string): boolean {
  return MEAL_LOGGING_SCOPES.includes(scope);
}

/**
 * Scopes the API documents as allowed to record grocery shopping state
 * (docs/30_API.md §24: full_management, pediatric_weight_management; view_only
 * is read-only). Hides write UI only — the server still decides.
 */
const SHOPPING_WRITE_SCOPES: readonly string[] = ['full_management', 'pediatric_weight_management'];

export function canRecordShopping(scope: string): boolean {
  return SHOPPING_WRITE_SCOPES.includes(scope);
}

/**
 * Scopes the API documents as allowed to create and edit recipes
 * (docs/30_API.md §17: full_management only; view_only and
 * pediatric_weight_management read). Hides write UI only — the server decides.
 */
const RECIPE_WRITE_SCOPES: readonly string[] = ['full_management'];

export function canManageRecipes(scope: string): boolean {
  return RECIPE_WRITE_SCOPES.includes(scope);
}
