// Layer 4A §1 / Layer 4B — app factory. Takes its dependencies (repository,
// scopedDbFactory, logger, jwt secret) as parameters rather than reaching
// for global state, so tests can build a fully wired app against either the
// production repository or the local RLS test harness (Layer 4A spec §20,
// Layer 4B spec §20) without any conditional/test-only branch inside
// application code itself.

import express, { type Express } from 'express';
import { createAuthMiddleware } from './middleware/auth';
import { createErrorHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { createRequestLogging } from './middleware/requestLogging';
import { createHealthRouter } from './domain/health/health.routes';
import { createProfileRouter } from './domain/profiles/profile.routes';
import { ProfileService } from './domain/profiles/profile.service';
import type { ProfileRepository } from './domain/profiles/profile.repository';
import { createGoalRouter } from './domain/goals/goal.routes';
import { GoalService } from './domain/goals/goal.service';
import { createNutritionTargetRouter } from './domain/nutritionTargets/nutritionTarget.routes';
import { NutritionTargetService } from './domain/nutritionTargets/nutritionTarget.service';
import { createClinicianTargetRouter } from './domain/clinicianTargets/clinicianTarget.routes';
import { ClinicianTargetService } from './domain/clinicianTargets/clinicianTarget.service';
import { createWeightMeasurementRouter } from './domain/weightMeasurements/weightMeasurement.routes';
import { WeightMeasurementService } from './domain/weightMeasurements/weightMeasurement.service';
import { createEffectiveTargetRouter } from './domain/effectiveTarget/effectiveTarget.routes';
import { EffectiveTargetService } from './domain/effectiveTarget/effectiveTarget.service';
import { createFoodRouter, createNutrientRouter } from './domain/foods/food.routes';
import { FoodService } from './domain/foods/food.service';
import { createUnitRouter } from './domain/conversion/unit.routes';
import { createNutritionRouter } from './domain/nutrition/nutrition.routes';
import { NutritionService } from './domain/nutrition/nutrition.service';
import { createRecipeRouter, createRecipeVariantRouter } from './domain/recipes/recipe.routes';
import { RecipeService } from './domain/recipes/recipe.service';
import { RecipeVariantService } from './domain/recipes/recipeVariant.service';
import type { ScopedDbFactory } from './lib/scopedDb';
import type { Logger } from './lib/logger';
import { AppError } from './lib/errors';

export interface AppDependencies {
  profileRepository: ProfileRepository;
  scopedDbFactory: ScopedDbFactory;
  jwtSecret: string;
  logger: Logger;
}

export function createApp({ profileRepository, scopedDbFactory, jwtSecret, logger }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestContext);
  app.use(createRequestLogging(logger));
  app.use(express.json({ limit: '1mb' }));

  // Unauthenticated: operational only, never behind /v1 (it is not a
  // versioned data contract).
  app.use('/health', createHealthRouter());

  const requireAuth = createAuthMiddleware({ jwtSecret });
  const profileService = new ProfileService(profileRepository, scopedDbFactory);
  const goalService = new GoalService(scopedDbFactory);
  const nutritionTargetService = new NutritionTargetService(scopedDbFactory);
  const clinicianTargetService = new ClinicianTargetService(scopedDbFactory);
  const weightMeasurementService = new WeightMeasurementService(scopedDbFactory);
  const effectiveTargetService = new EffectiveTargetService(scopedDbFactory);
  const foodService = new FoodService(scopedDbFactory);
  const nutritionService = new NutritionService(scopedDbFactory);
  const recipeService = new RecipeService(scopedDbFactory);
  const recipeVariantService = new RecipeVariantService(scopedDbFactory);

  const v1 = express.Router();
  v1.use('/profiles', requireAuth, createProfileRouter(profileService));
  v1.use('/profiles/:profile_id/goals', requireAuth, createGoalRouter(goalService));
  v1.use('/profiles/:profile_id/nutrition-targets', requireAuth, createNutritionTargetRouter(nutritionTargetService));
  v1.use('/profiles/:profile_id/clinician-targets', requireAuth, createClinicianTargetRouter(clinicianTargetService));
  v1.use('/profiles/:profile_id/weight-measurements', requireAuth, createWeightMeasurementRouter(weightMeasurementService));
  // Layer 6A — Recipe Book core (nutrition through the Layer 5B engine).
  v1.use('/profiles/:profile_id/recipes', requireAuth, createRecipeRouter(recipeService));
  v1.use('/profiles/:profile_id/recipe-variants', requireAuth, createRecipeVariantRouter(recipeVariantService));
  v1.use('/profiles/:profile_id', requireAuth, createEffectiveTargetRouter(effectiveTargetService));
  // Layer 5A — global food reference data and deterministic conversion
  // (not profile-scoped; see food.service.ts).
  v1.use('/foods', requireAuth, createFoodRouter(foodService));
  v1.use('/nutrients', requireAuth, createNutrientRouter(foodService));
  v1.use('/units', requireAuth, createUnitRouter());
  // Layer 5B — the single deterministic nutrition-calculation engine.
  v1.use('/nutrition', requireAuth, createNutritionRouter(nutritionService));
  app.use('/v1', v1);

  app.use((req, _res, next) => {
    next(AppError.notFound(`No route for ${req.method} ${req.path}.`));
  });

  app.use(createErrorHandler(logger));

  return app;
}
