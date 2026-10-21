// Layer 12D — create a recipe (POST), or edit one, which saves a NEW version
// (PATCH; the previous version is kept unchanged). The form sends only what
// the user entered: title, yield, description, ingredient lines and steps.
// Nutrition is calculated by the server afterwards; nothing is calculated
// here. An edit sends only the changed fields with the version it started
// from, so a concurrent edit is refused (409) instead of overwritten.
//
// Only scopes that can manage recipes (full_management) get this form; the
// server decides regardless.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';

import type { RecipeDetail } from '../../api/contracts/recipes';
import { createRecipe, getRecipe, updateRecipe } from '../../api/endpoints';
import { isApiError } from '../../api/errors';
import { formatNumber, t } from '../../i18n';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { canManageRecipes } from '../../profile/scope';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Button, Card, ErrorState, Input, LoadingState, Notice, Screen, Text, errorMessage } from '../../ui';
import { theme } from '../../ui/theme';
import { IngredientEditor } from './IngredientEditor';
import { draftErrors, draftFromVersion, editPatch, emptyDraft, newKey, toRecipeWrite, type DraftIngredient, type RecipeDraft } from './draft';

export function RecipeEditScreen({ recipeId, onSaved }: { recipeId?: string; onSaved: (recipeId: string) => void }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const existing = useQuery({
    queryKey: queryKeys.recipe(profile.id, recipeId ?? ''),
    queryFn: ({ signal }) => getRecipe(api, profile.id, recipeId!, signal),
    enabled: !!recipeId,
  });

  if (!canManageRecipes(profile.access_scope)) {
    return (
      <Screen testID="recipe-edit-screen">
        <Notice testID="recipe-edit-read-only">{t('recipeEdit.readOnly')}</Notice>
      </Screen>
    );
  }
  if (recipeId && existing.isPending) {
    return (
      <Screen testID="recipe-edit-screen">
        <LoadingState />
      </Screen>
    );
  }
  if (recipeId && existing.isError) {
    return (
      <Screen testID="recipe-edit-screen">
        <ErrorState error={existing.error} onRetry={() => void existing.refetch()} />
      </Screen>
    );
  }
  const version = existing.data?.current_version ?? null;
  if (recipeId && !version) {
    return (
      <Screen testID="recipe-edit-screen">
        <Notice>{t('recipes.noVersion')}</Notice>
      </Screen>
    );
  }
  return <RecipeForm key={version?.id ?? 'new'} recipe={recipeId ? existing.data! : null} onSaved={onSaved} />;
}

function RecipeForm({ recipe, onSaved }: { recipe: RecipeDetail | null; onSaved: (recipeId: string) => void }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const client = useQueryClient();
  const version = recipe?.current_version ?? null;
  const [original] = useState<RecipeDraft>(() => (version ? draftFromVersion(version) : emptyDraft()));
  const [draft, setDraft] = useState<RecipeDraft>(original);
  const [editing, setEditing] = useState<{ index: number | null; line: DraftIngredient } | null>(null);
  const [touched, setTouched] = useState(false);
  const [nothingChanged, setNothingChanged] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      if (!recipe || !version) return createRecipe(api, profile.id, toRecipeWrite(draft));
      return updateRecipe(api, profile.id, recipe.id, editPatch(original, draft)!, version.id);
    },
    onSuccess: async (saved) => {
      client.setQueryData(queryKeys.recipe(profile.id, saved.id), saved);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['recipes', profile.id] }),
        client.invalidateQueries({ queryKey: queryKeys.recipeNutrition(profile.id, saved.id) }),
      ]);
      onSaved(saved.id);
    },
  });

  const errors = draftErrors(draft);
  const set = (patch: Partial<RecipeDraft>) => {
    setNothingChanged(false);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const submit = () => {
    setTouched(true);
    if (errors.length || save.isPending || editing) return;
    if (version && !editPatch(original, draft)) {
      setNothingChanged(true);
      return;
    }
    save.mutate();
  };

  const listChanged = !!version && !!editPatch(original, draft)?.ingredients;
  const dropsSuggestion = listChanged && draft.ingredients.some((i) => i.unconfirmedSuggestion && !i.food);
  const show = (e: Parameters<typeof errors.includes>[0]) => touched && errors.includes(e);

  if (editing) {
    return (
      <Screen testID="recipe-edit-screen">
        <Text variant="title">{editing.index === null ? t('recipeEdit.addIngredient') : t('recipeEdit.editIngredient')}</Text>
        <IngredientEditor
          initial={editing.line}
          onCancel={() => setEditing(null)}
          onSave={(line) => {
            const list = [...draft.ingredients];
            if (editing.index === null) list.push(line);
            else list[editing.index] = line;
            set({ ingredients: list });
            setEditing(null);
          }}
        />
      </Screen>
    );
  }

  const move = (index: number, by: -1 | 1) => {
    const list = [...draft.ingredients];
    const [line] = list.splice(index, 1);
    list.splice(index + by, 0, line!);
    set({ ingredients: list });
  };

  return (
    <Screen testID="recipe-edit-screen">
      <Text variant="title">{version ? t('recipeEdit.editTitle') : t('recipeEdit.newTitle')}</Text>
      {version ? <Text variant="small">{t('recipeEdit.newVersionNote', { number: version.version_number })}</Text> : null}
      <Input label={t('recipeEdit.title')} value={draft.title} onChangeText={(title) => set({ title })} maxLength={200} testID="recipe-title" />
      {show('title') ? <Text variant="error">{t('recipeEdit.error.title')}</Text> : null}
      <Input label={t('recipeEdit.servings')} value={draft.servingsText} onChangeText={(servingsText) => set({ servingsText })} keyboardType="decimal-pad" testID="recipe-servings-input" />
      {show('servings') ? <Text variant="error">{t('recipeEdit.error.servings')}</Text> : null}
      <Input label={t('recipeEdit.description')} value={draft.description} onChangeText={(description) => set({ description })} maxLength={5000} multiline testID="recipe-description" />

      <Text variant="heading">{t('recipes.ingredients')}</Text>
      {draft.ingredients.map((line, index) => (
        <IngredientRow
          key={line.key}
          line={line}
          index={index}
          last={index === draft.ingredients.length - 1}
          onEdit={() => setEditing({ index, line })}
          onRemove={() => set({ ingredients: draft.ingredients.filter((_, i) => i !== index) })}
          onMove={(by) => move(index, by)}
        />
      ))}
      {show('ingredients') ? <Text variant="error">{t('recipeEdit.error.ingredients')}</Text> : null}
      <Button
        label={t('recipeEdit.addIngredient')}
        variant="secondary"
        onPress={() => setEditing({ index: null, line: { key: newKey(), text: '', food: null, amount: null, unconfirmedSuggestion: false } })}
        disabled={draft.ingredients.length >= 100}
        testID="add-ingredient"
      />

      <Text variant="heading">{t('recipes.steps')}</Text>
      {draft.steps.map((step, index) => (
        <View key={index} style={{ gap: theme.space.xs }}>
          <Input label={t('recipeEdit.stepLabel', { number: index + 1 })} value={step} onChangeText={(text) => set({ steps: draft.steps.map((s, i) => (i === index ? text : s)) })} maxLength={5000} multiline testID={`step-${index}`} />
          <Button label={t('recipeEdit.removeStep')} variant="secondary" onPress={() => set({ steps: draft.steps.filter((_, i) => i !== index) })} testID={`remove-step-${index}`} />
        </View>
      ))}
      {show('step') ? <Text variant="error">{t('recipeEdit.error.step')}</Text> : null}
      <Button label={t('recipeEdit.addStep')} variant="secondary" onPress={() => set({ steps: [...draft.steps, ''] })} disabled={draft.steps.length >= 100} testID="add-step" />

      {dropsSuggestion ? <Notice testID="drops-suggestion">{t('recipeEdit.dropsSuggestion')}</Notice> : null}
      {nothingChanged ? <Text variant="muted" testID="nothing-changed">{t('recipeEdit.nothingChanged')}</Text> : null}
      {save.isError ? (
        <Text variant="error" testID="recipe-save-error">
          {isApiError(save.error) && save.error.kind === 'conflict' ? t('recipeEdit.error.conflict') : errorMessage(save.error)}
        </Text>
      ) : null}
      <Button label={version ? t('recipeEdit.saveVersion') : t('recipeEdit.create')} onPress={submit} disabled={save.isPending} testID="recipe-save" />
    </Screen>
  );
}

export function amountSummary(line: DraftIngredient): string | null {
  const a = line.amount;
  if (!a) return null;
  if (a.kind === 'unit') return `${formatNumber(a.quantity, 3)} ${a.unit}`;
  if (a.kind === 'serving') return a.label ? t('plans.amount.serving', { quantity: formatNumber(a.quantity, 3), serving: a.label }) : t('recipeEdit.servingsOfFood', { quantity: formatNumber(a.quantity, 3) });
  return formatNumber(a.quantity, 3);
}

function IngredientRow({
  line,
  index,
  last,
  onEdit,
  onRemove,
  onMove,
}: {
  line: DraftIngredient;
  index: number;
  last: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onMove: (by: -1 | 1) => void;
}) {
  const status = line.food ? t('recipeEdit.linked', { amount: amountSummary(line) ?? '' }) : line.unconfirmedSuggestion ? t('recipeEdit.unconfirmed') : t('recipeEdit.textOnly');
  return (
    <Card testID={`draft-ingredient-${index}`} accessibilityLabel={`${line.text}. ${status}`}>
      <Text>{line.text}</Text>
      <Text variant="small" testID={`draft-ingredient-status-${index}`}>
        {status}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
        <Button label={t('recipeEdit.edit')} variant="secondary" onPress={onEdit} testID={`edit-ingredient-${index}`} />
        <Button label={t('recipeEdit.remove')} variant="secondary" onPress={onRemove} testID={`remove-ingredient-${index}`} />
        {index > 0 ? <Button label={t('recipeEdit.moveUp')} variant="secondary" onPress={() => onMove(-1)} testID={`up-ingredient-${index}`} /> : null}
        {!last ? <Button label={t('recipeEdit.moveDown')} variant="secondary" onPress={() => onMove(1)} testID={`down-ingredient-${index}`} /> : null}
      </View>
    </Card>
  );
}
