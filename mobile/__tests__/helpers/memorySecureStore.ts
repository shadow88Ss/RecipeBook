import type { SecureKeyValueStore } from '../../src/auth/secureStorage';

export interface MemorySecureStore extends SecureKeyValueStore {
  data: Map<string, string>;
  options: unknown[];
}

/** An in-memory stand-in for the iOS Keychain / Android Keystore. */
export function memorySecureStore(): MemorySecureStore {
  const data = new Map<string, string>();
  const options: unknown[] = [];
  return {
    data,
    options,
    async getItemAsync(key, opts) {
      options.push(opts);
      if (!/^[\w.-]+$/.test(key)) throw new Error('invalid key');
      return data.has(key) ? data.get(key)! : null;
    },
    async setItemAsync(key, value, opts) {
      options.push(opts);
      if (!/^[\w.-]+$/.test(key)) throw new Error('invalid key');
      data.set(key, value);
    },
    async deleteItemAsync(key, opts) {
      options.push(opts);
      data.delete(key);
    },
  };
}
