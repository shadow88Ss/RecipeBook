// Test doubles for native modules. The SecureStore double records the options
// it was called with so tests can assert the keychain accessibility policy.

jest.mock('expo-secure-store', () => {
  const { memorySecureStore } = jest.requireActual('./__tests__/helpers/memorySecureStore');
  const shared = memorySecureStore();
  return {
    __shared: shared,
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    AFTER_FIRST_UNLOCK: 0,
    getItemAsync: shared.getItemAsync,
    setItemAsync: shared.setItemAsync,
    deleteItemAsync: shared.deleteItemAsync,
  };
});

jest.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'en-US', languageCode: 'en', textDirection: 'ltr' }],
  getCalendars: () => [{ timeZone: 'UTC' }],
}));

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('expo-linking', () => ({ createURL: (path: string) => `myrecipebook-development://${path}` }));

// SafeAreaProvider waits for native inset measurement; use the library's own mock.
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);
