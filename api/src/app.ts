// Layer 4A §1 — app factory. Takes its dependencies (repository, logger,
// jwt secret) as parameters rather than reaching for global state, so
// tests can build a fully wired app against either the production
// repository or the local RLS test harness (Layer 4A spec §20) without any
// conditional/test-only branch inside application code itself.

import express, { type Express } from 'express';
import { createAuthMiddleware } from './middleware/auth';
import { createErrorHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { createRequestLogging } from './middleware/requestLogging';
import { createHealthRouter } from './domain/health/health.routes';
import { createProfileRouter } from './domain/profiles/profile.routes';
import { ProfileService } from './domain/profiles/profile.service';
import type { ProfileRepository } from './domain/profiles/profile.repository';
import type { Logger } from './lib/logger';
import { AppError } from './lib/errors';

export interface AppDependencies {
  profileRepository: ProfileRepository;
  jwtSecret: string;
  logger: Logger;
}

export function createApp({ profileRepository, jwtSecret, logger }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestContext);
  app.use(createRequestLogging(logger));
  app.use(express.json({ limit: '1mb' }));

  // Unauthenticated: operational only, never behind /v1 (it is not a
  // versioned data contract).
  app.use('/health', createHealthRouter());

  const requireAuth = createAuthMiddleware({ jwtSecret });
  const profileService = new ProfileService(profileRepository);

  const v1 = express.Router();
  v1.use('/profiles', requireAuth, createProfileRouter(profileService));
  app.use('/v1', v1);

  app.use((req, _res, next) => {
    next(AppError.notFound(`No route for ${req.method} ${req.path}.`));
  });

  app.use(createErrorHandler(logger));

  return app;
}
