import * as SecureStore from 'expo-secure-store';

import { CHUNK_SIZE, createSecureSessionStorage, toStoreKey } from '../src/auth/secureStorage';
import { memorySecureStore } from './helpers/memorySecureStore';

describe('secure session storage (§10)', () => {
  it('round-trips a value larger than one keychain entry through chunks', async () => {
    const store = memorySecureStore();
    const storage = createSecureSessionStorage(store);
    const value = 'x'.repeat(CHUNK_SIZE * 2 + 17);
    await storage.setItem('myrecipebook-auth', value);
    expect(store.data.get('myrecipebook-auth.chunks')).toBe('3');
    expect(await storage.getItem('myrecipebook-auth')).toBe(value);
    for (const v of store.data.values()) expect(v.length).toBeLessThanOrEqual(CHUNK_SIZE);
  });

  it('removes every chunk', async () => {
    const store = memorySecureStore();
    const storage = createSecureSessionStorage(store);
    await storage.setItem('k', 'y'.repeat(CHUNK_SIZE * 3));
    await storage.removeItem('k');
    expect(store.data.size).toBe(0);
    expect(await storage.getItem('k')).toBeNull();
  });

  it('overwriting with a shorter value leaves no stale chunks', async () => {
    const store = memorySecureStore();
    const storage = createSecureSessionStorage(store);
    await storage.setItem('k', 'a'.repeat(CHUNK_SIZE * 3));
    await storage.setItem('k', 'short');
    expect([...store.data.keys()].sort()).toEqual(['k.0', 'k.chunks']);
    expect(await storage.getItem('k')).toBe('short');
  });

  it('treats a torn write (missing chunk) as no session and cleans it up', async () => {
    const store = memorySecureStore();
    const storage = createSecureSessionStorage(store);
    await storage.setItem('k', 'z'.repeat(CHUNK_SIZE * 2));
    store.data.delete('k.1');
    expect(await storage.getItem('k')).toBeNull();
    expect(store.data.size).toBe(0);
  });

  it('uses device-only keychain accessibility and a SecureStore-safe key', async () => {
    const store = memorySecureStore();
    await createSecureSessionStorage(store).setItem('sb:auth/token', 'v');
    expect(toStoreKey('sb:auth/token')).toBe('sb_auth_token');
    expect(store.data.has('sb_auth_token.0')).toBe(true);
    expect(store.options.every((o) => (o as { keychainAccessible?: number }).keychainAccessible === SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY)).toBe(true);
  });
});
