import { KNOWN_ACCESS_SCOPES } from '../api/contracts/profile';
import { t } from '../i18n';

/** Display label for the access_scope the API returned. Display only — never a permission check. */
export function scopeLabel(scope: string): string {
  return (KNOWN_ACCESS_SCOPES as readonly string[]).includes(scope) ? t(`scope.${scope as (typeof KNOWN_ACCESS_SCOPES)[number]}`) : t('scope.unknown', { scope });
}
