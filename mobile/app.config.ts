// Layer 12A §6–7, §42 — Expo app config.
//
// Validates the public environment when Expo loads the config (start, export,
// EAS build) so a bad or missing value fails loudly before anything runs.
// Bundle identifiers are placeholders until store accounts exist.
import type { ExpoConfig } from 'expo/config';

import { findForbiddenPublicKeys, parseAppConfig, type AppEnvironment } from './src/config/env';

const forbidden = findForbiddenPublicKeys(process.env);
if (forbidden.length) {
  throw new Error(`[MyRecipeBook] Secret-looking EXPO_PUBLIC_ variables are not allowed in the app: ${forbidden.join(', ')}`);
}

const result = parseAppConfig(process.env);
if (!result.ok) {
  throw new Error(`[MyRecipeBook] Invalid mobile environment:\n  - ${result.issues.join('\n  - ')}\nSee mobile/README.md#environment.`);
}
for (const warning of result.warnings) {
  console.warn(`[MyRecipeBook] ${warning}`);
}

const environment: AppEnvironment = result.config.environment;
const suffix = environment === 'production' ? '' : `.${environment === 'development' ? 'dev' : 'staging'}`;
const nameSuffix = environment === 'production' ? '' : environment === 'development' ? ' (Dev)' : ' (Staging)';

const config: ExpoConfig = {
  name: `MyRecipeBook${nameSuffix}`,
  slug: 'myrecipebook',
  scheme: `myrecipebook${environment === 'production' ? '' : `-${environment}`}`,
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  ios: {
    // Placeholder identifier; replace once the Apple developer account exists.
    bundleIdentifier: `com.myrecipebook.app${suffix}`,
    supportsTablet: false,
    config: { usesNonExemptEncryption: false },
  },
  android: {
    // Placeholder identifier; replace once the Play Console account exists.
    package: `com.myrecipebook.app${suffix}`,
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    // Keep the secure-store session out of Android Auto Backup.
    allowBackup: false,
  },
  web: { favicon: './assets/favicon.png' },
  plugins: [
    'expo-router',
    ['expo-secure-store', { configureAndroidBackup: true, faceIDPermission: false }],
    'expo-localization',
    'expo-web-browser',
  ],
  experiments: { typedRoutes: false },
  extra: { appEnvironment: environment },
};

export default config;
