// Layer 12D — the recipe form's local draft, and how it becomes a request.
//
// The draft holds only what the user typed or chose. Turning it into a
// request never derives nutrition, never invents a match and never sends a
// server-owned field. Two rules protect what is already stored:
//   - An edit sends only the fields that changed. An unchanged ingredient list
//     is left out, so the server carries every line over with its stored
//     match state.
//   - A line whose stored match is NOT confirmed (`needs_confirmation`, from
//     an import) is never sent with its food_id, because sending a food_id is
//     how a user confirms a match. If the list changes, such a line is sent as
//     text only, and the form says so first.

import type { RecipeIngredient, RecipeIngredientInput, RecipeVersion, RecipeWrite } from '../../api/contracts/recipes';
import { parseQuantity } from '../log/LogItemScreen';

export type DraftAmount =
  | { kind: 'unit'; quantity: number; unit: string }
  | { kind: 'serving'; quantity: number; servingId: string; label: string | null }
  | { kind: 'count'; quantity: number };

export interface DraftIngredient {
  /** Local identity for list rendering only; never sent. */
  key: string;
  text: string;
  /** A Food the user chose (or a stored confirmed match). `name` is null when only the id is known. */
  food: { id: string; name: string | null } | null;
  amount: DraftAmount | null;
  /** Stored line whose match was proposed but never confirmed. */
  unconfirmedSuggestion: boolean;
}

export interface RecipeDraft {
  title: string;
  servingsText: string;
  description: string;
  ingredients: DraftIngredient[];
  steps: string[];
}

let nextKey = 0;
export const newKey = () => `draft-${(nextKey += 1)}`;

export const emptyDraft = (): RecipeDraft => ({ title: '', servingsText: '', description: '', ingredients: [], steps: [] });

function storedAmount(i: RecipeIngredient): DraftAmount | null {
  if (i.quantity === null) return null;
  if (i.serving_id) return { kind: 'serving', quantity: i.quantity, servingId: i.serving_id, label: null };
  if (i.unit) return { kind: 'unit', quantity: i.quantity, unit: i.unit };
  return { kind: 'count', quantity: i.quantity };
}

export function draftFromVersion(version: RecipeVersion): RecipeDraft {
  return {
    title: version.title,
    servingsText: version.servings === null ? '' : String(version.servings),
    description: version.description ?? '',
    ingredients: version.ingredients.map((i) => ({
      key: newKey(),
      text: i.text,
      food: i.match_status === 'matched' && i.food_id ? { id: i.food_id, name: null } : null,
      amount: storedAmount(i),
      unconfirmedSuggestion: i.match_status === 'needs_confirmation',
    })),
    steps: version.instructions.map((s) => s.text),
  };
}

export function toIngredientInput(d: DraftIngredient): RecipeIngredientInput {
  const out: RecipeIngredientInput = { text: d.text.trim() };
  if (d.food) out.food_id = d.food.id;
  const a = d.amount;
  if (a) {
    out.quantity = a.quantity;
    if (a.kind === 'unit') out.unit = a.unit;
    // A serving belongs to a Food; without the Food it cannot be sent.
    if (a.kind === 'serving' && d.food) out.serving_id = a.servingId;
  }
  return out;
}

export type DraftError = 'title' | 'servings' | 'ingredients' | 'ingredientText' | 'step';

/** Checks the draft against the API's request rules before anything is sent. */
export function draftErrors(draft: RecipeDraft): DraftError[] {
  const errors: DraftError[] = [];
  if (!draft.title.trim()) errors.push('title');
  const servings = parseQuantity(draft.servingsText);
  if (servings === null || servings > 1000) errors.push('servings');
  if (!draft.ingredients.length) errors.push('ingredients');
  if (draft.ingredients.some((i) => !i.text.trim())) errors.push('ingredientText');
  if (draft.steps.some((s) => !s.trim())) errors.push('step');
  return errors;
}

export function toRecipeWrite(draft: RecipeDraft): RecipeWrite {
  return {
    title: draft.title.trim(),
    description: draft.description.trim() || null,
    servings: parseQuantity(draft.servingsText)!,
    ingredients: draft.ingredients.map(toIngredientInput),
    instructions: draft.steps.map((s) => s.trim()),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The fields of an edit that differ from the version it started from; null when nothing changed. */
export function editPatch(original: RecipeDraft, draft: RecipeDraft): Partial<RecipeWrite> | null {
  const before = toRecipeWrite(original);
  const after = toRecipeWrite(draft);
  const patch: Partial<RecipeWrite> = {};
  if (after.title !== before.title) patch.title = after.title;
  if (after.description !== before.description) patch.description = after.description;
  if (after.servings !== before.servings) patch.servings = after.servings;
  if (!same(after.ingredients, before.ingredients) || !same(original.ingredients.map((i) => i.key), draft.ingredients.map((i) => i.key))) {
    patch.ingredients = after.ingredients;
  }
  if (!same(after.instructions, before.instructions)) patch.instructions = after.instructions;
  return Object.keys(patch).length ? patch : null;
}
