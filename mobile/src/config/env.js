// Layer 12A §6–7 — mobile environment configuration.
//
// The mobile app only ever holds PUBLIC values: the API base URL, the Supabase
// project URL, the Supabase anon (publishable) key and the environment id.
//
// Plain CommonJS (types in env.d.ts) so that app.config.ts can run exactly the
// same validation at build/start time on any supported Node version, and the
// app runs it again at startup.
//
// There is deliberately no default environment and no fallback URL: a missing
// or invalid value is an error, never a silent switch to production.

const APP_ENVIRONMENTS = ['development', 'staging', 'production'];
const OAUTH_PROVIDERS = ['google', 'apple'];

const ENV_KEYS = {
  environment: 'EXPO_PUBLIC_APP_ENV',
  apiBaseUrl: 'EXPO_PUBLIC_API_BASE_URL',
  supabaseUrl: 'EXPO_PUBLIC_SUPABASE_URL',
  supabaseAnonKey: 'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  oauthProviders: 'EXPO_PUBLIC_AUTH_OAUTH_PROVIDERS',
};

/**
 * Reads the public variables. Expo inlines `process.env.EXPO_PUBLIC_*` only for
 * static member access, so each one is read explicitly (no destructuring).
 */
function readPublicEnv() {
  return {
    EXPO_PUBLIC_APP_ENV: process.env.EXPO_PUBLIC_APP_ENV,
    EXPO_PUBLIC_API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL,
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    EXPO_PUBLIC_AUTH_OAUTH_PROVIDERS: process.env.EXPO_PUBLIC_AUTH_OAUTH_PROVIDERS,
  };
}

// Anything matching this must never be bundled into the app (§6, §41 A/B).
const FORBIDDEN_NAME = /SECRET|SERVICE_ROLE|SERVICE_KEY|PASSWORD|PRIVATE|FATSECRET|WHOOP|DATABASE_URL|JWT/i;

/** Names of EXPO_PUBLIC_* variables that look like secrets. */
function findForbiddenPublicKeys(env) {
  return Object.keys(env)
    .filter((k) => k.startsWith('EXPO_PUBLIC_') && env[k] !== undefined && FORBIDDEN_NAME.test(k))
    .sort();
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

function checkUrl(name, value, environment, issues, warnings) {
  if (!value || !value.trim()) {
    issues.push(`${name} is required.`);
    return null;
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    issues.push(`${name} is not a valid URL.`);
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    issues.push(`${name} must use https.`);
    return null;
  }
  if (url.protocol === 'http:' && environment !== 'development') {
    issues.push(`${name} must use https outside development.`);
  }
  if (url.username || url.password) {
    issues.push(`${name} must not contain credentials.`);
  }
  if (url.search || url.hash) {
    issues.push(`${name} must not contain a query string or fragment.`);
  }
  const host = url.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) {
    if (environment === 'development') {
      warnings.push(`${name} points at ${host}; a physical phone cannot reach it. Use the computer's LAN address or a hosted HTTPS URL.`);
    } else {
      issues.push(`${name} must not point at ${host} outside development.`);
    }
  }
  return value.trim().replace(/\/+$/, '');
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(atob(padded));
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

function checkAnonKey(value, issues) {
  if (!value || !value.trim()) {
    issues.push(`${ENV_KEYS.supabaseAnonKey} is required.`);
    return null;
  }
  const key = value.trim();
  // New-style Supabase keys: sb_publishable_… is public, sb_secret_… is not.
  if (key.startsWith('sb_secret_')) {
    issues.push(`${ENV_KEYS.supabaseAnonKey} is a secret key. Only the anon/publishable key may be used in the app.`);
    return null;
  }
  if (key.startsWith('sb_publishable_')) return key;
  const payload = decodeJwtPayload(key);
  if (!payload) {
    issues.push(`${ENV_KEYS.supabaseAnonKey} is not a Supabase anon or publishable key.`);
    return null;
  }
  if (payload.role !== 'anon') {
    // Never echo the key or its role claim; only say it is not the anon key.
    issues.push(`${ENV_KEYS.supabaseAnonKey} is not the anon key. Only the anon/publishable key may be used in the app.`);
    return null;
  }
  return key;
}

function checkOAuthProviders(value, issues) {
  if (!value || !value.trim()) return [];
  const out = [];
  for (const raw of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (OAUTH_PROVIDERS.includes(raw)) {
      if (!out.includes(raw)) out.push(raw);
    } else {
      issues.push(`${ENV_KEYS.oauthProviders} contains an unknown provider.`);
    }
  }
  return out;
}

/** Validates the public environment. Never falls back to another environment. */
function parseAppConfig(env) {
  const issues = [];
  const warnings = [];

  const envValue = env[ENV_KEYS.environment] ? env[ENV_KEYS.environment].trim() : '';
  let environment = null;
  if (!envValue) {
    issues.push(`${ENV_KEYS.environment} is required (development, staging or production).`);
  } else if (APP_ENVIRONMENTS.includes(envValue)) {
    environment = envValue;
  } else {
    issues.push(`${ENV_KEYS.environment} must be development, staging or production.`);
  }

  const forbidden = findForbiddenPublicKeys(env);
  if (forbidden.length) {
    issues.push(`Secret-looking public variables must be removed: ${forbidden.join(', ')}.`);
  }

  const apiBaseUrl = checkUrl(ENV_KEYS.apiBaseUrl, env[ENV_KEYS.apiBaseUrl], environment, issues, warnings);
  if (apiBaseUrl && /\/v1$/.test(apiBaseUrl)) {
    issues.push(`${ENV_KEYS.apiBaseUrl} must not include /v1; the client adds it.`);
  }
  const supabaseUrl = checkUrl(ENV_KEYS.supabaseUrl, env[ENV_KEYS.supabaseUrl], environment, issues, warnings);
  const supabaseAnonKey = checkAnonKey(env[ENV_KEYS.supabaseAnonKey], issues);
  const oauthProviders = checkOAuthProviders(env[ENV_KEYS.oauthProviders], issues);

  if (issues.length || !environment || !apiBaseUrl || !supabaseUrl || !supabaseAnonKey) {
    return { ok: false, issues, warnings };
  }
  return { ok: true, config: { environment, apiBaseUrl, supabaseUrl, supabaseAnonKey, oauthProviders }, warnings };
}

module.exports = { APP_ENVIRONMENTS, OAUTH_PROVIDERS, ENV_KEYS, readPublicEnv, findForbiddenPublicKeys, parseAppConfig };
