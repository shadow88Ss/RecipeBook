import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { logger } from '../../src/lib/logger';
import { TEST_JWT_SECRET } from '../helpers/jwt';
import type { ProfileRepository } from '../../src/domain/profiles/profile.repository';
import type { ScopedDbFactory } from '../../src/lib/scopedDb';

const stubRepository: ProfileRepository = {
  listAccessibleProfiles: async () => [],
  getProfileById: async () => null,
};

const stubScopedDbFactory: ScopedDbFactory = {
  forUser: () => ({
    select: async () => [],
    insert: () => {
      throw new Error('not implemented in stub');
    },
    update: async () => null,
    rpc: async <T>() => null as unknown as T,
  }),
};

describe('GET /health', () => {
  it('spec §13: responds 200 without requiring authentication and without leaking configuration', async () => {
    const app = createApp({ profileRepository: stubRepository, scopedDbFactory: stubScopedDbFactory, jwtSecret: TEST_JWT_SECRET, logger });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    const raw = JSON.stringify(res.body);
    expect(raw.toLowerCase()).not.toMatch(/secret|password|token|connection|postgres:\/\//);
  });

  it('an unknown route returns a safe 404 envelope, not an Express default HTML error page', async () => {
    const app = createApp({ profileRepository: stubRepository, scopedDbFactory: stubScopedDbFactory, jwtSecret: TEST_JWT_SECRET, logger });
    const res = await request(app).get('/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
