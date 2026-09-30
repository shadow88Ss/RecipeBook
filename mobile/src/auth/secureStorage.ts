// Layer 12A §10 — secure session storage.
//
// Supabase persists its session through this adapter. Everything goes to the
// iOS Keychain / Android Keystore via expo-secure-store — never AsyncStorage.
// Sessions are split into chunks because a Supabase session (JWT + refresh
// token + user object) can exceed what a single keychain entry handles well.

import * as SecureStore from 'expo-secure-store';

export const CHUNK_SIZE = 1800;

export interface SecureKeyValueStore {
  getItemAsync(key: string, options?: SecureStore.SecureStoreOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
  deleteItemAsync(key: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
}

export interface SessionStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const OPTIONS: SecureStore.SecureStoreOptions = {
  // Readable only while the device is unlocked, and never migrated to another device.
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** SecureStore keys may only contain alphanumerics, ".", "-" and "_". */
export function toStoreKey(key: string): string {
  return key.replace(/[^\w.-]/g, '_');
}

export function createSecureSessionStorage(store: SecureKeyValueStore = SecureStore): SessionStorage {
  const countKey = (key: string) => `${toStoreKey(key)}.chunks`;
  const chunkKey = (key: string, i: number) => `${toStoreKey(key)}.${i}`;

  async function removeItem(key: string): Promise<void> {
    const raw = await store.getItemAsync(countKey(key), OPTIONS);
    const count = raw === null ? 0 : Number.parseInt(raw, 10);
    const deletions: Promise<void>[] = [];
    for (let i = 0; i < (Number.isFinite(count) ? count : 0); i++) {
      deletions.push(store.deleteItemAsync(chunkKey(key, i), OPTIONS));
    }
    await Promise.all(deletions);
    await store.deleteItemAsync(countKey(key), OPTIONS);
  }

  return {
    async getItem(key) {
      const raw = await store.getItemAsync(countKey(key), OPTIONS);
      if (raw === null) return null;
      const count = Number.parseInt(raw, 10);
      if (!Number.isFinite(count) || count < 0) {
        await removeItem(key);
        return null;
      }
      const parts: string[] = [];
      for (let i = 0; i < count; i++) {
        const part = await store.getItemAsync(chunkKey(key, i), OPTIONS);
        if (part === null) {
          // A torn write: treat as no session rather than a corrupted one.
          await removeItem(key);
          return null;
        }
        parts.push(part);
      }
      return parts.join('');
    },

    async setItem(key, value) {
      await removeItem(key);
      const chunks: string[] = [];
      for (let i = 0; i < value.length; i += CHUNK_SIZE) chunks.push(value.slice(i, i + CHUNK_SIZE));
      for (let i = 0; i < chunks.length; i++) {
        await store.setItemAsync(chunkKey(key, i), chunks[i]!, OPTIONS);
      }
      // The count is written last so a partial write is never read as complete.
      await store.setItemAsync(countKey(key), String(chunks.length), OPTIONS);
    },

    removeItem,
  };
}
