import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createOfflineStore } from './offline.mjs';
import { projectView } from './offline-views.mjs';
import { canManageBuildingAccount, permissionKey } from './building-access.mjs';
import { createApplianceView } from './appliances.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(send) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  const records = new Map();
  const context = {
    user: { id: 'manager', role: 'maintenance_manager', propertyIds: ['a'] },
    server: 'server', session: 1
  };
  const storage = {
    get: async (key) => structuredClone(records.get(key)),
    set: async (key, value) => records.set(key, structuredClone(value))
  };
  const store = createOfflineStore({
    storage, send, getUser: () => context.user, getServer: () => context.server,
    getSession: () => context.session, notify: () => {}
  });
  return { store, context, records, storage };
}

for (const change of ['account', 'server', 'session', 'permissions']) {
  test(`delayed read is rejected after ${change} changes, without caching or delivering it`, async () => {
    const started = deferred(), response = deferred();
    const { store, context, records } = fixture(async () => {
      started.resolve();
      return response.promise;
    });
    const pending = store.request('/api/tickets');
    const rejected = assert.rejects(pending, /account or building access changed/);
    await started.promise;
    if (change === 'account') context.user = { ...context.user, id: 'other' };
    if (change === 'server') context.server = 'other-server';
    if (change === 'session') context.session++;
    if (change === 'permissions') context.user = { ...context.user, propertyIds: ['b'] };
    response.resolve({ tickets: [{ id: 'secret', property_id: 'a' }] });
    await rejected;
    assert.equal(records.size, 0);
    assert.deepEqual((await store.status()).cache, {});
  });
}

test('a known arrears block denies cached reads and queued writes without deleting pending work', async () => {
  const { store, context, records } = fixture(async () => { throw new TypeError('Offline'); });
  const key = 'offline-v1:server:manager';
  records.set(key, {
    role: context.user.role, permissions: permissionKey(context.user), ids: {}, photos: {},
    cache: { '/api/tickets': { value: { tickets: [{ id: 'cached', property_id: 'a' }] } } },
    jobs: [{ id: 'pending', state: 'pending', path: '/api/properties', method: 'POST', body: { name: 'Pending building' } }]
  });
  context.user = { ...context.user, billingBlocked: true };
  await assert.rejects(store.request('/api/tickets'), /blocked for overdue/);
  await assert.rejects(store.request('/api/properties', { method: 'POST', body: { name: 'New building' } }), /blocked for overdue/);
  const saved = await store.status();
  assert.equal(saved.jobs.length, 1);
  assert.equal(saved.jobs[0].state, 'blocked');
  assert.deepEqual(saved.cache, {});
});

test('a failed write cannot queue under a later signed-in account', async () => {
  const started = deferred(), response = deferred();
  const { store, context, records } = fixture(async () => {
    started.resolve();
    await response.promise;
    throw new TypeError('Network unavailable');
  });
  const pending = store.request('/api/properties', { method: 'POST', body: { name: 'Private building' } });
  const rejected = assert.rejects(pending, /account or building access changed/);
  await started.promise;
  context.user = { ...context.user, id: 'other' };
  response.resolve();
  await rejected;
  assert.equal(records.size, 0);
});

test('same-role building revocation purges all cached exports and photos and quarantines pending actions', async () => {
  const { store, context, records } = fixture(async () => { throw new TypeError('Offline'); });
  const key = 'offline-v1:server:manager';
  records.set(key, {
    role: context.user.role, permissions: permissionKey(context.user), ids: {},
    cache: {
      '/api/tickets': { value: { tickets: [{ id: 'ticket', property_id: 'a' }] }, at: '2026-01-01' },
      '/api/appliance-reports/secret/export': { value: { html: 'PRIVATE' }, at: '2026-01-01' }
    },
    photos: { ticket: 'PRIVATE PHOTO' },
    jobs: [{ id: 'pending', state: 'pending', path: '/api/reports', method: 'POST', body: { building: 'A', html: 'PRIVATE' } }]
  });
  context.user = { ...context.user, propertyIds: ['b'] };
  const saved = await store.status();
  assert.deepEqual(saved.cache, {});
  assert.deepEqual(saved.photos, {});
  assert.equal(saved.jobs[0].state, 'blocked');
  assert.equal(saved.jobs[0].scopeBlocked, true);
  await assert.rejects(store.retry('pending'), /role or buildings changed/);
  await assert.rejects(store.photo('ticket'), /not been downloaded/);
  assert.deepEqual(records.get(key).cache, {});
  assert.deepEqual(records.get(key).photos, {});
});

test('projection filters unauthorized buildings, users, pending changes and export HTML defensively', () => {
  const user = { id: 'mm', role: 'maintenance_manager', propertyIds: ['a'] };
  const cache = {
    '/api/properties': { value: { properties: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } },
    '/api/tickets': { value: { tickets: [{ id: 'allowed', property_id: 'a' }, { id: 'secret', property_id: 'b' }] } },
    '/api/appliance-reports': { value: { reports: [{ id: 'secret', property_id: 'b' }] } },
    '/api/appliance-reports/secret/export': { value: { html: 'PRIVATE' } },
    '/api/users': { value: { users: [
      { id: 'allowed', role: 'user', property_ids: ['a'] },
      { id: 'mixed', role: 'user', property_ids: ['a', 'b'] },
      { id: 'manager', role: 'maintenance_manager', property_ids: ['a'] }
    ] } }
  };
  const jobs = [{ state: 'blocked', scopeBlocked: true, path: '/api/tickets', method: 'POST', body: { propertyId: 'b' } }];
  assert.deepEqual(projectView('/api/tickets', cache, jobs, user).tickets.map((ticket) => ticket.id), ['allowed']);
  assert.deepEqual(projectView('/api/properties', cache, jobs, user).properties.map((property) => property.id), ['a']);
  assert.deepEqual(projectView('/api/users', cache, jobs, user).users.map((account) => account.id), ['allowed']);
  assert.throws(() => projectView('/api/appliance-reports/secret/export', cache, jobs, user), /not been downloaded/);
  assert.equal(projectView('/api/tickets', cache, jobs, { id: 'admin', role: 'admin' }).tickets.length, 2);
  assert.equal(canManageBuildingAccount(user, { role: 'user', property_ids: ['a', 'b'] }), false);
});

test('quarantined changes do not prevent downloading newly permitted buildings', async () => {
  const { store, context, records } = fixture(async () => ({ properties: [{ id: 'b', name: 'New building' }] }));
  const saved = await store.status();
  saved.jobs.push({ id: 'old', state: 'pending', path: '/api/reports', method: 'POST', body: { building: 'A', html: 'PRIVATE' } });
  records.set('offline-v1:server:manager', saved);
  context.user = { ...context.user, propertyIds: ['b'] };
  assert.deepEqual((await store.request('/api/properties')).properties, [{ id: 'b', name: 'New building' }]);
  assert.equal((await store.status()).jobs[0].scopeBlocked, true);
});

test('warming never continues under a different account', async () => {
  const started = deferred(), response = deferred(), requests = [];
  const { store, context } = fixture(async (path) => {
    requests.push(path);
    started.resolve();
    return response.promise;
  });
  const pending = store.warm();
  const rejected = assert.rejects(pending, /account or building access changed/);
  await started.promise;
  context.user = { id: 'other', role: 'technician', propertyIds: ['b'] };
  response.resolve({ properties: [{ id: 'a', name: 'A' }] });
  await rejected;
  assert.deepEqual(requests, ['/api/properties']);
  assert.deepEqual((await store.status()).cache, {});
});

test('a delayed photo storage read cannot deliver a previous account photo', async () => {
  const { store, context, records, storage } = fixture(async () => {});
  const saved = await store.status();
  saved.cache['/api/tickets'] = { value: { tickets: [{ id: 'ticket', property_id: 'a' }] } };
  saved.photos.ticket = 'PRIVATE PHOTO';
  records.set('offline-v1:server:manager', saved);
  const started = deferred(), release = deferred(), get = storage.get;
  storage.get = async (key) => {
    const data = await get(key);
    started.resolve();
    await release.promise;
    return data;
  };
  const pending = store.photo('ticket');
  const rejected = assert.rejects(pending, /account or building access changed/);
  await started.promise;
  context.user = { ...context.user, id: 'other' };
  release.resolve();
  await rejected;
});

test('sync does not apply an old account upload response after switching accounts', async () => {
  const started = deferred(), response = deferred();
  const { store, context, records } = fixture(async (path) => {
    if (path === '/api/auth/me') return { user: structuredClone(context.user) };
    started.resolve();
    return response.promise;
  });
  const saved = await store.status();
  saved.jobs.push({ id: 'job', localId: 'local-building', path: '/api/properties', method: 'POST', body: { name: 'Private' }, state: 'pending' });
  records.set('offline-v1:server:manager', saved);
  const syncing = store.sync();
  await started.promise;
  context.user = { ...context.user, id: 'other' };
  response.resolve({ property: { id: 'private-building' } });
  await syncing;
  assert.deepEqual((await store.status()).cache, {});
  assert.deepEqual((await store.status()).jobs, []);
  assert.equal(records.get('offline-v1:server:manager').jobs[0].state, 'pending');
});

test('a delayed laundry draft cannot replace the next account screen', async () => {
  const draft = deferred();
  let owner = 'first-account';
  const workspace = { innerHTML: '', addEventListener() {} };
  const view = createApplianceView({
    workspace, isCurrent: () => true, getOwner: () => owner, canManage: () => false,
    draftKey: () => owner, draftStorage: { get: () => draft.promise },
    apiRequest: async (path) => path === '/api/appliance-parts' ? { parts: [] }
      : path === '/api/appliance-reports' ? { reports: [{ id: 'PRIVATE' }] } : { properties: [] }
  });
  const loading = view.render();
  owner = 'second-account';
  workspace.innerHTML = 'Second account screen';
  draft.resolve({ checkStart: {}, entries: [{ notes: 'PRIVATE' }] });
  await loading;
  assert.equal(workspace.innerHTML, 'Second account screen');
});

test('OHS workspace scoping removes checks, report revisions and surveys outside manager assignments', async () => {
  const source = await fs.readFile(new URL('./app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function scopeStateToUser(');
  const end = source.indexOf('\nfunction hasFullAccess', start);
  const { canUseSection } = await import('./account-access.mjs');
  const context = vm.createContext({ hasOpsAccess: () => true, canUseSection });
  vm.runInContext(source.slice(start, end), context);
  const workspace = {
    properties: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    surveys: [{ id: 'allowed', propertyId: 'a' }, { id: 'private', buildingName: 'B', reports: [{ html: 'PRIVATE' }] }],
    buildingChecks: [{ id: 'private-check', propertyId: 'b', reports: [{ html: 'PRIVATE' }] }]
  };
  const scoped = context.scopeStateToUser(workspace, { role: 'maintenance_manager', propertyIds: ['a'] });
  assert.equal(scoped.surveys.length, 1);
  assert.equal(scoped.properties.length, 1);
  assert.equal(scoped.buildingChecks.length, 0);
  assert(!JSON.stringify(scoped).includes('PRIVATE'));
  assert.equal(context.scopeStateToUser(workspace, { role: 'admin' }).surveys.length, 2);
});
