// Layer 5A integration tests — Food & Conversion Foundation.
//
// Same real-RLS harness as Layers 4A/4B (see profiles.api.test.ts's
// header): the full committed migration chain, including
// 20260927120000_food_conversion_foundation.sql, is applied to a throwaway
// Postgres database and every API read runs as the `authenticated` role
// with the caller's account id in the session. Food rows come from
// tests/helpers/foodFixtures.ts — illustrative TEST FIXTURES, not
// production food data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { logger } from '../../src/lib/logger';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { FOOD, NUTRIENT, SERVING, seedFoodFixtures } from '../helpers/foodFixtures';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';

let pool: Pool;
let app: ReturnType<typeof createApp>;

const auth = (accountId: string = SEED.accountA) => `Bearer ${signTestToken(accountId)}`;
const search = (query: Record<string, string | number>) => request(app).get('/v1/foods').query(query).set('Authorization', auth());
const convertFood = (foodId: string, body: unknown) =>
  request(app).post(`/v1/foods/${foodId}/convert`).set('Authorization', auth()).send(body as object);

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer5a');
  await seedScenario(pool);
  await seedFoodFixtures(pool);
  app = createApp({
    profileRepository: new PgHarnessProfileRepository(pool),
    scopedDbFactory: new PgHarnessScopedDbFactory(pool),
    jwtSecret: TEST_JWT_SECRET,
    logger,
  });
}, 60_000);

afterAll(async () => {
  await pool.end();
});

describe('authentication', () => {
  it('every Layer 5A endpoint rejects a missing token with 401', async () => {
    const calls = [
      request(app).get('/v1/foods').query({ q: 'chick' }),
      request(app).get(`/v1/foods/${FOOD.flour}`),
      request(app).post(`/v1/foods/${FOOD.flour}/convert`).send({ quantity: 1, from: { unit: 'g' }, to: { unit: 'oz' } }),
      request(app).get('/v1/nutrients'),
      request(app).get('/v1/units'),
      request(app).post('/v1/units/convert').send({ quantity: 1, from_unit: 'g', to_unit: 'kg' }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('food reference data is global: any authenticated Account sees the same result', async () => {
    const results = await Promise.all(
      [SEED.accountA, SEED.accountUnrelated, SEED.accountPediatric].map((account) =>
        request(app).get('/v1/foods').query({ q: 'chick' }).set('Authorization', auth(account)),
      ),
    );
    const ids = results.map((r) => r.body.data.map((f: { id: string }) => f.id));
    expect(ids[0]).toHaveLength(4);
    expect(ids[1]).toEqual(ids[0]);
    expect(ids[2]).toEqual(ids[0]);
  });
});

describe('GET /v1/foods — search', () => {
  it('ranks exact > prefix > contains, then validated before ai_matched, deterministically', async () => {
    const res = await search({ q: 'chick' });
    expect(res.status).toBe(200);
    expect(res.body.data.map((f: { id: string }) => f.id)).toEqual([FOOD.chickpeas, FOOD.chickenBreast, FOOD.chickpeaFlour, FOOD.aiOnly]);
    expect(res.body.data[0]).toMatchObject({
      canonical_name: 'fixture_chickpeas_cooked',
      display_name: 'Chickpeas',
      display_locale: 'en',
      source: 'trusted_database',
      match: { source: 'alias', text: 'Chickpeas', locale: 'en', kind: 'prefix', alias_source: 'trusted_database', identity_confirmation_required: false },
    });
    expect(res.body.data[3].match).toMatchObject({ text: 'Chickpea snack', alias_source: 'ai_matched', identity_confirmation_required: true });

    const exact = await search({ q: 'CHICKPEAS' });
    expect(exact.body.data[0].match.kind).toBe('exact');

    const contains = await search({ q: 'flour' });
    expect(contains.body.data.map((f: { match: { kind: string } }) => f.match.kind)).toEqual(['contains', 'contains']);
  });

  it('matches an alias in any locale and resolves the display name through the locale chain', async () => {
    const ar = await search({ q: 'حمص', locale: 'ar-AE' });
    expect(ar.body.data).toHaveLength(1);
    expect(ar.body.data[0]).toMatchObject({
      id: FOOD.chickpeas,
      display_name: 'حمص حب',
      display_locale: 'ar-AE',
      match: { source: 'alias', text: 'حمص', locale: 'ar', kind: 'exact' },
    });

    const englishQueryArabicLocale = await search({ q: 'garbanzo', locale: 'ar' });
    expect(englishQueryArabicLocale.body.data[0]).toMatchObject({ id: FOOD.chickpeas, display_name: 'حمص', display_locale: 'ar' });
  });

  it('falls back to en when the requested locale has no alias', async () => {
    const res = await search({ q: 'chickpeas', locale: 'fr-FR' });
    expect(res.body.data[0]).toMatchObject({ display_name: 'Chickpeas', display_locale: 'en' });
  });

  it('prefers the caller\'s regional alias when one exists', async () => {
    const india = await search({ q: 'besan', locale: 'en-IN' });
    expect(india.body.data[0]).toMatchObject({ id: FOOD.chickpeaFlour, display_name: 'Besan', display_locale: 'en-IN' });
    const generic = await search({ q: 'besan', locale: 'en' });
    expect(generic.body.data[0]).toMatchObject({ id: FOOD.chickpeaFlour, display_name: 'Chickpea flour', display_locale: 'en' });
  });

  it('normalizes the term (case, whitespace, NFKC) and treats % and _ literally', async () => {
    const spaced = await search({ q: '  WHEAT    Flour ' });
    expect(spaced.body.data[0].id).toBe(FOOD.flour);
    const fullWidth = await search({ q: 'ＷＨＥＡＴ' });
    expect(fullWidth.body.data[0].id).toBe(FOOD.flour);

    const percent = await search({ q: '%' });
    expect(percent.body.data.map((f: { id: string }) => f.id)).toEqual([FOOD.percentFood]);
    // '_' is literal too: it matches no alias, only canonical_name keys
    // that really contain an underscore — never "any single character".
    const underscore = await search({ q: '_' });
    expect(underscore.body.data.length).toBeGreaterThan(0);
    for (const food of underscore.body.data) {
      expect(food.match.source).toBe('canonical_name');
      expect(food.canonical_name).toContain('_');
    }
  });

  it('returns an empty page (not an error) when nothing matches', async () => {
    const res = await search({ q: 'zzzz-no-such-food' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], pagination: { nextCursor: null, limit: 20 } });
  });

  it('paginates with the Layer 4A cursor convention', async () => {
    const first = await search({ q: 'chick', limit: 2 });
    expect(first.body.data).toHaveLength(2);
    expect(first.body.pagination.nextCursor).toEqual(expect.any(String));
    const second = await search({ q: 'chick', limit: 2, cursor: first.body.pagination.nextCursor });
    expect(second.body.data.map((f: { id: string }) => f.id)).toEqual([FOOD.chickpeaFlour, FOOD.aiOnly]);
    expect(second.body.pagination.nextCursor).toBeNull();

    const bad = await search({ q: 'chick', cursor: 'not-a-cursor' });
    expect(bad.status).toBe(400);
  });

  it('validates q and locale', async () => {
    for (const query of [{}, { q: '   ' }, { q: 'x'.repeat(101) }, { q: 'rice', locale: 'english' }, { q: 'rice', locale: 'en_US' }]) {
      const res = await search(query);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('Final alignment — canonical_name search fallback (item 7)', () => {
  it('finds a food by exact canonical_name, and still labels it only from its aliases', async () => {
    const res = await search({ q: 'fixture_chickpeas_cooked', locale: 'ar-AE' });
    expect(res.body.data[0]).toMatchObject({
      id: FOOD.chickpeas,
      display_name: 'حمص حب',
      display_locale: 'ar-AE',
      match: { source: 'canonical_name', text: 'fixture_chickpeas_cooked', locale: null, kind: 'exact', alias_source: null },
    });
  });

  it('finds a food by canonical_name prefix, with "_" also matched as a space', async () => {
    const raw = await search({ q: 'fixture_lent' });
    expect(raw.body.data.map((f: { id: string }) => f.id)).toEqual([FOOD.lentils]);
    expect(raw.body.data[0].match).toMatchObject({ source: 'canonical_name', kind: 'prefix' });

    const spaced = await search({ q: 'Fixture Chickpea' });
    const byCanonical = spaced.body.data.filter((f: { match: { source: string } }) => f.match.source === 'canonical_name');
    // Both are prefix matches; the shorter key ranks first (deterministic tiebreak).
    expect(byCanonical.map((f: { id: string }) => f.id)).toEqual([FOOD.chickpeaFlour, FOOD.chickpeas]);
    expect(byCanonical.every((f: { match: { kind: string } }) => f.match.kind === 'prefix')).toBe(true);
  });

  it('never exposes canonical_name as display_name for a food with no alias', async () => {
    const res = await search({ q: 'fixture_lentils' });
    expect(res.body.data[0]).toMatchObject({ id: FOOD.lentils, canonical_name: 'fixture_lentils', display_name: null, display_locale: null });
    const detail = await request(app).get(`/v1/foods/${FOOD.lentils}`).set('Authorization', auth());
    expect(detail.body).toMatchObject({ canonical_name: 'fixture_lentils', display_name: null, aliases: [] });
  });

  it('prefers a localized alias match over a canonical_name match for the same food', async () => {
    // "chickpeas" is an exact alias AND a canonical_name substring.
    const res = await search({ q: 'chickpeas' });
    expect(res.body.data[0]).toMatchObject({ id: FOOD.chickpeas, match: { source: 'alias', text: 'Chickpeas', kind: 'exact' } });
  });

  it('ranks an alias-matched food ahead of a better canonical_name match on another food', async () => {
    // fixture_lentils matches "fixture lentils" EXACTLY by canonical_name;
    // fixture_soup_base matches only as an alias PREFIX — the alias still wins.
    const res = await search({ q: 'fixture lentils' });
    expect(res.body.data.map((f: { id: string }) => f.id)).toEqual([FOOD.lentilSoup, FOOD.lentils]);
    expect(res.body.data[0].match).toMatchObject({ source: 'alias', kind: 'prefix' });
    expect(res.body.data[1].match).toMatchObject({ source: 'canonical_name', kind: 'exact' });
  });
});

describe('Final alignment — AI identity vs nutrition authority (item 8)', () => {
  it('an ai_matched alias identifies a food (flagged for confirmation) but creates no nutrient data', async () => {
    const before = await pool.query('select count(*)::int as n from food_nutrient');

    const found = await search({ q: 'chickpea snack' });
    expect(found.body.data[0]).toMatchObject({
      id: FOOD.aiOnly,
      match: { source: 'alias', alias_source: 'ai_matched', identity_confirmation_required: true },
    });

    const detail = await request(app).get(`/v1/foods/${FOOD.aiOnly}`).set('Authorization', auth());
    expect(detail.status).toBe(200);
    expect(detail.body.nutrients).toEqual([]);
    expect(detail.body.density).toBeNull();
    expect(detail.body.servings).toEqual([]);

    const conversion = await convertFood(FOOD.aiOnly, { quantity: 1, from: { unit: 'cup_us' }, to: { unit: 'g' } });
    expect(conversion.body).toMatchObject({ status: 'unresolved', reason: 'density_unavailable' });

    const after = await pool.query('select count(*)::int as n from food_nutrient');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const own = await pool.query('select count(*)::int as n from food_nutrient where food_id = $1', [FOOD.aiOnly]);
    expect(own.rows[0].n).toBe(0);
  });

  it('a conversion using ai_matched serving weight or density is never authoritative', async () => {
    const density = await convertFood(FOOD.chickpeaFlour, { quantity: 100, from: { unit: 'ml' }, to: { unit: 'g' } });
    expect(density.body).toMatchObject({ status: 'converted', confirmation_required: true, authoritative: false });
    const serving = await convertFood(FOOD.chickpeaFlour, { quantity: 1, from: { serving_id: SERVING.aiScoop }, to: { unit: 'g' } });
    expect(serving.body).toMatchObject({ confirmation_required: true, authoritative: false });
    const trusted = await convertFood(FOOD.flour, { quantity: 1, from: { unit: 'cup_us' }, to: { unit: 'g' } });
    expect(trusted.body).toMatchObject({ confirmation_required: false, authoritative: true });
  });
});

describe('Final alignment — conversion rules (items 2, 4)', () => {
  it('every generic household unit stays unresolved, never defaulted to a regional system', async () => {
    for (const unit of ['cup', 'tbsp', 'tsp', 'fl_oz', 'pint', 'quart', 'gallon']) {
      const res = await request(app).post('/v1/units/convert').set('Authorization', auth()).send({ quantity: 1, from_unit: unit, to_unit: 'ml' });
      expect(res.body).toMatchObject({ status: 'unresolved', reason: 'ambiguous_unit' });
      expect(res.body.candidates.length).toBeGreaterThan(1);
      const viaFood = await convertFood(FOOD.flour, { quantity: 1, from: { unit }, to: { unit: 'g' } });
      expect(viaFood.body).toMatchObject({ status: 'unresolved', reason: 'ambiguous_unit' });
    }
  });

  it('mass <-> volume without food density stays unresolved (1 ml is never assumed to be 1 g)', async () => {
    for (const [from, to] of [['ml', 'g'], ['g', 'ml'], ['l', 'kg']]) {
      const res = await convertFood(FOOD.chickpeas, { quantity: 1, from: { unit: from }, to: { unit: to } });
      expect(res.body).toMatchObject({ status: 'unresolved', reason: 'density_unavailable' });
      const noFood = await request(app).post('/v1/units/convert').set('Authorization', auth()).send({ quantity: 1, from_unit: from, to_unit: to });
      expect(noFood.body).toMatchObject({ status: 'unresolved', reason: 'incompatible_dimensions' });
    }
    // A mass serving still cannot be expressed in volume without density.
    const serving = await convertFood(FOOD.chickpeas, { quantity: 1, from: { serving_id: SERVING.chickpeasCan }, to: { unit: 'cup_us' } });
    expect(serving.body).toMatchObject({ status: 'unresolved', reason: 'density_unavailable' });
  });
});

describe('GET /v1/foods/{food_id} — detail', () => {
  it('returns aliases, servings, nutrients and density with provenance', async () => {
    const res = await request(app).get(`/v1/foods/${FOOD.chickpeas}`).query({ locale: 'ar-ae' }).set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: FOOD.chickpeas,
      canonical_name: 'fixture_chickpeas_cooked',
      category: 'legumes',
      source: 'trusted_database',
      display_name: 'حمص حب',
      display_locale: 'ar-AE',
      locale: 'ar-AE',
      region: 'AE',
      density: null,
    });
    expect(res.body.aliases.map((a: { locale: string; alias_text: string }) => `${a.locale}:${a.alias_text}`)).toEqual([
      'ar-AE:حمص حب',
      'ar:حمص',
      'en:Chickpeas',
      'en:Garbanzo beans',
    ]);
    expect(res.body.servings).toEqual([
      { id: SERVING.chickpeasCan, serving_description: '1 can, drained', region: null, canonical_quantity: 240, canonical_unit: 'g', source: 'trusted_database' },
    ]);
    expect(res.body.nutrients).toEqual([
      expect.objectContaining({ nutrient_id: NUTRIENT.energy, nutrient_key: 'energy', nutrient_unit: 'kcal', amount: 164, basis_quantity: 100, basis_unit: 'g', source: 'trusted_database' }),
      expect.objectContaining({ nutrient_key: 'fiber', amount: 7.6 }),
      expect.objectContaining({ nutrient_key: 'protein', amount: 9.1, source: 'manufacturer_label' }),
      expect.objectContaining({ nutrient_key: 'protein', amount: 8.9, source: 'trusted_database' }),
    ]);
  });

  it('filters servings by region (explicit, or derived from the locale) and keeps region-agnostic ones', async () => {
    const get = (query: Record<string, string>) => request(app).get(`/v1/foods/${FOOD.flour}`).query(query).set('Authorization', auth());
    const ids = (res: { body: { servings: Array<{ id: string }> } }) => res.body.servings.map((s) => s.id);

    expect(ids(await get({ locale: 'en-AU' }))).toEqual([SERVING.flourCupAu, SERVING.flourTbsp]);
    expect(ids(await get({ locale: 'en-AU', region: 'us' }))).toEqual([SERVING.flourCupUs, SERVING.flourTbsp]);
    expect(ids(await get({}))).toEqual([SERVING.flourCupAu, SERVING.flourCupUs, SERVING.flourTbsp]);

    const flour = await get({});
    expect(flour.body.density).toEqual({ g_per_ml: 0.593, source: 'trusted_database' });
    expect(flour.body.region).toBeNull();
  });

  it('returns 404 for an unknown food and 400 for a malformed id or region', async () => {
    const missing = await request(app).get('/v1/foods/00000000-0000-4000-8000-00000000abcd').set('Authorization', auth());
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    expect((await request(app).get('/v1/foods/not-a-uuid').set('Authorization', auth())).status).toBe(400);
    expect((await request(app).get(`/v1/foods/${FOOD.flour}`).query({ region: 'USA' }).set('Authorization', auth())).status).toBe(400);
  });
});

describe('POST /v1/foods/{food_id}/convert', () => {
  it('converts a household volume to grams through the food\'s stored density', async () => {
    const res = await convertFood(FOOD.flour, { quantity: 1, from: { unit: 'cup_us' }, to: { unit: 'g' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'converted',
      quantity: 140.296824,
      unit: 'g',
      serving_id: null,
      precision: { decimal_places: 6, rounding: 'half_up' },
      confirmation_required: false,
      conversion_version: 'conversion-5a.1',
    });
    expect(res.body.provenance).toContainEqual({ kind: 'food_density', reference: FOOD.flour, source: 'trusted_database', authority: 'global_reference' });
  });

  it('converts servings both ways, including a region-specific serving by explicit id', async () => {
    const au = await convertFood(FOOD.flour, { quantity: 1, from: { serving_id: SERVING.flourCupAu }, to: { unit: 'g' } });
    expect(au.body).toMatchObject({ status: 'converted', quantity: 148.25 });

    const toServing = await convertFood(FOOD.flour, { quantity: 100, from: { unit: 'g' }, to: { serving_id: SERVING.flourTbsp } });
    expect(toServing.body).toMatchObject({ status: 'converted', quantity: 12.820513, unit: 'serving', serving_id: SERVING.flourTbsp });

    const piece = await convertFood(FOOD.chickenBreast, { quantity: 1.5, from: { serving_id: SERVING.chickenPiece }, to: { unit: 'oz' } });
    expect(piece.body).toMatchObject({ status: 'converted', quantity: 6.349313 });
    expect(piece.body.provenance[0]).toEqual({ kind: 'food_serving', reference: SERVING.chickenPiece, source: 'trusted_database', authority: 'global_reference' });
  });

  it('returns unresolved outcomes (200) instead of guessing', async () => {
    const noDensity = await convertFood(FOOD.chickpeas, { quantity: 1, from: { unit: 'cup_us' }, to: { unit: 'g' } });
    expect(noDensity.status).toBe(200);
    expect(noDensity.body).toMatchObject({ status: 'unresolved', reason: 'density_unavailable' });

    const ambiguous = await convertFood(FOOD.flour, { quantity: 1, from: { unit: 'cup' }, to: { unit: 'g' } });
    expect(ambiguous.body).toMatchObject({ status: 'unresolved', reason: 'ambiguous_unit', candidates: ['cup_us', 'cup_metric', 'cup_us_legal'] });

    const unknown = await convertFood(FOOD.flour, { quantity: 1, from: { unit: 'handful' }, to: { unit: 'g' } });
    expect(unknown.body).toMatchObject({ status: 'unresolved', reason: 'unknown_unit' });

    // A serving that belongs to a different food is never applied.
    const foreign = await convertFood(FOOD.chickpeas, { quantity: 1, from: { serving_id: SERVING.flourTbsp }, to: { unit: 'g' } });
    expect(foreign.body).toMatchObject({ status: 'unresolved', reason: 'serving_not_found' });
  });

  it('flags ai_matched reference data as requiring confirmation', async () => {
    const density = await convertFood(FOOD.chickpeaFlour, { quantity: 100, from: { unit: 'ml' }, to: { unit: 'g' } });
    expect(density.body).toMatchObject({ status: 'converted', quantity: 41, confirmation_required: true });
    const serving = await convertFood(FOOD.chickpeaFlour, { quantity: 2, from: { serving_id: SERVING.aiScoop }, to: { unit: 'g' } });
    expect(serving.body).toMatchObject({ status: 'converted', quantity: 60, confirmation_required: true });
  });

  it('validates the request and 404s an unknown food', async () => {
    const invalid = [
      { quantity: 0, from: { unit: 'g' }, to: { unit: 'oz' } },
      { quantity: -2, from: { unit: 'g' }, to: { unit: 'oz' } },
      { quantity: 1, from: { unit: 'g', serving_id: SERVING.flourTbsp }, to: { unit: 'oz' } },
      { quantity: 1, from: { serving_id: 'nope' }, to: { unit: 'oz' } },
      { quantity: 1, from: { unit: 'g' } },
    ];
    for (const body of invalid) {
      const res = await convertFood(FOOD.flour, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    const missing = await convertFood('00000000-0000-4000-8000-00000000abcd', { quantity: 1, from: { unit: 'g' }, to: { unit: 'oz' } });
    expect(missing.status).toBe(404);
  });
});

describe('GET /v1/nutrients, GET /v1/units, POST /v1/units/convert', () => {
  it('lists the nutrient vocabulary, paginated', async () => {
    const first = await request(app).get('/v1/nutrients').query({ limit: 2 }).set('Authorization', auth());
    expect(first.body.data.map((n: { canonical_key: string }) => n.canonical_key)).toEqual(['calcium', 'carbohydrate']);
    const keys: string[] = [];
    let cursor: string | null = null;
    do {
      const page: request.Response = await request(app)
        .get('/v1/nutrients')
        .query(cursor ? { limit: 5, cursor } : { limit: 5 })
        .set('Authorization', auth());
      keys.push(...page.body.data.map((n: { canonical_key: string }) => n.canonical_key));
      cursor = page.body.pagination.nextCursor;
    } while (cursor);
    expect(keys).toHaveLength(22);
    expect(keys).toContain('vitamin_b12');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lists the unit registry with exact factors', async () => {
    const res = await request(app).get('/v1/units').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.base_units).toEqual({ mass: 'g', volume: 'ml' });
    expect(res.body.data).toContainEqual({
      code: 'cup_us',
      dimension: 'volume',
      base_unit: 'ml',
      factor_to_base: '236.5882365',
      system: 'us_customary',
      label: 'US customary cup',
    });
  });

  it('converts food-independent units and refuses cross-dimension conversion', async () => {
    const post = (body: object) => request(app).post('/v1/units/convert').set('Authorization', auth()).send(body);
    expect((await post({ quantity: 1, from_unit: 'kg', to_unit: 'lb' })).body).toMatchObject({ status: 'converted', quantity: 2.204623, unit: 'lb' });
    expect((await post({ quantity: 2, from_unit: 'Tablespoons', to_unit: 'ml' })).body).toMatchObject({ status: 'unresolved', reason: 'ambiguous_unit' });
    expect((await post({ quantity: 1, from_unit: 'g', to_unit: 'ml' })).body).toMatchObject({ status: 'unresolved', reason: 'incompatible_dimensions' });
    expect((await post({ quantity: 1, from_unit: 'g' })).status).toBe(400);
  });
});

describe('RLS and schema guarantees (direct database checks)', () => {
  async function asRole<T>(role: 'authenticated' | 'anon', sql: string, params: unknown[] = []): Promise<T[]> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', SEED.accountA]);
      await client.query(`set local role ${role}`);
      const { rows } = await client.query(sql, params);
      return rows as T[];
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  }

  it('authenticated clients cannot write any food reference table', async () => {
    const writes = [
      ["insert into food (canonical_name, source) values ('x', 'user_entered')", []],
      ["update food set density_g_per_ml = 1, density_source = 'user_entered' where id = $1", [FOOD.chickpeas]],
      ["insert into food_alias (food_id, locale, alias_text, source) values ($1, 'en', 'x', 'user_entered')", [FOOD.chickpeas]],
      ['update food_alias set alias_text = $2 where food_id = $1', [FOOD.chickpeas, 'x']],
      ['delete from food_serving where food_id = $1', [FOOD.flour]],
      ['update food_nutrient set amount_per_canonical_unit = 0 where food_id = $1', [FOOD.chickpeas]],
      ["insert into nutrient (canonical_key, unit) values ('x', 'g')", []],
    ] as const;
    for (const [sql, params] of writes) {
      await expect(asRole('authenticated', sql, [...params])).rejects.toThrow(/permission denied/);
    }
  });

  it('authenticated clients can read and call search_foods(); anon can do neither', async () => {
    const rows = await asRole<{ food_id: string }>('authenticated', "select food_id from search_foods('chick', array['en'], 10)");
    expect(rows).toHaveLength(4);
    await expect(asRole('anon', 'select id from food')).rejects.toThrow(/permission denied/);
    await expect(asRole('anon', "select * from search_foods('chick', array['en'], 10)")).rejects.toThrow(/permission denied/);
  });

  it('enforces canonical units, density provenance pairing and the nutrient basis', async () => {
    await expect(
      pool.query("insert into food_serving (food_id, serving_description, canonical_quantity, canonical_unit, source) values ($1, 'x', 1, 'cup', 'trusted_database')", [FOOD.flour]),
    ).rejects.toThrow(/food_serving_canonical_unit_base/);
    await expect(pool.query("update food set density_g_per_ml = 1 where id = $1", [FOOD.chickpeas])).rejects.toThrow(/food_density_source_pairing/);
    await expect(pool.query("update food set density_g_per_ml = 0, density_source = 'trusted_database' where id = $1", [FOOD.chickpeas])).rejects.toThrow(/check/);
    await expect(
      pool.query("insert into food_nutrient (food_id, nutrient_id, amount_per_canonical_unit, source, basis_unit) values ($1, $2, 1, 'user_entered', 'oz')", [FOOD.flour, NUTRIENT.protein]),
    ).rejects.toThrow(/check/);
    const { rows } = await pool.query('select basis_quantity, basis_unit from food_nutrient where food_id = $1 limit 1', [FOOD.chickpeas]);
    expect(rows[0]).toEqual({ basis_quantity: 100, basis_unit: 'g' });
  });
});
