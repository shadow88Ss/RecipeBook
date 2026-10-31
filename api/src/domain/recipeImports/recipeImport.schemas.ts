// Layer 13A — recipe import request contracts.

import { z } from 'zod';
import { profileIdParamSchema } from '../profiles/profile.schemas';
import { recipeCreateSchema } from '../recipes/recipe.schemas';
import { MAX_SOURCE_URL_LENGTH } from './sourceUrl';

export const recipeImportCreateSchema = z.object({
  url: z.string().trim().min(1).max(MAX_SOURCE_URL_LENGTH),
  /** Client-generated, one per import attempt: a retried request with the
   * same key returns the same import instead of fetching again. Generated
   * by the server when omitted. */
  idempotency_key: z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
});
export type RecipeImportCreateInput = z.infer<typeof recipeImportCreateSchema>;

/** Saving takes the reviewed recipe in the normal recipe create shape: the
 * user's edits are what is saved, the extraction stays as provenance. */
export const recipeImportSaveSchema = recipeCreateSchema;
export type RecipeImportSaveInput = z.infer<typeof recipeImportSaveSchema>;

export const recipeImportIdParamSchema = profileIdParamSchema.extend({
  import_id: z.uuid({ message: 'import_id must be a valid UUID.' }),
});
