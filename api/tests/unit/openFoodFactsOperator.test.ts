// Option A — guards of the Open Food Facts DEV operator command (pure; no network).

import { describe, expect, it } from 'vitest';
import { findExposures, parseOpsArgs, readPublicEnv } from '../../src/operator/openFoodFactsDev';

const REF = 'psundpxqgiknxnjudmxv';
const ENV = [
  'EXPO_PUBLIC_APP_ENV=development',
  'EXPO_PUBLIC_API_BASE_URL=https://api.example.test/',
  `EXPO_PUBLIC_SUPABASE_URL=https://${REF}.supabase.co`,
  'EXPO_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_x',
].join('\n');

describe('operator command arguments', () => {
  it('requires a known command and the project ref; lookup needs a barcode', () => {
    expect(() => parseOpsArgs([])).toThrow(/Usage/);
    expect(() => parseOpsArgs(['status'])).toThrow(/project-ref/);
    expect(parseOpsArgs(['status', '--project-ref', REF])).toMatchObject({ command: 'status', barcode: null, envFile: '../mobile/.env.local' });
    expect(() => parseOpsArgs(['lookup', '--project-ref', REF])).toThrow(/barcode/);
    expect(parseOpsArgs(['lookup', '3017624010701', '--project-ref', REF]).barcode).toBe('3017624010701');
  });
});

describe('public env file', () => {
  it('reads only the public values and refuses another project or a secret key', () => {
    expect(readPublicEnv(ENV, REF)).toEqual({ api: 'https://api.example.test', supabaseUrl: `https://${REF}.supabase.co`, anonKey: 'sb_publishable_x' });
    expect(() => readPublicEnv(ENV, 'otherprojectref')).toThrow(/not project/);
    expect(() => readPublicEnv(ENV.replace('sb_publishable_x', 'sb_secret_x'), REF)).toThrow(/publishable/);
    expect(() => readPublicEnv(ENV.replace('https://api', 'http://api'), REF)).toThrow(/https/);
  });
});

describe('exposure scan', () => {
  it('reports sensitive keys and any occurrence of the given values', () => {
    const body = { candidates: [{ provenance: { attribution: { text: 'Product data from Open Food Facts' } }, note: 'ops@example.test' }], configuration: {} };
    expect(findExposures(body, { keys: /configuration|contact/i, values: ['OPS@example.test'] })).toEqual(['$.candidates[0].note', '$.configuration']);
    expect(findExposures({ ok: true, list: ['a'] }, { keys: /secret/, values: [''] })).toEqual([]);
  });
});
