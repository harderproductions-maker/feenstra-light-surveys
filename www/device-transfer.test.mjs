import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptTransfer, decryptTransfer } from './device-transfer.mjs';
import { migrateLocalSettings } from './product-migration.mjs';
import legacy from './legacy-identifiers.json' with { type: 'json' };

test('encrypted transfer preserves queued work and rejects wrong passwords, tampering and malformed files', async () => {
  const data = { company: 'EXAMPLE', entries: [['offline-v1:server:one', { jobs: [{ path: '/api/users', state: 'pending', body: { name: 'Offline account' } }] }]],
    settings: { 'primeops-token-EXAMPLE': 'private-session' } };
  const bundle = await encryptTransfer(data, 'backup-password-123');
  assert(!JSON.stringify(bundle).includes('private-session'));
  assert.deepEqual(await decryptTransfer(bundle, 'backup-password-123'), data);
  await assert.rejects(decryptTransfer(bundle, 'incorrect-password'), /incorrect or.*damaged/);
  const corrupt = { ...bundle, data: `${bundle.data[0] === 'A' ? 'B' : 'A'}${bundle.data.slice(1)}` };
  await assert.rejects(decryptTransfer(corrupt, 'backup-password-123'), /incorrect or.*damaged/);
  await assert.rejects(decryptTransfer({}, 'backup-password-123'), /valid PrimeOps/);
  await assert.rejects(encryptTransfer(data, 'short'), /12 characters/);
});
test('settings migrate without overwriting new data or deleting old copies', () => {
  const entries = new Map([
    [`${legacy.storagePrefix}-token`, 'old-token'], [`${legacy.storagePrefix}-theme`, 'dark'],
    ['primeops-token', 'new-token'], [legacy.companyCodeKey, 'EXAMPLE']
  ]);
  const storage = { get length() { return entries.size; }, key: (index) => [...entries.keys()][index],
    getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  migrateLocalSettings(storage);
  assert.equal(entries.get('primeops-token'), 'new-token');
  assert.equal(entries.get('primeops-theme'), 'dark');
  assert.equal(entries.get('primeops-company-code'), 'EXAMPLE');
  assert.equal(entries.get(`${legacy.storagePrefix}-token`), 'old-token');
});
