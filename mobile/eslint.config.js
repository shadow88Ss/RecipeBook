// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.expo/*', 'node_modules/*'],
  },
  {
    rules: {
      // §36: no console logging outside the redacting logger.
      'no-console': 'error',
    },
  },
  {
    files: ['src/lib/logger.ts', 'app.config.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // §5, §40: data goes through the /v1 API client only; Supabase is for auth only.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/auth/supabaseAuth.ts', 'src/auth/authService.ts', 'src/auth/AuthProvider.tsx'],
    rules: {
      'no-restricted-imports': ['error', { paths: [{ name: '@supabase/supabase-js', message: 'Only src/auth may use Supabase (auth only).' }, { name: '@react-native-async-storage/async-storage', message: 'Sessions and tokens live in SecureStore only.' }] }],
    },
  },
]);
