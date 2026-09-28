// Layer 6A — Recipe Book routes, mounted at /v1/profiles/:profile_id/recipes
// and /v1/profiles/:profile_id/recipe-variants. PATCH creates a new
// RecipeVersion; there is no PUT and no DELETE (see recipe.service.ts).

import { Router, type Request, type RequestHandler } from 'express';
import { AppError } from '../../lib/errors';
import { paginationQuerySchema, type PaginationQuery } from '../../lib/pagination';
import { validate } from '../../middleware/validate';
import { profileIdParamSchema } from '../profiles/profile.schemas';
import type { AuthContext } from '../../types/express';
import {
  recipeCreateSchema,
  recipeIdParamSchema,
  recipeListQuerySchema,
  recipePatchSchema,
  recipeVariantListQuerySchema,
  recipeVariantParamSchema,
  recipeVersionParamSchema,
  type RecipeCreateInput,
  type RecipeListQuery,
  type RecipePatchInput,
  type RecipeVariantListQuery,
} from './recipe.schemas';
import type { RecipeService } from './recipe.service';
import type { RecipeVariantService } from './recipeVariant.service';

type Params = { profile_id: string; recipe_id: string; version_id: string; variant_id: string };

function handle(status: number, fn: (auth: AuthContext, params: Params, req: Request) => Promise<unknown>): RequestHandler {
  return async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      res.status(status).json(await fn(req.auth, req.params as unknown as Params, req));
    } catch (err) {
      next(err);
    }
  };
}

export function createRecipeRouter(service: RecipeService): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    validate({ params: profileIdParamSchema, query: recipeListQuerySchema }),
    handle(200, (auth, p, req) => service.list(auth, p.profile_id, req.query as unknown as RecipeListQuery)),
  );
  router.post(
    '/',
    validate({ params: profileIdParamSchema, body: recipeCreateSchema }),
    handle(201, (auth, p, req) => service.create(auth, p.profile_id, req.body as RecipeCreateInput)),
  );
  router.get(
    '/:recipe_id',
    validate({ params: recipeIdParamSchema }),
    handle(200, (auth, p) => service.get(auth, p.profile_id, p.recipe_id)),
  );
  router.patch(
    '/:recipe_id',
    validate({ params: recipeIdParamSchema, body: recipePatchSchema }),
    handle(200, (auth, p, req) => service.update(auth, p.profile_id, p.recipe_id, req.body as RecipePatchInput)),
  );
  router.get(
    '/:recipe_id/nutrition',
    validate({ params: recipeIdParamSchema }),
    handle(200, (auth, p) => service.nutrition(auth, p.profile_id, p.recipe_id)),
  );
  router.get(
    '/:recipe_id/versions',
    validate({ params: recipeIdParamSchema, query: paginationQuerySchema }),
    handle(200, (auth, p, req) => service.listVersions(auth, p.profile_id, p.recipe_id, req.query as unknown as PaginationQuery)),
  );
  router.get(
    '/:recipe_id/versions/:version_id',
    validate({ params: recipeVersionParamSchema }),
    handle(200, (auth, p) => service.getVersion(auth, p.profile_id, p.recipe_id, p.version_id)),
  );
  router.get(
    '/:recipe_id/versions/:version_id/nutrition',
    validate({ params: recipeVersionParamSchema }),
    handle(200, (auth, p) => service.nutrition(auth, p.profile_id, p.recipe_id, p.version_id)),
  );

  return router;
}

export function createRecipeVariantRouter(service: RecipeVariantService): Router {
  const router = Router({ mergeParams: true });
  router.get(
    '/',
    validate({ params: profileIdParamSchema, query: recipeVariantListQuerySchema }),
    handle(200, (auth, p, req) => service.list(auth, p.profile_id, req.query as unknown as RecipeVariantListQuery)),
  );
  router.get(
    '/:variant_id',
    validate({ params: recipeVariantParamSchema }),
    handle(200, (auth, p) => service.get(auth, p.profile_id, p.variant_id)),
  );
  return router;
}
