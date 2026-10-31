// Layer 13A integration tests — website recipe import against the real
// migration chain and RLS harness. Pages come from an in-memory fetcher
// (no network); the real fetcher is covered by tests/unit/recipeImport.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { logger } from '../../src/lib/logger';
import { PageFetchError, type PageFetcher } from '../../src/domain/recipeImports/pageFetcher';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { F, seedNutritionFixtures } from '../helpers/nutritionFixtures';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';

let pool: Pool;
let app: ReturnType<typeof createApp>;

const recipePage = (name: string) => `<html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'WebSite', name: 'Fixture Kitchen' },
    {
      '@type': 'Recipe',
      name,
      description: 'Test-only page.',
      recipeYield: '4 servings',
      recipeIngredient: ['200 g cooked rice', '2 cups spinach', '1 egg'],
      recipeInstructions: [{ '@type': 'HowToStep', text: 'Cook.' }, { '@type': 'HowToStep', text: 'Serve.' }],
    },
  ],
})}</script></head><body></body></html>`;

const PAGES: Record<string, string | PageFetchError> = {
  'https://kitchen.example-recipes.com/rice-bowl': recipePage('Fixture Rice Bowl'),
  'https://kitchen.example-recipes.com/rice-bowl?utm_source=insta': recipePage('Fixture Rice Bowl'),
  'https://kitchen.example-recipes.com/other': recipePage('Other Dish'),
  'https://kitchen.example-recipes.com/blog': '<html><body>No recipe here</body></html>',
  'https://kitchen.example-recipes.com/down': new PageFetchError('http_error', true, 503),
};
const fetched: string[] = [];
const fakeFetcher: PageFetcher = {
  async fetchPage(url) {
    fetched.push(url);
    const page = PAGES[url];
    if (page === undefined) throw new PageFetchError('http_error', false, 404);
    if (page instanceof PageFetchError) throw page;
    return { finalUrl: url, status: 200, contentType: 'text/html', html: page };
  },
};

const as = (account: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${signTestToken(account)}`),
  post: (path: string, body: unknown) => request(app).post(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
  patch: (path: string, body: unknown) => request(app).patch(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
});
const A = () => as(SEED.accountA);
const importsOf = (profile: string) => `/v1/profiles/${profile}/recipe-imports`;

async function asAccountSql(account: string, sql: string, params: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [account]);
    await client.query('set local role authenticated');
    return await client.query(sql, params);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

const reviewed = (title: string) => ({
  title,
  servings: 4,
  ingredients: [
    { text: '200 g cooked rice', food_id: F.rice, quantity: 200, unit: 'g' },
    { text: '2 cups spinach' },
    { text: '1 egg', quantity: 1 },
  ],
  instructions: ['Cook.', 'Serve.'],
});

let importId: string;
let recipeId: string;

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer13a');
  await seedScenario(pool);
  await seedNutritionFixtures(pool);
  app = createApp({
    profileRepository: new PgHarnessProfileRepository(pool),
    scopedDbFactory: new PgHarnessScopedDbFactory(pool),
    jwtSecret: TEST_JWT_SECRET,
    logger,
    pageFetcher: fakeFetcher,
  });
}, 60_000);

afterAll(async () => {
  await pool.end();
});

describe('importing a website link', () => {
  it('fetches, extracts and records the import for review', async () => {
    const res = await A().post(importsOf(SEED.profileA), { url: 'https://kitchen.example-recipes.com/rice-bowl?utm_source=insta', idempotency_key: 'key-rice-bowl-1' });
    expect(res.status).toBe(201);
    importId = res.body.id;
    expect(res.body).toMatchObject({
      profile_id: SEED.profileA,
      status: 'needs_confirmation',
      trigger_type: 'initial_import',
      error_code: null,
      source: { url: 'https://kitchen.example-recipes.com/rice-bowl', original_url: 'https://kitchen.example-recipes.com/rice-bowl?utm_source=insta', provider: 'web' },
      extraction: { method: 'schema_org_json_ld', version: 'recipe-json-ld-v1', status: 'success' },
      draft: {
        title: 'Fixture Rice Bowl',
        servings: 4,
        ingredients: [
          { text: '200 g cooked rice', quantity: 200, unit: 'g' },
          { text: '2 cups spinach', note: 'ambiguous_unit' },
          { text: '1 egg', quantity: 1 },
        ],
        instructions: ['Cook.', 'Serve.'],
      },
      recipe_id: null,
      existing_recipe_id: null,
    });
    expect(res.body.extraction.confidence).toBeGreaterThan(0.8);

    const { rows } = await pool.query(
      `select us.canonical_url, us.latest_content_fingerprint, ij.processing_status, ij.idempotency_key, ij.content_fingerprint,
              rc.content_type, rc.storage_reference, rc.content_excerpt->>'name' as excerpt_name, ae.source, ae.confidence
         from import_job ij join url_source us on us.id = ij.url_source_id
         join raw_content rc on rc.import_job_id = ij.id join ai_extraction ae on ae.raw_content_id = rc.id
        where ij.id = $1`,
      [importId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      canonical_url: 'https://kitchen.example-recipes.com/rice-bowl',
      processing_status: 'needs_confirmation',
      idempotency_key: `${SEED.accountA}:key-rice-bowl-1`,
      content_type: 'json',
      storage_reference: 'inline:content_excerpt',
      excerpt_name: 'Fixture Rice Bowl',
      source: 'url_import',
    });
    expect(rows[0].content_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(rows[0].latest_content_fingerprint).toBe(rows[0].content_fingerprint);
  });

  it('returns the same import for a repeated idempotency key without fetching again', async () => {
    const before = fetched.length;
    const res = await A().post(importsOf(SEED.profileA), { url: 'https://kitchen.example-recipes.com/rice-bowl?utm_source=insta', idempotency_key: 'key-rice-bowl-1' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(importId);
    expect(fetched.length).toBe(before);
  });

  it('refuses an idempotency key reused for another link', async () => {
    const res = await A().post(importsOf(SEED.profileA), { url: 'https://kitchen.example-recipes.com/other', idempotency_key: 'key-rice-bowl-1' });
    expect(res.status).toBe(409);
  });

  it('records pages without recipe data and unreachable pages as failed imports', async () => {
    const blog = await A().post(importsOf(SEED.profileA), { url: 'https://kitchen.example-recipes.com/blog' });
    expect(blog.status).toBe(201);
    expect(blog.body).toMatchObject({ status: 'permanently_failed', error_code: 'no_recipe_found', draft: null, extraction: null });
    const down = await A().post(importsOf(SEED.profileA), { url: 'https://kitchen.example-recipes.com/down' });
    expect(down.body).toMatchObject({ status: 'retryable_failed', error_code: 'http_error' });
    const { rows } = await pool.query('select count(*)::int as n from raw_content where import_job_id = any($1)', [[blog.body.id, down.body.id]]);
    expect(rows[0].n).toBe(0);
  });

  it.each([
    ['https://www.instagram.com/p/abc123/', 'unsupported_provider'],
    ['http://localhost/admin', 'host_not_allowed'],
    ['http://169.254.169.254/latest', 'host_not_allowed'],
    ['ftp://kitchen.example-recipes.com/x', 'unsupported_scheme'],
  ])('refuses %s before recording anything', async (url, reason) => {
    const { rows: before } = await pool.query('select count(*)::int as n from import_job');
    const res = await A().post(importsOf(SEED.profileA), { url });
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues[0]).toMatchObject({ path: 'url', message: reason });
    const { rows: after } = await pool.query('select count(*)::int as n from import_job');
    expect(after[0].n).toBe(before[0].n);
  });
});

describe('authorization', () => {
  it('needs full management of the profile to import', async () => {
    expect((await as(SEED.accountViewOnly).post(importsOf(SEED.profileChild), { url: 'https://kitchen.example-recipes.com/other' })).status).toBe(403);
    expect((await as(SEED.accountUnrelated).post(importsOf(SEED.profileA), { url: 'https://kitchen.example-recipes.com/other' })).status).toBe(404);
  });

  it('never shows an import to another account', async () => {
    expect((await as(SEED.accountB).get(`${importsOf(SEED.profileA)}/${importId}`)).status).toBe(404);
    expect((await as(SEED.accountB).get(`${importsOf(SEED.profileB)}/${importId}`)).status).toBe(404);
    expect((await as(SEED.accountB).post(`${importsOf(SEED.profileB)}/${importId}/save`, reviewed('Stolen'))).status).toBe(404);
  });

  it('keeps url_source closed to clients and the import tables client-read-only', async () => {
    await expect(asAccountSql(SEED.accountA, 'select * from url_source')).rejects.toMatchObject({ code: '42501' });
    await expect(asAccountSql(SEED.accountA, "insert into ai_extraction (raw_content_id, import_job_id, source, extraction_method, model_version, confidence, status, extracted_payload) select id, import_job_id, 'url_import', 'x', 'x', 1, 'success', '{}' from raw_content limit 1")).rejects.toMatchObject({ code: '42501' });
  });

  it('lets a caller complete only their own job, once', async () => {
    await expect(
      asAccountSql(SEED.accountB, 'select complete_url_recipe_import($1, $2)', [importId, { status: 'permanently_failed', error_code: 'x' }]),
    ).rejects.toMatchObject({ code: 'P0002' });
    await expect(
      asAccountSql(SEED.accountA, 'select complete_url_recipe_import($1, $2)', [importId, { status: 'permanently_failed', error_code: 'x' }]),
    ).rejects.toMatchObject({ code: '55000' });
  });
});

describe('saving the reviewed recipe', () => {
  it('saves a recipe whose version records the import, and marks the import succeeded', async () => {
    const res = await A().post(`${importsOf(SEED.profileA)}/${importId}/save`, reviewed('My Rice Bowl'));
    expect(res.status).toBe(201);
    recipeId = res.body.id;
    expect(res.body).toMatchObject({ title: 'My Rice Bowl', version_count: 1 });
    expect(res.body.current_version.provenance).toMatchObject({ origin: 'imported', origin_import_job_id: importId });
    expect(res.body.current_version.provenance.origin_url_source_id).toEqual(expect.any(String));
    expect(res.body.current_version.provenance.origin_ai_extraction_id).toEqual(expect.any(String));
    expect(res.body.current_version.ingredients.map((i: { match_status: string }) => i.match_status)).toEqual(['matched', 'unmatched', 'unmatched']);

    const view = await A().get(`${importsOf(SEED.profileA)}/${importId}`);
    expect(view.body).toMatchObject({ status: 'succeeded', recipe_id: recipeId, existing_recipe_id: recipeId });
  });

  it('refuses saving the same import twice', async () => {
    const res = await A().post(`${importsOf(SEED.profileA)}/${importId}/save`, reviewed('Again'));
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ existing_recipe_id: recipeId });
  });

  it('re-importing the same link points at the recipe already saved and refuses a duplicate', async () => {
    const again = await A().post(importsOf(SEED.profileA), { url: 'https://kitchen.example-recipes.com/rice-bowl' });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ status: 'needs_confirmation', trigger_type: 'manual_reimport', existing_recipe_id: recipeId, recipe_id: null });
    const save = await A().post(`${importsOf(SEED.profileA)}/${again.body.id}/save`, reviewed('Duplicate'));
    expect(save.status).toBe(409);
    expect(save.body.error.details).toEqual({ existing_recipe_id: recipeId });
    const { rows } = await pool.query('select processing_status from import_job where id = $1', [again.body.id]);
    expect(rows[0].processing_status).toBe('needs_confirmation');
  });

  it('refuses saving an import that failed', async () => {
    const blog = await A().post(importsOf(SEED.profileA), { url: 'https://kitchen.example-recipes.com/blog', idempotency_key: 'key-blog-save' });
    expect((await A().post(`${importsOf(SEED.profileA)}/${blog.body.id}/save`, reviewed('Nope'))).status).toBe(409);
  });

  it('keeps the provenance on later versions', async () => {
    const res = await A().patch(`/v1/profiles/${SEED.profileA}/recipes/${recipeId}`, { title: 'My Rice Bowl, edited' });
    expect(res.status).toBe(200);
    expect(res.body.version_count).toBe(2);
    expect(res.body.current_version.provenance).toMatchObject({ origin: 'imported', origin_import_job_id: importId });
  });

  it('refuses a recipe version claiming an import it did not come from', async () => {
    // Profile B's own recipe claiming profile A's import.
    const own = await as(SEED.accountB).post(`/v1/profiles/${SEED.profileB}/recipes`, reviewed('B recipe'));
    expect(own.status).toBe(201);
    await expect(
      asAccountSql(
        SEED.accountB,
        `insert into recipe_version (recipe_id, version_number, title, servings, created_by_account_id, origin_import_job_id)
         values ($1, 99, 'forged', 1, $2, $3)`,
        [own.body.id, SEED.accountB, importId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // An origin with no import job at all.
    const { rows } = await pool.query('select url_source_id from import_job where id = $1', [importId]);
    await expect(
      asAccountSql(
        SEED.accountB,
        `insert into recipe_version (recipe_id, version_number, title, servings, created_by_account_id, origin_url_source_id)
         values ($1, 98, 'forged', 1, $2, $3)`,
        [own.body.id, SEED.accountB, rows[0].url_source_id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
