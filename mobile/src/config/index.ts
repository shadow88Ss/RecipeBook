import { parseAppConfig, readPublicEnv, type ConfigResult } from './env';

export type { AppConfig, AppEnvironment, OAuthProvider } from './env';

/** Validated once at startup; the root layout refuses to start the app when it is not ok. */
export const configResult: ConfigResult = parseAppConfig(readPublicEnv());
