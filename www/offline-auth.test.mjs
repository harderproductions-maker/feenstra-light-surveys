import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineAuth, isServerUnavailable } from './offline-auth.mjs';

function setup() {
  const records = new Map();
  let server = 'https://first.example';
  let failure;
  let password = 'correct-password';
  let user = { id: 'manager', email: 'manager', role: 'maintenance_manager', propertyIds: ['building'] };
  const options = {
    storage: {
      get: async (key) => structuredClone(records.get(key)),
      set: async (key, value) => records.set(key, structuredClone(value))
    },
    getServer: () => server,
    authenticate: async (email, suppliedPassword) => {
      if (failure) throw failure;
      if (email !== user.email || suppliedPassword !== password) {
        throw Object.assign(new Error('Invalid credentials'), { status: 401 });
      }
      return { user, token: 'server-issued-token' };
    }
  };
  return {
    auth: createOfflineAuth(options), records,
    reopen: () => createOfflineAuth(options),
    fail: (error) => { failure = error; },
    server: (value) => { server = value; },
    password: (value) => { password = value; },
    user: (value) => { user = value; }
  };
}

test('sign out, restart and sign in offline using verified credentials', async () => {
  const app = setup();
  const online = await app.auth.signIn('  MANAGER ', 'correct-password');
  assert.equal(online.offline, false);
  assert.deepEqual((await app.auth.session()).user, online.user);
  const record = app.records.get('offline-auth-v1:https://first.example:manager');
  assert(record.verifier.startsWith('$2b$12$'));
  assert(!JSON.stringify([...app.records]).includes('correct-password'));
  await app.auth.signOut();
  assert.equal(await app.auth.session(), null);
  app.fail(new TypeError('Failed to fetch'));
  const reopened = app.reopen();
  const offline = await reopened.signIn('MANAGER', 'correct-password');
  assert.equal(offline.offline, true);
  assert.deepEqual(offline.user.propertyIds, ['building']);
  assert.equal((await reopened.session()).token, online.token);
  await assert.rejects(() => reopened.signIn('manager', 'wrong-password'), /incorrect/);
  await assert.rejects(() => reopened.signIn('unknown', 'correct-password'), /while connected once/);
});

test('timeouts and HTTP server failures permit offline sign-in', async () => {
  const app = setup();
  await app.auth.signIn('manager', 'correct-password');
  for (const error of [
    new DOMException('Timed out', 'TimeoutError'),
    new DOMException('Aborted', 'AbortError'),
    Object.assign(new Error('Database down'), { status: 503 }),
    Object.assign(new Error('Bad gateway'), { status: 502 })
  ]) {
    app.fail(error);
    assert.equal((await app.auth.signIn('manager', 'correct-password')).offline, true);
  }
});

test('online rejection never falls back and revokes rejected offline credentials', async () => {
  for (const status of [400, 401, 403, 429]) {
    const app = setup();
    await app.auth.signIn('manager', 'correct-password');
    app.fail(Object.assign(new Error('Rejected by server'), { status }));
    await assert.rejects(() => app.auth.signIn('manager', 'correct-password'), /Rejected by server/);
    if ([401, 403].includes(status)) {
      app.fail(new TypeError('Disconnected'));
      await assert.rejects(() => app.auth.signIn('manager', 'correct-password'), /while connected once/);
    }
  }
});

test('cached sign-ins and sessions are isolated by server and account', async () => {
  const app = setup();
  await app.auth.signIn('manager', 'correct-password');
  app.fail(new TypeError('Disconnected'));
  app.server('https://second.example');
  assert.equal(await app.auth.session(), undefined);
  await assert.rejects(() => app.auth.signIn('manager', 'correct-password'), /while connected once/);
  app.server('https://first.example');
  assert.equal((await app.auth.session()).user.id, 'manager');
  await assert.rejects(() => app.auth.signIn('student', 'correct-password'), /while connected once/);
});

test('a later online sign-in replaces the offline password and current permissions', async () => {
  const app = setup();
  await app.auth.signIn('manager', 'correct-password');
  app.password('replacement-password');
  app.user({ id: 'manager', email: 'manager', role: 'maintenance_assistant', propertyIds: ['other'] });
  await app.auth.signIn('manager', 'replacement-password');
  app.fail(new TypeError('Disconnected'));
  await assert.rejects(() => app.auth.signIn('manager', 'correct-password'), /incorrect/);
  const result = await app.auth.signIn('manager', 'replacement-password');
  assert.equal(result.user.role, 'maintenance_assistant');
  assert.deepEqual(result.user.propertyIds, ['other']);
});

test('reconnection refreshes permissions and token without storing the password', async () => {
  const app = setup();
  await app.auth.signIn('manager', 'correct-password');
  await app.auth.refresh({
    token: 'renewed-token',
    user: { id: 'manager', email: 'manager', role: 'maintenance_assistant', propertyIds: [] }
  });
  app.fail(new TypeError('Disconnected'));
  const result = await app.auth.signIn('manager', 'correct-password');
  assert.equal(result.token, 'renewed-token');
  assert.equal(result.user.role, 'maintenance_assistant');
  assert.deepEqual(result.user.propertyIds, []);
});

test('storage and programming errors are surfaced, not treated as offline success', async () => {
  assert.equal(isServerUnavailable(new Error('Programming error')), false);
  assert.equal(isServerUnavailable({ status: 401 }), false);
  const app = setup();
  await app.auth.signIn('manager', 'correct-password');
  app.fail(new Error('Unexpected error'));
  await assert.rejects(() => app.auth.signIn('manager', 'correct-password'), /Unexpected error/);
  const brokenStorage = createOfflineAuth({
    getServer: () => 'server',
    storage: {
      get: async () => { throw new Error('Cannot read local storage'); },
      set: async () => { throw new Error('Cannot save local storage'); }
    },
    authenticate: async () => ({ token: 'token', user: { id: 'manager', email: 'manager' } })
  });
  await assert.rejects(() => brokenStorage.signIn('manager', 'password'), /Cannot save local storage/);
  await assert.rejects(() => brokenStorage.session(), /Cannot read local storage/);
});

test('a late reconnect cannot recreate a session after signing out', async () => {
  let releaseRead;
  const records = new Map();
  const auth = createOfflineAuth({
    getServer: () => 'server',
    authenticate: async () => { throw new Error('Not used'); },
    storage: {
      get: () => new Promise((resolve) => { releaseRead = resolve; }),
      set: async (key, value) => records.set(key, value)
    }
  });
  const refresh = auth.refresh({ token: 'token', user: { id: 'manager', email: 'manager' } });
  await auth.signOut();
  releaseRead({ verifier: 'existing-verifier', user: { id: 'manager' } });
  await refresh;
  assert.equal(records.get('offline-session-v1:server'), null);
});

test('changing servers during sign-in cannot cache credentials under the other server', async () => {
  let server = 'first';
  let complete;
  const records = new Map();
  const auth = createOfflineAuth({
    getServer: () => server,
    authenticate: () => new Promise((resolve) => { complete = resolve; }),
    storage: {
      get: async (key) => records.get(key),
      set: async (key, value) => records.set(key, value)
    }
  });
  const pending = auth.signIn('manager', 'correct-password');
  server = 'second';
  complete({ token: 'token', user: { id: 'manager', email: 'manager' } });
  await assert.rejects(() => pending, /server address changed/);
  assert.equal(records.size, 0);
});
