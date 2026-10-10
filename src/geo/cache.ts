export interface KeyValueStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface LookupCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  /** True when the last successful get was already in memory. */
  wasMemoryHit(): boolean;
}

export function memoryStore(): KeyValueStore {
  const values = new Map<string, string>();
  return {
    async get(key) {
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
    },
  };
}

/** Memory first, then the persistent store. Repeat lookups of the same key do not read the store again. */
export function createLookupCache(persistent?: KeyValueStore): LookupCache {
  const memory = new Map<string, string>();
  let memoryHit = false;
  return {
    wasMemoryHit: () => memoryHit,
    async get(key) {
      const cached = memory.get(key);
      if (cached !== undefined) {
        memoryHit = true;
        return cached;
      }
      memoryHit = false;
      if (persistent === undefined) return undefined;
      const stored = await persistent.get(key);
      if (stored !== undefined) memory.set(key, stored);
      return stored;
    },
    async set(key, value) {
      memory.set(key, value);
      await persistent?.set(key, value);
    },
  };
}

const DB_NAME = 'solarhome';
const STORE = 'lookups';

export function openIndexedDbStore(): Promise<KeyValueStore> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB is unavailable.'));
    request.onsuccess = () => {
      const database = request.result;
      resolve({
        get(key) {
          return new Promise((resolveGet, rejectGet) => {
            const read = database.transaction(STORE, 'readonly').objectStore(STORE).get(key);
            read.onsuccess = () => resolveGet(typeof read.result === 'string' ? read.result : undefined);
            read.onerror = () => rejectGet(read.error ?? new Error('Could not read the cache.'));
          });
        },
        set(key, value) {
          return new Promise((resolveSet, rejectSet) => {
            const write = database.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
            write.onsuccess = () => resolveSet();
            write.onerror = () => rejectSet(write.error ?? new Error('Could not write the cache.'));
          });
        },
      });
    };
  });
}
