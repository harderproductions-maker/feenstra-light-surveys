import legacy from './legacy-identifiers.json' with { type: 'json' };

export function isPrimaryCompany(code) {
  return !code || code === legacy.defaultClientCode;
}
export function migrateLocalSettings(storage) {
  const entries = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .map((key) => [key, storage.getItem(key)]);
  for (const [key, value] of entries) {
    const target = key.startsWith('fg-ops-') ? key.replace('fg-ops-', 'primeops-')
      : key.startsWith(legacy.storagePrefix) ? key.replace(legacy.storagePrefix, 'primeops') : null;
    if (target && storage.getItem(target) === null) storage.setItem(target, value);
  }
}
export function readDatabaseEntries(database) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('workspace', 'readonly');
    const store = transaction.objectStore('workspace');
    const keys = store.getAllKeys(), values = store.getAll();
    transaction.oncomplete = () => resolve(keys.result.map((key, index) => [key, values.result[index]]));
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Could not read local data.'));
  });
}
export function writeDatabaseEntries(database, entries) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('workspace', 'readwrite');
    for (const [key, value] of entries) transaction.objectStore('workspace').put(value, key);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Could not save migrated data.'));
  });
}
export async function migrateLegacyDatabase(database, suffix) {
  if ((await readDatabaseEntries(database)).length) return;
  const name = `${legacy.storagePrefix}${suffix}`;
  if (typeof indexedDB.databases === 'function' && !(await indexedDB.databases()).some((item) => item.name === name)) return;
  const source = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    let absent = false;
    request.onupgradeneeded = () => { absent = true; request.transaction.abort(); };
    request.onerror = () => absent ? resolve(null) : reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  if (!source) return;
  try {
    if (!source.objectStoreNames.contains('workspace')) throw new Error('The previous app data format is not supported. Keep the old app and contact support.');
    await writeDatabaseEntries(database, await readDatabaseEntries(source));
  } finally { source.close(); }
}
