// Types for env.js (kept in JavaScript so app.config.ts can load it on any Node version).

export declare const APP_ENVIRONMENTS: readonly ['development', 'staging', 'production'];
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

export declare const OAUTH_PROVIDERS: readonly ['google', 'apple'];
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export interface AppConfig {
  environment: AppEnvironment;
  /** Origin (and optional path prefix) of the MyRecipeBook API, without `/v1`. */
  apiBaseUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** OAuth providers the environment's Supabase project has been configured for. */
  oauthProviders: OAuthProvider[];
}

export type RawEnv = Record<string, string | undefined>;

export type ConfigResult = { ok: true; config: AppConfig; warnings: string[] } | { ok: false; issues: string[]; warnings: string[] };

export declare const ENV_KEYS: {
  readonly environment: 'EXPO_PUBLIC_APP_ENV';
  readonly apiBaseUrl: 'EXPO_PUBLIC_API_BASE_URL';
  readonly supabaseUrl: 'EXPO_PUBLIC_SUPABASE_URL';
  readonly supabaseAnonKey: 'EXPO_PUBLIC_SUPABASE_ANON_KEY';
  readonly oauthProviders: 'EXPO_PUBLIC_AUTH_OAUTH_PROVIDERS';
};

export declare function readPublicEnv(): RawEnv;
export declare function findForbiddenPublicKeys(env: RawEnv): string[];
export declare function parseAppConfig(env: RawEnv): ConfigResult;
