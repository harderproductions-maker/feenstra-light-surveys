import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountSections, sectionsFor, canUseSection, canDelegateAccounts, sectionForPath, accountBuildingIds, managerRoles } from './account-access.mjs';
import { canManageBuildingAccount, permissionKey } from './building-access.mjs';
import { projectView } from './offline-views.mjs';
import { createOfflineStore } from './offline.mjs';

const mm = { id: 'manager', role: 'maintenance_manager', propertyIds: ['p'] };
test('office administrators default to leasing and billing within assigned buildings and approved features', () => {
  const office = { id: 'office', role: 'office_admin', propertyIds: ['p'] };
  assert.equal(managerRoles.includes('office_admin'), true);
  assert.deepEqual(sectionsFor(office), ['leasing', 'billing']);
  assert.deepEqual(sectionsFor({ ...office, companyFeatures: ['billing'] }), ['billing']);
  assert.equal(canUseSection(office, 'users'), false);
  assert.equal(canDelegateAccounts(office), false);
  assert.deepEqual(sectionsFor({ ...office, sections: ['users', 'residents'] }), ['users', 'residents']);
  assert.equal(canManageBuildingAccount({ role: 'admin' }, office), true);
  assert.equal(canManageBuildingAccount({ ...mm, adminRights: true }, { ...office, property_ids: ['outside'] }), false);
});
test('residents require exactly one distinct building while staff can have several', () => {
  for (const role of ['user', 'admin', ...managerRoles, 'maintenance_assistant', 'technician']) {
    for (const invalid of [undefined, [], [''], [null], ['p', ' ']]) assert.throws(() => accountBuildingIds(role, invalid), /Choose at least one/);
    assert.deepEqual(accountBuildingIds(role, ['p']), ['p']);
    assert.deepEqual(accountBuildingIds(role, ['p', 'p']), ['p']);
    if (role === 'user') assert.throws(() => accountBuildingIds(role, ['p', 'q']), /exactly one/);
    else assert.deepEqual(accountBuildingIds(role, ['p', 'q']), ['p', 'q']);
  }
});
test('company features intersect every role while user management stays essential', () => {
  const companyFeatures = ['tickets'];
  assert.deepEqual(sectionsFor({ role: 'admin', companyFeatures }), ['tickets', 'users']);
  assert.deepEqual(sectionsFor({ ...mm, sections: ['checks', 'tickets'], companyFeatures }), ['tickets']);
  assert.equal(canUseSection({ role: 'technician', companyFeatures }, 'appliances'), false);
  assert.deepEqual(sectionsFor({ role: 'admin', companyFeatures: [] }), ['users']);
  assert.notEqual(permissionKey(mm), permissionKey({ ...mm, companyFeatures }));
});
test('legacy managers retain sections and full admins remain unrestricted', () => {
  assert.deepEqual(sectionsFor(mm), accountSections.filter(([id]) => id !== 'leasing').map(([id]) => id));
  assert.equal(canDelegateAccounts(mm), false);
  assert.equal(sectionsFor({ role: 'admin', sections: [] }).length, accountSections.length);
  assert.equal(canDelegateAccounts({ role: 'admin' }), true);
});
test('manager profiles support scoped grants and assigned client admin leasing access', () => {
  for (const role of ['admin', 'portfolio_manager', 'building_manager']) {
    assert.equal(canUseSection({ role, companyFeatures: ['leasing'] }, 'leasing'), true);
    assert.equal(canUseSection({ role, companyFeatures: [] }, 'leasing'), false);
  }
  for (const role of managerRoles) {
    const manager = { id: 'manager', role, propertyIds: ['p'], sections: ['tickets', 'users'], companyFeatures: ['tickets'], adminRights: true };
    assert.equal(canDelegateAccounts(manager), true);
    assert.equal(canUseSection(manager, 'billing'), false);
    assert.equal(canUseSection({ ...manager, sections: [] }, 'tickets'), false);
    assert.equal(canManageBuildingAccount(manager, { id: 'worker', role: 'maintenance_assistant', property_ids: ['outside'] }), false);
  }
  assert.equal(canUseSection({ role: 'operations_manager' }, 'billing'), false);
  assert.equal(canUseSection({ role: 'operations_manager' }, 'leasing'), false);
  assert.equal(canUseSection({ role: 'building_manager', sections: [], companyFeatures: ['leasing'] }, 'leasing'), false);
  assert.equal(sectionForPath('/api/leasing/leases'), 'leasing');
});
test('custom manager grants are independent and fingerprinted for cache/replay isolation', () => {
  const restricted = { ...mm, sections: ['lighting'] };
  assert.equal(canUseSection(restricted, 'lighting'), true);
  assert.equal(canUseSection(restricted, 'checks'), false);
  assert.equal(sectionsFor({ ...mm, sections: [] }).length, 0);
  assert.notEqual(permissionKey(mm), permissionKey(restricted));
  assert.notEqual(permissionKey(mm), permissionKey({ ...mm, adminRights: true }));
  for (const [path, section] of [['/api/tickets/1/photo', 'tickets'], ['/api/ticket-assignees?propertyId=p', 'tickets'],
    ['/api/users/1', 'users'], ['/api/billing/accounts', 'billing'],
    ['/api/building-quote-contacts', 'appliances'], ['/api/technician-attendance', 'appliances'],
    ['/api/operations/security', 'security'], ['/api/operations/residents/123', 'residents'],
    ['/api/operations/meters', 'meters'], ['/api/operations/assets', 'assets'],
    ['/api/operations/incidents', 'incidents'], ['/api/operations/contractors', 'contractors']]) {
    assert.equal(sectionForPath(path), section);
  }
});
test('new operations intersect role, explicit MM sections and client activation', () => {
  const companyFeatures = ['security', 'residents', 'meters', 'assets', 'incidents', 'contractors'];
  assert.deepEqual(sectionsFor({ role: 'user', companyFeatures }), ['security', 'residents', 'incidents']);
  assert.deepEqual(sectionsFor({ role: 'maintenance_assistant', companyFeatures }), ['meters', 'assets', 'incidents']);
  assert.deepEqual(sectionsFor({ ...mm, sections: ['security', 'residents'], companyFeatures }), ['security', 'residents']);
  assert.deepEqual(sectionsFor({ role: 'technician', companyFeatures }), []);
});
test('scoped admins cannot edit themselves, full admins, other scoped admins or wider accounts', () => {
  const actor = { ...mm, sections: ['users', 'tickets'], adminRights: true };
  const target = { id: 'other', role: 'maintenance_manager', sections: ['tickets'], property_ids: ['p'] };
  assert.equal(canManageBuildingAccount(actor, target), true);
  for (const change of [{ id: mm.id }, { role: 'admin' }, { admin_rights: true }, { sections: ['billing'] }, { property_ids: ['outside'] }]) {
    assert.equal(canManageBuildingAccount(actor, { ...target, ...change }), false);
  }
  assert.equal(canManageBuildingAccount({ ...actor, adminRights: false }, target), false);
});
test('disabled cached sections are unavailable and ticket-only assignees need no Users permission', () => {
  const actor = { ...mm, sections: ['tickets'] };
  const cache = { '/api/appliance-parts': { value: { parts: [{ name: 'PRIVATE' }] } },
    '/api/ticket-assignees?propertyId=p': { value: { assistants: [{ id: 'ma', name: 'Assistant' }] } } };
  assert.throws(() => projectView('/api/appliance-parts', cache, [], actor), /access/);
  assert.equal(projectView('/api/ticket-assignees?propertyId=p', cache, [], actor).assistants[0].name, 'Assistant');
});
test('billing access does not require user management or ticket access', () => {
  const actor = { ...mm, sections: ['billing'] };
  const cache = { '/api/billing/accounts': { value: { accounts: [
    { id: 'student', property_ids: ['p'] }, { id: 'outside', property_ids: ['outside'] }
  ] } } };
  assert.deepEqual(projectView('/api/billing/accounts', cache, [], actor).accounts.map((row) => row.id), ['student']);
});
test('warming restricted manager caches downloads only enabled sections', async () => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  const records = new Map(), paths = [];
  const store = createOfflineStore({
    storage: { get: async (key) => records.get(key), set: async (key, value) => records.set(key, value) },
    getUser: () => ({ ...mm, sections: ['tickets'] }), getServer: () => 'server', notify() {},
    send: async (path) => {
      paths.push(path);
      if (path === '/api/properties') return { properties: [{ id: 'p' }] };
      if (path === '/api/tickets') return { tickets: [] };
      if (path.startsWith('/api/ticket-assignees')) return { assistants: [] };
      throw new Error(`Unexpected download: ${path}`);
    }
  });
  await store.warm();
  assert.deepEqual(paths, ['/api/properties', '/api/tickets', '/api/ticket-assignees?propertyId=p']);
  await assert.rejects(store.request('/api/users'), /access/);
});
test('revoking sections clears downloaded data and quarantines existing pending writes', async () => {
  let user = { ...mm, sections: ['tickets'] };
  let online = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  const records = new Map();
  const store = createOfflineStore({
    storage: { get: async (key) => structuredClone(records.get(key)), set: async (key, value) => records.set(key, structuredClone(value)) },
    getUser: () => user, getServer: () => 'server', notify() {},
    send: async (path) => {
      if (!online) throw new TypeError('Offline');
      if (path === '/api/properties') return { properties: [{ id: 'p' }] };
      if (path === '/api/tickets') return { tickets: [{ id: 'ticket', property_id: 'p', status: 'assigned', events: [] }] };
      return { assistants: [] };
    }
  });
  await store.warm();
  online = false;
  await store.request('/api/tickets/ticket/status', { method: 'PUT', body: { status: 'in_progress' } });
  user = { ...user, sections: [] };
  const saved = await store.status();
  assert.equal(saved.jobs.length, 1);
  assert.equal(saved.jobs[0].scopeBlocked, true);
  assert.equal(saved.jobs[0].state, 'blocked');
  const state = [...records.values()][0];
  assert.deepEqual(state.cache, {});
  assert.deepEqual(state.photos, {});
  await assert.rejects(store.request('/api/tickets'), /access/);
});
