// Layer 13A — import a recipe from a website link.
//
// The user pastes a link; the server fetches the page and reads the recipe
// data the site publishes (POST /recipe-imports). The result opens in the
// recipe form for review: nothing is saved until the user saves it, and what
// is saved is what the user reviewed (POST /recipe-imports/{id}/save). The
// app never fetches the page itself and never reads or converts amounts:
// the server fills an amount only when it is certain, and the form shows
// every other line as text for the user to complete.
//
// Only website links are supported. Instagram, TikTok and YouTube links are
// refused by the server.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import type { RecipeImport } from '../../api/contracts/recipeImports';
import { getRecipeImport, saveRecipeImport, startRecipeImport } from '../../api/endpoints';
import { isApiError } from '../../api/errors';
import { t } from '../../i18n';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { canManageRecipes } from '../../profile/scope';
import { useServices } from '../../state/AppProviders';
import { Button, Input, Notice, Screen, Text, errorMessage } from '../../ui';
import { RecipeForm } from './RecipeEditScreen';
import { draftFromImport } from './draft';

const newIdempotencyKey = () => `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/** Server error codes (docs/30_API.md §33) -> what the user can do about it. */
export function importFailureMessage(code: string | null): string {
  switch (code) {
    case 'no_recipe_found':
    case 'no_ingredients':
      return t('recipeImport.failed.noRecipe');
    case 'not_html':
      return t('recipeImport.failed.notPage');
    case 'too_large':
      return t('recipeImport.failed.tooLarge');
    case 'http_error':
    case 'dns_failed':
    case 'timeout':
    case 'network_error':
      return t('recipeImport.failed.unreachable');
    default:
      return t('recipeImport.failed.other');
  }
}

export function RecipeImportScreen({ onSaved, onOpenRecipe }: { onSaved: (recipeId: string) => void; onOpenRecipe: (recipeId: string) => void }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const client = useQueryClient();
  const [url, setUrl] = useState('');
  const [result, setResult] = useState<RecipeImport | null>(null);
  // One key per link: retrying after a network error returns the same import.
  const keyFor = useRef<{ url: string; key: string } | null>(null);

  const start = useMutation({
    mutationFn: (link: string) => {
      if (keyFor.current?.url !== link) keyFor.current = { url: link, key: newIdempotencyKey() };
      return startRecipeImport(api, profile.id, link, keyFor.current.key);
    },
    onSuccess: (imported) => {
      // A finished attempt (even a failed one) is done: trying again is a new import.
      keyFor.current = null;
      setResult(imported);
    },
  });

  if (!canManageRecipes(profile.access_scope)) {
    return (
      <Screen testID="recipe-import-screen">
        <Notice testID="recipe-import-read-only">{t('recipeEdit.readOnly')}</Notice>
      </Screen>
    );
  }

  const reset = () => {
    setResult(null);
    start.reset();
  };

  if (result?.status === 'needs_confirmation' && result.draft && !result.existing_recipe_id) {
    const draft = result.draft;
    const host = hostOf(result.source?.url);
    return (
      <RecipeForm
        key={result.id}
        recipe={null}
        onSaved={(id) => {
          void client.invalidateQueries({ queryKey: ['recipe-import', profile.id, result.id] });
          onSaved(id);
        }}
        review={{
          initialDraft: draftFromImport(draft),
          submit: async (recipe) => {
            try {
              return await saveRecipeImport(api, profile.id, result.id, recipe);
            } catch (error) {
              // Saved meanwhile (another device, or a second tap): show where it is.
              if (isApiError(error) && error.kind === 'conflict') {
                const latest = await getRecipeImport(api, profile.id, result.id).catch(() => null);
                if (latest) setResult(latest);
              }
              throw error;
            }
          },
          conflictMessage: t('recipeImport.alreadySaved'),
          header: (
            <>
              <Text variant="small" testID="import-source">
                {t('recipeImport.from', { host })}
              </Text>
              <Notice testID="import-review-notice">{t('recipeImport.reviewNotice')}</Notice>
              {draft.servings === null ? (
                <Text variant="small" testID="import-yield">
                  {draft.yield_text ? t('recipeImport.yieldText', { text: draft.yield_text }) : t('recipeImport.noYield')}
                </Text>
              ) : null}
              {draft.truncated ? <Text variant="small">{t('recipeImport.truncated')}</Text> : null}
            </>
          ),
        }}
      />
    );
  }

  const existing = result?.recipe_id ?? result?.existing_recipe_id ?? null;
  return (
    <Screen testID="recipe-import-screen">
      <Text variant="title">{t('recipeImport.title')}</Text>
      <Text variant="muted">{t('recipeImport.intro')}</Text>
      {existing ? (
        <>
          <Notice testID="import-existing">{t('recipeImport.existing')}</Notice>
          <Button label={t('recipeImport.openExisting')} onPress={() => onOpenRecipe(existing)} testID="import-open-existing" />
          <Button label={t('recipeImport.another')} variant="secondary" onPress={reset} testID="import-another" />
        </>
      ) : result ? (
        <>
          <Text variant="error" testID="import-failed">
            {importFailureMessage(result.error_code)}
          </Text>
          <Button label={t('recipeImport.tryAgain')} variant="secondary" onPress={reset} testID="import-try-again" />
        </>
      ) : (
        <>
          <Input
            label={t('recipeImport.urlLabel')}
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            inputMode="url"
            maxLength={2048}
            onSubmitEditing={() => url.trim() && start.mutate(url.trim())}
            testID="import-url"
          />
          {start.isError ? (
            <Text variant="error" testID="import-error">
              {isApiError(start.error) && start.error.kind === 'validation' ? t('recipeImport.badLink') : errorMessage(start.error)}
            </Text>
          ) : null}
          <Button
            label={start.isPending ? t('recipeImport.reading') : t('recipeImport.import')}
            onPress={() => start.mutate(url.trim())}
            disabled={!url.trim() || start.isPending}
            testID="import-submit"
          />
        </>
      )}
    </Screen>
  );
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
