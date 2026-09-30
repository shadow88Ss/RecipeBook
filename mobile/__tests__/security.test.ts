// Layer 12A §37–41 — static checks over the mobile source and dependencies.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|js)$/.test(name) ? [p] : [];
  });
}

const sources = [...files(join(ROOT, 'src')), join(ROOT, 'app.config.ts')].map((p) => ({ p, text: readFileSync(p, 'utf8') }));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });

describe('mobile security checks', () => {
  it('A/B: no service-role key, provider secret or database password is referenced', () => {
    for (const { p, text } of sources) {
      if (p.endsWith(join('config', 'env.js'))) continue; // the validator that rejects them
      expect({ p, hit: /service_role|SERVICE_ROLE|client_secret|CLIENT_SECRET|DATABASE_URL|SUPABASE_JWT_SECRET|WHOOP_SECRET/.test(text) }).toEqual({ p, hit: false });
    }
  });

  it('never calls product/wearable providers or retailers directly (§40)', () => {
    for (const { p, text } of sources) {
      expect({ p, hit: /fatsecret\.com|openfoodfacts\.org|whoop\.com/i.test(text) }).toEqual({ p, hit: false });
    }
  });

  it('E: the Platform Admin API is only mentioned by the client guard that refuses it (§39)', () => {
    const mentions = sources.filter(({ text }) => /\/v1\/admin|\\\/v1\\\/admin/.test(text)).map(({ p }) => p.replace(ROOT, ''));
    expect(mentions).toEqual([join('/src', 'api', 'client.ts')]);
  });

  it('never uses AsyncStorage for anything (§10)', () => {
    expect(deps).not.toContain('@react-native-async-storage/async-storage');
    for (const { text } of sources) expect(text).not.toMatch(/@react-native-async-storage|localStorage/);
  });

  it('only src/auth talks to Supabase (auth only, §5)', () => {
    const users = sources.filter(({ text }) => /from '@supabase\/supabase-js'/.test(text)).map(({ p }) => p.replace(ROOT, ''));
    expect(users.every((p) => p.startsWith(join('/src', 'auth')))).toBe(true);
    for (const { text } of sources) expect(text).not.toMatch(/\.from\(['"]|\.rpc\(|\.storage\.from/);
  });

  it('has no analytics or crash-reporting SDKs (§37–38)', () => {
    const banned = /sentry|bugsnag|crashlytics|firebase|amplitude|segment|mixpanel|datadog|posthog|appsflyer|branch|newrelic|instabug|expo-insights/i;
    expect(deps.filter((d) => banned.test(d))).toEqual([]);
  });

  it('does not log with console outside the redacting logger (§36)', () => {
    for (const { p, text } of sources) {
      if (p.endsWith(join('lib', 'logger.ts')) || p.endsWith('app.config.ts')) continue;
      expect({ p, hit: /console\.(log|info|warn|error|debug)/.test(text) }).toEqual({ p, hit: false });
    }
  });

  it('never disables TLS verification (§45)', () => {
    for (const { text } of sources) expect(text).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized|NSAllowsArbitraryLoads/);
  });
});
