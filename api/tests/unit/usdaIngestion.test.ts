// Layer 12B.1 unit tests — USDA SR Legacy planning (pure; no database).
// Fixture: tests/fixtures/usda/sr-legacy.TEST-FIXTURE.json (invented values, NOT USDA data).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANONICAL_NUTRIENT_BY_KEY } from '../../src/domain/nutrition/vocabulary';
import { checkTarget, DEFAULT_MANIFEST, parseArgs } from '../../src/ingestion/usda/cli';
import { manifestSchema, buildPlan, PlanError, servingDescription } from '../../src/ingestion/usda/plan';
import { normalizeUsdaUnit, USDA_NUTRIENT_MAP } from '../../src/ingestion/usda/nutrientMap';

const FIX = path.resolve(__dirname, '../fixtures/usda');
const file = () => JSON.parse(readFileSync(path.join(FIX, 'sr-legacy.TEST-FIXTURE.json'), 'utf8')) as { SRLegacyFoods: Record<string, unknown>[] };
const manifest = () => JSON.parse(readFileSync(path.join(FIX, 'test.manifest.json'), 'utf8')) as { foods: { ndb_number: string; description: string }[] };

describe('nutrient map', () => {
  it('maps only to canonical vocabulary keys, in the vocabulary unit, one source nutrient per key', () => {
    for (const m of USDA_NUTRIENT_MAP) {
      expect(CANONICAL_NUTRIENT_BY_KEY.get(m.key)?.unit, m.key).toBe(m.unit);
    }
    expect(new Set(USDA_NUTRIENT_MAP.map((m) => m.key)).size).toBe(USDA_NUTRIENT_MAP.length);
    expect(new Set(USDA_NUTRIENT_MAP.map((m) => m.fdcNutrientId)).size).toBe(USDA_NUTRIENT_MAP.length);
  });

  it('never maps kJ energy, IU vitamins, phylloquinone-only vitamin K or total folate', () => {
    const ids = USDA_NUTRIENT_MAP.map((m) => m.fdcNutrientId);
    for (const excluded of [1062, 1104, 1110, 1185, 1177]) expect(ids).not.toContain(excluded);
    expect(USDA_NUTRIENT_MAP.some((m) => m.key === 'vitamin_k')).toBe(false);
  });

  it('normalizes USDA unit spellings', () => {
    expect(['µg', 'UG', 'mcg'].map(normalizeUsdaUnit)).toEqual(['mcg', 'mcg', 'mcg']);
    expect(normalizeUsdaUnit('KCAL')).toBe('kcal');
  });
});

describe('plan', () => {
  it('selects exactly the manifest records and keeps known zeros vs missing', () => {
    const plan = buildPlan(file(), manifest());
    expect(plan.foods.map((f) => f.fdcId)).toEqual(['990000001', '990000002']);
    const alpha = plan.foods[0]!;
    expect(alpha.canonicalName).toBe('usda-fdc:990000001');
    expect(alpha.ndbNumber).toBe('99001');
    expect(alpha.category).toBe('Test Category');
    const by = Object.fromEntries(alpha.nutrients.map((n) => [n.key, n.amount]));
    expect(by).toEqual({ energy: 150, protein: 10, fat: 5, carbohydrate: 12, fiber: 0, vitamin_a: 40 });
    // stated zero is kept; never-stated nutrients are simply absent (unavailable)
    expect(by.fiber).toBe(0);
    expect('sodium' in by).toBe(false);
    // kJ, IU, phylloquinone and total folate are reported as unmapped, not converted
    expect(alpha.unmappedNumbers).toEqual(['268', '318', '417', '430']);
    // energy is USDA's stated kcal, never derived
    expect(plan.foods[1]!.nutrients).toEqual([
      { key: 'energy', unit: 'kcal', amount: 80 },
      { key: 'protein', unit: 'g', amount: 2.5 },
    ]);
  });

  it('builds servings only from USDA portions with a stated gram weight', () => {
    const alpha = buildPlan(file(), manifest()).foods[0]!;
    expect(alpha.servings).toEqual([
      { description: '1 piece', grams: 40 },
      { description: '0.5 cup, sliced', grams: 60 },
    ]);
    expect(alpha.skippedPortions).toBe(1);
    expect(servingDescription({ amount: 1, modifier: 'large', measureUnit: { name: 'undetermined' } })).toBe('1 large');
    expect(servingDescription({ amount: 2, modifier: 'chopped', measureUnit: { name: 'cup' } })).toBe('2 cup chopped');
  });

  it('is deterministic: the same input gives the same content hash; a changed value changes it', () => {
    const a = buildPlan(file(), manifest()).foods[0]!.contentSha256;
    expect(buildPlan(file(), manifest()).foods[0]!.contentSha256).toBe(a);
    const changed = file();
    (changed.SRLegacyFoods[0]!.foodNutrients as { amount: number }[])[0]!.amount = 151;
    expect(buildPlan(changed, manifest()).foods[0]!.contentSha256).not.toBe(a);
  });

  it('refuses a description mismatch, a missing record, a duplicate and a wrong file', () => {
    const wrong = manifest();
    wrong.foods[0]!.description = 'Testfood, alpha, cooked';
    expect(() => buildPlan(file(), wrong)).toThrow(/manifest expects "Testfood, alpha, cooked"/);
    const missing = manifest();
    missing.foods.push({ ndb_number: '99999', description: 'Nothing' });
    expect(() => buildPlan(file(), missing)).toThrow(/NDB 99999 \(Nothing\) is not in the file/);
    const dup = manifest();
    dup.foods.push({ ndb_number: '99001', description: 'Testfood, alpha, raw' });
    expect(() => buildPlan(file(), dup)).toThrow(/twice/);
    expect(() => buildPlan({ FoundationFoods: [] }, manifest())).toThrow(PlanError);
  });

  it('refuses a nutrient whose SR number or unit does not match the pinned mapping', () => {
    const bad = file();
    (bad.SRLegacyFoods[0]!.foodNutrients as { nutrient: { unitName: string } }[])[0]!.nutrient.unitName = 'kJ';
    expect(() => buildPlan(bad, manifest())).toThrow(/unit kJ, expected kcal/);
  });

  it('refuses branded or non-SR records (dataType must be SR Legacy)', () => {
    const branded = file();
    branded.SRLegacyFoods[1]!.dataType = 'Branded';
    expect(() => buildPlan(branded, manifest())).toThrow(/unexpected record format/);
  });
});

describe('committed DEV bootstrap manifest', () => {
  it('is valid, has 100-300 distinct SR records, and lists only generic (non-branded) descriptions', () => {
    const m = manifestSchema.parse(JSON.parse(readFileSync(DEFAULT_MANIFEST, 'utf8')));
    expect(m.foods.length).toBeGreaterThanOrEqual(100);
    expect(m.foods.length).toBeLessThanOrEqual(300);
    expect(new Set(m.foods.map((f) => f.ndb_number)).size).toBe(m.foods.length);
    // SR brand names are written in capitals (e.g. "KRAFT"); none may be selected
    for (const f of m.foods) expect(f.description, f.description).not.toMatch(/\b[A-Z]{3,}\b/);
  });
});

describe('operator command guards', () => {
  it('requires file, release and project ref; dry run unless --apply', () => {
    expect(() => parseArgs([])).toThrow(/Usage/);
    const a = parseArgs(['--file', 'x.json', '--release', 'r', '--project-ref', 'psundpxqgiknxnjudmxv']);
    expect(a.apply).toBe(false);
    expect(parseArgs(['--file', 'x', '--release', 'r', '--project-ref', 'local', '--apply']).apply).toBe(true);
  });

  it('only connects to the named project (or localhost for "local")', () => {
    expect(() => checkTarget('postgresql://postgres.otherproject:pw@aws-0-x.pooler.supabase.com:5432/postgres', 'psundpxqgiknxnjudmxv')).toThrow(/does not belong/);
    expect(checkTarget('postgresql://postgres.psundpxqgiknxnjudmxv:pw@aws-0-x.pooler.supabase.com:5432/postgres', 'psundpxqgiknxnjudmxv').local).toBe(false);
    expect(() => checkTarget('postgresql://postgres:pw@db.example.com:5432/postgres', 'local')).toThrow(/localhost/);
    expect(() => checkTarget('https://x', 'local')).toThrow(/postgres/);
  });
});

describe('ingestion is not part of the API server', () => {
  it('no server module imports src/ingestion (operator-only code)', async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const root = path.resolve(__dirname, '../../src');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n)) : [path.join(dir, n)]));
    const offenders = walk(root)
      .filter((p) => p.endsWith('.ts') && !p.includes(`${path.sep}ingestion${path.sep}`))
      .filter((p) => /from ['"][./]*ingestion\//.test(readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
