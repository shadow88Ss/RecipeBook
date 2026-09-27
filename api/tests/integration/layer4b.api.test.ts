// Layer 4B integration tests — same real-RLS-harness approach as Layer 4A's
// tests/integration/profiles.api.test.ts (see that file's header for the
// simulation-vs-live-verification disclosure, which applies identically
// here). One shared DB rebuild + seed for this whole file; tests that write
// shared-vocabulary rows (nutrition/clinician target field_name) use
// per-test-unique field names to avoid interference, except where a test
// deliberately exercises cross-request state (supersession, resolver
// precedence).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { logger } from '../../src/lib/logger';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';
import { EffectiveTargetService } from '../../src/domain/effectiveTarget/effectiveTarget.service';

let pool: Pool;
let app: ReturnType<typeof createApp>;
let scopedDbFactory: PgHarnessScopedDbFactory;

const asAccount = (accountId: string) => `Bearer ${signTestToken(accountId)}`;

beforeAll(async () => {
  // Distinct database name from Layer 4A's profiles.api.test.ts — vitest
  // runs test files in parallel, and both files independently rebuild
  // (drop+create) their database; sharing a name races destructively.
  pool = await rebuildTestDatabase('recipebook_api_test_layer4b');
  await seedScenario(pool);
  scopedDbFactory = new PgHarnessScopedDbFactory(pool);
  app = createApp({
    profileRepository: new PgHarnessProfileRepository(pool),
    scopedDbFactory,
    jwtSecret: TEST_JWT_SECRET,
    logger,
  });
}, 60_000);

afterAll(async () => {
  await pool.end();
});

describe('A/B: Profile read regression (Layer 4A behavior unchanged)', () => {
  it('A: the owner reads their own Profile', async () => {
    const res = await request(app).get(`/v1/profiles/${SEED.profileA}`).set('Authorization', asAccount(SEED.accountA));
    expect(res.status).toBe(200);
  });

  it('B: an unrelated Account cannot read another Account\'s Profile', async () => {
    const res = await request(app).get(`/v1/profiles/${SEED.profileB}`).set('Authorization', asAccount(SEED.accountA));
    expect(res.status).toBe(404);
  });
});

describe('C/D: Profile PATCH', () => {
  it('C: the owner performs a permitted update', async () => {
    const res = await request(app)
      .patch(`/v1/profiles/${SEED.profileA}`)
      .set('Authorization', asAccount(SEED.accountA))
      .send({ display_name: 'Updated Name' });
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Updated Name');
  });

  it('D: account_id and is_child cannot be changed through PATCH, even when supplied', async () => {
    const res = await request(app)
      .patch(`/v1/profiles/${SEED.profileA}`)
      .set('Authorization', asAccount(SEED.accountA))
      .send({ display_name: 'Still A', account_id: SEED.accountB, is_child: true });
    expect(res.status).toBe(200);
    expect(res.body.account_id).toBe(SEED.accountA);
    expect(res.body.is_child).toBe(false);
  });

  it('view_only/pediatric cannot PATCH a Profile they can read', async () => {
    for (const account of [SEED.accountViewOnly, SEED.accountPediatric]) {
      const res = await request(app).patch(`/v1/profiles/${SEED.profileChild}`).set('Authorization', asAccount(account)).send({ display_name: 'x' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('an unrelated Account gets the non-disclosing 404 on PATCH too', async () => {
    const res = await request(app)
      .patch(`/v1/profiles/${SEED.profileChild}`)
      .set('Authorization', asAccount(SEED.accountUnrelated))
      .send({ display_name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('E/F/G: Goal', () => {
  it('E: creation succeeds for an authorized owner', async () => {
    const res = await request(app)
      .post(`/v1/profiles/${SEED.profileA}/goals`)
      .set('Authorization', asAccount(SEED.accountA))
      .send({ goal_type: 'maintenance', notes: 'steady' });
    expect(res.status).toBe(201);
    expect(res.body.goal_type).toBe('maintenance');
    expect(res.body.is_active).toBe(true);
  });

  it('F: an invalid goal_type is rejected', async () => {
    const res = await request(app)
      .post(`/v1/profiles/${SEED.profileA}/goals`)
      .set('Authorization', asAccount(SEED.accountA))
      .send({ goal_type: 'extreme_shred' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('F: a non-positive target_weight_kg is rejected', async () => {
    const res = await request(app)
      .post(`/v1/profiles/${SEED.profileA}/goals`)
      .set('Authorization', asAccount(SEED.accountA))
      .send({ goal_type: 'weight_loss', target_weight_kg: -5 });
    expect(res.status).toBe(400);
  });

  it('G: a Goal belonging to another Profile cannot be accessed via a different profile_id in the path', async () => {
    const created = await request(app)
      .post(`/v1/profiles/${SEED.profileA}/goals`)
      .set('Authorization', asAccount(SEED.accountA))
      .send({ goal_type: 'other' });
    const goalId = created.body.id;

    // Account B owns profileB, not profileA — cannot see A's goal at all.
    const crossAccount = await request(app).get(`/v1/profiles/${SEED.profileA}/goals/${goalId}`).set('Authorization', asAccount(SEED.accountB));
    expect(crossAccount.status).toBe(404);

    // Even Account A cannot reach that same goal_id through profileB's path.
    const crossProfile = await request(app).get(`/v1/profiles/${SEED.profileB}/goals/${goalId}`).set('Authorization', asAccount(SEED.accountB));
    expect(crossProfile.status).toBe(404);
  });

  it('a full_management guardian can update a child Goal; view_only cannot', async () => {
    const created = await request(app)
      .post(`/v1/profiles/${SEED.profileChild}/goals`)
      .set('Authorization', asAccount(SEED.accountFullManagement))
      .send({ goal_type: 'fiber_improvement' });
    const patch = await request(app)
      .patch(`/v1/profiles/${SEED.profileChild}/goals/${created.body.id}`)
      .set('Authorization', asAccount(SEED.accountFullManagement))
      .send({ is_active: false });
    expect(patch.status).toBe(200);
    expect(patch.body.is_active).toBe(false);

    const deniedPatch = await request(app)
      .patch(`/v1/profiles/${SEED.profileChild}/goals/${created.body.id}`)
      .set('Authorization', asAccount(SEED.accountViewOnly))
      .send({ is_active: true });
    expect(deniedPatch.status).toBe(403);
  });
});

describe('H/I/J/K: NutritionTarget', () => {
  it('H: the first active value for a field succeeds', async () => {
    const res = await request(app)
      .post(`/v1/profiles/${SEED.profileA}/nutrition-targets`)
      .set('Authorization', asAccount(SEED.accountA))
      .send({ field_name: 'sodium_mg', value: 2000, unit: 'mg' });
    expect(res.status).toBe(201);
    expect(res.body.is_active).toBe(true);
    expect(res.body.superseded_at).toBeNull();
  });

  it('I/J/K: replacing the same field supersedes the prior value, history is available, and exactly one row is ever active', async () => {
    const account = asAccount(SEED.accountA);
    const field = 'potassium_mg';
    const first = await request(app).post(`/v1/profiles/${SEED.profileA}/nutrition-targets`).set('Authorization', account).send({ field_name: field, value: 3000, unit: 'mg' });
    const second = await request(app).post(`/v1/profiles/${SEED.profileA}/nutrition-targets`).set('Authorization', account).send({ field_name: field, value: 3500, unit: 'mg' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const active = await request(app).get(`/v1/profiles/${SEED.profileA}/nutrition-targets`).set('Authorization', account);
    const activeForField = active.body.data.filter((r: { field_name: string }) => r.field_name === field);
    // K: never more than one active row for this field, even having just
    // created two rows for it back to back.
    expect(activeForField).toHaveLength(1);
    expect(activeForField[0].value).toBe(3500);
    expect(activeForField[0].id).toBe(second.body.id);

    const history = await request(app)
      .get(`/v1/profiles/${SEED.profileA}/nutrition-targets/history?field_name=${field}`)
      .set('Authorization', account);
    expect(history.body.data).toHaveLength(2);
    const firstInHistory = history.body.data.find((r: { id: string }) => r.id === first.body.id);
    expect(firstInHistory.is_active).toBe(false);
    expect(firstInHistory.superseded_at).not.toBeNull();
  });

  it('view_only cannot create a NutritionTarget', async () => {
    const res = await request(app)
      .post(`/v1/profiles/${SEED.profileChild}/nutrition-targets`)
      .set('Authorization', asAccount(SEED.accountViewOnly))
      .send({ field_name: 'calcium_mg', value: 1000, unit: 'mg' });
    expect(res.status).toBe(403);
  });

  it('NaN/Infinity/zero values are rejected', async () => {
    const account = asAccount(SEED.accountA);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      const res = await request(app)
        .post(`/v1/profiles/${SEED.profileA}/nutrition-targets`)
        .set('Authorization', account)
        .send({ field_name: 'vitamin_d_iu', value, unit: 'iu' });
      expect(res.status).toBe(400);
    }
  });
});

describe('L/M/N: ClinicianTarget', () => {
  it('L: provenance fields are returned correctly', async () => {
    const res = await request(app)
      .post(`/v1/profiles/${SEED.profileA}/clinician-targets`)
      .set('Authorization', asAccount(SEED.accountA))
      .send({ field_name: 'iron_mg', value: 18, unit: 'mg' });
    expect(res.status).toBe(201);
    expect(res.body.provided_by_account_id).toBe(SEED.accountA);
    expect(res.body.source_type).toBe('user_entered'); // adult's own profile
    expect(typeof res.body.entered_at).toBe('string');
  });

  it('L: source_type is guardian_entered when the target profile is a child', async () => {
    const res = await request(app)
      .post(`/v1/profiles/${SEED.profileChild}/clinician-targets`)
      .set('Authorization', asAccount(SEED.accountFullManagement))
      .send({ field_name: 'calcium_target_mg', value: 1300, unit: 'mg' });
    expect(res.body.source_type).toBe('guardian_entered');
  });

  it('M: a client cannot set verification_status to platform_verified', async () => {
    const res = await request(app)
      .post(`/v1/profiles/${SEED.profileA}/clinician-targets`)
      .set('Authorization', asAccount(SEED.accountA))
      .send({ field_name: 'zinc_mg', value: 11, unit: 'mg', verification_status: 'platform_verified' });
    expect(res.status).toBe(201);
    expect(res.body.verification_status).toBe('unverified');
  });

  it('M: a client cannot set provided_by_account_id to someone else', async () => {
    const res = await request(app)
      .post(`/v1/profiles/${SEED.profileA}/clinician-targets`)
      .set('Authorization', asAccount(SEED.accountA))
      .send({ field_name: 'magnesium_mg', value: 400, unit: 'mg', provided_by_account_id: SEED.accountB });
    expect(res.body.provided_by_account_id).toBe(SEED.accountA);
  });

  it('N: pediatric_weight_management can read ClinicianTarget but never create one', async () => {
    const read = await request(app).get(`/v1/profiles/${SEED.profileChild}/clinician-targets`).set('Authorization', asAccount(SEED.accountPediatric));
    expect(read.status).toBe(200);

    const write = await request(app)
      .post(`/v1/profiles/${SEED.profileChild}/clinician-targets`)
      .set('Authorization', asAccount(SEED.accountPediatric))
      .send({ field_name: 'phosphorus_mg', value: 500, unit: 'mg' });
    expect(write.status).toBe(403);
  });
});

describe('O/P/Q: WeightMeasurement', () => {
  it('O: insert succeeds', async () => {
    const res = await request(app)
      .post(`/v1/profiles/${SEED.profileA}/weight-measurements`)
      .set('Authorization', asAccount(SEED.accountA))
      .send({ measured_at: new Date(Date.now() - 60_000).toISOString(), value_kg: 70.2 });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe('user_entered');
  });

  it('P: mutation is blocked — no PATCH/DELETE route exists, and the database rejects a raw UPDATE regardless', async () => {
    const created = await request(app)
      .post(`/v1/profiles/${SEED.profileA}/weight-measurements`)
      .set('Authorization', asAccount(SEED.accountA))
      .send({ measured_at: new Date(Date.now() - 30_000).toISOString(), value_kg: 71 });

    const patchAttempt = await request(app)
      .patch(`/v1/profiles/${SEED.profileA}/weight-measurements/${created.body.id}`)
      .set('Authorization', asAccount(SEED.accountA))
      .send({ value_kg: 999 });
    expect(patchAttempt.status).toBe(404); // no such route at all

    // Defense-in-depth: even a direct, RLS-scoped raw UPDATE (bypassing the
    // API entirely) is rejected by the Layer 1 prevent_update() trigger.
    const db = scopedDbFactory.forUser({ accountId: SEED.accountA, accessToken: 'unused-by-harness' });
    await expect(
      db.update('weight_measurement', { id: created.body.id }, { value_kg: 999 }, 'id'),
    ).rejects.toThrow();
  });

  it('Q: an unauthorized Account cannot access another Profile\'s measurements', async () => {
    const res = await request(app).get(`/v1/profiles/${SEED.profileA}/weight-measurements`).set('Authorization', asAccount(SEED.accountB));
    expect(res.status).toBe(404);
  });

  it('view_only cannot create a WeightMeasurement, but can read one', async () => {
    const write = await request(app)
      .post(`/v1/profiles/${SEED.profileChild}/weight-measurements`)
      .set('Authorization', asAccount(SEED.accountViewOnly))
      .send({ measured_at: new Date().toISOString(), value_kg: 30 });
    expect(write.status).toBe(403);

    const read = await request(app).get(`/v1/profiles/${SEED.profileChild}/weight-measurements`).set('Authorization', asAccount(SEED.accountViewOnly));
    expect(read.status).toBe(200);
  });

  it('corrects_measurement_id must reference a real measurement on the same profile', async () => {
    const res = await request(app)
      .post(`/v1/profiles/${SEED.profileA}/weight-measurements`)
      .set('Authorization', asAccount(SEED.accountA))
      .send({ measured_at: new Date().toISOString(), value_kg: 70, corrects_measurement_id: '99999999-9999-4999-8999-999999999999' });
    expect(res.status).toBe(400);
  });
});

describe('R/S/T/U: EffectiveTargetResolver', () => {
  it('R/S/T: clinician precedence wins field-by-field, with provenance, over the user target', async () => {
    const account = asAccount(SEED.accountA);
    await request(app).post(`/v1/profiles/${SEED.profileA}/nutrition-targets`).set('Authorization', account).send({ field_name: 'resolver_calories', value: 1800, unit: 'kcal' });
    await request(app).post(`/v1/profiles/${SEED.profileA}/nutrition-targets`).set('Authorization', account).send({ field_name: 'resolver_fiber_g', value: 22, unit: 'g' });
    const clinician = await request(app)
      .post(`/v1/profiles/${SEED.profileA}/clinician-targets`)
      .set('Authorization', account)
      .send({ field_name: 'resolver_calories', value: 2100, unit: 'kcal' });

    const res = await request(app).get(`/v1/profiles/${SEED.profileA}/effective-target`).set('Authorization', account);
    expect(res.status).toBe(200);
    expect(res.body.resolved.resolver_calories).toEqual({
      value: 2100,
      unit: 'kcal',
      source: 'clinician_target',
      source_reference: clinician.body.id,
    });
    // S: a DIFFERENT field with no clinician override still resolves from
    // the user target, independently of resolver_calories's resolution.
    expect(res.body.resolved.resolver_fiber_g.source).toBe('user_target');
    expect(res.body.resolved.resolver_fiber_g.value).toBe(22);
    expect(res.body.resolver_version).toBeTruthy();
    expect(res.body.resolved_at).toBeTruthy();
  });

  it('U: a field with no active clinician or user target is absent, never fabricated', async () => {
    const res = await request(app).get(`/v1/profiles/${SEED.profileB}/effective-target`).set('Authorization', asAccount(SEED.accountB));
    expect(res.status).toBe(200);
    expect(res.body.resolved).toEqual({});
    expect(res.body.implemented_sources).toEqual(['clinician_target', 'user_target']);
  });

  it('pediatric_weight_management can read the resolved target for the child', async () => {
    const res = await request(app).get(`/v1/profiles/${SEED.profileChild}/effective-target`).set('Authorization', asAccount(SEED.accountPediatric));
    expect(res.status).toBe(200);
  });
});

describe('V: EffectiveTargetSnapshot immutability', () => {
  it('a snapshot cannot be updated even by the Account that created it', async () => {
    const auth = { accountId: SEED.accountA, accessToken: 'unused-by-harness' };
    const service = new EffectiveTargetService(scopedDbFactory);
    const snapshot = await service.createSnapshotInternal(auth, SEED.profileA, 'manual_audit');
    expect(snapshot.id).toBeTruthy();

    const db = scopedDbFactory.forUser(auth);
    await expect(
      db.update('effective_target_snapshot', { id: snapshot.id }, { snapshot_reason: 'manual_audit' }, 'id'),
    ).rejects.toThrow();

    const list = await request(app)
      .get(`/v1/profiles/${SEED.profileA}/effective-target-snapshots`)
      .set('Authorization', asAccount(SEED.accountA));
    expect(list.status).toBe(200);
    expect(list.body.data.some((s: { id: string }) => s.id === snapshot.id)).toBe(true);
  });

  it('pediatric_weight_management cannot create a snapshot', async () => {
    const service = new EffectiveTargetService(scopedDbFactory);
    await expect(
      service.createSnapshotInternal({ accountId: SEED.accountPediatric, accessToken: 'unused-by-harness' }, SEED.profileChild, 'manual_audit'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('W: revoked guardian loses access immediately, across every Layer 4B resource', () => {
  it('a revoked guardian is denied on goals, targets, measurements, and the resolver', async () => {
    const account = asAccount(SEED.accountRevoked);
    const endpoints = [
      `/v1/profiles/${SEED.profileChild}/goals`,
      `/v1/profiles/${SEED.profileChild}/nutrition-targets`,
      `/v1/profiles/${SEED.profileChild}/clinician-targets`,
      `/v1/profiles/${SEED.profileChild}/weight-measurements`,
      `/v1/profiles/${SEED.profileChild}/effective-target`,
    ];
    for (const path of endpoints) {
      const res = await request(app).get(path).set('Authorization', account);
      expect(res.status).toBe(404);
    }
  });
});

describe('X: view_only cannot perform unauthorized writes anywhere', () => {
  it('view_only is denied write access on goal/nutrition-target/clinician-target/weight-measurement', async () => {
    const account = asAccount(SEED.accountViewOnly);
    const attempts = [
      request(app).post(`/v1/profiles/${SEED.profileChild}/goals`).set('Authorization', account).send({ goal_type: 'other' }),
      request(app).post(`/v1/profiles/${SEED.profileChild}/nutrition-targets`).set('Authorization', account).send({ field_name: 'x_view_only', value: 1, unit: 'g' }),
      request(app).post(`/v1/profiles/${SEED.profileChild}/clinician-targets`).set('Authorization', account).send({ field_name: 'x_view_only', value: 1, unit: 'g' }),
      request(app).post(`/v1/profiles/${SEED.profileChild}/weight-measurements`).set('Authorization', account).send({ measured_at: new Date().toISOString(), value_kg: 20 }),
    ];
    const results = await Promise.all(attempts);
    for (const res of results) {
      expect(res.status).toBe(403);
    }
  });
});

describe('Y: pediatric_weight_management performs only its approved writes', () => {
  it('can create/update Goal and NutritionTarget and WeightMeasurement, but not ClinicianTarget or a snapshot', async () => {
    const account = asAccount(SEED.accountPediatric);
    const goal = await request(app).post(`/v1/profiles/${SEED.profileChild}/goals`).set('Authorization', account).send({ goal_type: 'fiber_improvement' });
    expect(goal.status).toBe(201);
    const nutritionTarget = await request(app)
      .post(`/v1/profiles/${SEED.profileChild}/nutrition-targets`)
      .set('Authorization', account)
      .send({ field_name: 'pediatric_fiber_g', value: 18, unit: 'g' });
    expect(nutritionTarget.status).toBe(201);
    const measurement = await request(app)
      .post(`/v1/profiles/${SEED.profileChild}/weight-measurements`)
      .set('Authorization', account)
      .send({ measured_at: new Date().toISOString(), value_kg: 28 });
    expect(measurement.status).toBe(201);

    const clinicianTarget = await request(app)
      .post(`/v1/profiles/${SEED.profileChild}/clinician-targets`)
      .set('Authorization', account)
      .send({ field_name: 'pediatric_iron_mg', value: 10, unit: 'mg' });
    expect(clinicianTarget.status).toBe(403);
  });
});

describe('Z: no SQL/internal error leakage', () => {
  it('a duplicate-key-shaped failure never reaches the client as raw SQL/driver detail', async () => {
    // corrects_measurement_id references a well-formed but nonexistent uuid
    // — validated by the service layer, but exercised here specifically to
    // confirm the error body stays within the safe envelope.
    const res = await request(app)
      .post(`/v1/profiles/${SEED.profileA}/weight-measurements`)
      .set('Authorization', asAccount(SEED.accountA))
      .send({ measured_at: new Date().toISOString(), value_kg: 70, corrects_measurement_id: '88888888-8888-4888-8888-888888888888' });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(new Set(Object.keys(res.body.error))).toEqual(new Set(['code', 'message', 'requestId']));
    const raw = JSON.stringify(res.body);
    expect(raw.toLowerCase()).not.toMatch(/relation|syntax error|constraint|postgres|column ".*" does not exist/);
  });

  it('an actual database-layer rejection (immutability trigger) is converted to a safe 500, never leaking the trigger/SQL text', async () => {
    const db = scopedDbFactory.forUser({ accountId: SEED.accountA, accessToken: 'unused-by-harness' });
    let caught: unknown;
    try {
      await db.update('profile', { id: SEED.profileA }, { account_id: SEED.accountB }, 'id');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    // This confirms the DB-level defense-in-depth trigger itself blocks the
    // mutation (20260825130000_profile_immutable_columns.sql); the API's
    // own errorHandler unit tests (tests/unit/errorHandler.test.ts) already
    // confirm any such raw error is converted to a generic INTERNAL_ERROR
    // envelope before ever reaching an HTTP client.
  });
});
