// Layer 13A — recipe import routes, mounted at
// /v1/profiles/:profile_id/recipe-imports.
//
//   POST /                    import a website link (201; 200 for a replayed
//                             idempotency key). A page that could not be
//                             imported is still 201: the import's `status`
//                             and `error_code` say why.
//   GET  /:import_id          the import and its draft
//   POST /:import_id/save     save the reviewed recipe (201, recipe detail)

import { Router, type Request, type RequestHandler } from 'express';
import { AppError } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import { profileIdParamSchema } from '../profiles/profile.schemas';
import type { RecipeService } from '../recipes/recipe.service';
import type { AuthContext } from '../../types/express';
import {
  recipeImportCreateSchema,
  recipeImportIdParamSchema,
  recipeImportSaveSchema,
  type RecipeImportCreateInput,
  type RecipeImportSaveInput,
} from './recipeImport.schemas';
import type { RecipeImportService } from './recipeImport.service';

type Params = { profile_id: string; import_id: string };

function handle(fn: (auth: AuthContext, params: Params, req: Request) => Promise<{ status: number; body: unknown }>): RequestHandler {
  return async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { status, body } = await fn(req.auth, req.params as unknown as Params, req);
      res.status(status).json(body);
    } catch (err) {
      next(err);
    }
  };
}

export function createRecipeImportRouter(imports: RecipeImportService, recipes: RecipeService): Router {
  const router = Router({ mergeParams: true });

  router.post(
    '/',
    validate({ params: profileIdParamSchema, body: recipeImportCreateSchema }),
    handle(async (auth, p, req) => {
      const result = await imports.start(auth, p.profile_id, req.body as RecipeImportCreateInput);
      return { status: result.replayed ? 200 : 201, body: result.import };
    }),
  );
  router.get(
    '/:import_id',
    validate({ params: recipeImportIdParamSchema }),
    handle(async (auth, p) => ({ status: 200, body: await imports.get(auth, p.profile_id, p.import_id) })),
  );
  router.post(
    '/:import_id/save',
    validate({ params: recipeImportIdParamSchema, body: recipeImportSaveSchema }),
    handle(async (auth, p, req) => ({ status: 201, body: await recipes.saveImport(auth, p.profile_id, p.import_id, req.body as RecipeImportSaveInput) })),
  );

  return router;
}
