// Layer 12D — create a recipe (POST), or edit one, which saves a NEW version
// (PATCH; the previous version is kept unchanged). The form sends only what
// the user entered: title, yield, description, ingredient lines and steps.
// Nutrition is calculated by the server; nothing is calculated here.
// Layer 13B: while the form is open, the server's nutrition preview is
// requested again after every change (ingredient, amount, food or its
// preparation state, servings) and shown with each line's own values. An edit sends only the changed fields with the version it started
// from, so a concurrent edit is refused (409) instead of overwritten.
//
// Only scopes that can manage recipes (full_management) get this form; the
// server decides regardless.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import type { RecipeDetail, RecipeNutritionPreview, RecipeWrite } from '../../api/contracts/recipes';
import { createRecipe, getRecipe, previewRecipeNutrition, updateRecipe } from '../../api/endpoints';
import { isApiError } from '../../api/errors';
import { formatNumber, t, type MessageKey } from '../../i18n';
import { en } from '../../i18n/en';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { canManageRecipes } from '../../profile/scope';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Button, Card, ErrorState, Input, LoadingState, Notice, Screen, Text, errorMessage } from '../../ui';
import { theme } from '../../ui/theme';
import { IngredientEditor } from './IngredientEditor';
import { acceptSuggestion, draftErrors, draftFromVersion, editPatch, emptyDraft, newKey, toIngredientInput, toRecipeWrite, type DraftIngredient, type RecipeDraft } from './draft';
import { ingredientNutritionLine, ingredientStatusText, RecipeNutritionView } from './RecipeScreen';
import { parseQuantity } from '../log/LogItemScreen';

const PREVIEW_DELAY_MS = 400;

/** `value` once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Layer 13B — the server's nutrition for the form as it is now (nothing saved). */
function useNutritionPreview(draft: RecipeDraft) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const servings = parseQuantity(draft.servingsText);
  const body = { servings: servings !== null && servings <= 1000 ? servings : null, ingredients: draft.ingredients.filter((i) => i.text.trim()).map(toIngredientInput) };
  const key = useSettled(JSON.stringify(body), PREVIEW_DELAY_MS);
  return useQuery({
    queryKey: ['recipe-nutrition-preview', profile.id, key],
    queryFn: ({ signal }) => previewRecipeNutrition(api, profile.id, JSON.parse(key) as typeof body, signal),
    enabled: body.ingredients.length > 0,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

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

/** Layer 13A — the form can also review an imported recipe: it starts from
 * the import's draft and saves through the import (`submit`). */
export interface ImportReview {
  initialDraft: RecipeDraft;
  submit: (recipe: RecipeWrite) => Promise<RecipeDetail>;
  header: ReactNode;
  conflictMessage: string;
}

export function RecipeForm({ recipe, onSaved, review }: { recipe: RecipeDetail | null; onSaved: (recipeId: string) => void; review?: ImportReview }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const client = useQueryClient();
  const version = recipe?.current_version ?? null;
  const [original] = useState<RecipeDraft>(() => (version ? draftFromVersion(version) : (review?.initialDraft ?? emptyDraft())));
  const [draft, setDraft] = useState<RecipeDraft>(original);
  const [editing, setEditing] = useState<{ index: number | null; line: DraftIngredient } | null>(null);
  const [touched, setTouched] = useState(false);
  const [nothingChanged, setNothingChanged] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      if (review) return review.submit(toRecipeWrite(draft));
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

  const preview = useNutritionPreview(draft);
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
            // Editing a line is the user's own review of it.
            else list[editing.index] = { ...line, auto: undefined };
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
      <Text variant="title">{version ? t('recipeEdit.editTitle') : review ? t('recipeImport.reviewTitle') : t('recipeEdit.newTitle')}</Text>
      {review?.header}
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
          preview={preview.data && !preview.isPlaceholderData ? preview.data.ingredients.find((p) => p.index === index) : undefined}
          onConfirmSuggestion={
            line.suggestion && !line.food
              ? () => {
                  const accepted = acceptSuggestion(line, line.suggestion!);
                  // With an amount from the food's servings it is complete; otherwise ask for the amount.
                  if (accepted.amount && accepted.amount.kind !== 'count') set({ ingredients: draft.ingredients.map((l, i) => (i === index ? accepted : l)) });
                  else setEditing({ index, line: accepted });
                }
              : undefined
          }
          onChooseAlternative={(alt) =>
            set({ ingredients: draft.ingredients.map((l, i) => (i === index ? { ...acceptSuggestion(l, alt), auto: l.auto ? { ...l.auto, assumptions: alt.assumptions } : undefined } : l)) })
          }
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

      <FormNutrition preview={preview.data ?? null} pending={preview.isFetching} failed={preview.isError} />

      {dropsSuggestion ? <Notice testID="drops-suggestion">{t('recipeEdit.dropsSuggestion')}</Notice> : null}
      {nothingChanged ? <Text variant="muted" testID="nothing-changed">{t('recipeEdit.nothingChanged')}</Text> : null}
      {save.isError ? (
        <Text variant="error" testID="recipe-save-error">
          {isApiError(save.error) && save.error.kind === 'conflict' ? (review?.conflictMessage ?? t('recipeEdit.error.conflict')) : errorMessage(save.error)}
        </Text>
      ) : null}
      <Button label={version ? t('recipeEdit.saveVersion') : review ? t('recipeImport.save') : t('recipeEdit.create')} onPress={submit} disabled={save.isPending} testID="recipe-save" />
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

const has = (key: string): key is MessageKey => key in en;
const optional = (key: string, params?: Record<string, string | number>): string | null => (has(key) ? t(key, params) : null);

/** Layer 13B — why an automatic match or a suggestion may need a look. */
export function matchNotes(line: DraftIngredient): string[] {
  const notes: string[] = [];
  const reasons = line.auto?.reasons ?? line.suggestion?.reasons ?? [];
  const assumptions = line.auto?.assumptions ?? line.suggestion?.assumptions ?? [];
  for (const r of reasons) {
    const note = optional(`recipeImport.reason.${r}`);
    if (note) notes.push(note);
  }
  for (const a of assumptions) {
    const note = optional(`recipeImport.assumption.${a}`);
    if (note) notes.push(note);
  }
  return notes;
}

function IngredientRow({
  line,
  index,
  last,
  preview,
  onEdit,
  onRemove,
  onMove,
  onConfirmSuggestion,
  onChooseAlternative,
}: {
  line: DraftIngredient;
  index: number;
  last: boolean;
  preview?: RecipeNutritionPreview['ingredients'][number];
  onEdit: () => void;
  onRemove: () => void;
  onMove: (by: -1 | 1) => void;
  onConfirmSuggestion?: () => void;
  onChooseAlternative: (alt: { foodId: string; name: string; amount: DraftIngredient['amount']; assumptions: string[] }) => void;
}) {
  const status = line.food
    ? line.auto
      ? t('recipeImport.autoMatched', { name: line.food.name ?? '', amount: amountSummary(line) ?? '' })
      : t('recipeEdit.linked', { amount: amountSummary(line) ?? '' })
    : line.suggestion
      ? t('recipeImport.suggested', { name: line.suggestion.name })
      : line.unconfirmedSuggestion
        ? t('recipeEdit.unconfirmed')
        : t('recipeEdit.textOnly');
  const measureNote = !line.food && line.note === 'ambiguous_unit' && !line.suggestion?.amount ? t('recipeImport.note.ambiguousUnit') : line.note === 'range' && !line.food ? t('recipeImport.note.range') : null;
  const notes = matchNotes(line);
  const alternatives = (line.auto?.alternatives ?? line.suggestion?.alternatives ?? []).filter((a) => a.foodId !== line.food?.id).slice(0, 2);
  const counted = preview?.calculation ? ingredientNutritionLine(preview.calculation.summary) : null;
  const notCounted = preview && !preview.calculation ? ingredientStatusText(preview.nutrition_status) : null;
  return (
    <Card testID={`draft-ingredient-${index}`} accessibilityLabel={[line.text, status, measureNote, ...notes].filter(Boolean).join('. ')}>
      <Text>{line.text}</Text>
      <Text variant="small" testID={`draft-ingredient-status-${index}`}>
        {status}
      </Text>
      {notes.map((note, i) => (
        <Text key={i} variant="small" testID={`draft-ingredient-flag-${index}-${i}`}>
          {note}
        </Text>
      ))}
      {measureNote ? (
        <Text variant="small" testID={`draft-ingredient-note-${index}`}>
          {measureNote}
        </Text>
      ) : null}
      {!line.food && !line.suggestion && line.text.trim() ? (
        <Text variant="small" testID={`draft-ingredient-review-${index}`}>
          {t('recipeImport.noMatch')}
        </Text>
      ) : null}
      {counted ? (
        <Text variant="small" testID={`draft-ingredient-nutrition-${index}`}>
          {counted}
        </Text>
      ) : null}
      {notCounted ? (
        <Text variant="small" testID={`draft-ingredient-uncounted-${index}`}>
          {notCounted}
        </Text>
      ) : null}
      {onConfirmSuggestion ? <Button label={t('recipeImport.confirmFood')} onPress={onConfirmSuggestion} testID={`confirm-suggestion-${index}`} /> : null}
      {alternatives.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
          {alternatives.map((alt, i) => (
            <Button key={alt.foodId} label={t('recipeImport.useInstead', { name: alt.name })} variant="secondary" onPress={() => onChooseAlternative(alt)} testID={`alternative-${index}-${i}`} />
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
        <Button label={t('recipeEdit.edit')} variant="secondary" onPress={onEdit} testID={`edit-ingredient-${index}`} />
        <Button label={t('recipeEdit.remove')} variant="secondary" onPress={onRemove} testID={`remove-ingredient-${index}`} />
        {index > 0 ? <Button label={t('recipeEdit.moveUp')} variant="secondary" onPress={() => onMove(-1)} testID={`up-ingredient-${index}`} /> : null}
        {!last ? <Button label={t('recipeEdit.moveDown')} variant="secondary" onPress={() => onMove(1)} testID={`down-ingredient-${index}`} /> : null}
      </View>
    </Card>
  );
}

/** Layer 13B — the form's nutrition, from the server's preview. */
function FormNutrition({ preview, pending, failed }: { preview: RecipeNutritionPreview | null; pending: boolean; failed: boolean }) {
  if (!preview) return failed ? <Text variant="muted" testID="form-nutrition-unavailable">{t('recipeEdit.previewUnavailable')}</Text> : null;
  return (
    <View testID="form-nutrition" style={{ gap: theme.space.xs }}>
      {pending ? <Text variant="small" testID="form-nutrition-updating">{t('recipeEdit.previewUpdating')}</Text> : null}
      <RecipeNutritionView nutrition={preview} />
    </View>
  );
}
