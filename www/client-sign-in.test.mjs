import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { resolveClient, signInClient } from './client-sign-in.mjs';
const { issueToken } = createRequire(import.meta.url)('../server/license-token.cjs');

test('company code/name resolution caches only client identity for offline use and isolates servers', async () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  const input = { identifier: ' Example Company ', server: 'https://one.example', storage };
  assert.equal(await resolveClient({ ...input, request: async (path, body) => {
    assert.equal(path, '/api/auth/company');
    assert.deepEqual(body, { identifier: 'Example Company' });
    return { code: 'EXAMPLE', name: 'Example Company' };
  } }), 'EXAMPLE');
  const unavailable = async () => { throw new TypeError('Offline'); };
  assert.equal(await resolveClient({ ...input, request: unavailable }), 'EXAMPLE');
  await assert.rejects(resolveClient({ ...input, server: 'https://other.example', request: unavailable }), /Connect once/);
  assert.equal(await resolveClient({ ...input, identifier: 'example-code', request: unavailable }), 'EXAMPLE-CODE');
});

test('unknown and ambiguous companies are not replaced with cached client identities', async () => {
  const storage = { getItem: () => 'OLD', setItem: () => assert.fail('Unexpected cache write') };
  for (const status of [404, 409, 429]) {
    await assert.rejects(resolveClient({ identifier: 'Company', server: 'server', storage,
      request: async () => { throw Object.assign(new Error('Lookup rejected'), { status }); }
    }), { status });
  }
  await assert.rejects(resolveClient({ identifier: '', server: 'server', storage }), /Enter your client/);
});

test('one-step client sign-in verifies the licence and credentials and retains offline sign-in without storing plaintext passwords', async () => {
  const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const systemId = crypto.randomUUID();
  const licence = { systemId, token: issueToken(keys.privateKey, systemId), publicKey: keys.publicKey.export({ format: 'jwk' }),
    serverTime: new Date().toISOString(), state: 'active', message: 'Active' };
  const values = new Map([['pending-work', { jobs: ['keep'] }]]);
  const storage = { get: async (key) => values.get(key), set: async (key, value) => values.set(key, value) };
  let offline = false, rejectLogin = false;
  const user = { id: 'office', email: 'office', role: 'office_admin', propertyIds: ['one'] };
  const options = { server: 'https://server.example/c/EXAMPLE', storage, email: 'Office', password: 'office-test-password',
    request: async (path, body, token) => {
      if (offline) throw new TypeError('Offline');
      if (path === '/api/license') return licence;
      if (path === '/api/auth/login') {
        assert.deepEqual(body, { email: 'office', password: options.password });
        if (rejectLogin) throw Object.assign(new Error('Incorrect password'), { status: 401 });
        return { token: 'session-token' };
      }
      assert.equal(path, '/api/auth/me');
      assert.equal(token, 'session-token');
      return { user };
    }
  };
  assert.deepEqual(await signInClient(options), { token: 'session-token', user, offline: false });
  assert(!JSON.stringify([...values]).includes(options.password));
  assert.deepEqual(values.get('pending-work'), { jobs: ['keep'] });
  offline = true;
  assert.equal((await signInClient(options)).offline, true);
  await assert.rejects(signInClient({ ...options, password: 'wrong-password' }), /incorrect/);
  offline = false;
  rejectLogin = true;
  await assert.rejects(signInClient(options), { status: 401 });
});

test('inactive client licence blocks sign-in before credentials are sent', async () => {
  await assert.rejects(signInClient({
    server: 'server', email: 'office', password: 'password',
    storage: { get: async () => null, set: async () => {} },
    request: async (path) => {
      assert.equal(path, '/api/license');
      return { state: 'missing', message: 'Contact the office to activate your client.', serverTime: new Date().toISOString() };
    }
  }), /Contact the office/);
});
