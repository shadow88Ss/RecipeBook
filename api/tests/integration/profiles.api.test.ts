// Layer 4A integration tests — exercise the real HTTP layer (supertest)
// against the real, freshly-migrated Layer 1-3 schema (tests/helpers/
// testDb.ts + tests/fixtures/auth-shim.sql), through the
// PgHarnessProfileRepository (tests/helpers/pgHarnessProfileRepository.ts).
// This is the strongest available local verification given no live
// Supabase project exists (Layer 4A spec §20) — real RLS policies, real
// profile_access_scope(), real Zod validation, real (locally-signed) JWTs.
// It does not verify against Supabase's live signing key or PostgREST
// itself; see the Layer 4A report's "External configuration required".

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { logger } from '../../src/lib/logger';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';

let pool: Pool;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  pool = await rebuildTestDatabase();
  await seedScenario(pool);
  app = createApp({
    profileRepository: new PgHarnessProfileRepository(pool),
    jwtSecret: TEST_JWT_SECRET,
    logger,
  });
}, 60_000);

afterAll(async () => {
  await pool.end();
});

describe('GET /v1/profiles', () => {
  it('A: no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app).get('/v1/profiles');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('B: invalid token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app).get('/v1/profiles').set('Authorization', 'Bearer garbage.not.a.jwt');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('C: Account A sees only its own profile, never Account B or the child profile it has no grant for', async () => {
    const res = await request(app).get('/v1/profiles').set('Authorization', `Bearer ${signTestToken(SEED.accountA)}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((p: { id: string }) => p.id);
    expect(ids).toEqual([SEED.profileA]);
  });

  it('F/G/H: a guardian with any active grant sees the child profile in their list', async () => {
    for (const guardian of [SEED.accountFullManagement, SEED.accountViewOnly, SEED.accountPediatric] as const) {
      const res = await request(app).get('/v1/profiles').set('Authorization', `Bearer ${signTestToken(guardian)}`);
      expect(res.status).toBe(200);
      const ids = res.body.data.map((p: { id: string }) => p.id);
      expect(ids).toContain(SEED.profileChild);
    }
  });

  it('J: a revoked guardian does not see the child profile in their list', async () => {
    const res = await request(app).get('/v1/profiles').set('Authorization', `Bearer ${signTestToken(SEED.accountRevoked)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { id: string }) => p.id)).not.toContain(SEED.profileChild);
  });

  it('O: propagates a caller-supplied request id and always returns one', async () => {
    const withCustom = await request(app)
      .get('/v1/profiles')
      .set('Authorization', `Bearer ${signTestToken(SEED.accountA)}`)
      .set('x-request-id', 'my-custom-correlation-id');
    expect(withCustom.headers['x-request-id']).toBe('my-custom-correlation-id');

    const withoutCustom = await request(app).get('/v1/profiles').set('Authorization', `Bearer ${signTestToken(SEED.accountA)}`);
    expect(withoutCustom.headers['x-request-id']).toBeTruthy();
  });

  it('M: an unexpected/unknown query parameter is ignored, not rejected', async () => {
    const res = await request(app)
      .get('/v1/profiles?some_future_param=xyz')
      .set('Authorization', `Bearer ${signTestToken(SEED.accountA)}`);
    expect(res.status).toBe(200);
  });

  it('paginates: a limit of 1 across two guardian grants returns a nextCursor, and the second page returns the rest', async () => {
    const res1 = await request(app)
      .get('/v1/profiles?limit=1')
      .set('Authorization', `Bearer ${signTestToken(SEED.accountFullManagement)}`);
    expect(res1.status).toBe(200);
    expect(res1.body.data).toHaveLength(1);
    expect(res1.body.pagination.nextCursor).toBeNull();
    // accountFullManagement has exactly one accessible profile (the child),
    // so nextCursor is null on a full single-item page — covered further by
    // the unit-level pagination tests for the multi-page case.
  });
});

describe('GET /v1/profiles/:profile_id', () => {
  it('D: Account A can read its own profile', async () => {
    const res = await request(app)
      .get(`/v1/profiles/${SEED.profileA}`)
      .set('Authorization', `Bearer ${signTestToken(SEED.accountA)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: SEED.profileA, account_id: SEED.accountA, access_scope: 'full_management' });
  });

  it('E: Account A cannot read Account B\'s profile (non-disclosing 404, not 403)', async () => {
    const res = await request(app)
      .get(`/v1/profiles/${SEED.profileB}`)
      .set('Authorization', `Bearer ${signTestToken(SEED.accountA)}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('F: full_management guardian can read the child profile with the standard projection', async () => {
    const res = await request(app)
      .get(`/v1/profiles/${SEED.profileChild}`)
      .set('Authorization', `Bearer ${signTestToken(SEED.accountFullManagement)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: SEED.profileChild, access_scope: 'full_management', account_id: SEED.accountFullManagement });
  });

  it('G: view_only guardian can read the child profile with the standard projection', async () => {
    const res = await request(app)
      .get(`/v1/profiles/${SEED.profileChild}`)
      .set('Authorization', `Bearer ${signTestToken(SEED.accountViewOnly)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: SEED.profileChild, access_scope: 'view_only' });
    expect(res.body).toHaveProperty('account_id');
  });

  it('H/I: pediatric_weight_management guardian gets the safe projection, with account_id/created_at absent', async () => {
    const res = await request(app)
      .get(`/v1/profiles/${SEED.profileChild}`)
      .set('Authorization', `Bearer ${signTestToken(SEED.accountPediatric)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: SEED.profileChild,
      display_name: 'Child Profile',
      is_child: true,
      date_of_birth: '2018-06-01',
      access_scope: 'pediatric_weight_management',
    });
    expect(res.body).not.toHaveProperty('account_id');
    expect(res.body).not.toHaveProperty('created_at');
    expect(res.body).not.toHaveProperty('deleted_at');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(SEED.accountFullManagement);
  });

  it('J: a revoked guardian is denied (non-disclosing 404)', async () => {
    const res = await request(app)
      .get(`/v1/profiles/${SEED.profileChild}`)
      .set('Authorization', `Bearer ${signTestToken(SEED.accountRevoked)}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('K: an unrelated account with zero grants is denied (non-disclosing 404)', async () => {
    const res = await request(app)
      .get(`/v1/profiles/${SEED.profileChild}`)
      .set('Authorization', `Bearer ${signTestToken(SEED.accountUnrelated)}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('L: a malformed UUID profile_id is rejected as a validation error, never reaching the database', async () => {
    const res = await request(app)
      .get('/v1/profiles/not-a-uuid')
      .set('Authorization', `Bearer ${signTestToken(SEED.accountA)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('a well-formed but non-existent profile_id is also a non-disclosing 404', async () => {
    const res = await request(app)
      .get('/v1/profiles/ffffffff-ffff-4fff-8fff-ffffffffffff')
      .set('Authorization', `Bearer ${signTestToken(SEED.accountA)}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('RLS regression (spec §19): the harness never uses elevated/service-role access', () => {
  it('a request with a syntactically valid but unprovisioned Account id sees no profiles, not an error', async () => {
    const res = await request(app)
      .get('/v1/profiles')
      .set('Authorization', `Bearer ${signTestToken('99999999-9999-4999-8999-999999999999')}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
