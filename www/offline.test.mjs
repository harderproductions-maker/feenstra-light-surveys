import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineStore } from './offline.mjs';
import { projectView } from './offline-views.mjs';
import { bookingWindow, localDay } from './technician-visits.mjs';

function scheduleFixture() {
  return { visits: [{ id: 'visit', technician_id: 'tech', property_id: 'p', kind: 'booking',
    ...bookingWindow({ date: localDay(), allDay: true }), started_at: new Date(Date.now() - 60000).toISOString() }],
  locations: [{ property_id: 'p', latitude: -25.75, longitude: 28.19, radius: 100 }], technicians: [] };
}

function checkAudit() {
  const point = { latitude: -25.75, longitude: 28.19, accuracy: 8, capturedAt: new Date().toISOString(), mocked: false };
  return { started: point, completed: point, durationMs: 0, offlineCompleted: true };
}

function laundryBody(propertyId, parts = []) {
  const audit = checkAudit();
  return {
    propertyId, applianceType: 'Washer', expectedCount: 1, checkAudit: audit, visitId: 'visit',
    entries: [{
      machineNumber: '1', serialNumber: 'SERIAL-1', modelNumber: 'SWNMN2SP303SW01', status: parts.length ? 'needs_repair' : 'working', notes: '',
      parts, checkAudit: audit, photo: { data: 'data:image/jpeg;base64,/9j/2Q==', source: 'camera', capturedAt: audit.completed.capturedAt }
    }]
  };
}

test('downloaded no-show notes are manager-only and building-scoped; recording is online-only', async () => {
  const absence = { id: 'one', property_id: 'p', technician_id: 'tech', note: 'Private manager note' };
  const cache = { '/api/technician-schedule': { value: { visits: [], locations: [], technicians: [],
    absences: [absence, { ...absence, id: 'two', property_id: 'outside' }] } } };
  for (const role of ['admin', 'maintenance_manager', 'technician']) {
    const projected = projectView('/api/technician-schedule', cache, [], { id: 'tech', role, propertyIds: ['p'] });
    assert.equal(projected.absences.length, role === 'admin' ? 2 : role === 'maintenance_manager' ? 1 : 0);
  }
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  let user = { id: 'manager', role: 'maintenance_manager', propertyIds: ['p'] }, sends = 0;
  const records = new Map();
  const store = createOfflineStore({
    storage: { get: async (key) => records.get(key), set: async (key, value) => records.set(key, value) },
    getUser: () => user, getServer: () => 'server', notify() {},
    send: async () => { sends++; throw new TypeError('Network unavailable'); }
  });
  await assert.rejects(store.request('/api/technician-absences', { method: 'POST', body: {} }), /Network unavailable/);
  assert.equal(records.size, 0);
  user = { ...user, role: 'technician' };
  await assert.rejects(store.request('/api/technician-absences', { method: 'POST', body: {} }), /Only MMs/);
  assert.equal(sends, 1);
});

test('downloaded booking requests stay building- and technician-scoped and cannot be submitted offline', async () => {
  const cache = { '/api/technician-schedule': { value: { visits: [], locations: [], technicians: [], requests: [
    { id: 'own', property_id: 'p', technician_id: 'tech', status: 'pending', reason: 'Own request' },
    { id: 'other-tech', property_id: 'p', technician_id: 'another', status: 'pending', reason: 'Private request' },
    { id: 'outside', property_id: 'outside', technician_id: 'tech', status: 'pending', reason: 'Other building' }
  ] } } };
  assert.deepEqual(projectView('/api/technician-schedule', cache, [], { id: 'tech', role: 'technician', propertyIds: ['p'] }).requests.map((r) => r.id), ['own']);
  assert.deepEqual(projectView('/api/technician-schedule', cache, [], { id: 'mm', role: 'maintenance_manager', propertyIds: ['p'] }).requests.map((r) => r.id), ['own', 'other-tech']);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  const records = new Map();
  const store = createOfflineStore({
    storage: { get: async (key) => records.get(key), set: async (key, value) => records.set(key, value) },
    getUser: () => ({ id: 'tech', role: 'technician', propertyIds: ['p'] }), getServer: () => 'server', notify() {},
    send: async () => { throw new TypeError('Connection required'); }
  });
  await assert.rejects(store.request('/api/technician-bookings/visit/requests',
    { method: 'POST', body: { action: 'cancel', reason: 'Unavailable' } }), /Connection required/);
  assert.equal(records.size, 0);
});

test('saving building quotation contacts refreshes the downloaded offline copy without another fetch', async () => {
  let online = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  const records = new Map();
  const original = { property_id: 'p', email: 'old@building.example', suppliers: [] };
  const updated = { ...original, email: 'new@building.example', suppliers: [{ name: 'Parts', email: 'parts@supplier.example' }] };
  const store = createOfflineStore({
    storage: { get: async (key) => structuredClone(records.get(key)), set: async (key, value) => records.set(key, structuredClone(value)) },
    getUser: () => ({ id: 'manager', role: 'maintenance_manager', propertyIds: ['p'] }),
    getServer: () => 'https://server.example', notify() {},
    send: async (path, options = {}) => {
      if (!online) throw new TypeError('Network unavailable');
      return options.method === 'PUT' ? { contact: updated } : { contacts: [original] };
    }
  });

  test('manager can queue in-progress ticket status without losing its assigned assistant', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    let online = true;
    const records = new Map(), user = { id: 'manager', role: 'maintenance_manager', propertyIds: ['p'] };
    const ticket = { id: 'ticket', property_id: 'p', status: 'assigned', assigned_to: 'ma', assigned_to_name: 'Alex', events: [] };
    const store = createOfflineStore({
      storage: { get: async (key) => structuredClone(records.get(key)), set: async (key, value) => records.set(key, structuredClone(value)) },
      getUser: () => user, getServer: () => 'server', notify() {},
      send: async () => { if (!online) throw new TypeError('Network unavailable'); return { tickets: [ticket] }; }
    });
    await store.request('/api/tickets');
    online = false;
    const result = await store.request('/api/tickets/ticket/status', { method: 'PUT', body: { status: 'in_progress', note: 'Started repair' } });
    assert.equal(result.queued, true);
    const projected = (await store.request('/api/tickets')).tickets[0];
    assert.equal(projected.status, 'in_progress');
    assert.equal(projected.assigned_to_name, 'Alex');
    assert.equal(projected.assigned_to, 'ma');
  });
  await store.request('/api/building-quote-contacts');
  await store.request('/api/building-quote-contacts/p', { method: 'PUT', body: updated });
  online = false;
  const downloaded = await store.request('/api/building-quote-contacts');
  assert.equal(downloaded.offline_copy, true);
  assert.deepEqual(downloaded.contacts, [updated]);
  await assert.rejects(store.request('/api/building-quote-contacts/p', { method: 'PUT', body: updated }), /Network unavailable/);
});

test('offline fieldwork persists, maps new resources and uploads in order', async () => {
  let online = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  const records = new Map();
  const storage = {
    get: async (key) => structuredClone(records.get(key)),
    set: async (key, value) => records.set(key, structuredClone(value))
  };
  let user = { id: 'manager', role: 'maintenance_manager', name: 'Manager', propertyIds: ['building'] };
  const data = {
    '/api/check-templates': { templates: [] },
    '/api/properties': { properties: [{ id: 'building', name: 'Building' }] },
    '/api/users': { users: [] },
    '/api/tickets': { tickets: [] },
    '/api/appliance-parts': { parts: [{ id: 'heater', name: 'Heater', part_number: 'HT1', supplier: 'Parts shop', machine_type: 'Washer', active: true }] },
    '/api/appliance-assets': { properties: [], assets: [], reports: [], events: [], machines: [], buildings: [], requests: [], unlinkedChecks: 0 },
    '/api/appliance-reports': { reports: [] },
    '/api/billing/accounts': { accounts: [] }
    , '/api/technician-schedule': { visits: [], locations: [], technicians: [] }
  };
  const uploaded = [];
  let failUpload = false;
  const send = async (path, options = {}) => {
    if (!online || failUpload) throw new TypeError('Network unavailable');
    if (path === '/api/auth/me') return { user };
    if (!options.method || options.method === 'GET') return structuredClone(data[path] || { assistants: [] });
    uploaded.push({ path, ...options });
    if (path === '/api/users') {
      const result = { id: 'server-user', role: options.body.role, unit_number: options.body.unitNumber, property_ids: options.body.propertyIds };
      data['/api/users'].users.push(result);
      return { user: result };
    }
    if (path.endsWith('/entries')) return { entries: [{ id: 'server-entry' }] };
    if (path === '/api/tickets') return { ticket: { id: 'server-ticket' } };
    if (path === '/api/appliance-reports') return { report: { id: 'server-report' } };
    return { success: true };
  };
  const store = createOfflineStore({ storage, send, getUser: () => user, getServer: () => 'https://server.example', notify: () => {} });
  await store.warm();
  online = false;
  await assert.rejects(store.request('/api/users', { method: 'POST', body: {
    name: 'Student', email: 'student', password: 'password', role: 'user', unitNumber: 'A1', propertyIds: ['building', 'another']
  } }), /exactly one building/);
  assert.equal((await store.status()).jobs.length, 0);
  const { user: student } = await store.request('/api/users', { method: 'POST', body: {
    name: 'Student', email: 'student', password: 'password', role: 'user', unitNumber: 'A1', propertyIds: ['building']
  } });
  assert(student.id.startsWith('local-'));
  await assert.rejects(store.request(`/api/users/${student.id}`, { method: 'PUT', body: {
    name: 'Student', email: 'student', role: 'user', unitNumber: 'A1', propertyIds: ['building', 'another']
  } }), /exactly one building/);
  assert.equal((await store.status()).jobs.length, 1);
  await store.request(`/api/billing/accounts/${student.id}/entries`, { method: 'POST', body: { kind: 'charge', amount: '150.25', description: 'Rent' } });
  const account = await store.request(`/api/billing/accounts/${student.id}`);
  assert.equal(account.balanceCents, 15025);
  assert.equal(account.offline_copy, true);
  assert.equal((await store.request('/api/billing/accounts')).accounts[0].balance_cents, 15025);
  const { ticket } = await store.request('/api/tickets', { method: 'POST', body: {
    propertyId: 'building', unitNumber: 'A1', subject: 'Tap', description: 'Leaking', tags: ['Plumbing'], accessGranted: false
  } });
  await store.request(`/api/tickets/${ticket.id}/replies`, { method: 'POST', body: { message: 'Recorded offline' } });
  const tickets = await store.request('/api/tickets');
  assert.equal(tickets.tickets[0].events[0].detail, 'Recorded offline');
  assert.equal(tickets.tickets[0].pending_sync, true);
  const laundry = laundryBody('building', [{ id: 'heater', quantity: 2 }]);
  const { report } = await store.request('/api/appliance-reports', { method: 'POST', body: laundry });
  const exported = await store.request(`/api/appliance-reports/${report.id}/export`);
  assert(exported.html.includes('OFFLINE COPY'));
  assert(exported.html.includes('HT1'));
  assert(!exported.html.includes('Where to get'));
  const reopened = createOfflineStore({ storage, send, getUser: () => user, getServer: () => 'https://server.example', notify: () => {} });
  assert.equal((await reopened.request('/api/tickets')).tickets[0].id, ticket.id);
  assert.deepEqual((await reopened.request('/api/appliance-reports')).reports[0].check_audit, (await reopened.status()).jobs.at(-1).body.checkAudit);
  assert(exported.html.includes('Pending upload'));
  online = true;
  await reopened.sync();
  assert.deepEqual(uploaded.map((job) => job.path), [
    '/api/users', '/api/billing/accounts/server-user/entries', '/api/tickets',
    '/api/tickets/server-ticket/replies', '/api/appliance-reports'
  ]);
  assert(uploaded.every((job) => job.headers['X-Operation-ID']));
  assert.equal(new Set(uploaded.map((job) => job.headers['X-Operation-ID'])).size, 5);
  assert.equal((await reopened.status()).jobs.length, 0);
  assert.deepEqual(uploaded.at(-1).body.checkAudit.completed.latitude, -25.75);
  assert.deepEqual(uploaded.at(-1).body.entries[0].photo, laundry.entries[0].photo);
  assert.equal(uploaded.at(-1).body.entries[0].parts[0].quantity, 2);

  user = { id: 'student', role: 'user', name: 'Student', unitNumber: 'A1' };
  online = false;
  await assert.rejects(() => reopened.request('/api/users'), /Manager access/);
  await assert.rejects(() => reopened.request('/api/tickets'), /not been downloaded/);
  user = { id: 'manager', role: 'maintenance_manager', name: 'Manager', propertyIds: ['building'] };
  failUpload = true;
  const pending = await reopened.request('/api/users', { method: 'POST', body: {
    name: 'Other', email: 'other', password: 'password', role: 'user', unitNumber: 'B1', propertyIds: ['building']
  } });
  assert(pending.queued);
  const before = (await reopened.status()).jobs[0].id;
  await reopened.sync();
  assert.equal((await reopened.status()).jobs[0].id, before);
  failUpload = false;
});

test('server rejections remain visible and block dependent uploads', async () => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  const data = new Map();
  let offline = false;
  const send = async (path, options = {}) => {
    if (path === '/api/auth/me') return { user: { id: 'tech', role: 'technician', propertyIds: ['p'] } };
    if (offline) {
      if (options.method) throw Object.assign(new Error('Part details changed'), { status: 409 });
      throw new TypeError('Offline');
    }
    if (path === '/api/properties') return { properties: [{ id: 'p', name: 'Building' }] };
    if (path === '/api/appliance-parts') return { parts: [{ id: 'part', name: 'Part', part_number: 'P1', supplier: 'Shop', machine_type: 'Washer', active: true }] };
    if (path === '/api/appliance-assets') return { properties: [], assets: [], reports: [], events: [], machines: [], buildings: [], requests: [], unlinkedChecks: 0 };
    if (path === '/api/technician-schedule') return scheduleFixture();
    return { reports: [] };
  };
  const store = createOfflineStore({
    storage: { get: async (key) => structuredClone(data.get(key)), set: async (key, value) => data.set(key, structuredClone(value)) },
    send, getUser: () => ({ id: 'tech', role: 'technician', name: 'Tech', propertyIds: ['p'] }), getServer: () => 'server', notify: () => {}
  });
  await store.warm();
  offline = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  await assert.rejects(() => store.request('/api/appliance-reports', { method: 'POST', body: { ...laundryBody('p'), entries: [] } }), /at least one checked machine/);
  await store.request('/api/appliance-reports', { method: 'POST', body: { ...laundryBody('p', [{ id: 'part', quantity: 1 }]), expectedCount: 2 } });
  const pending = (await store.request('/api/appliance-reports')).reports.find((report) => report.pending_sync);
  assert.equal(pending.expected_count, 2);
  assert.equal(pending.entries.length, 1);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  await store.sync();
  const saved = await store.status();
  assert.equal(saved.jobs[0].state, 'blocked');
  assert.equal(saved.jobs[0].error, 'Part details changed');
  await store.discard(saved.jobs[0].id);
  assert.equal((await store.status()).jobs.length, 0);
});

test('local projection remaps paths and dates without losing part snapshots', () => {
  const job = {
    id: 'one', localId: 'local-report', state: 'pending', method: 'POST', path: '/api/appliance-reports',
    createdAt: '2026-10-30T06:00:00.000Z',
    body: { propertyId: 'p', unitNumber: '1', applianceType: 'Oven', modelNumber: 'M', fault: '<fault>', notes: '', parts: [{ id: 'part', quantity: 3 }] }
  };
  const cache = {
    '/api/properties': { value: { properties: [{ id: 'p', name: 'Building' }] }, at: '2026-10-29' },
    '/api/appliance-parts': { value: { parts: [{ id: 'part', name: 'Element', part_number: 'E1', supplier: 'Shop' }] }, at: '2026-10-29' },
    '/api/appliance-reports': { value: { reports: [] }, at: '2026-10-29' }
  };
  const result = projectView('/api/appliance-reports/local-report/export', cache, [job], { id: 'tech', name: 'Tech', role: 'technician', propertyIds: ['p'] });
  assert(result.html.includes('&lt;fault&gt;'));
  assert(result.html.includes('<td>3</td>'));
  job.body.checkAudit = checkAudit();
  const technician = projectView('/api/appliance-reports', cache, [job], { id: 'tech', role: 'technician', propertyIds: ['p'] });
  assert(!('check_audit' in technician.reports[0]));
  const manager = projectView('/api/appliance-reports', cache, [job], { id: 'manager', role: 'maintenance_manager', propertyIds: ['p'] });
  assert.deepEqual(manager.reports[0].check_audit, job.body.checkAudit);
});

test('a lost response retries the original operation and exact request body', async () => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  const saved = new Map();
  const attempts = [];
  let loseResponse = true;
  const send = async (path, options = {}) => {
    if (path === '/api/auth/me') return { user: { id: 'tech', role: 'technician', propertyIds: ['p'] } };
    if (!options.method) {
      if (path === '/api/properties') return { properties: [{ id: 'p', name: 'Building' }] };
      if (path === '/api/appliance-parts') return { parts: [] };
      if (path === '/api/appliance-assets') return { properties: [], assets: [], reports: [], events: [], machines: [], buildings: [], requests: [], unlinkedChecks: 0 };
      if (path === '/api/technician-schedule') return scheduleFixture();
      return { reports: [] };
    }
    attempts.push({ body: structuredClone(options.body), operation: new Headers(options.headers).get('X-Operation-ID') });
    if (loseResponse) {
      loseResponse = false;
      throw new TypeError('Response lost after commit');
    }
    return { report: { id: 'saved-report' } };
  };
  const store = createOfflineStore({
    storage: { get: async (key) => structuredClone(saved.get(key)), set: async (key, value) => saved.set(key, structuredClone(value)) },
    send, getUser: () => ({ id: 'tech', role: 'technician', name: 'Tech', propertyIds: ['p'] }), getServer: () => 'server', notify: () => {}
  });
  await store.warm();
  const result = await store.request('/api/appliance-reports', { method: 'POST', body: laundryBody('p') });
  assert(result.queued);
  await store.sync();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal((await store.status()).jobs.length, 0);
});

test('a name-only part can be created, used and numbered later while offline', async () => {
  let online = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  const records = new Map();
  const uploaded = [];
  const user = { id: 'mm', role: 'maintenance_manager', name: 'Manager', propertyIds: ['building'] };
  const data = {
    '/api/check-templates': { templates: [] },
    '/api/properties': { properties: [{ id: 'building', name: 'Building' }] },
    '/api/appliance-parts': { parts: [] }, '/api/appliance-reports': { reports: [] },
    '/api/appliance-assets': { properties: [], assets: [], reports: [], events: [], machines: [], buildings: [], requests: [], unlinkedChecks: 0 },
    '/api/users': { users: [] }, '/api/tickets': { tickets: [] }, '/api/billing/accounts': { accounts: [] },
    '/api/technician-schedule': { visits: [], locations: [], technicians: [] }
  };
  const store = createOfflineStore({
    storage: { get: async (key) => structuredClone(records.get(key)), set: async (key, value) => records.set(key, structuredClone(value)) },
    getUser: () => user, getServer: () => 'server', notify: () => {},
    send: async (path, options = {}) => {
      if (!online) throw new TypeError('Offline');
      if (path === '/api/auth/me') return { user };
      if (!options.method) return structuredClone(data[path] || { assistants: [] });
      uploaded.push({ path, ...options });
      if (path === '/api/appliance-parts') return { part: { id: 'server-part', name: options.body.name, part_number: '', supplier: '', active: true } };
      if (path === '/api/appliance-reports') return { report: { id: 'server-report' } };
      return { part: { id: 'server-part', name: options.body.name, part_number: options.body.partNumber, active: true } };
    }
  });
  await store.warm();
  online = false;
  const { part } = await store.request('/api/appliance-parts', { method: 'POST', body: { name: 'Manual pump', machineType: 'Washer' } });
  assert.equal(part.part_number, '');
  await store.request('/api/appliance-reports', { method: 'POST', body: laundryBody('building', [{ id: part.id, quantity: 2 }]) });
  await store.request(`/api/appliance-parts/${part.id}`, { method: 'PUT', body: { name: 'Manual pump', partNumber: 'P-123', machineType: 'Washer', active: true } });
  const pending = (await store.request('/api/appliance-reports')).reports[0];
  assert.equal(pending.entries[0].parts[0].part_number, '');
  assert.equal((await store.request('/api/appliance-parts')).parts[0].part_number, 'P-123');
  online = true;
  await store.sync();
  assert.equal((await store.status()).jobs.length, 0);
  assert.equal(uploaded[1].body.entries[0].parts[0].id, 'server-part');
  assert.equal(uploaded[1].body.expectedParts[0].part_number, '');
  assert.equal(uploaded[2].path, '/api/appliance-parts/server-part');
  assert.equal(uploaded[2].body.partNumber, 'P-123');
});
