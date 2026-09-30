import { findForbiddenPublicKeys, parseAppConfig } from '../src/config/env';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: object) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.signature`;

const valid = {
  EXPO_PUBLIC_APP_ENV: 'staging',
  EXPO_PUBLIC_API_BASE_URL: 'https://api.staging.example.com/',
  EXPO_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
  EXPO_PUBLIC_SUPABASE_ANON_KEY: jwt({ role: 'anon', iss: 'supabase' }),
};

describe('environment validation (§6–7)', () => {
  it('accepts a complete staging environment and trims the trailing slash', () => {
    const result = parseAppConfig(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.environment).toBe('staging');
      expect(result.config.apiBaseUrl).toBe('https://api.staging.example.com');
      expect(result.config.oauthProviders).toEqual([]);
    }
  });

  it('fails clearly when everything is missing and never defaults to production', () => {
    const result = parseAppConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        'EXPO_PUBLIC_APP_ENV is required (development, staging or production).',
        'EXPO_PUBLIC_API_BASE_URL is required.',
        'EXPO_PUBLIC_SUPABASE_URL is required.',
        'EXPO_PUBLIC_SUPABASE_ANON_KEY is required.',
      ]);
    }
  });

  it('rejects an unknown environment id instead of falling back', () => {
    const result = parseAppConfig({ ...valid, EXPO_PUBLIC_APP_ENV: 'prod' });
    expect(result.ok).toBe(false);
  });

  it('requires https outside development and allows a LAN http API in development', () => {
    expect(parseAppConfig({ ...valid, EXPO_PUBLIC_API_BASE_URL: 'http://api.example.com' }).ok).toBe(false);
    const dev = parseAppConfig({ ...valid, EXPO_PUBLIC_APP_ENV: 'development', EXPO_PUBLIC_API_BASE_URL: 'http://192.168.1.20:3000' });
    expect(dev.ok).toBe(true);
  });

  it('warns in development and fails elsewhere for localhost URLs a phone cannot reach', () => {
    const dev = parseAppConfig({ ...valid, EXPO_PUBLIC_APP_ENV: 'development', EXPO_PUBLIC_API_BASE_URL: 'http://localhost:3000' });
    expect(dev.ok).toBe(true);
    expect(dev.warnings.join(' ')).toMatch(/physical phone cannot reach/);
    expect(parseAppConfig({ ...valid, EXPO_PUBLIC_API_BASE_URL: 'https://localhost' }).ok).toBe(false);
  });

  it('rejects an API base URL that already includes /v1, credentials or a query', () => {
    expect(parseAppConfig({ ...valid, EXPO_PUBLIC_API_BASE_URL: 'https://api.example.com/v1' }).ok).toBe(false);
    expect(parseAppConfig({ ...valid, EXPO_PUBLIC_API_BASE_URL: 'https://u:p@api.example.com' }).ok).toBe(false);
    expect(parseAppConfig({ ...valid, EXPO_PUBLIC_API_BASE_URL: 'https://api.example.com?x=1' }).ok).toBe(false);
  });

  it('refuses a service-role JWT or an sb_secret_ key as the anon key, without echoing it', () => {
    const serviceRole = jwt({ role: 'service_role' });
    const r1 = parseAppConfig({ ...valid, EXPO_PUBLIC_SUPABASE_ANON_KEY: serviceRole });
    const r2 = parseAppConfig({ ...valid, EXPO_PUBLIC_SUPABASE_ANON_KEY: 'sb_secret_abcdef' });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    if (!r1.ok) expect(r1.issues.join(' ')).not.toContain(serviceRole);
    if (!r2.ok) expect(r2.issues.join(' ')).not.toContain('abcdef');
  });

  it('accepts a publishable key', () => {
    expect(parseAppConfig({ ...valid, EXPO_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_xyz' }).ok).toBe(true);
  });

  it('flags secret-looking public variables (service role, provider and database secrets)', () => {
    const env = {
      ...valid,
      EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: 'x',
      EXPO_PUBLIC_FATSECRET_CLIENT_SECRET: 'x',
      EXPO_PUBLIC_DATABASE_PASSWORD: 'x',
      EXPO_PUBLIC_WHOOP_KEY: 'x',
      SUPABASE_SERVICE_ROLE_KEY: 'server-only is not our concern here',
    };
    expect(findForbiddenPublicKeys(env)).toEqual([
      'EXPO_PUBLIC_DATABASE_PASSWORD',
      'EXPO_PUBLIC_FATSECRET_CLIENT_SECRET',
      'EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY',
      'EXPO_PUBLIC_WHOOP_KEY',
    ]);
    expect(parseAppConfig(env).ok).toBe(false);
  });

  it('parses the OAuth provider list and rejects unknown providers', () => {
    const r = parseAppConfig({ ...valid, EXPO_PUBLIC_AUTH_OAUTH_PROVIDERS: 'google, apple,google' });
    expect(r.ok && r.config.oauthProviders).toEqual(['google', 'apple']);
    expect(parseAppConfig({ ...valid, EXPO_PUBLIC_AUTH_OAUTH_PROVIDERS: 'facebook' }).ok).toBe(false);
  });
});
