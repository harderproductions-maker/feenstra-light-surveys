import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createLicenceClient, verifyLicenceToken, licenceWarning } from './licence.mjs';
const { issueToken } = createRequire(import.meta.url)('../server/license-token.cjs');
const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const systemId = crypto.randomUUID();
const publicKey = keys.publicKey.export({ format: 'jwk' });
const token = issueToken(keys.privateKey, systemId, null, '2024-02-29T12:00:00.000Z');
const status = { systemId, publicKey, token, serverTime: '2025-02-01T12:00:00.000Z', state: 'active', message: 'Annual licence active.' };

test('browser WebCrypto verifies owner signatures, annual term and installation binding', async () => {
  assert.equal((await verifyLicenceToken(token, publicKey, systemId)).expiresAt, '2025-02-28T12:00:00.000Z');
  await assert.rejects(verifyLicenceToken(token, publicKey, crypto.randomUUID()), /this system/);
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
  await assert.rejects(verifyLicenceToken(token, other, systemId), /signature/);
  await assert.rejects(verifyLicenceToken(`${token}.extra`, publicKey, systemId));
});

test('warnings occur exactly one calendar month, seven days and one day before expiry', () => {
  const expiry = '2025-03-31T12:00:00.000Z';
  assert.equal(licenceWarning(expiry, '2025-02-28T11:59:59.999Z'), null);
  assert.equal(licenceWarning(expiry, '2025-02-28T12:00:00.000Z'), 'one month');
  assert.equal(licenceWarning(expiry, '2025-03-24T11:59:59.999Z'), 'one month');
  assert.equal(licenceWarning(expiry, '2025-03-24T12:00:00.000Z'), 'one week');
  assert.equal(licenceWarning(expiry, '2025-03-30T11:59:59.999Z'), 'one week');
  assert.equal(licenceWarning(expiry, '2025-03-30T12:00:00.000Z'), 'one day');
  assert.equal(licenceWarning(expiry, expiry), 'expired');
  assert.equal(licenceWarning('2024-03-31T12:00:00.000Z', '2024-02-29T12:00:00.000Z'), 'one month');
  assert.equal(licenceWarning('2026-01-31T12:00:00.000Z', '2025-12-31T12:00:00.000Z'), 'one month');
});

function fixture() {
  let wall = Date.parse(status.serverTime), tick = 0, server = 'https://one.example', unavailable = false, response = status;
  const values = new Map([['unsent-work', { jobs: ['keep this work'] }]]);
  const storage = { get: async (key) => values.get(key), set: async (key, value) => { values.set(key, structuredClone(value)); } };
  const make = () => createLicenceClient({ storage, getServer: () => server,
    request: async () => { if (unavailable) throw new TypeError('Server down'); return response; },
    onChange: () => {}, now: () => wall, monotonic: () => tick });
  return { make, values, setWall: (value) => { wall = Date.parse(value); }, setTick: (value) => { tick = value; },
    setServer: (value) => { server = value; }, offline: () => { unavailable = true; }, respond: (value) => { response = value; } };
}

test('offline start and exact expiry block access without deleting work, credentials or licence', async () => {
  const f = fixture();
  const first = f.make();
  assert.equal(await first.refresh(), true);
  await first.checkpoint();
  f.offline();
  const offline = f.make();
  assert.equal(await offline.refresh(), true);
  offline.assertActive();
  f.setWall('2025-02-28T11:59:59.999Z');
  offline.assertActive();
  f.setWall('2025-02-28T12:00:00.000Z');
  assert.throws(() => offline.assertActive(), { status: 423 });
  assert.deepEqual(f.values.get('unsent-work'), { jobs: ['keep this work'] });
  assert.equal(f.values.size, 2);
  assert.equal(await f.make().refresh(), false);
});

test('rollback detection and monotonic time prevent reopening an expired active session', async () => {
  const f = fixture();
  const client = f.make();
  await client.refresh();
  f.setWall('2025-01-31T12:00:00.000Z');
  assert.throws(() => client.assertActive(), /clock/);
  f.setWall(status.serverTime);
  await client.refresh();
  f.setTick(28 * 86400000);
  assert.throws(() => client.assertActive(), /expired/);
});

test('server caches are isolated, explicit lock never becomes an offline fallback, invalid live signatures fail closed', async () => {
  const f = fixture();
  const client = f.make();
  await client.refresh();
  f.setServer('https://two.example');
  assert.throws(() => client.assertActive(), /server changed/);
  f.offline();
  assert.equal(await client.refresh(), false);
  const live = fixture();
  const locked = live.make();
  await locked.refresh();
  live.respond({ ...status, state: 'clock', message: 'Correct server clock' });
  assert.equal(await locked.refresh(), false);
  live.offline();
  assert.equal(await live.make().refresh(), false);
  const forged = fixture();
  const verification = forged.make();
  await verification.refresh();
  forged.respond({ ...status, token: token.replace('PO1.', 'FG2.') });
  await assert.rejects(verification.refresh());
  assert.throws(() => verification.assertActive());
});

test('an online owner renewal is downloaded system-wide and restores offline use', async () => {
  const f = fixture();
  const client = f.make();
  await client.refresh();
  f.setWall('2025-02-28T12:00:00.000Z');
  assert.equal(client.check(), false);
  const renewed = issueToken(keys.privateKey, systemId, token, '2025-02-28T12:00:00.000Z');
  f.respond({ ...status, token: renewed, serverTime: '2025-02-28T12:00:00.000Z' });
  assert.equal(await client.refresh(), true);
  assert.equal(client.state().expiresAt, '2026-02-28T12:00:00.000Z');
  f.offline();
  assert.equal(await f.make().refresh(), true);
});

test('manual periods enforce start, end and inactive status online and from downloaded offline data', async () => {
  const f = fixture();
  const manual = (active, startsAt, expiresAt) => issueToken(keys.privateKey, systemId, null, '2025-01-01T00:00:00.000Z', { active, startsAt, expiresAt });
  const client = f.make();
  await client.refresh();
  const originalOffline = f.make();
  await originalOffline.refresh();
  const future = manual(true, '2025-02-10T00:00:00.000Z', '2025-04-15T00:00:00.000Z');
  assert.equal((await verifyLicenceToken(future, publicKey, systemId)).v, 2);
  f.respond({ ...status, token: future, state: 'scheduled' });
  assert.equal(await client.refresh(), false);
  assert.throws(() => client.assertActive(), /not started/);
  f.respond({ ...status, token: manual(false, '2025-01-01T00:00:00.000Z', '2025-04-15T00:00:00.000Z'), state: 'inactive' });
  assert.equal(await client.refresh(), false);
  assert.throws(() => client.assertActive(), /inactive/);
  f.offline();
  assert.equal(await f.make().refresh(), false);
  assert.equal(originalOffline.check(), true);
  const restored = fixture();
  const activeToken = manual(true, '2025-01-01T00:00:00.000Z', '2025-03-05T00:00:00.000Z');
  restored.respond({ ...status, token: activeToken });
  const active = restored.make();
  assert.equal(await active.refresh(), true);
  restored.setWall('2025-03-05T00:00:00.000Z');
  assert.equal(active.check(), false);
  assert.throws(() => active.assertActive(), /expired/);
});
