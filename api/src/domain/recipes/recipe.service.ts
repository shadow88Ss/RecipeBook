// Layer 6A — Recipe Book domain logic.
//
// Allowed scopes transcribed from 20260825121500_rls_recipes.sql and
// 20260825121000_rls_helpers.sql (never broadened here):
//   read  — can_read_recipe(): any access scope to the authoring Profile
//           (full_management, view_only, pediatric_weight_management;
//           20260825121900 confirms pediatric read access to recipes).
//   write — recipe_insert_own / can_manage_recipe(): full_management only.
// A revoked guardian has no scope (404). Every query runs as the caller
// under RLS; the API check only picks the right HTTP status first.
//
// Recipes are listed/read under the Profile that authored them
// (created_by_profile_id). There is no public/community discovery: a
// shared_library recipe authored elsewhere is not reachable through another
// Profile's routes. New recipes are always `private`; visibility is not
// changeable in this layer.
//
// Versioning: POST writes Recipe + version 1; PATCH writes version n+1. Both
// go through create_recipe_version() (20261001120000), which writes the
// version, its ingredients and instructions and moves current_version_id in
// one transaction. Existing versions/ingredients/instructions are never
// updated (no UPDATE grant + prevent_update triggers). There is no DELETE:
// deletion/archival semantics belong to 10_Recipe_Library.md, which is not
// available.
//
// Nutrition is computed on read from the requested version's own
// ingredients through the Layer 5B engine (recipe.nutrition.ts) and is not
// persisted.

import { requireProfileScope } from '../../lib/authorize';
import { AppError } from '../../lib/errors';
import { IN_MEMORY_PAGE_FETCH_CAP, paginateInMemory, type Page, type PaginationQuery } from '../../lib/pagination';
import type { ScopedDbClient, ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import { loadNutritionReference } from '../nutrition/nutrition.service';
import {
  RECIPE_COLUMNS,
  RECIPE_INGREDIENT_COLUMNS,
  RECIPE_INSTRUCTION_COLUMNS,
  RECIPE_VERSION_COLUMNS,
  toRecipeListItemDto,
  toRecipeNutritionDto,
  toVersionDto,
  toVersionSummaryDto,
  type RecipeIngredientRow,
  type RecipeInstructionRow,
  type RecipeRow,
  type RecipeVersionRow,
  type VersionContent,
} from './recipe.dto';
import { calculateRecipeNutrition } from './recipe.nutrition';
import { normalizeSearchText, type RecipeCreateInput, type RecipeIngredientInput, type RecipeListQuery, type RecipePatchInput } from './recipe.schemas';

export const RECIPE_READ_SCOPES = ['full_management', 'view_only', 'pediatric_weight_management'] as const;
export const RECIPE_WRITE_SCOPES = ['full_management'] as const;

/** Ingredient as passed to create_recipe_version(). */
interface IngredientContent {
  raw_ingredient_text: string;
  food_id: string | null;
  food_serving_id: string | null;
  quantity: number | null;
  unit: string | null;
  match_status: RecipeIngredientRow['match_status'];
  match_confidence: number | null;
}

interface VersionWriteContent {
  title: string;
  description: string | null;
  servings: number | null;
  ingredients: IngredientContent[];
  instructions: string[];
}

interface VersionWriteResult {
  recipe_id: string;
  recipe_version_id: string;
  version_number: number;
}

export class RecipeService {
  constructor(private readonly dbFactory: ScopedDbFactory) {}

  async list(auth: AuthContext, profileId: string, query: RecipeListQuery): Promise<Page<ReturnType<typeof toRecipeListItemDto>>> {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, RECIPE_READ_SCOPES);
    const recipes = await db.select<RecipeRow>('recipe', {
      columns: RECIPE_COLUMNS,
      eq: { created_by_profile_id: profileId },
      order: { column: 'updated_at', ascending: false },
      limit: IN_MEMORY_PAGE_FETCH_CAP,
    });
    const q = query.q;
    const matching = recipes
      .filter((r) => q === undefined || normalizeSearchText(r.canonical_title).includes(q))
      // Deterministic order for cursor pagination: most recently updated
      // first, id as the tie-breaker.
      .sort((a, b) => (a.updated_at === b.updated_at ? (a.id < b.id ? -1 : 1) : a.updated_at < b.updated_at ? 1 : -1));

    const currentIds = matching.map((r) => r.current_version_id).filter((id): id is string => id !== null);
    const versions = currentIds.length
      ? await db.select<RecipeVersionRow>('recipe_version', { columns: RECIPE_VERSION_COLUMNS, in: { id: currentIds } })
      : [];
    const byId = new Map(versions.map((v) => [v.id, v]));
    return paginateInMemory(
      matching.map((r) => toRecipeListItemDto(r, r.current_version_id ? byId.get(r.current_version_id) : undefined)),
      query as PaginationQuery,
    );
  }

  async get(auth: AuthContext, profileId: string, recipeId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, RECIPE_READ_SCOPES);
    return this.detail(db, profileId, recipeId);
  }

  async create(auth: AuthContext, profileId: string, input: RecipeCreateInput) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, RECIPE_WRITE_SCOPES);
    const content: VersionWriteContent = {
      title: input.title,
      description: input.description ?? null,
      servings: input.servings,
      ingredients: await this.resolveIngredientInputs(db, input.ingredients),
      instructions: input.instructions,
    };
    const written = await writeVersion(db, profileId, null, null, content);
    return this.detail(db, profileId, written.recipe_id);
  }

  /** Creates a new RecipeVersion from the current one plus the patch. The
   * previous version and its rows are left untouched. */
  async update(auth: AuthContext, profileId: string, recipeId: string, patch: RecipePatchInput) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, RECIPE_WRITE_SCOPES);
    const recipe = await loadRecipe(db, profileId, recipeId);
    if (patch.expected_current_version_id !== undefined && patch.expected_current_version_id !== recipe.current_version_id) {
      throw staleVersion();
    }
    const current = recipe.current_version_id ? await loadVersionContent(db, recipe.id, recipe.current_version_id) : null;

    const content: VersionWriteContent = {
      title: patch.title ?? current?.version.title ?? recipe.canonical_title,
      description: patch.description !== undefined ? patch.description : (current?.version.description ?? null),
      servings: patch.servings ?? current?.version.servings ?? null,
      ingredients:
        patch.ingredients !== undefined
          ? await this.resolveIngredientInputs(db, patch.ingredients)
          : [...(current?.ingredients ?? [])].sort((a, b) => a.sort_order - b.sort_order).map(carryOverIngredient),
      instructions:
        patch.instructions ??
        [...(current?.instructions ?? [])].sort((a, b) => a.step_number - b.step_number).map((s) => s.instruction_text),
    };
    if (content.ingredients.length === 0) {
      throw AppError.validation('A recipe version needs at least one ingredient.', { issues: [{ path: 'ingredients', message: 'Required.' }] });
    }
    // The version this edit was built from is the concurrency guard: a
    // version created in between makes this write a 409, never a lost update.
    await writeVersion(db, profileId, recipe.id, recipe.current_version_id, content);
    return this.detail(db, profileId, recipe.id);
  }

  async listVersions(auth: AuthContext, profileId: string, recipeId: string, pagination: PaginationQuery) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, RECIPE_READ_SCOPES);
    const recipe = await loadRecipe(db, profileId, recipeId);
    const versions = await db.select<RecipeVersionRow>('recipe_version', {
      columns: RECIPE_VERSION_COLUMNS,
      eq: { recipe_id: recipe.id },
      order: { column: 'version_number', ascending: false },
      limit: IN_MEMORY_PAGE_FETCH_CAP,
    });
    return paginateInMemory(
      versions.map((v) => toVersionSummaryDto(v, recipe.current_version_id)),
      pagination,
    );
  }

  async getVersion(auth: AuthContext, profileId: string, recipeId: string, versionId: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, RECIPE_READ_SCOPES);
    const recipe = await loadRecipe(db, profileId, recipeId);
    const content = await loadVersionContent(db, recipe.id, versionId);
    return {
      ...toVersionDto(content, recipe.current_version_id),
      nutrition: toRecipeNutritionDto(await recipeVersionNutrition(db, content), { includeIngredients: false }),
    };
  }

  /** Nutrition of the current version, or of `versionId` — always from
   * THAT version's own ingredients and yield. */
  async nutrition(auth: AuthContext, profileId: string, recipeId: string, versionId?: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, RECIPE_READ_SCOPES);
    const recipe = await loadRecipe(db, profileId, recipeId);
    const targetVersionId = versionId ?? recipe.current_version_id;
    if (!targetVersionId) throw AppError.notFound('Recipe version not found.');
    const content = await loadVersionContent(db, recipe.id, targetVersionId);
    return {
      recipe_id: recipe.id,
      recipe_version_id: content.version.id,
      version_number: content.version.version_number,
      is_current: content.version.id === recipe.current_version_id,
      ...toRecipeNutritionDto(await recipeVersionNutrition(db, content), { includeIngredients: true }),
    };
  }

  private async detail(db: ScopedDbClient, profileId: string, recipeId: string) {
    const recipe = await loadRecipe(db, profileId, recipeId);
    const versions = await db.select<{ id: string }>('recipe_version', {
      columns: 'id',
      eq: { recipe_id: recipe.id },
      limit: IN_MEMORY_PAGE_FETCH_CAP,
    });
    const current = recipe.current_version_id ? await loadVersionContent(db, recipe.id, recipe.current_version_id) : null;
    return {
      id: recipe.id,
      profile_id: recipe.created_by_profile_id,
      visibility: recipe.visibility,
      title: recipe.canonical_title,
      created_at: recipe.created_at,
      updated_at: recipe.updated_at,
      version_count: versions.length,
      current_version: current ? toVersionDto(current, recipe.current_version_id) : null,
      nutrition: current ? toRecipeNutritionDto(await recipeVersionNutrition(db, current), { includeIngredients: false }) : null,
    };
  }

  /** Client ingredients -> stored ingredient content. A selected Food is a
   * user-confirmed match (`matched`); no Food means `unmatched` text. Every
   * referenced Food must exist and every serving must belong to its Food. */
  private async resolveIngredientInputs(db: ScopedDbClient, inputs: readonly RecipeIngredientInput[]): Promise<IngredientContent[]> {
    const foodIds = [...new Set(inputs.flatMap((i) => (i.food_id ? [i.food_id] : [])))];
    const servingIds = [...new Set(inputs.flatMap((i) => (i.serving_id ? [i.serving_id] : [])))];
    const [foods, servings] = await Promise.all([
      foodIds.length ? db.select<{ id: string }>('food', { columns: 'id', in: { id: foodIds } }) : Promise.resolve([]),
      servingIds.length ? db.select<{ id: string; food_id: string }>('food_serving', { columns: 'id, food_id', in: { id: servingIds } }) : Promise.resolve([]),
    ]);
    const knownFoods = new Set(foods.map((f) => f.id));
    const servingFood = new Map(servings.map((s) => [s.id, s.food_id]));

    const issues: Array<{ path: string; message: string }> = [];
    inputs.forEach((input, index) => {
      if (input.food_id && !knownFoods.has(input.food_id)) {
        issues.push({ path: `ingredients.${index}.food_id`, message: 'Food not found.' });
      }
      if (input.serving_id && servingFood.get(input.serving_id) !== input.food_id) {
        issues.push({ path: `ingredients.${index}.serving_id`, message: 'serving_id does not exist for this food.' });
      }
    });
    if (issues.length) throw AppError.validation('Invalid ingredient reference.', { issues });

    return inputs.map((input): IngredientContent => ({
      raw_ingredient_text: input.text,
      food_id: input.food_id ?? null,
      food_serving_id: input.serving_id ?? null,
      quantity: input.quantity ?? null,
      unit: input.unit ?? null,
      match_status: input.food_id ? 'matched' : 'unmatched',
      match_confidence: null,
    }));
  }
}

/** An unchanged ingredient is copied into the new version verbatim,
 * including its match state (a `needs_confirmation` match stays unconfirmed). */
function carryOverIngredient(row: RecipeIngredientRow): IngredientContent {
  return {
    raw_ingredient_text: row.raw_ingredient_text,
    food_id: row.food_id,
    food_serving_id: row.food_serving_id,
    quantity: row.quantity,
    unit: row.unit,
    match_status: row.match_status,
    match_confidence: row.match_confidence,
  };
}

function staleVersion(): AppError {
  return AppError.conflict('The recipe has a newer version than the one this edit was based on. Reload and retry.');
}

async function writeVersion(
  db: ScopedDbClient,
  profileId: string,
  recipeId: string | null,
  expectedCurrentVersionId: string | null,
  content: VersionWriteContent,
): Promise<VersionWriteResult> {
  try {
    return await db.rpc<VersionWriteResult>('create_recipe_version', {
      p_profile_id: profileId,
      p_recipe_id: recipeId,
      p_expected_current_version_id: expectedCurrentVersionId,
      p_content: content,
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'P0002') throw AppError.notFound('Recipe not found.');
    if (code === '40001' || code === '23505') throw staleVersion();
    if (code === '23503') throw AppError.validation('An ingredient references a food or serving that does not exist.');
    if (code === '42501') throw AppError.forbidden('This operation is not permitted for this recipe.');
    throw err;
  }
}

/** Filtering on (id, created_by_profile_id) keeps every recipe route inside
 * its Profile, on top of RLS. */
export async function loadRecipe(db: ScopedDbClient, profileId: string, recipeId: string): Promise<RecipeRow> {
  const rows = await db.select<RecipeRow>('recipe', { columns: RECIPE_COLUMNS, eq: { id: recipeId, created_by_profile_id: profileId }, limit: 1 });
  const row = rows[0];
  if (!row) throw AppError.notFound('Recipe not found.');
  return row;
}

export async function loadVersionContent(db: ScopedDbClient, recipeId: string, versionId: string): Promise<VersionContent> {
  const versions = await db.select<RecipeVersionRow>('recipe_version', {
    columns: RECIPE_VERSION_COLUMNS,
    eq: { id: versionId, recipe_id: recipeId },
    limit: 1,
  });
  const version = versions[0];
  if (!version) throw AppError.notFound('Recipe version not found.');
  const [ingredients, instructions] = await Promise.all([
    db.select<RecipeIngredientRow>('recipe_ingredient', {
      columns: RECIPE_INGREDIENT_COLUMNS,
      eq: { recipe_version_id: version.id },
      order: { column: 'sort_order', ascending: true },
    }),
    db.select<RecipeInstructionRow>('recipe_instruction', {
      columns: RECIPE_INSTRUCTION_COLUMNS,
      eq: { recipe_version_id: version.id },
      order: { column: 'step_number', ascending: true },
    }),
  ]);
  return { version, ingredients, instructions };
}

export async function recipeVersionNutrition(db: ScopedDbClient, content: VersionContent) {
  const foodIds = content.ingredients.flatMap((i) => (i.food_id ? [i.food_id] : []));
  const { foods, vocabulary } = await loadNutritionReference(db, foodIds);
  return calculateRecipeNutrition(content.ingredients, foods, vocabulary, content.version.servings);
}
