const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const crypto = require('node:crypto');
const { Client } = require('pg');

test('role boundaries, ticket threads, units and appliance part snapshots', { skip: !process.env.TEST_DATABASE_URL, timeout: 90000 }, async (t) => {
  const database = `fg_test_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const fs = require('node:fs/promises');
  const reportsRoot = await fs.mkdtemp(require('node:path').join(require('node:os').tmpdir(), 'fg-reports-'));
  let browserLicenceDb;
  const licenceKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const licencePublicPath = require('node:path').join(reportsRoot, 'test-public.pem');
  await fs.writeFile(licencePublicPath, licenceKeys.publicKey.export({ type: 'spki', format: 'pem' }));
  const child = spawn(process.execPath, ['server/index.cjs'], {
    cwd: require('node:path').join(__dirname, '..'),
    env: { ...process.env, ADMIN_PORT: '0', ADMIN_HOST: '127.0.0.1', DATABASE_URL: url.href, PORT: String(port), REPORTS_ROOT: reportsRoot, LICENSE_PUBLIC_KEY_FILE: licencePublicPath, JWT_SECRET: crypto.randomBytes(32).toString('hex'), ADMIN_EMAIL: 'admin', ADMIN_PASSWORD: 'test-password' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    if (browserLicenceDb) await browserLicenceDb.end();
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    await admin.end();
    await fs.rm(reportsRoot, { recursive: true, force: true });
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  for (let attempt = 0; !output.includes('listening on port'); attempt++) {
    if (attempt > 300 || child.exitCode !== null) throw new Error(`Test server failed: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  async function request(path, token, body, method = body === undefined ? 'GET' : 'POST', expected = 200, extraHeaders = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body?.revision !== undefined ? { 'If-Match': String(body.revision) } : {}), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
    return result;
  }
  const login = async (email) => (await request('/api/auth/login', '', { email, password: 'test-password' })).token;
  const { issueToken, verifyToken } = require('./license-token.cjs');
  const licenceStatus = await request('/api/license');
  let activeLicenceToken;
  await t.test('annual licence gates login and APIs, validates renewals and allows recovery without sign-in', async () => {
    assert.equal(licenceStatus.state, 'missing');
    await request('/api/auth/login', '', { email: 'admin', password: 'test-password' }, 'POST', 423);
    await request('/api/workspace', '', undefined, 'GET', 423, { 'X-Operation-ID': crypto.randomUUID() });
    await request('/api/health');
    await request('/api/license/activate', '', { token: issueToken(licenceKeys.privateKey, crypto.randomUUID()) }, 'POST', 400);
    const first = issueToken(licenceKeys.privateKey, licenceStatus.systemId);
    assert.equal((await request('/api/license/activate', '', { token: first })).state, 'active');
    assert.equal((await request('/api/license/activate', '', { token: first })).token, first);
    const renewal = issueToken(licenceKeys.privateKey, licenceStatus.systemId, first);
    assert.equal((await request('/api/license/activate', '', { token: renewal })).state, 'active');
    assert.equal(verifyToken(renewal, licenceKeys.publicKey).termStart, verifyToken(first, licenceKeys.publicKey).expiresAt);
    await request('/api/license/activate', '', { token: first }, 'POST', 400);
    const client = new Client({ connectionString: url.href });
    await client.connect();
    try {
      const expired = issueToken(licenceKeys.privateKey, licenceStatus.systemId, null, '2023-01-01T00:00:00.000Z');
      await client.query('UPDATE system_licence SET token=$1 WHERE id=1', [expired]);
      assert.equal((await request('/api/license')).state, 'expired');
      await request('/api/auth/login', '', { email: 'admin', password: 'test-password' }, 'POST', 423);
      await request('/api/tickets', '', undefined, 'GET', 423);
      activeLicenceToken = issueToken(licenceKeys.privateKey, licenceStatus.systemId, expired);
      assert.equal((await request('/api/license/activate', '', { token: activeLicenceToken })).state, 'active');
      await client.query("UPDATE system_licence SET last_seen=NOW()+INTERVAL '1 hour' WHERE id=1");
      assert.equal((await request('/api/license')).state, 'clock');
      await request('/api/auth/me', '', undefined, 'GET', 423);
      await client.query('UPDATE system_licence SET last_seen=NOW() WHERE id=1');
    } finally { await client.end(); }
  });
  const a = await login('admin');
  await t.test('startup installs researched building pins and preserves manager corrections on reseeding', async () => {
    const { locations, seedLocations } = require('./building-locations.cjs');
    const seeded = (await request('/api/technician-schedule', a)).locations;
    for (const location of locations) {
      const saved = seeded.find((pin) => pin.property_id === location.propertyId);
      assert(saved, `Missing startup pin: ${location.propertyId}`);
      assert.equal(saved.radius, 100);
      assert.equal(saved.latitude, location.latitude);
      assert.equal(saved.longitude, location.longitude);
    }
    const propertyId = 'brooklyn-studios';
    const correction = { latitude: -25.7575, longitude: 28.2335, radius: 100 };
    await request(`/api/technician-locations/${propertyId}`, a, correction, 'PUT');
    const client = new Client({ connectionString: url.href });
    await client.connect();
    try { await seedLocations(client); }
    finally { await client.end(); }
    const corrected = (await request('/api/technician-schedule', a)).locations.find((pin) => pin.property_id === propertyId);
    assert.equal(corrected.latitude, correction.latitude);
    assert.equal(corrected.longitude, correction.longitude);
    assert.equal(corrected.radius, 100);
  });
  const { properties } = await request('/api/properties', a);
  const propertyId = properties[0].id;
  const users = {};
  const tokens = {};
  for (const role of ['user', 'office_admin', 'maintenance_assistant', 'maintenance_manager', 'portfolio_manager', 'building_manager', 'operations_manager', 'technician']) {
    users[role] = (await request('/api/users', a, {
      email: role, name: role, password: 'test-password', role, unitNumber: 'A-12', propertyIds: [propertyId]
    }, 'POST', 201)).user;
    tokens[role] = await login(role);
  }
  const s = tokens.user, ma = tokens.maintenance_assistant, mm = tokens.maintenance_manager, tech = tokens.technician;
  await t.test('office administrators sign in without resident details and have scoped billing rather than full administration', async () => {
    const office = tokens.office_admin;
    const user = (await request('/api/auth/me', office)).user;
    assert.equal(user.unitNumber, '');
    assert.deepEqual((await request('/api/properties', office)).properties.map((row) => row.id), [propertyId]);
    await request('/api/billing/accounts', office);
    for (const path of ['/api/users', '/api/tickets', '/api/settings/reports', '/api/appliance-reports']) {
      await request(path, office, undefined, 'GET', 403);
    }
    const { user: created } = await request('/api/users', a, {
      email: 'office-without-unit', name: 'Office administrator', password: 'test-password',
      role: 'office_admin', propertyIds: [propertyId]
    }, 'POST', 201);
    assert.equal(created.unit_number, '');
    await request('/api/users', a, {
      email: 'resident-without-unit', name: 'Resident', password: 'test-password',
      role: 'user', propertyIds: [propertyId]
    }, 'POST', 400);
  });
  await t.test('new manager profiles retain building scoping and support removable section grants', async () => {
    for (const role of ['portfolio_manager', 'building_manager', 'operations_manager']) {
      const token = tokens[role];
      assert.equal((await request('/api/auth/me', token)).user.role, role);
      assert.deepEqual((await request('/api/properties', token)).properties.map((row) => row.id), [propertyId]);
      await request('/api/tickets', token);
      await request('/api/appliance-reports', token);
      await request(`/api/operations/assets`, token);
      await request('/api/company-features/remove', token, { features: ['lighting'] }, 'POST', 403);
      await request(`/api/users/${users[role].id}`, a, {
        email: role, name: role, role, propertyIds: [propertyId], sections: [], adminRights: false, active: true
      }, 'PUT');
      await request('/api/tickets', token, undefined, 'GET', 403);
      await request('/api/appliance-reports', token, undefined, 'GET', 403);
    }
  });
  await t.test('all roles may upload and remove only their own validated profile picture', async () => {
    const photo = 'data:image/jpeg;base64,' + Buffer.from([255,216,255,192,0,8,8,0,1,0,1,1,255,218,0,2,1,255,217]).toString('base64');
    await request('/api/auth/profile-photo', '', undefined, 'GET', 401);
    await request('/api/auth/profile-photo', '', { photo }, 'PUT', 401);
    for (const token of [a, s, ma, mm, tech]) {
      assert.equal((await request('/api/auth/profile-photo', token)).photo, null);
      for (const invalid of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/jpeg;base64,YmFk', 'data:image/jpeg;base64,' + 'A'.repeat(350000), undefined]) {
        await request('/api/auth/profile-photo', token, { photo: invalid }, 'PUT', 400);
      }
      assert.equal((await request('/api/auth/profile-photo', token, { photo, userId: 'another-account' }, 'PUT')).photo, photo);
      assert.equal((await request('/api/auth/profile-photo', token)).photo, photo);
      const other = token === a ? s : a;
      assert.equal((await request('/api/auth/profile-photo', other)).photo, null);
      await request('/api/auth/profile-photo', token, { photo: null }, 'PUT');
      assert.equal((await request('/api/auth/profile-photo', token)).photo, null);
    }
  });
  assert.equal((await request('/api/auth/me', s)).user.unitNumber, 'A-12');
  for (const token of [s, ma, tech]) {
    await request('/api/users', token, undefined, 'GET', 403);
    await request('/api/billing/accounts', token, undefined, 'GET', 403);
    await request('/api/settings/reports', token, undefined, 'GET', 403);
    await request('/api/appliance-parts', token, { name: 'x' }, 'POST', 403);
  }
  await request('/api/users', mm);
  await request('/api/billing/accounts', mm);
  assert.deepEqual((await request('/api/properties', mm)).properties.map((property) => property.id), [propertyId]);
  await request('/api/settings/reports', mm, undefined, 'GET', 403);
  await request('/api/settings/reports', mm, {}, 'PUT', 403);
  for (const token of [s, tech]) {
    const { data } = await request('/api/workspace', token);
    assert.deepEqual(data.surveys, []);
    assert.deepEqual(data.buildingChecks, []);
    await request('/api/workspace', token, {}, 'PUT', 403);
  }
  const workspace = await request('/api/workspace', ma);
  await request('/api/workspace', ma, { revision: workspace.revision, data: workspace.data }, 'PUT');
  for (const token of [s, ma]) {
    await request('/api/appliance-reports', token, undefined, 'GET', 403);
    await request('/api/appliance-parts', token, undefined, 'GET', 403);
  }
  await request('/api/tickets', tech, undefined, 'GET', 403);
  await request('/api/tickets', tech, {}, 'POST', 403);
  await request('/api/users', mm, { email: 'missing-unit', name: 'Student', role: 'user', password: 'test-password', propertyIds: [propertyId] }, 'POST', 400);

  const { ticket } = await request('/api/tickets', s, {
    propertyId, subject: 'Leaking tap', description: 'Kitchen tap drips', unitNumber: 'A-12',
    tags: ['Plumbing'], accessGranted: true, scheduledFor: new Date(Date.now() + 86400000).toISOString()
  }, 'POST', 201);
  let tickets = (await request('/api/tickets', s)).tickets;
  assert.equal(tickets[0].unit_number, 'A-12');
  assert.deepEqual(tickets[0].tags, ['Plumbing']);
  assert.equal(tickets[0].access_granted, true);
  assert(tickets[0].events.some((event) => event.event === 'Access granted'));
  await request(`/api/tickets/${ticket.id}/assignment`, mm, { assistantId: users.maintenance_assistant.id }, 'PUT');
  const assignedTicket = (await request('/api/tickets', s)).tickets.find((item) => item.id === ticket.id);
  assert.equal(assignedTicket.status, 'assigned');
  assert.equal(assignedTicket.assigned_to_name, 'maintenance_assistant');
  assert(assignedTicket.events.some((event) => event.event === 'Assigned to maintenance assistant' && event.detail === 'maintenance_assistant'));
  await request(`/api/tickets/${ticket.id}/status`, s, { status: 'in_progress' }, 'PUT', 403);
  await request(`/api/tickets/${ticket.id}/status`, ma, { status: 'in_progress' }, 'PUT', 403);
  await request(`/api/tickets/${ticket.id}/status`, mm, { status: 'in_progress', note: 'Work started' }, 'PUT');
  const progressTicket = (await request('/api/tickets', s)).tickets.find((item) => item.id === ticket.id);
  assert.equal(progressTicket.status, 'in_progress');
  assert.equal(progressTicket.assigned_to_name, 'maintenance_assistant');
  assert(progressTicket.events.some((event) => event.event === 'In progress'));
  await request(`/api/tickets/${ticket.id}/replies`, ma, { message: 'We will attend tomorrow.' }, 'POST', 201);
  await request(`/api/tickets/${ticket.id}/replies`, s, { message: 'Thank you.' }, 'POST', 201);
  await request(`/api/tickets/${ticket.id}/tags`, mm, { tags: ['Plumbing', 'Urgent'] }, 'PUT');
  await request(`/api/tickets/${ticket.id}/tags`, s, { tags: ['General'] }, 'PUT', 403);
  await request(`/api/tickets/${ticket.id}/status`, ma, { status: 'awaiting_stock' }, 'PUT', 403);
  await request(`/api/tickets/${ticket.id}/status`, ma, { status: 'out_of_stock' }, 'PUT');
  await request(`/api/tickets/${ticket.id}/status`, mm, { status: 'awaiting_stock' }, 'PUT');
  await request(`/api/tickets/${ticket.id}/complete`, ma, {}, 'POST', 400);
  await request(`/api/tickets/${ticket.id}/access`, s, { granted: false }, 'PUT');
  tickets = (await request('/api/tickets', s)).tickets;
  assert.equal(tickets[0].access_granted, false);
  assert.equal(tickets[0].events.filter((event) => event.event === 'Reply').length, 2);
  assert.equal(tickets[0].events.filter((event) => event.event === 'Access withdrawn').length, 1);
  await request(`/api/tickets/${ticket.id}/replies`, tech, { message: 'No' }, 'POST', 403);
  await request(`/api/tickets/${ticket.id}/photo`, tech, undefined, 'GET', 403);

  const { part } = await request('/api/appliance-parts', mm, { name: 'Heater', partNumber: 'HT-100', machineType: 'Washer', supplier: 'Local supplier' }, 'POST', 201);
  const catalogue = (await request('/api/appliance-parts', tech)).parts;
  assert.equal(catalogue.filter((item) => item.id.startsWith('speedqueen-')).length, 17);
  assert.equal(catalogue.find((item) => item.part_number === '200923').name, 'Speed Queen Washer SWNMN2SP303SW01 - Agitate & Spin Belt');
  assert(catalogue.every((part) => !Object.hasOwn(part, 'benchmark_prices')));
  const managerCatalogue = (await request('/api/appliance-parts', mm)).parts;
  assert.equal(managerCatalogue.find((part) => part.part_number === '200923').benchmark_prices[0].price, 843);
  await request('/api/appliance-parts', mm, { name: 'No supplier needed', machineType: 'Washer', partNumber: 'NS-1' }, 'POST', 201);
  const { part: manualPart } = await request('/api/appliance-parts', mm, { name: 'Manual pump', machineType: 'Washer' }, 'POST', 201);
  assert.equal(manualPart.part_number, '');
  await request('/api/appliance-parts', mm, { name: '', partNumber: '' }, 'POST', 400);
  await request(`/api/appliance-parts/${manualPart.id}`, tech, { name: 'Manual pump', partNumber: 'X', active: true }, 'PUT', 403);
  const location = { latitude: -25.75, longitude: 28.19, accuracy: 8, capturedAt: new Date().toISOString(), mocked: false };
  await request(`/api/technician-locations/${propertyId}`, mm, { latitude: location.latitude, longitude: location.longitude, radius: 100 }, 'PUT');
  const visitId = crypto.randomUUID();
  await request('/api/technician-checkins', tech, { id: visitId, propertyId, extra: true, location });
  const checkAudit = { started: location, completed: location, durationMs: 0, offlineCompleted: false };
  const machineEntry = (number, parts = [], notes = '') => ({
    machineNumber: String(number), serialNumber: `TEST-SERIAL-${number}`, modelNumber: 'SWNMN2SP303SW01', status: parts.length ? 'needs_repair' : 'working', parts, notes, checkAudit,
    photo: {
      source: 'camera', capturedAt: location.capturedAt,
      data: 'data:image/jpeg;base64,' + Buffer.from([255,216,255,192,0,8,8,0,1,0,1,1,255,218,0,2,number + 1,255,217]).toString('base64')
    }
  });
  const reportBody = { propertyId, applianceType: 'Washer', expectedCount: 1, entries: [machineEntry(1)], visitId };
  await request('/api/appliance-reports', tech, reportBody, 'POST', 400);
  await request('/api/appliance-reports', tech, { ...reportBody, checkAudit: { ...checkAudit, completed: { ...location, mocked: true } } }, 'POST', 400);
  await request('/api/appliance-reports', tech, { ...reportBody, checkAudit: { ...checkAudit, completed: { ...location, latitude: 91 } } }, 'POST', 400);
  const { report } = await request('/api/appliance-reports', tech, {
    ...reportBody, entries: [machineEntry(12, [{ id: part.id, quantity: 2, part_number: 'spoofed', supplier: 'spoofed' }], '<script>fault</script>')], checkAudit
  }, 'POST', 201);
  const { report: secondReport } = await request('/api/appliance-reports', tech, {
    ...reportBody, entries: [machineEntry(13, [{ id: part.id, quantity: 3 }], 'Also cold')], checkAudit: { ...checkAudit, offlineCompleted: true }
  }, 'POST', 201);
  await request(`/api/appliance-parts/${part.id}`, a, { name: 'New heater', partNumber: 'HT-200', machineType: 'Washer', supplier: 'Other supplier', active: false }, 'PUT');
  const exported = await request(`/api/appliance-reports/${report.id}/export`, tech);
  assert(exported.html.includes('HT-100'));
  assert(!exported.html.includes('Where to get it'));
  assert(exported.html.includes('<td>2</td>'));
  assert(exported.html.includes('&lt;script&gt;fault&lt;/script&gt;'));
  assert(!exported.html.includes('HT-200'));
  assert(!exported.html.includes('spoofed'));
  assert(!('check_audit' in report));
  assert(!('checkAudit' in report.entries[0]));
  assert(!('capturedAt' in report.entries[0].photo));
  assert(!exported.html.includes('28.19'));
  assert((await request('/api/appliance-reports', tech)).reports.every((row) => !('check_audit' in row)));
  const managerReports = (await request('/api/appliance-reports', mm)).reports;
  assert.deepEqual(managerReports.find((row) => row.id === report.id).check_audit, checkAudit);
  assert(managerReports.find((row) => row.id === report.id).created_at);
  const managerExport = await request(`/api/appliance-reports/${report.id}/export`, mm);
  assert(managerExport.html.includes('28.19'));
  assert(managerExport.html.includes('Server received'));
  await request(`/api/appliance-reports/${report.id}/export`, s, undefined, 'GET', 403);
  assert.equal((await request('/api/appliance-reports', mm)).reports.length, 2);
  const combined = await request('/api/appliance-reports/export', mm, { ids: [report.id, secondReport.id], mode: 'parts' });
  assert(combined.html.includes('<td>HT-100</td>'));
  assert(combined.html.includes('<td>5</td>'));
  assert(combined.html.includes('Machine 12'));
  assert(combined.html.includes('Machine 13'));
  assert(!combined.html.includes('Unit '));
  assert(!exported.html.includes('Apartment'));
  assert(!combined.html.includes('Where to get'));
  await request('/api/appliance-reports/export', tech, { ids: [report.id], mode: 'parts' }, 'POST', 403);
  await request('/api/appliance-reports/export', s, { ids: [report.id], mode: 'full' }, 'POST', 403);
  await request('/api/appliance-reports/export', mm, { ids: [], mode: 'parts' }, 'POST', 400);
  await request('/api/appliance-reports/export', mm, { ids: [report.id, 'missing'], mode: 'parts' }, 'POST', 404);
  const fullExport = await request('/api/appliance-reports/export', a, { ids: [report.id, secondReport.id], mode: 'full' });
  assert(fullExport.html.includes('Also cold'));
  assert(fullExport.html.includes('&lt;script&gt;fault&lt;/script&gt;'));
  assert(fullExport.html.includes('28.19'));
  assert(fullExport.html.includes('Completed offline'));
  assert(!combined.html.includes('28.19'));
  await request('/api/appliance-reports', tech, {
    ...reportBody, entries: [machineEntry(1, [{ id: part.id, quantity: 1 }])], checkAudit
  }, 'POST', 409);
  const largeReport = { ...reportBody, expectedCount: 40, entries: Array.from({ length: 40 }, (_, n) => machineEntry(n + 1)), checkAudit };
  const reportOperation = { 'X-Operation-ID': crypto.randomUUID() };
  const savedLarge = await request('/api/appliance-reports', tech, largeReport, 'POST', 201, reportOperation);
  assert.equal(savedLarge.report.entries.length, 40);
  assert.deepEqual(await request('/api/appliance-reports', tech, largeReport, 'POST', 201, reportOperation), savedLarge);
  const partialReport = (await request('/api/appliance-reports', tech, { ...largeReport, entries: largeReport.entries.slice(1) }, 'POST', 201)).report;
  assert.equal(partialReport.entries.length, 39);
  assert.equal(partialReport.expected_count, 40);
  assert((await request(`/api/appliance-reports/${partialReport.id}/export`, tech)).html.includes('Not checked: 1.'));
  await request('/api/appliance-reports', tech, { ...largeReport, entries: [] }, 'POST', 400);
  await request('/api/appliance-reports', tech, { ...largeReport, expectedCount: 39 }, 'POST', 400);
  await request('/api/appliance-reports', tech, { ...largeReport, entries: [machineEntry(1), machineEntry(1)], expectedCount: 2 }, 'POST', 400);
  await request('/api/appliance-reports', tech, {
    ...reportBody, checkAudit, entries: [{ ...machineEntry(1), photo: { ...machineEntry(1).photo, data: 'data:image/jpeg;base64,YmFk' } }]
  }, 'POST', 400);
  const { report: pendingNumberReport } = await request('/api/appliance-reports', tech, {
    ...reportBody, checkAudit, entries: [machineEntry(1, [{ id: manualPart.id, quantity: 2 }])]
  }, 'POST', 201);
  assert.equal(pendingNumberReport.entries[0].parts[0].part_number, '');
  assert((await request(`/api/appliance-reports/${pendingNumberReport.id}/export`, tech)).html.includes('Part number pending'));
  const updatedPart = (await request(`/api/appliance-parts/${manualPart.id}`, a, {
    name: 'Manual pump', partNumber: 'MP-123', machineType: 'Washer', active: true
  }, 'PUT')).part;
  assert.equal(updatedPart.part_number, 'MP-123');
  assert((await request(`/api/appliance-reports/${pendingNumberReport.id}/export`, mm)).html.includes('Part number pending'));
  const { report: numberedReport } = await request('/api/appliance-reports', tech, {
    ...reportBody, checkAudit, entries: [machineEntry(1, [{ id: manualPart.id, quantity: 1 }])]
  }, 'POST', 201);
  assert.equal(numberedReport.entries[0].parts[0].part_number, 'MP-123');

  const other = (await request('/api/users', mm, { email: 'other-tech', name: 'Other', role: 'technician', password: 'test-password', propertyIds: [propertyId] }, 'POST', 201)).user;
  assert(other.id);
  const otherToken = await login('other-tech');
  assert.deepEqual((await request('/api/appliance-reports', otherToken)).reports, []);
  await request(`/api/appliance-reports/${report.id}/export`, otherToken, undefined, 'GET', 404);
  const operation = { 'X-Operation-ID': crypto.randomUUID() };
  const bill = { kind: 'charge', amount: '10.25', description: 'Offline charge', date: '2026-10-30' };
  const firstBill = await request(`/api/billing/accounts/${users.user.id}/entries`, mm, bill, 'POST', 201, operation);
  const licenceDb = new Client({ connectionString: url.href });
  await licenceDb.connect();
  try {
    await licenceDb.query('UPDATE system_licence SET token=$1 WHERE id=1', [
      issueToken(licenceKeys.privateKey, licenceStatus.systemId, null, '2023-01-01T00:00:00.000Z')
    ]);
    await request(`/api/billing/accounts/${users.user.id}/entries`, mm, bill, 'POST', 423, operation);
  } finally {
    await licenceDb.query('UPDATE system_licence SET token=$1 WHERE id=1', [activeLicenceToken]);
    await licenceDb.end();
  }
  const secondBill = await request(`/api/billing/accounts/${users.user.id}/entries`, mm, bill, 'POST', 201, operation);
  assert.deepEqual(firstBill, secondBill);
  assert.equal((await request(`/api/billing/accounts/${users.user.id}`, mm)).entries.length, 1);
  await request(`/api/billing/accounts/${users.user.id}/entries`, mm, { ...bill, amount: '20' }, 'POST', 409, operation);
  await request(`/api/tickets/${ticket.id}/access`, s, { granted: true }, 'PUT', 400, { 'X-Operation-ID': crypto.randomUUID() });
  const offlineReply = { 'X-Operation-ID': crypto.randomUUID() };
  await request(`/api/tickets/${ticket.id}/replies`, ma, { message: 'Uploaded once' }, 'POST', 201, offlineReply);
  await request(`/api/tickets/${ticket.id}/replies`, ma, { message: 'Uploaded once' }, 'POST', 201, offlineReply);
  assert.equal((await request('/api/tickets', s)).tickets[0].events.filter((event) => event.detail === 'Uploaded once').length, 1);
  await request(`/api/appliance-parts/${part.id}`, mm, {
    name: 'Do not overwrite', partNumber: 'OLD', supplier: 'Old shop', active: true,
    offlineBase: { name: 'Heater', part_number: 'HT-100', supplier: 'Local supplier', active: true }
  }, 'PUT', 409, { 'X-Operation-ID': crypto.randomUUID() });
  assert.equal((await request('/api/appliance-parts', mm)).parts.find((item) => item.id === part.id).part_number, 'HT-200');

  const outsideId = properties.find((property) => property.id !== propertyId).id;
  const outside = (await request('/api/users', a, {
    email: 'outside', name: 'Outside student', password: 'test-password', role: 'user', unitNumber: 'B-1', propertyIds: [outsideId]
  }, 'POST', 201)).user;
  const mixed = (await request('/api/users', a, {
    email: 'mixed', name: 'Mixed staff', password: 'test-password', role: 'maintenance_assistant', propertyIds: [propertyId, outsideId]
  }, 'POST', 201)).user;
  const outsideToken = await login('outside');
  const { ticket: outsideTicket } = await request('/api/tickets', outsideToken, {
    propertyId: outsideId, unitNumber: 'B-1', subject: 'Private issue', description: 'Private building', tags: ['General']
  }, 'POST', 201);
  assert(!(await request('/api/tickets', mm)).tickets.some((row) => row.id === outsideTicket.id));
  for (const [action, body, expected] of [
    ['tags', { tags: ['Private'] }, 404], ['status', { status: 'awaiting_stock' }, 404],
    ['assignment', { assistantId: users.maintenance_assistant.id }, 400],
    ['replies', { message: 'No access' }, 404]
  ]) await request(`/api/tickets/${outsideTicket.id}/${action}`, mm, body, action === 'replies' ? 'POST' : 'PUT', expected);
  await request(`/api/tickets/${outsideTicket.id}/photo`, mm, undefined, 'GET', 404);
  const visibleUsers = (await request('/api/users', mm)).users;
  assert(!visibleUsers.some((row) => [outside.id, mixed.id, users.maintenance_manager.id].includes(row.id)));
  const visibleAccounts = (await request('/api/billing/accounts', mm)).accounts;
  assert(!visibleAccounts.some((row) => [outside.id, mixed.id].includes(row.id)));
  for (const target of [outside, mixed]) {
    await request(`/api/users/${target.id}`, mm, {
      email: target.email, name: target.name, role: 'user', unitNumber: 'B-1', propertyIds: [propertyId]
    }, 'PUT', 404);
    await request(`/api/billing/accounts/${target.id}`, mm, undefined, 'GET', 404);
    await request(`/api/billing/accounts/${target.id}/entries`, mm, bill, 'POST', 404);
    await request(`/api/billing/accounts/${target.id}/status`, mm, { status: 'blocked' }, 'PUT', 404);
    await request(`/api/billing/accounts/${target.id}/entries/missing/void`, mm, {}, 'POST', 404);
  }
  await request('/api/users', mm, {
    email: 'escalation', name: 'Escalation', password: 'test-password', role: 'maintenance_manager', propertyIds: [propertyId]
  }, 'POST', 403);
  await request('/api/users', mm, {
    email: 'outside-create', name: 'Outside', password: 'test-password', role: 'technician', propertyIds: [outsideId]
  }, 'POST', 403);
  await request(`/api/users/${users.maintenance_manager.id}`, mm, {
    email: 'maintenance_manager', name: 'Manager', role: 'maintenance_manager', propertyIds: [propertyId, outsideId]
  }, 'PUT', 404);
  const { report: outsideReport } = await request('/api/appliance-reports', a, {
    ...reportBody, propertyId: outsideId, checkAudit, entries: [{ ...machineEntry(1), serialNumber: 'OUTSIDE-SERIAL-1' }]
  }, 'POST', 201);
  assert(!(await request('/api/appliance-reports', mm)).reports.some((row) => row.id === outsideReport.id));
  await request(`/api/appliance-reports/${outsideReport.id}/export`, mm, undefined, 'GET', 404);
  await request('/api/appliance-reports/export', mm, { ids: [report.id, outsideReport.id], mode: 'full' }, 'POST', 404);
  assert((await request(`/api/appliance-reports/${outsideReport.id}/export`, a)).html.includes(properties.find((p) => p.id === outsideId).name));
  await request('/api/reports', mm, { building: properties.find((p) => p.id === outsideId).name, html: '<p>Forbidden</p>' }, 'POST', 403);
  await request('/api/reports', mm, { building: properties[0].name, html: '<p>Allowed report</p>' }, 'POST', 201);
  const allWorkspace = await request('/api/workspace', a);
  await request('/api/workspace', a, {
    revision: allWorkspace.revision,
    data: { ...allWorkspace.data, surveys: [{ id: 'outside-survey', propertyId: outsideId, buildingName: 'Private' }],
      buildingChecks: [{ id: 'outside-check', propertyId: outsideId, reports: [{ html: 'PRIVATE' }] }] }
  }, 'PUT');
  const managerWorkspace = await request('/api/workspace', mm);
  assert(!JSON.stringify(managerWorkspace.data).includes('PRIVATE'));
  assert.deepEqual(managerWorkspace.data.surveys, []);
  await request('/api/workspace', mm, {
    revision: managerWorkspace.revision,
    data: { ...managerWorkspace.data, surveys: [{ id: 'forbidden-survey', propertyId: outsideId }] }
  }, 'PUT', 403);

  let restrictedToken;
  await t.test('independent MM sections and scoped admins enforce API, workspace and account boundaries', async () => {
    const createManager = async (email, sections, adminRights = false) => (await request('/api/users', a,
      { email, name: email, password: 'test-password', role: 'maintenance_manager', propertyIds: [propertyId], sections, adminRights }, 'POST', 201)).user;
    const limited = await createManager('restricted-mm', ['lighting']);
    restrictedToken = await login(limited.email);
    const rights = (await request('/api/auth/me', restrictedToken)).user;
    assert.deepEqual(rights.sections, ['lighting']);
    assert.equal(rights.adminRights, false);
    assert.deepEqual((await request('/api/properties', restrictedToken)).properties.map((p) => p.id), [propertyId]);
    for (const path of ['/api/tickets', '/api/ticket-assignees?propertyId=' + propertyId, '/api/users', '/api/billing/accounts',
      '/api/appliance-parts', '/api/appliance-reports', '/api/technician-schedule', '/api/technician-attendance',
      '/api/building-quote-contacts', '/api/settings/reports']) {
      await request(path, restrictedToken, undefined, 'GET', 403);
    }
    await request('/api/tickets', restrictedToken, {}, 'POST', 403);
    await request('/api/appliance-reports/export', restrictedToken, { ids: [report.id], mode: 'full' }, 'POST', 403);
    await request('/api/users', a, { ...limited, propertyIds: [propertyId], password: 'test-password',
      email: 'bad-sections', sections: ['not-a-section'] }, 'POST', 400);
    await request('/api/users', a, { ...limited, propertyIds: [propertyId], password: 'test-password',
      email: 'bad-admin', sections: ['lighting'], adminRights: true }, 'POST', 400);
    const all = await request('/api/workspace', a);
    const localSurvey = { id: 'local-permission-survey', propertyId };
    const hiddenCheck = { id: 'hidden-permission-check', propertyId, buildingName: properties[0].name,
      inspectorName: 'Layout test inspector', inspectionDate: '2026-11-02', lastChangedBy: 'Layout test inspector',
      reports: [{ html: 'PRIVATE CHECK' }], checks: [
        { id: 'layout-condition', title: 'Condition navigation', condition: 'needs-attention', severity: 'low',
          status: 'open', notes: '', photos: [], history: [], reports: [] }
      ] };
    await request('/api/workspace', a, { revision: all.revision, data: { ...all.data,
      surveys: [...all.data.surveys, localSurvey], buildingChecks: [...all.data.buildingChecks, hiddenCheck] } }, 'PUT');
    let restricted = await request('/api/workspace', restrictedToken);
    assert(restricted.data.surveys.some((row) => row.id === localSurvey.id));
    assert.deepEqual(restricted.data.buildingChecks, []);
    assert(!JSON.stringify(restricted).includes('PRIVATE CHECK'));
    await request('/api/workspace', restrictedToken, { revision: restricted.revision,
      data: { ...restricted.data, buildingChecks: [hiddenCheck] } }, 'PUT', 403);
    await request('/api/workspace', restrictedToken, { revision: restricted.revision, data: restricted.data }, 'PUT');
    assert((await request('/api/workspace', a)).data.buildingChecks.some((row) => row.id === hiddenCheck.id));
    await request('/api/reports', restrictedToken, { building: properties[0].name, kind: 'Building checklist', html: '<p>No</p>' }, 'POST', 403);
    await request('/api/reports', restrictedToken, { building: properties[0].name, kind: 'Lighting survey', html: '<p>Allowed</p>' }, 'POST', 201);

    const edit = { email: limited.email, name: limited.name, role: 'maintenance_manager', propertyIds: [propertyId] };
    await request(`/api/users/${limited.id}`, a, edit, 'PUT');
    assert.deepEqual((await request('/api/auth/me', restrictedToken)).user.sections, ['lighting']);
    await request(`/api/users/${limited.id}`, a, { ...edit, sections: ['checks'] }, 'PUT');
    restricted = await request('/api/workspace', restrictedToken);
    assert.deepEqual(restricted.data.surveys, []);
    assert(restricted.data.buildingChecks.some((row) => row.id === hiddenCheck.id));
    await request('/api/workspace', restrictedToken, { revision: restricted.revision, data: restricted.data }, 'PUT');
    assert((await request('/api/workspace', a)).data.surveys.some((row) => row.id === localSurvey.id));
    await request(`/api/users/${limited.id}`, a, { ...edit, sections: ['billing'] }, 'PUT');
    assert((await request('/api/billing/accounts', restrictedToken)).accounts.some((row) => row.id === users.user.id));
    await request(`/api/billing/accounts/${users.user.id}`, restrictedToken);
    await request('/api/users', restrictedToken, undefined, 'GET', 403);
    await request(`/api/users/${limited.id}`, a, { ...edit, sections: [] }, 'PUT');
    await request('/api/workspace', restrictedToken, { revision: restricted.revision, data: restricted.data }, 'PUT', 403);
    assert.deepEqual((await request('/api/workspace', restrictedToken)).data.buildingChecks, []);
    await request(`/api/users/${limited.id}`, a, { ...edit, sections: ['lighting'] }, 'PUT');

    const delegated = await createManager('delegated-mm', ['users', 'lighting'], true);
    const delegatedToken = await login(delegated.email);
    assert((await request('/api/users', delegatedToken)).users.some((row) => row.id === limited.id));
    assert(!(await request('/api/users', delegatedToken)).users.some((row) => row.id === users.maintenance_manager.id));
    await request(`/api/users/${limited.id}`, delegatedToken, { ...edit, sections: [] }, 'PUT');
    await request(`/api/users/${limited.id}`, delegatedToken, { ...edit, sections: ['lighting'] }, 'PUT');
    for (const changes of [{ sections: ['billing'] }, { propertyIds: [outsideId], sections: [] }, { adminRights: true, sections: ['users'] }]) {
      await request(`/api/users/${limited.id}`, delegatedToken, { ...edit, ...changes }, 'PUT', 403);
    }
    await request(`/api/users/${delegated.id}`, delegatedToken, { ...edit, email: delegated.email }, 'PUT', 404);
    await request('/api/users', delegatedToken, { ...edit, email: 'new-scoped-mm', sections: ['lighting'], password: 'test-password' }, 'POST', 201);
    await request('/api/users', delegatedToken, { ...edit, email: 'escalation-mm', sections: ['billing'], password: 'test-password' }, 'POST', 403);
    await request('/api/users', mm, { ...edit, email: 'ordinary-mm-cannot-create-mm', sections: [], password: 'test-password' }, 'POST', 403);
    const fullAdmin = (await request('/api/auth/me', a)).user;
    await request(`/api/users/${fullAdmin.id}`, delegatedToken, edit, 'PUT', 404);
  });
  await t.test('an assigned in-progress ticket can complete with a valid JPEG and retains creator visibility', async () => {
    const created = (await request('/api/tickets', s, { propertyId, subject: 'Progress completion',
      description: 'Completion regression', unitNumber: 'A-12', tags: ['General'] }, 'POST', 201)).ticket;
    await request(`/api/tickets/${created.id}/assignment`, mm, { assistantId: users.maintenance_assistant.id }, 'PUT');
    await request(`/api/tickets/${created.id}/status`, mm, { status: 'in_progress' }, 'PUT');
    await request(`/api/tickets/${created.id}/complete`, ma, { photo: machineEntry(1).photo.data }, 'POST');
    const completed = (await request('/api/tickets', s)).tickets.find((row) => row.id === created.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.assigned_to_name, 'maintenance_assistant');
    assert.equal(completed.has_completion_photo, true);
  });

  const residentInput = { email: 'user', name: 'user', role: 'user', unitNumber: 'A-12', propertyIds: [outsideId] };
  await request(`/api/tickets/${ticket.id}/access`, s, { granted: true }, 'PUT');
  await request(`/api/users/${users.user.id}`, a, residentInput, 'PUT');
  assert.equal((await request('/api/tickets', a)).tickets.find((row) => row.id === ticket.id).access_granted, false);
  await request(`/api/tickets/${ticket.id}/access`, s, { granted: true }, 'PUT', 404);
  await request(`/api/users/${users.user.id}`, a, { ...residentInput, propertyIds: [propertyId] }, 'PUT');
  await request(`/api/tickets/${ticket.id}/access`, s, { granted: true }, 'PUT');
  await request(`/api/users/${users.user.id}`, a, { ...residentInput, propertyIds: [propertyId], unitNumber: 'A-99' }, 'PUT');
  assert.equal((await request('/api/tickets', a)).tickets.find((row) => row.id === ticket.id).access_granted, false);
  await request(`/api/tickets/${ticket.id}/access`, s, { granted: true }, 'PUT', 404);
  await request(`/api/users/${users.user.id}`, a, { ...residentInput, propertyIds: [propertyId] }, 'PUT');

  await request(`/api/users/${users.maintenance_manager.id}`, a, {
    email: 'maintenance_manager', name: 'maintenance_manager', role: 'maintenance_manager', propertyIds: [outsideId]
  }, 'PUT');
  await request(`/api/billing/accounts/${users.user.id}/entries`, mm, bill, 'POST', 403, operation);
  await request(`/api/users/${users.maintenance_manager.id}`, a, {
    email: 'maintenance_manager', name: 'maintenance_manager', role: 'maintenance_manager', propertyIds: [propertyId]
  }, 'PUT');

  await t.test('building quotation contacts are saved and scoped to manager properties', async () => {
    const body = { email: 'building@example.com', suppliers: [
      { name: 'First supplier', email: 'first@example.com' }, { name: 'Second supplier', email: 'second@example.com' }
    ] };
    for (const token of [s, ma, tech]) {
      await request('/api/building-quote-contacts', token, undefined, 'GET', 403);
      await request(`/api/building-quote-contacts/${propertyId}`, token, body, 'PUT', 403);
    }
    await request(`/api/building-quote-contacts/${outsideId}`, a, { ...body, email: 'outside@example.com' }, 'PUT');
    await request(`/api/building-quote-contacts/${outsideId}`, mm, body, 'PUT', 403);
    await request(`/api/building-quote-contacts/${propertyId}`, mm, { ...body, email: 'bad\r\nBcc: other@example.com' }, 'PUT', 400);
    await request(`/api/building-quote-contacts/${propertyId}`, mm, body, 'PUT');
    const visible = await request('/api/building-quote-contacts', mm);
    assert.deepEqual(visible.contacts, [{ property_id: propertyId, ...body }]);
    assert((await request('/api/building-quote-contacts', a)).contacts.some((contact) => contact.property_id === outsideId));
    await request(`/api/building-quote-contacts/${propertyId}`, mm, { ...body, email: 'updated@example.com' }, 'PUT');
    assert.equal((await request('/api/building-quote-contacts', mm)).contacts[0].email, 'updated@example.com');
  });

  let browserChangeVisit;
  let browserPostponeVisit;
  await t.test('MM reschedules are atomic and technician requests require scoped approval', async () => {
    const { localDay } = await import('../www/technician-visits.mjs');
    const date = (offset) => localDay(new Date(Date.now() + offset * 86400000));
    const body = { propertyId, technicianId: users.technician.id, date: date(5), allDay: true, note: 'Movable appointment' };
    const original = (await request('/api/technician-bookings', mm, body, 'POST', 201)).visit;
    const conflict = (await request('/api/technician-bookings', mm, { ...body, date: date(6) }, 'POST', 201)).visit;
    const move = { ...body, date: date(6), reschedulesId: original.id };
    await request('/api/technician-bookings', tech, move, 'POST', 403);
    await request('/api/technician-bookings', mm, move, 'POST', 409);
    assert.equal((await request('/api/technician-schedule', tech)).visits.find((v) => v.id === original.id).cancelled_at, null);
    const requestBody = { action: 'reschedule', reason: 'Technician unavailable on that date' };
    for (const token of [s, ma, mm]) await request(`/api/technician-bookings/${original.id}/requests`, token, requestBody, 'POST', 403);
    await request(`/api/technician-bookings/${original.id}/requests`, tech, { ...requestBody, reason: ' ' }, 'POST', 400);
    const change = (await request(`/api/technician-bookings/${original.id}/requests`, tech, requestBody, 'POST', 201)).request;
    assert.equal(change.status, 'pending');
    await request(`/api/technician-bookings/${original.id}/requests`, tech, requestBody, 'POST', 409);
    const pending = await request('/api/technician-schedule', tech);
    assert.equal(pending.visits.find((v) => v.id === original.id).cancelled_at, null);
    assert.equal(pending.requests.find((r) => r.id === change.id).status, 'pending');
    await request(`/api/technician-requests/${change.id}/decision`, tech, { approve: true }, 'POST', 403);
    await request(`/api/technician-requests/${change.id}/decision`, mm, { approve: true }, 'POST', 400);
    await request('/api/technician-bookings', mm, { ...move, changeRequestId: change.id }, 'POST', 409);
    assert.equal((await request('/api/technician-schedule', tech)).requests.find((r) => r.id === change.id).status, 'pending');
    const replacement = (await request('/api/technician-bookings', mm, { ...move, date: date(7), changeRequestId: change.id }, 'POST', 201)).visit;
    assert.equal(replacement.replaces_id, original.id);
    const after = await request('/api/technician-schedule', tech);
    assert(after.visits.find((v) => v.id === original.id).cancelled_at);
    assert.equal(after.visits.find((v) => v.id === original.id).rebooked_as, replacement.id);
    assert.equal(after.requests.find((r) => r.id === change.id).status, 'approved');
    await request('/api/technician-bookings', mm, { ...move, date: date(8) }, 'POST', 409);
    const cancellation = (await request(`/api/technician-bookings/${replacement.id}/requests`, tech,
      { action: 'cancel', reason: 'No longer available' }, 'POST', 201)).request;
    await request(`/api/technician-requests/${cancellation.id}/decision`, mm, { approve: false }, 'POST');
    assert.equal((await request('/api/technician-schedule', tech)).visits.find((v) => v.id === replacement.id).cancelled_at, null);
    const cancelAgain = (await request(`/api/technician-bookings/${replacement.id}/requests`, tech,
      { action: 'cancel', reason: 'Please cancel' }, 'POST', 201)).request;
    await request(`/api/technician-requests/${cancelAgain.id}/decision`, mm, { approve: true }, 'POST');
    await request(`/api/technician-requests/${cancelAgain.id}/decision`, mm, { approve: true }, 'POST', 409);
    assert((await request('/api/technician-schedule', tech)).visits.find((v) => v.id === replacement.id).cancelled_at);
    const direct = (await request('/api/technician-bookings', mm, { ...body, date: date(9), reschedulesId: conflict.id }, 'POST', 201)).visit;
    assert.equal(direct.replaces_id, conflict.id);
    await request('/api/technician-bookings', mm, { ...body, date: date(10), reschedulesId: visitId }, 'POST', 409);
    const outside = (await request('/api/technician-bookings', a,
      { ...body, propertyId: outsideId, date: date(10) }, 'POST', 403));
    assert(outside.error);
    const otherTech = (await request('/api/users', a, { email: 'request-other-tech', name: 'Other technician',
      password: 'test-password', role: 'technician', propertyIds: [outsideId] }, 'POST', 201)).user;
    const otherToken = await login(otherTech.email);
    const privateVisit = (await request('/api/technician-bookings', a,
      { ...body, propertyId: outsideId, technicianId: otherTech.id, date: date(10) }, 'POST', 201)).visit;
    await request(`/api/technician-bookings/${privateVisit.id}/requests`, tech, requestBody, 'POST', 403);
    await request(`/api/technician-bookings/${privateVisit.id}/postpone`, mm, { reason: 'Outside building' }, 'POST', 403);
    const privateRequest = (await request(`/api/technician-bookings/${privateVisit.id}/requests`, otherToken, requestBody, 'POST', 201)).request;
    assert(!(await request('/api/technician-schedule', tech)).requests.some((r) => r.id === privateRequest.id));
    assert(!(await request('/api/technician-schedule', mm)).requests.some((r) => r.id === privateRequest.id));
    await request(`/api/technician-requests/${privateRequest.id}/decision`, mm, { approve: false }, 'POST', 403);
    browserChangeVisit = (await request('/api/technician-bookings', mm, { ...body, date: date(11) }, 'POST', 201)).visit;
    browserPostponeVisit = (await request('/api/technician-bookings', mm, { ...body, date: date(15) }, 'POST', 201)).visit;
  });

  await t.test('undated postponements release slots, preserve audit history and only authorised managers can reschedule them', async () => {
    const { localDay } = await import('../www/technician-visits.mjs');
    const day = (offset) => localDay(new Date(Date.now() + offset * 86400000));
    const body = { propertyId, technicianId: users.technician.id, date: day(40), startTime: '08:00', endTime: '10:00' };
    const original = (await request('/api/technician-bookings', mm, body, 'POST', 201)).visit;
    await request(`/api/technician-bookings/${original.id}/postpone`, tech, { reason: 'Technician cannot directly postpone' }, 'POST', 403);
    await request(`/api/technician-bookings/${original.id}/postpone`, mm, { reason: ' ' }, 'POST', 400);
    await request(`/api/technician-bookings/${original.id}/postpone`, mm, { reason: 'Waiting for access confirmation' });
    const pending = (await request('/api/technician-schedule', mm)).visits.find((visit) => visit.id === original.id);
    assert.equal(pending.booking_status, 'postponed');
    assert.equal(pending.postpone_reason, 'Waiting for access confirmation');
    assert.equal(pending.postponed_by, users.maintenance_manager.id);
    assert(pending.postponed_at && pending.cancelled_at);
    await request(`/api/technician-bookings/${original.id}/postpone`, mm, { reason: 'Again' }, 'POST', 409);
    const occupied = (await request('/api/technician-bookings', mm, body, 'POST', 201)).visit;
    await request('/api/technician-bookings', mm, { ...body, reschedulesId: original.id }, 'POST', 409);
    assert.equal((await request('/api/technician-schedule', mm)).visits.find((visit) => visit.id === original.id).booking_status, 'postponed');
    await request(`/api/technician-bookings/${occupied.id}/cancel`, mm, {});
    const restored = (await request('/api/technician-bookings', mm, { ...body, reschedulesId: original.id }, 'POST', 201)).visit;
    assert.equal(restored.replaces_id, original.id);
    const history = (await request('/api/technician-schedule', mm)).visits.find((visit) => visit.id === original.id);
    assert.equal(history.rebooked_as, restored.id);
    assert.equal(history.postpone_reason, pending.postpone_reason);
    await request('/api/technician-bookings', mm, { ...body, date: day(39), reschedulesId: restored.id, postpone: true }, 'POST', 400);
    const later = (await request('/api/technician-bookings', mm, { ...body, date: day(41), reschedulesId: restored.id, postpone: true }, 'POST', 201)).visit;
    await request(`/api/technician-bookings/${later.id}/postpone`, mm, { reason: 'No replacement date yet' });
    await request(`/api/technician-bookings/${later.id}/cancel`, mm, {});
    const cancelled = (await request('/api/technician-schedule', mm)).visits.find((visit) => visit.id === later.id);
    assert.equal(cancelled.booking_status, 'cancelled');
    assert(cancelled.postponed_at);
    await request('/api/technician-bookings', mm, { ...body, date: day(42), reschedulesId: later.id }, 'POST', 409);
  });

  await t.test('technician bookings enforce building GPS, both checks, scoped MM attendance and rebooking history', async () => {
    const { localDay } = await import('../www/technician-visits.mjs');
    const day = localDay();
    const scheduledUser = (await request('/api/users', a, {
      email: 'scheduled-tech', name: 'Scheduled technician', password: 'test-password', role: 'technician', propertyIds: [propertyId, outsideId]
    }, 'POST', 201)).user;
    const scheduledToken = await login('scheduled-tech');
    await request(`/api/technician-locations/${outsideId}`, a, { latitude: -25.76, longitude: 28.19, radius: 100 }, 'PUT');
    await request(`/api/technician-locations/${outsideId}`, mm, { latitude: -25.76, longitude: 28.19, radius: 100 }, 'PUT', 403);
    await request(`/api/technician-locations/${propertyId}`, scheduledToken, { latitude: -25.75, longitude: 28.19, radius: 100 }, 'PUT', 403);
    await request('/api/technician-bookings', mm, { propertyId: outsideId, technicianId: scheduledUser.id, date: day, allDay: true }, 'POST', 403);
    const bookingBody = { propertyId, technicianId: scheduledUser.id, date: day, allDay: true, note: 'Both laundry checks' };
    const { visit: booked } = await request('/api/technician-bookings', mm, bookingBody, 'POST', 201);
    await request('/api/technician-bookings', mm, bookingBody, 'POST', 409);
    await request('/api/technician-bookings', scheduledToken, bookingBody, 'POST', 403);
    const ownSchedule = await request('/api/technician-schedule', scheduledToken);
    assert.deepEqual(ownSchedule.visits.map((row) => row.id), [booked.id]);
    assert(!ownSchedule.visits.some((row) => row.technician_id === users.technician.id));
    const checkin = { id: booked.id, propertyId, extra: false, location: { ...location, capturedAt: new Date().toISOString() } };
    await request('/api/technician-checkins', scheduledToken, { ...checkin, location: { ...checkin.location, latitude: -25.76 } }, 'POST', 400);
    await request('/api/technician-checkins', scheduledToken, { ...checkin, location: { ...checkin.location, accuracy: 80 } }, 'POST', 400);
    const checkinOperation = { 'X-Operation-ID': crypto.randomUUID() };
    const checkedIn = await request('/api/technician-checkins', scheduledToken, checkin, 'POST', 200, checkinOperation);
    await request(`/api/technician-bookings/${booked.id}/postpone`, mm, { reason: 'Already started' }, 'POST', 409);
    assert.deepEqual(await request('/api/technician-checkins', scheduledToken, checkin, 'POST', 200, checkinOperation), checkedIn);
    assert(!('checkin' in checkedIn.visit));
    const extra = { id: crypto.randomUUID(), propertyId: outsideId, extra: true,
      location: { ...checkin.location, latitude: -25.76, capturedAt: new Date().toISOString() } };
    await request('/api/technician-checkins', scheduledToken, extra, 'POST', 400);
    const visitReport = (type) => {
      const current = { ...location, capturedAt: new Date().toISOString() };
      const audit = { started: current, completed: current, durationMs: 0, offlineCompleted: false };
      return { ...reportBody, visitId: booked.id, applianceType: type, checkAudit: audit,
        entries: [{ ...machineEntry(1), serialNumber: type === 'Dryer' ? 'TEST-DRYER-SERIAL-1' : 'TEST-SERIAL-1',
          checkAudit: audit, photo: { ...machineEntry(1).photo, capturedAt: current.capturedAt } }] };
    };
    const badEvidence = visitReport('Washer');
    badEvidence.entries[0].checkAudit.completed = { ...badEvidence.entries[0].checkAudit.completed, latitude: -25.76 };
    await request('/api/appliance-reports', scheduledToken, badEvidence, 'POST', 400);
    await request('/api/appliance-reports', scheduledToken, visitReport('Washer'), 'POST', 201);
    await request('/api/technician-checkins', scheduledToken, extra, 'POST', 400);
    await request('/api/appliance-reports', scheduledToken, visitReport('Dryer'), 'POST', 201);
    await request('/api/technician-checkins', scheduledToken, extra);
    const managerOutside = (await request('/api/users', a, {
      email: 'outside-manager', name: 'Outside MM', password: 'test-password', role: 'maintenance_manager', propertyIds: [outsideId]
    }, 'POST', 201)).user;
    assert(managerOutside.id);
    const outsideManagerToken = await login('outside-manager');
    const extraAttendance = await request('/api/technician-attendance?alerts=true', outsideManagerToken);
    assert(extraAttendance.rows.some((row) => row.id === extra.id && row.kind === 'extra'));
    assert(!(await request('/api/technician-attendance?alerts=true', mm)).rows.some((row) => row.id === extra.id));
    for (const token of [a, scheduledToken, s, ma]) await request('/api/technician-attendance', token, undefined, 'GET', 403);

    const isolated = new Client({ connectionString: url.href });
    await isolated.connect();
    try {
      const missedId = crypto.randomUUID(), partialId = crypto.randomUUID();
      await isolated.query(`INSERT INTO technician_visits(id,technician_id,property_id,kind,starts_at,ends_at,created_by)
        VALUES($1,$3,$4,'booking',NOW()-interval '2 days',NOW()-interval '2 days'+interval '1 hour',$5),
              ($2,$3,$4,'booking',NOW()-interval '1 day',NOW()-interval '1 day'+interval '1 hour',$5)`,
      [missedId, partialId, scheduledUser.id, propertyId, users.maintenance_manager.id]);
      await isolated.query(`INSERT INTO appliance_reports(id,created_by,property_id,unit_number,appliance_type,model_number,fault,visit_id)
        VALUES($1,$2,$3,'','Washer','','',$4)`, [crypto.randomUUID(), scheduledUser.id, propertyId, partialId]);
      const data = await request(`/api/technician-attendance?alerts=true&technicianId=${scheduledUser.id}`, mm);
      assert.equal(data.totals.missedAppointments, 1);
      assert.equal(data.totals.missedDays, 1);
      assert.equal(data.totals.incompleteAppointments, 1);
      assert.equal(data.totals.incompleteChecks, 3);
      assert(!JSON.stringify(await request('/api/technician-attendance?alerts=true', outsideManagerToken)).includes(missedId));
      await request(`/api/technician-bookings/${missedId}/cancel`, mm, {}, 'POST', 400);
      const tomorrow = localDay(new Date(Date.now() + 86400000));
      const { visit: replacement } = await request('/api/technician-bookings', mm, {
        ...bookingBody, allDay: false, date: tomorrow, startTime: '08:00', endTime: '10:00', replacesId: missedId
      }, 'POST', 201);
      assert.equal(replacement.replaces_id, missedId);
      const after = await request(`/api/technician-attendance?alerts=true&technicianId=${scheduledUser.id}`, mm);
      assert.equal(after.rows.find((row) => row.id === missedId).rebooked_as, replacement.id);
      assert.equal(after.totals.missedAppointments, 1);
      await request(`/api/technician-bookings/${replacement.id}/cancel`, outsideManagerToken, {}, 'POST', 403);
      await request(`/api/technician-bookings/${replacement.id}/cancel`, mm, {}, 'POST');
      const afterCancellation = await request(`/api/technician-attendance?alerts=true&technicianId=${scheduledUser.id}`, mm);
      assert.equal(afterCancellation.rows.find((row) => row.id === missedId).rebooked_as, null);
      await request('/api/technician-bookings', mm, {
        ...bookingBody, allDay: false, date: tomorrow, startTime: '08:00', endTime: '10:00', replacesId: missedId
      }, 'POST', 201);
    } finally { await isolated.end(); }
  });

  let absenceUiTechId;
  let absenceUiVisitId;
  await t.test('no-show records require manager roles, notes and access to every building for a whole workday', async () => {
    const { localDay, bookingWindow } = await import('../www/technician-visits.mjs');
    const yesterday = localDay(new Date(Date.now() - 86400000));
    const tomorrow = localDay(new Date(Date.now() + 86400000));
    const absenceTech = (await request('/api/users', a, {
      email: 'absence-tech', name: 'No-show technician', password: 'test-password', role: 'technician', propertyIds: [propertyId, outsideId]
    }, 'POST', 201)).user;
    const ownTech = (await request('/api/users', a, {
      email: 'own-absence-tech', name: 'Own no-show technician', password: 'test-password', role: 'technician', propertyIds: [propertyId]
    }, 'POST', 201)).user;
    absenceUiTechId = ownTech.id;
    const noShowToken = await login('absence-tech');
    const isolated = new Client({ connectionString: url.href });
    await isolated.connect();
    const ids = { own: crypto.randomUUID(), outside: crypto.randomUUID(), future: crypto.randomUUID(), cancelled: crypto.randomUUID() };
    try {
      absenceUiVisitId = crypto.randomUUID();
      const missedWindow = bookingWindow({ date: localDay(new Date(Date.now() - 4 * 86400000)), allDay: true });
      await isolated.query(`INSERT INTO technician_visits(id,technician_id,property_id,kind,starts_at,ends_at,created_by)
        VALUES($1,$2,$3,'booking',$4,$5,$6)`, [absenceUiVisitId, ownTech.id, propertyId,
        missedWindow.starts_at, missedWindow.ends_at, users.maintenance_manager.id]);
      for (const [kind, id] of Object.entries(ids)) {
        const window = bookingWindow({ date: kind === 'future' ? tomorrow : yesterday, allDay: true });
        await isolated.query(`INSERT INTO technician_visits(id,technician_id,property_id,kind,starts_at,ends_at,created_by,cancelled_at)
          VALUES($1,$2,$3,'booking',$4,$5,$6,$7)`, [id, absenceTech.id, kind === 'outside' ? outsideId : propertyId,
          window.starts_at, window.ends_at, users.maintenance_manager.id, kind === 'cancelled' ? new Date() : null]);
      }
      const body = { scope: 'visit', technicianId: absenceTech.id, visitId: ids.own, note: 'Did not arrive; called technician.' };
      for (const token of [s, ma, tech, noShowToken]) await request('/api/technician-absences', token, body, 'POST', 403);
      for (const note of ['', '   ', null, 'x'.repeat(2001)]) {
        await request('/api/technician-absences', mm, { ...body, note }, 'POST', 400);
      }
      await request('/api/technician-absences', mm, { ...body, visitId: ids.outside }, 'POST', 403);
      await request('/api/technician-absences', mm, { ...body, visitId: ids.future }, 'POST', 400);
      await request('/api/technician-absences', mm, { ...body, visitId: ids.cancelled }, 'POST', 400);
      await request('/api/technician-absences', mm, body, 'POST', 201);
      await request('/api/technician-absences', mm, body, 'POST', 409);
      const dayBody = { scope: 'day', technicianId: absenceTech.id, date: yesterday, note: 'Absent for entire workday.' };
      await request('/api/technician-absences', mm, dayBody, 'POST', 403);
      assert.equal((await request('/api/technician-schedule', a)).absences.filter((item) => item.technician_id === absenceTech.id).length, 1);
      const wholeDay = await request('/api/technician-absences', a, dayBody, 'POST', 201);
      assert.equal(wholeDay.absence.buildings, 2);
      await request('/api/technician-absences', a, dayBody, 'POST', 409);
      const all = (await request('/api/technician-schedule', a)).absences.filter((item) => item.group_id === wholeDay.absence.groupId);
      assert.equal(all.length, 2);
      assert(all.every((item) => item.absence_date === yesterday && item.note === dayBody.note && item.recorded_by_name === 'Administrator' && item.recorded_at));
      const scoped = (await request('/api/technician-schedule', mm)).absences;
      assert(scoped.every((item) => item.property_id === propertyId));
      assert.equal((await request('/api/technician-schedule', noShowToken)).absences.length, 0);
      const attendance = await request(`/api/technician-attendance?from=${yesterday}&to=${yesterday}&technicianId=${absenceTech.id}`, mm);
      assert.equal(attendance.absences.length, 2);
      assert(!attendance.absences.some((item) => item.property_id === outsideId));
      await request(`/api/technician-attendance?from=${yesterday}&to=${yesterday}`, a, undefined, 'GET', 403);
      const ownDay = { ...dayBody, technicianId: ownTech.id };
      for (const date of [tomorrow, '2026-02-30', 'wrong']) {
        await request('/api/technician-absences', mm, { ...ownDay, date }, 'POST', 400);
      }
      await request('/api/technician-absences', mm, ownDay, 'POST', 201);
      await isolated.query('UPDATE technician_visits SET started_at=starts_at WHERE id=$1', [ids.own]);
      await request('/api/technician-absences', a, { ...dayBody, date: localDay(), note: 'Current day' }, 'POST', 201);
      const thirdDay = localDay(new Date(Date.now() - 2 * 86400000));
      const window = bookingWindow({ date: thirdDay, allDay: true });
      const checkedIn = crypto.randomUUID();
      await isolated.query(`INSERT INTO technician_visits(id,technician_id,property_id,kind,starts_at,ends_at,started_at,created_by)
        VALUES($1,$2,$3,'booking',$4,$5,$4,$6)`, [checkedIn, ownTech.id, propertyId, window.starts_at, window.ends_at, users.maintenance_manager.id]);
      await request('/api/technician-absences', mm, { ...body, technicianId: ownTech.id, visitId: checkedIn }, 'POST', 409);
      await request('/api/technician-absences', mm, { ...ownDay, date: thirdDay }, 'POST', 409);
      assert((await request('/api/technician-schedule', a)).absences.some((item) => item.visit_id === ids.own));
    } finally { await isolated.end(); }
  });

  if (process.env.CHROMIUM) {
    const fs = require('node:fs/promises');
    const profile = await fs.mkdtemp(require('node:path').join(require('node:os').tmpdir(), 'fg-browser-'));
    const browser = spawn(process.env.CHROMIUM, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    t.after(async () => {
      if (browser.exitCode === null) {
        browser.kill();
        await once(browser, 'exit');
      }
      await fs.rm(profile, { recursive: true, force: true });
    });
    let browserLog = '';
    browser.stderr.on('data', (data) => { browserLog += data; });
    for (let attempt = 0; !browserLog.includes('DevTools listening on'); attempt++) {
      if (attempt > 300 || browser.exitCode !== null) throw new Error(`Browser did not start: ${browserLog}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const browserAddress = browserLog.match(/ws:\/\/127\.0\.0\.1:(\d+)/)[1];
    const pages = await (await fetch(`http://127.0.0.1:${browserAddress}/json`)).json();
    const ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
    await once(ws, 'open');
    t.after(() => ws.close());
    const pending = new Map();
    let nextId = 0;
    const dialogs = [];
    ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method === 'Page.javascriptDialogOpening') {
        dialogs.push(message.params.message);
        void cdp('Page.handleJavaScriptDialog', { accept: message.params.message.startsWith('Record did not report to work for ') });
      }
      if (!message.id) return;
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(message.error.message));
      else callback.resolve(message.result);
    });
    function cdp(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evaluate(expression) {
      const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    async function waitFor(expression) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const screen = await evaluate('document.querySelector("#workspace")?.textContent.slice(0, 1200)');
      throw new Error(`Browser condition failed: ${expression}; screen: ${screen}; dialogs: ${dialogs.join('; ')}`);
    }
    async function assertTabPanels() {
      const errors = await evaluate(`(() => {
        const errors = [];
        for (const group of document.querySelectorAll('[data-section-group]')) {
          const own = (selector) => [...group.querySelectorAll(selector)].filter(element => element.closest('[data-section-group]') === group);
          const tabs = own('[data-section-tab]');
          if (!tabs.length) continue;
          if (tabs.filter(tab => tab.getAttribute('aria-selected') === 'true').length !== 1) errors.push(group.dataset.sectionGroup + ': selected tabs');
          if (own('[data-section-panel]').filter(panel => !panel.hidden).length !== 1) errors.push(group.dataset.sectionGroup + ': visible panels');
          for (const tab of tabs) {
            const panel = document.getElementById(tab.getAttribute('aria-controls'));
            if (!panel || panel.getAttribute('aria-labelledby') !== tab.id || panel.hidden === (tab.getAttribute('aria-selected') === 'true')) errors.push(tab.id + ': panel link');
          }
        }
        return errors;
      })()`);
      assert.deepEqual(errors, []);
    }
    await cdp('Page.enable');
    browserLicenceDb = new Client({ connectionString: url.href });
    await browserLicenceDb.connect();
    await browserLicenceDb.query('UPDATE system_licence SET token=NULL WHERE id=1');
    await cdp('Page.navigate', { url: `http://127.0.0.1:${port}` });
    await waitFor('!!document.querySelector("#app-shell") && document.querySelector("#auth-screen")?.hidden === false && document.querySelector("[data-licence-system]").textContent === ' + JSON.stringify(licenceStatus.systemId));
    assert.equal(await evaluate('document.querySelector("#app-shell").hidden'), true);
    assert.equal(await evaluate('document.querySelector("[data-licence-system]").textContent'), licenceStatus.systemId);
    activeLicenceToken = issueToken(licenceKeys.privateKey, licenceStatus.systemId);
    await evaluate(`document.querySelector('#auth-screen [data-open-licence]').click();
      document.querySelector('#licence-form [name=token]').value = ${JSON.stringify(activeLicenceToken)};
      document.querySelector('#licence-form').requestSubmit();`);
    await waitFor('document.querySelector("#auth-screen")?.hidden === false && !document.querySelector("#licence-dialog").open');
    const nearExpiryStart = new Date(Date.now() + 12 * 60 * 60 * 1000);
    nearExpiryStart.setUTCFullYear(nearExpiryStart.getUTCFullYear() - 1);
    activeLicenceToken = issueToken(licenceKeys.privateKey, licenceStatus.systemId, null, nearExpiryStart);
    await browserLicenceDb.query('UPDATE system_licence SET token=$1 WHERE id=1', [activeLicenceToken]);
    for (const [token, expected] of [
      [restrictedToken, ['home', 'lighting']],
      [tech, ['home', 'appliances']],
      [s, ['home', 'tickets', 'log-ticket', 'billing', 'security', 'residents', 'incidents']],
      [ma, ['home', 'lighting', 'checks', 'tickets', 'meters', 'assets', 'incidents']],
      [mm, ['home', 'lighting', 'checks', 'tickets', 'log-ticket', 'appliances', 'billing', 'security', 'residents', 'meters', 'assets', 'incidents', 'contractors', 'users']],
      [a, ['home', 'lighting', 'checks', 'tickets', 'log-ticket', 'appliances', 'billing', 'security', 'residents', 'meters', 'assets', 'incidents', 'contractors', 'users', 'storage']]
    ]) {
      await evaluate(`localStorage.setItem('primeops-token', ${JSON.stringify(token)})`);
      await cdp('Page.reload');
      await waitFor('document.querySelector("#app-shell")?.hidden === false');
      assert.equal(await evaluate('document.querySelector("#licence-warning").hidden'), ![a, mm, restrictedToken].includes(token));
      if ([a, mm, restrictedToken].includes(token)) assert.match(await evaluate('document.querySelector("[data-licence-warning]").textContent'), /one day/);
      const visible = await evaluate('[...document.querySelectorAll(".module-link:not([hidden])")].map(button => button.dataset.view)');
      assert.deepEqual(visible, expected);
      assert.equal(await evaluate('[...document.querySelectorAll(".module-link")].every(button => !!button.querySelector("svg.navigation-picture"))'), true);
      assert.equal(await evaluate('[...document.querySelectorAll("[data-home-view]")].every(button => !!button.querySelector("svg.navigation-picture") && button.textContent.trim().length > 1)'), true);
      await cdp('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true);
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".home-section-grid")).gridTemplateColumns.split(" ").length'), 2);
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".module-nav")).display'), 'none');
      await evaluate('document.querySelector("#section-menu-toggle").click()');
      assert.equal(await evaluate('document.querySelector("#section-menu-toggle").getAttribute("aria-expanded")'), 'true');
      const menuSizes = await evaluate('[...document.querySelectorAll(".module-link:not([hidden])")].map(button => ({width:button.getBoundingClientRect().width,height:button.getBoundingClientRect().height}))');
      assert(menuSizes.every((size) => size.width >= 44 && size.height >= 44));
      await evaluate(`document.querySelector('.module-nav [data-view="home"]').click()`);
      assert.equal(await evaluate('document.querySelector("#section-menu-toggle").getAttribute("aria-expanded")'), 'false');
      await cdp('Emulation.clearDeviceMetricsOverride');
      await evaluate('document.querySelector("#account-button").click()');
      await waitFor('!document.querySelector("#profile-photo-input").disabled');
      await evaluate(`(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 32; canvas.height = 32;
        const context = canvas.getContext('2d');
        context.fillStyle = '#663399'; context.fillRect(0,0,32,32);
        const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], 'profile.png', {type:'image/png'}));
        const input = document.querySelector('#profile-photo-input');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', {bubbles:true}));
      })()`);
      await waitFor('document.querySelector("#profile-photo-status").textContent === "Profile picture saved."');
      assert.equal(await evaluate('document.querySelector("#account-button [data-profile-photo]").hidden'), false);
      assert((await request('/api/auth/profile-photo', token)).photo.startsWith('data:image/jpeg;base64,'));
      await evaluate('document.querySelector("#remove-profile-photo").click()');
      await waitFor('document.querySelector("#profile-photo-status").textContent === "Profile picture removed."');
      assert.equal(await evaluate('document.querySelector("#account-button [data-profile-photo]").hidden'), true);
      await evaluate('document.querySelector("#close-account-dialog").click()');
      if (token === tech) {
        await evaluate(`document.querySelector('[data-home-view="appliances"]').click()`);
        await waitFor('!!document.querySelector("#appliance-report-form")');
        assert.equal(await evaluate('!!document.querySelector("#technician-booking-form")'), false);
        assert.equal(await evaluate('!!document.querySelector("#technician-attendance-form")'), false);
        assert.equal(await evaluate('!!document.querySelector("[data-open-absence], #technician-absence-form, [data-recorded-absence]")'), false);
        assert((await evaluate('document.querySelector("#workspace").textContent')).includes('My building visits'));
        assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-appliance-tab]")].map(tab => tab.dataset.applianceTab)'), ['schedule', 'checks', 'reports', 'assets']);
        assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-appliance-panel]:not([hidden])")].map(panel => panel.dataset.appliancePanel)'), ['schedule']);
        assert((await evaluate('document.querySelectorAll("[data-calendar-day]").length')) >= 28);
        const requestDay = (await import('../www/technician-visits.mjs')).localDay(browserChangeVisit.starts_at);
        await evaluate(`(() => {
          const month = document.querySelector('[data-calendar-month]');
          month.value = ${JSON.stringify(requestDay.slice(0, 7))};
          month.dispatchEvent(new Event('change',{bubbles:true}));
          document.querySelector('[data-calendar-day="${requestDay}"]').click();
          document.querySelector('[data-request-visit="${browserChangeVisit.id}"][data-request-action=reschedule]').click();
          const form = document.querySelector('#technician-change-request-form');
          form.elements.reason.value = 'Browser request to move visit';
          form.requestSubmit();
        })()`);
        await waitFor('document.querySelector(".visit-change-requests")?.textContent.includes("Browser request to move visit")');
        assert((await evaluate('document.querySelector(".visit-change-requests").textContent')).includes('Pending MM approval'));
        assert.equal((await request('/api/technician-schedule', tech)).visits.find((v) => v.id === browserChangeVisit.id).cancelled_at, null);
        await evaluate('document.querySelector("[data-calendar-move=\\"1\\"]").click()');
        await evaluate('document.querySelector("[data-calendar-today]").click()');
        await evaluate('document.querySelector("[data-appliance-tab=checks]").click()');
        assert.equal(await evaluate('!!document.querySelector("#new-appliance-part")'), false);
        assert((await evaluate('document.querySelector("#workspace").textContent')).includes('SWNMN2SP303SW01'));
        assert.equal(await evaluate('!!document.querySelector("#appliance-report-form [name=unitNumber]")'), false);
        assert.equal(await evaluate('!!document.querySelector("#appliance-report-form input[type=file]")'), false);
        await waitFor('document.querySelector("#offline-banner").textContent.includes("Offline copy ready")');
        await cdp('Network.enable');
        await evaluate(`(() => {
          const form = document.querySelector('#appliance-report-form');
          form.elements.propertyId.value = ${JSON.stringify(propertyId)};
          form.elements.visitId.value = ${JSON.stringify(visitId)};
          form.elements.expectedCount.value = '3';
          form.elements.machineNumber.value = '01';
          form.elements.machineNumber.dispatchEvent(new Event('change', {bubbles:true}));
        })()`);
        assert.equal(await evaluate('document.querySelector("#appliance-report-form [name=serialNumber]").value'), 'TEST-SERIAL-1');
        assert.equal(await evaluate('document.querySelector("#appliance-report-form [name=serialNumber]").readOnly'), true);
        await evaluate(`(() => {
          const input = document.querySelector('#appliance-report-form [name=replaceMachine]');
          input.checked = true;
          input.dispatchEvent(new Event('change', {bubbles:true}));
        })()`);
        assert.equal(await evaluate('document.querySelector("#appliance-report-form [name=serialNumber]").value'), '');
        assert.equal(await evaluate('document.querySelector("#appliance-report-form [name=serialNumber]").readOnly'), false);
        const downloadedParts = (await request('/api/appliance-parts', tech)).parts;
        for (const type of ['Dryer', 'Washer']) {
          await evaluate(`(() => {
            const input = document.querySelector('#appliance-report-form [name=applianceType]');
            input.value = ${JSON.stringify(type)};
            input.dispatchEvent(new Event('change', {bubbles:true}));
          })()`);
          assert.deepEqual((await evaluate('[...document.querySelectorAll("[data-select-part]")].map(input => input.dataset.selectPart)')).sort(),
            downloadedParts.filter((part) => part.active && part.machine_type === type).map((part) => part.id).sort());
        }
        assert.equal(await evaluate('document.querySelector("#appliance-parts-list").textContent.includes("Benchmark:")'), false);
        await evaluate('document.querySelector("[data-appliance-tab=schedule]").click(); document.querySelector("[data-appliance-tab=checks]").click()');
        assert.equal(await evaluate('document.querySelector("#appliance-report-form [name=expectedCount]").value'), '3');
        await evaluate(`navigator.geolocation.getCurrentPosition = (success, failure) => failure({message: 'Permission denied'})`);
        await evaluate(`document.querySelector('#start-appliance-check').click()`);
        await waitFor('document.querySelector("#appliance-check-status").textContent.includes("Permission denied")');
        await evaluate(`navigator.geolocation.getCurrentPosition = (success) => success({coords:{latitude:-25.75,longitude:28.19,accuracy:8},timestamp:Date.now()})`);
        await evaluate(`document.querySelector('#start-appliance-check').click()`);
        await waitFor('document.querySelector("#appliance-check-status").textContent.includes("Check started")');
        await cdp('Network.setBlockedURLs', { urls: [`http://127.0.0.1:${port}/api/*`] });
        await evaluate(`(() => {
          const form = document.querySelector('#appliance-report-form');
          const values = {machineNumber: 'OFF-1', serialNumber: 'OFF-SERIAL-1', modelNumber: 'OFF-MODEL', notes: 'Offline notes'};
          for (const [key, value] of Object.entries(values)) form.elements[key].value = value;
          form.querySelector('[name=status][value=needs_repair]').click();
          const checkboxes = [...document.querySelectorAll('[data-select-part]')].slice(0, 2);
          checkboxes.forEach((box) => {
            document.querySelector('[data-select-part="' + box.dataset.selectPart + '"]').click();
          });
          const quantity = document.querySelector('[data-part-quantity]:not([disabled])');
          quantity.value = '2';
          quantity.dispatchEvent(new Event('input', {bubbles:true}));
        })()`);
        await evaluate(`document.querySelector('#take-machine-photo').click()`);
        await waitFor('!!document.querySelector("[data-camera-snap]") && document.querySelector(".machine-camera video").videoWidth > 0 && document.querySelector(".machine-camera video").currentTime > 0.2');
        await evaluate(`document.querySelector('[data-camera-snap]').click()`);
        await waitFor('document.querySelector("#machine-photo-status").textContent.includes("Photo taken")');
        await evaluate('document.querySelector("[data-appliance-tab=schedule]").click(); document.querySelector("[data-appliance-tab=checks]").click()');
        assert((await evaluate('document.querySelector("#machine-photo-status").textContent')).includes('Photo taken'));
        await evaluate(`document.querySelector('#appliance-report-form').requestSubmit()`);
        await waitFor('document.querySelector("#machine-progress").textContent.includes("1 of 3")');
        assert.equal(await evaluate('document.querySelector("#finish-laundry-report").disabled'), false);
        await cdp('Page.reload');
        await waitFor('document.querySelector("#app-shell")?.hidden === false');
        await evaluate(`document.querySelector('[data-home-view="appliances"]').click()`);
        await waitFor('document.querySelector("#machine-progress")?.textContent.includes("1 of 3")');
        assert.equal(await evaluate('document.querySelector("#finish-laundry-report").disabled'), false);
        await evaluate(`navigator.geolocation.getCurrentPosition = (success) => success({coords:{latitude:-25.75,longitude:28.19,accuracy:8},timestamp:Date.now()})`);
        await evaluate(`(() => {
          const form = document.querySelector('#appliance-report-form');
          form.elements.machineNumber.value = 'OFF-2';
          form.elements.serialNumber.value = 'OFF-SERIAL-2';
          form.querySelector('[name=status][value=working]').click();
          document.querySelector('#take-machine-photo').click();
        })()`);
        await waitFor('!!document.querySelector("[data-camera-snap]") && document.querySelector(".machine-camera video").videoWidth > 0 && document.querySelector(".machine-camera video").currentTime > 1.5');
        await evaluate(`document.querySelector('[data-camera-snap]').click()`);
        await waitFor('document.querySelector("#machine-photo-status").textContent.includes("Photo taken")');
        await evaluate(`document.querySelector('#appliance-report-form').requestSubmit()`);
        await waitFor('document.querySelector("#machine-progress").textContent.includes("2 of 3")');
        assert.equal(await evaluate('document.querySelector("#finish-laundry-report").disabled'), false);
        await evaluate(`document.querySelector('#finish-laundry-report').click()`);
        await waitFor('document.querySelector("#workspace").textContent.includes("OFF-1")');
        await waitFor('document.querySelector("#offline-banner").textContent.includes("1 change")');
        assert.equal(await evaluate('document.querySelector("[data-appliance-tab=reports]").getAttribute("aria-selected")'), 'true');
        await cdp('Page.reload');
        await waitFor('document.querySelector("#app-shell")?.hidden === false');
        await evaluate(`document.querySelector('[data-home-view="appliances"]').click()`);
        await waitFor('!!document.querySelector("[data-appliance-tab=reports]")');
        await evaluate('document.querySelector("[data-appliance-tab=reports]").click()');
        await waitFor('document.querySelector("#workspace").textContent.includes("OFF-1")');
        assert((await evaluate('document.querySelector("#workspace").textContent')).includes('awaiting server confirmation'));
        await cdp('Network.setBlockedURLs', { urls: [] });
        await evaluate('document.querySelector("#offline-sync").click()');
        await waitFor('document.querySelector("#offline-banner").textContent.includes("No pending uploads")');
        const uploaded = (await request('/api/appliance-reports', tech)).reports.filter((report) => report.entries?.some((entry) => entry.machineNumber === 'OFF-1'));
        assert.equal(uploaded.length, 1);
        assert.equal(uploaded[0].entries.length, 2);
        assert.equal(uploaded[0].expected_count, 3);
        assert.equal(uploaded[0].entries[0].parts.length, 2);
        assert.equal(uploaded[0].entries[0].parts[0].quantity, 2);
        assert.equal(uploaded[0].entries[1].status, 'working');
        assert.equal(uploaded[0].entries[1].parts.length, 0);
        assert(uploaded[0].entries.every((entry) => entry.photo.source === 'camera' && !entry.checkAudit));
      }
      if (token === s) {
        await evaluate(`document.querySelector('[data-home-view="tickets"]').click()`);
        await waitFor('!!document.querySelector(".ticket-thread")');
        assert.equal(await evaluate('!!document.querySelector("#create-ticket-form")'), false);
        await evaluate('document.querySelector(".ticket-thread").open = true');
        const threadId = await evaluate('document.querySelector(".ticket-thread").dataset.sectionGroup');
        assert.equal(await evaluate('document.querySelector(".ticket-thread [data-section-panel=conversation]").hidden'), true);
        await evaluate('document.querySelector(".ticket-thread [data-section-tab=conversation]").click()');
        await evaluate(`(() => {
          const input = document.querySelector('.ticket-thread [name=message]');
          input.value = 'Draft conversation retained';
          input.dispatchEvent(new Event('input',{bubbles:true}));
          document.querySelector('.ticket-thread [data-section-tab=overview]').click();
          document.querySelector('.ticket-thread [data-section-tab=conversation]').click();
        })()`);
        assert.equal(await evaluate('document.querySelector(".ticket-thread [name=message]").value'), 'Draft conversation retained');
        assert(threadId);
        await assertTabPanels();
        assert((await evaluate('document.querySelector(".ticket-thread").textContent')).includes('We will attend tomorrow.'));
        await evaluate('document.querySelector(\'[data-view="log-ticket"]\').click()');
        await waitFor('!!document.querySelector("#create-ticket-form")');
        assert.equal(await evaluate('!!document.querySelector(".ticket-list-section")'), false);
        assert((await evaluate('document.querySelector("#create-ticket-form").textContent')).includes('A-12'));
        await assertTabPanels();
        await evaluate(`(() => {
          document.querySelector('#create-ticket-form [name=subject]').value = 'Unsent issue retained';
          document.querySelector('#new-ticket-tab-visit').click();
          document.querySelector('#new-ticket-tab-issue').click();
        })()`);
        assert.equal(await evaluate('document.querySelector("#create-ticket-form [name=subject]").value'), 'Unsent issue retained');
      }
      if (token === mm) {
        await evaluate('document.querySelector(\'[data-view="appliances"]\').click()');
        await waitFor('!!document.querySelector("#new-appliance-part")');
        assert.equal(await evaluate('!!document.querySelector("#technician-attendance-form")'), true);
        assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-appliance-panel]:not([hidden])")].map(panel => panel.dataset.appliancePanel)'), ['schedule']);
        await evaluate(`document.querySelector('[data-open-booking-requests]').click();
          document.querySelector('[data-reschedule-visit="${browserChangeVisit.id}"][data-change-request]').click()`);
        assert.equal(await evaluate('document.querySelector("[data-booking-dialog]").open'), true);
        assert.equal(await evaluate('document.querySelector("#technician-booking-form [name=propertyId]").disabled'), true);
        const moveDay = (await import('../www/technician-visits.mjs')).localDay(new Date(Date.parse(browserChangeVisit.starts_at) + 86400000));
        await evaluate(`(() => {
          const form = document.querySelector('#technician-booking-form');
          form.elements.date.value = ${JSON.stringify(moveDay)};
          form.requestSubmit();
        })()`);
        await waitFor(`!document.querySelector('[data-reschedule-visit="${browserChangeVisit.id}"][data-change-request]')`);
        const movedSchedule = await request('/api/technician-schedule', tech);
        const movedVisit = movedSchedule.visits.find((v) => v.replaces_id === browserChangeVisit.id);
        assert(movedVisit);
        assert.equal((await import('../www/technician-visits.mjs')).localDay(movedVisit.starts_at), moveDay);
        assert.equal(movedSchedule.requests.find((r) => r.visit_id === browserChangeVisit.id).status, 'approved');
        await waitFor('!!document.querySelector("[data-calendar-today]")');
        await evaluate('document.querySelector("[data-calendar-today]").click()');
        await waitFor('!!document.querySelector("[data-book-calendar-day]")');
        await evaluate('document.querySelector("[data-book-calendar-day]").click()');
        assert.equal(await evaluate('document.querySelector("[data-booking-editor]").open'), true);
        assert.equal(await evaluate('document.querySelector("#technician-location-form [name=radius]").value'), '100');
        await evaluate(`(() => {
          const form = document.querySelector('#technician-booking-form');
          form.elements.allDay.click();
        })()`);
        assert.equal(await evaluate('document.querySelector("#technician-booking-form [name=startTime]").disabled'), true);
        await evaluate(`(() => {
          const form = document.querySelector('#technician-booking-form');
          form.elements.allDay.click();
          form.elements.technicianId.value = ${JSON.stringify(users.technician.id)};
          form.elements.date.value = ${JSON.stringify((await import('../www/technician-visits.mjs')).localDay(new Date(Date.now() + 86400000)))};
          form.elements.note.value = 'Booked through MM schedule screen';
          form.requestSubmit();
        })()`);
        const tomorrow = (await import('../www/technician-visits.mjs')).localDay(new Date(Date.now() + 86400000));
        await waitFor('document.querySelector(".schedule-notice")?.textContent.includes("Booking saved")');
        const uiBooking = (await request('/api/technician-schedule', mm)).visits.find((visit) => visit.note === 'Booked through MM schedule screen');
        assert(uiBooking);
        await evaluate(`document.querySelector('[data-calendar-day="${tomorrow}"]').click()`);
        await evaluate(`document.querySelector('[data-open-booking="${uiBooking.id}"]').click()`);
        await waitFor('document.querySelector("[data-booking-overview]").textContent.includes("Booked through MM schedule screen")');
        assert.equal(await evaluate('document.querySelectorAll(".calendar-days button button").length'), 0);
        await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
        assert.equal(await evaluate('[...document.querySelectorAll("[data-booking-overview] .booking-action")].every(button => {const rect=button.getBoundingClientRect();return rect.width>=44&&rect.height>=44;})'), true);
        assert.equal(await evaluate('document.querySelector("[data-booking-dialog]").scrollWidth <= document.querySelector("[data-booking-dialog]").clientWidth + 1'), true);
        await cdp('Emulation.clearDeviceMetricsOverride');
        await evaluate(`document.querySelector('[data-postpone-visit="${uiBooking.id}"]').click();
          document.querySelector('[data-postpone-date]').click();`);
        assert.equal(await evaluate('document.querySelector("#technician-booking-form [name=postpone]").value'), 'true');
        await evaluate(`(() => {
          const form = document.querySelector('#technician-booking-form');
          form.elements.date.value = ${JSON.stringify((await import('../www/technician-visits.mjs')).localDay(new Date(Date.parse(uiBooking.starts_at) + 2 * 86400000)))};
          form.requestSubmit();
        })()`);
        await waitFor('document.querySelector(".schedule-notice")?.textContent.includes("Booking moved")');
        const datedPostponement = (await request('/api/technician-schedule', mm)).visits.find((visit) => visit.replaces_id === uiBooking.id);
        assert(datedPostponement);
        await evaluate(`document.querySelector('[data-open-booking="${datedPostponement.id}"]').click()`);
        await evaluate('document.querySelector("[data-booking-close]").click()');
        const postponeDay = (await import('../www/technician-visits.mjs')).localDay(browserPostponeVisit.starts_at);
        await evaluate(`(() => {
          const month = document.querySelector('[data-calendar-month]');
          month.value = ${JSON.stringify(postponeDay.slice(0, 7))};
          month.dispatchEvent(new Event('change', { bubbles: true }));
          document.querySelector('[data-open-booking="${browserPostponeVisit.id}"]').click();
          document.querySelector('[data-postpone-visit="${browserPostponeVisit.id}"]').click();
          document.querySelector('[data-postpone-undated]').click();
          const form = document.querySelector('#technician-booking-action-form');
          form.elements.reason.value = 'Browser postponed until access is arranged';
          form.requestSubmit();
        })()`);
        await waitFor('document.querySelector(".schedule-notice")?.textContent.includes("Booking postponed")');
        assert.equal(await evaluate('document.querySelector("[data-booking-dialog]").open'), false);
        assert((await evaluate('document.querySelector(".calendar-waiting").textContent')).includes('Awaiting reschedule'));
        await evaluate(`document.querySelector('.calendar-waiting [data-open-booking="${browserPostponeVisit.id}"]').click();
          document.querySelector('[data-reschedule-visit="${browserPostponeVisit.id}"]').click();`);
        assert.equal(await evaluate('document.querySelector("[data-booking-dialog]").open'), true);
        await evaluate(`(() => {
          const form = document.querySelector('#technician-booking-form');
          form.elements.date.value = ${JSON.stringify((await import('../www/technician-visits.mjs')).localDay(new Date(Date.parse(browserPostponeVisit.starts_at) + 86400000)))};
          form.requestSubmit();
        })()`);
        await waitFor('document.querySelector(".schedule-notice")?.textContent.includes("Booking moved")');
        const resumed = (await request('/api/technician-schedule', mm)).visits.find((visit) => visit.replaces_id === browserPostponeVisit.id);
        assert(resumed);
        await evaluate(`document.querySelector('[data-open-booking="${resumed.id}"]').click();
          document.querySelector('[data-cancel-visit="${resumed.id}"]').click();
          document.querySelector('#technician-booking-action-form').requestSubmit();`);
        await waitFor('document.querySelector(".schedule-notice")?.textContent.includes("Booking cancelled")');
        assert((await request('/api/technician-schedule', mm)).visits.find((visit) => visit.id === resumed.id).cancelled_at);
        const missedDay = (await import('../www/technician-visits.mjs')).localDay(new Date(Date.now() - 4 * 86400000));
        await evaluate(`(() => {
          const month = document.querySelector('[data-calendar-month]');
          month.value = ${JSON.stringify(missedDay.slice(0, 7))};
          month.dispatchEvent(new Event('change', { bubbles: true }));
          document.querySelector('[data-open-booking="${absenceUiVisitId}"]').click();
          document.querySelector('[data-record-visit-absence="${absenceUiVisitId}"]').click();
          const form = document.querySelector('#technician-absence-form');
          form.elements.note.value = 'Missed visit recorded directly from calendar';
          form.requestSubmit();
        })()`);
        await waitFor('document.querySelector(".schedule-notice")?.textContent.includes("Missed attendance recorded")');
        assert((await request('/api/technician-schedule', mm)).absences.some((absence) => absence.visit_id === absenceUiVisitId));
        await evaluate(`document.querySelector('[data-open-booking="${absenceUiVisitId}"]').click()`);
        assert((await evaluate('document.querySelector("[data-booking-overview]").textContent')).includes('Marked as missed'));
        assert.equal(await evaluate('!!document.querySelector("[data-booking-overview] [data-record-visit-absence]")'), false);
        await evaluate('document.querySelector("[data-booking-close]").click()');
        await evaluate('document.querySelector("[data-open-absence]").click()');
        assert.equal(await evaluate('document.querySelector("[data-absence-editor]").open'), true);
        assert.equal(await evaluate('document.querySelector("#technician-absence-form [name=note]").required'), true);
        await evaluate(`(() => {
          const form = document.querySelector('#technician-absence-form');
          form.elements.technicianId.value = ${JSON.stringify(absenceUiTechId)};
          form.elements.technicianId.dispatchEvent(new Event('change', { bubbles: true }));
          form.elements.scope.value = 'day';
          form.elements.date.value = ${JSON.stringify((await import('../www/technician-visits.mjs')).localDay())};
          form.elements.note.value = 'Browser MM recorded no-show for the whole workday.';
          form.requestSubmit();
        })()`);
        await waitFor('!![...document.querySelectorAll("[data-recorded-absence]")].find(row => row.textContent.includes("Browser MM recorded no-show"))');
        assert((await request('/api/technician-schedule', mm)).absences.some((item) => item.technician_id === absenceUiTechId && item.note.includes('Browser MM')));
        await evaluate('document.querySelector("[data-appliance-tab=quotes]").click()');
        await waitFor('!!document.querySelector("[data-quote-report]")');
        assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-appliance-panel]:not([hidden])")].map(panel => panel.dataset.appliancePanel)'), ['quotes']);
        await evaluate(`(() => {
          const form = document.querySelector('#building-quote-contacts-form');
          form.elements.email.value = 'quotes-building@example.com';
          form.requestSubmit();
        })()`);
        await waitFor('document.querySelector("[data-quote-contacts-status]").textContent.includes("contacts saved")');
        await evaluate(`document.querySelector('[data-quote-report="${report.id}"]').click(); document.querySelector('[data-prepare-building-quotes]').click()`);
        await waitFor('!!document.querySelector("[data-compose-quote]")');
        assert.equal(await evaluate('document.querySelectorAll("[data-compose-quote]").length'), 2);
        assert((await evaluate('document.querySelector("[data-quote-requests]").textContent')).includes('Bcc'));
        assert((await evaluate('document.querySelector("[data-quote-requests]").textContent')).includes('quotes-building@example.com'));
        assert((await evaluate('document.querySelector("[data-quote-status]").textContent')).includes('Nothing has been sent'));
        await evaluate(`(() => {
          const input = document.querySelector('#building-quote-contacts-form [name=email]');
          input.value = 'revised-building@example.com';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        assert.equal(await evaluate('document.querySelectorAll("[data-compose-quote]").length'), 0);
        assert((await evaluate('document.querySelector("[data-quote-contacts-status]").textContent')).includes('Unsaved'));
        await evaluate('document.querySelector("#building-quote-contacts-form").requestSubmit()');
        await waitFor('document.querySelector("[data-quote-contacts-status]").textContent.includes("contacts saved")');
        assert.equal(await evaluate(`document.querySelector('[data-quote-report="${report.id}"]').checked`), true);
        await evaluate('document.querySelector("[data-prepare-building-quotes]").click()');
        await waitFor('!!document.querySelector("[data-compose-quote]")');
        assert((await evaluate('document.querySelector("[data-quote-requests]").textContent')).includes('revised-building@example.com'));
        await evaluate('document.querySelector("[data-appliance-tab=parts]").click()');
        assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-appliance-panel]:not([hidden])")].map(panel => panel.dataset.appliancePanel)'), ['parts']);
        assert.equal(await evaluate('document.querySelector("#new-appliance-part [name=partNumber]").required'), false);
        await evaluate(`(() => {
          const form = document.querySelector('#new-appliance-part');
          form.elements.name.value = 'Browser manual part';
          form.requestSubmit();
        })()`);
        await waitFor('[...document.querySelectorAll(".edit-appliance-part")].some(form => form.elements.name.value === "Browser manual part")');
        assert((await request('/api/appliance-parts', mm)).parts.some((part) => part.name === 'Browser manual part' && part.part_number === ''));
        await evaluate(`(() => {
          const form = [...document.querySelectorAll('.edit-appliance-part')].find(form => form.elements.name.value === 'Browser manual part');
          form.elements.partNumber.value = 'BM-123';
          form.requestSubmit();
        })()`);
        await waitFor('[...document.querySelectorAll(".edit-appliance-part")].some(form => form.elements.name.value === "Browser manual part" && form.closest("details").querySelector("summary").textContent.includes("BM-123"))');
        assert((await request('/api/appliance-parts', mm)).parts.some((part) => part.name === 'Browser manual part' && part.part_number === 'BM-123'));
        await evaluate('document.querySelector("[data-appliance-tab=parts]").focus(); document.querySelector("[data-appliance-tab=parts]").dispatchEvent(new KeyboardEvent("keydown", {key:"End",bubbles:true}))');
        assert.equal(await evaluate('document.querySelector("[data-appliance-tab=attendance]").getAttribute("aria-selected")'), 'true');
        assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-appliance-panel]:not([hidden])")].map(panel => panel.dataset.appliancePanel)'), ['attendance']);
      }
      if (token === a) {
        await evaluate(`document.querySelector('[data-home-view="users"]').click()`);
        await waitFor('!!document.querySelector("#create-user-form [name=sections]")');
        await assertTabPanels();
        assert.equal(await evaluate('document.querySelector("#users-panel-create").hidden'), true);
        await evaluate('document.querySelector("#users-tab-create").click()');
        await evaluate(`(() => {
          const input = document.querySelector('#create-user-form [name=name]');
          input.value = 'Unsaved name retained';
          document.querySelector('#create-user-tab-access').click();
          document.querySelector('#create-user-form').requestSubmit();
        })()`);
        assert.equal(await evaluate('document.querySelector("#create-user-panel-details").hidden'), false);
        assert.equal(await evaluate('document.querySelector("#create-user-form [name=name]").value'), 'Unsaved name retained');
        await evaluate('document.querySelector("#create-user-tab-details").dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true}))');
        assert.equal(await evaluate('document.activeElement.id'), 'create-user-tab-access');
        assert.equal(await evaluate('document.querySelector("#create-user-panel-details").hidden'), true);
        await evaluate(`(() => {
          const form = document.querySelector('#create-user-form');
          form.elements.role.value = 'maintenance_manager';
          form.elements.role.dispatchEvent(new Event('change', {bubbles:true}));
          form.elements.name.value = 'Browser scoped administrator';
          form.elements.email.value = 'browser-scoped-admin';
          form.elements.password.value = 'test-password';
          for (const input of form.querySelectorAll('[name=propertyIds]')) input.checked = input.value === ${JSON.stringify(propertyId)};
          for (const input of form.querySelectorAll('[name=sections]')) input.checked = ['users','lighting'].includes(input.value);
          form.elements.adminRights.checked = true;
          form.requestSubmit();
        })()`);
        await waitFor('[...document.querySelectorAll(".managed-user-form")].some(form => form.elements.email.value === "browser-scoped-admin")');
        const browserCreated = (await request('/api/users', a)).users.find((user) => user.email === 'browser-scoped-admin');
        assert.deepEqual(browserCreated.sections, ['users', 'lighting']);
        assert.equal(browserCreated.admin_rights, true);
        await evaluate(`(() => {
          const form = [...document.querySelectorAll('.managed-user-form')].find(form => form.elements.email.value === 'browser-scoped-admin');
          form.dataset.editPending = 'true';
          for (const input of form.querySelectorAll('[name=sections]')) input.checked = input.value === 'tickets';
          form.elements.adminRights.checked = false;
          form.requestSubmit();
        })()`);
        await waitFor('[...document.querySelectorAll(".managed-user-form")].some(form => form.elements.email.value === "browser-scoped-admin" && !form.dataset.editPending && !form.querySelector("[name=sections][value=users]").checked)');
        const browserEdited = (await request('/api/users', a)).users.find((user) => user.id === browserCreated.id);
        assert.deepEqual(browserEdited.sections, ['tickets']);
        assert.equal(browserEdited.admin_rights, false);
        await assertTabPanels();
        await cdp('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true);
        await cdp('Emulation.clearDeviceMetricsOverride');

        await evaluate(`document.querySelector('[data-view="billing"]').click()`);
        await waitFor('!!document.querySelector("[data-billing-open]")');
        await evaluate('document.querySelector("[data-billing-open]").click()');
        await waitFor('!!document.querySelector("#billing-entry-form")');
        assert.equal(await evaluate('document.querySelector("#billing-entry-form").closest("[data-section-panel]").hidden'), true);
        await evaluate(`(() => {
          document.querySelector('[data-section-tab=entry]').click();
          document.querySelector('#billing-entry-form [name=amount]').value = '123.45';
          document.querySelector('[data-section-tab=status]').click();
          document.querySelector('[data-section-tab=entry]').click();
        })()`);
        assert.equal(await evaluate('document.querySelector("#billing-entry-form [name=amount]").value'), '123.45');
        await assertTabPanels();

        await evaluate(`document.querySelector('[data-view="lighting"]').click(); document.querySelector('#new-survey').click()`);
        await evaluate(`(() => {
          const form = document.querySelector('#survey-form');
          form.elements.propertyId.value = ${JSON.stringify(propertyId)};
          form.elements.inspectorName.value = 'Layout test inspector';
          form.requestSubmit();
        })()`);
        await waitFor('!!document.querySelector("#new-entry-form")');
        await evaluate(`document.querySelector('#new-entry-form [name=name]').value = 'Layout test room'; document.querySelector('#new-entry-form').requestSubmit()`);
        await waitFor('document.querySelector("#entry-select").textContent.includes("Layout test room")');
        await evaluate(`(() => {
          document.querySelector('[data-section-tab=measure]').click();
          document.querySelector('#manual-lux').value = '400';
          document.querySelector('#reading-note').value = 'Draft reading retained';
          document.querySelector('[data-section-tab=photos]').click();
          document.querySelector('[data-section-tab=measure]').click();
        })()`);
        assert.equal(await evaluate('document.querySelector("#reading-note").value'), 'Draft reading retained');
        await evaluate('document.querySelector("#measurement-form").requestSubmit()');
        await waitFor('document.querySelector(".reading-list").textContent.includes("400")');
        await evaluate('document.querySelector("[data-section-tab=readings]").click()');
        await assertTabPanels();

        await evaluate(`document.querySelector('[data-view="checks"]').click()`);
        await waitFor('!!document.querySelector("[data-action=select-property]")');
        await evaluate('document.querySelector("[data-action=select-property]").click()');
        await waitFor('!!document.querySelector("[data-action=start-property-template]")');
        await assertTabPanels();
        await evaluate('document.querySelector("[data-action=start-property-template]").click()');
        await waitFor('!!document.querySelector("#monthly-template-form")');
        await evaluate(`(() => {
          document.querySelector('[data-section-tab=questions]').click();
          const input = document.querySelector('[data-template-answer]');
          if (input.tagName === 'SELECT') input.selectedIndex = 1;
          else input.value = input.type === 'number' ? '1' : input.type === 'date' ? '2026-11-02' : 'Draft answer retained';
          input.dataset.draftValue = input.value;
          document.querySelector('[data-section-tab=reports]').click();
          document.querySelector('[data-section-tab=questions]').click();
        })()`);
        assert.equal(await evaluate('document.querySelector("[data-template-answer]").value === document.querySelector("[data-template-answer]").dataset.draftValue'), true);
        await assertTabPanels();
        await evaluate(`document.querySelector('[data-view="checks"]').click()`);
        await waitFor('!!document.querySelector("[data-action=select-property]")');
        await evaluate(`document.querySelector('[data-property-id="${propertyId}"][data-action=select-property]').click()`);
        await waitFor('!!document.querySelector("[data-section-tab=saved]")');
        await evaluate(`document.querySelector('[data-section-tab=saved]').click(); document.querySelector('[data-project-id="hidden-permission-check"][data-action=open-check-project]').click()`);
        await waitFor('!!document.querySelector("#checklist-edit-form")');
        await assertTabPanels();
        await evaluate('document.querySelector("#home-button").click()');
        await evaluate(`document.querySelector('[data-home-view="appliances"]').click()`);
        await waitFor('!!document.querySelector("[data-open-absence]")');
        assert.equal(await evaluate('!!document.querySelector("#technician-attendance-form")'), false);
        await evaluate('document.querySelector("[data-open-absence]").click()');
        assert.equal(await evaluate('document.querySelector("[data-absence-editor]").open'), true);
        assert.equal(await evaluate('!!document.querySelector("[data-appliance-tab=attendance]")'), false);
        assert.equal(await evaluate('!!document.querySelector("[data-appliance-tab=locations]")'), true);
      }
      await evaluate('document.querySelector("#signout-button").click()');
      await waitFor('document.querySelector("#app-shell")?.hidden === true');
    }
    await evaluate(`localStorage.setItem('primeops-token', ${JSON.stringify(a)})`);
    await cdp('Page.reload');
    await waitFor('document.querySelector("#app-shell")?.hidden === false');
    await evaluate(`(async () => { window.licenceWorkBefore = await new Promise((resolve, reject) => {
      const request = indexedDB.open('primeops', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('workspace').objectStore('workspace').get('state');
        read.onsuccess = () => { resolve(JSON.stringify(read.result)); db.close(); };
        read.onerror = () => { reject(read.error); db.close(); };
      };
    }); })()`);
    const imminent = new Date(Date.now() + 4000);
    imminent.setUTCFullYear(imminent.getUTCFullYear() - 1);
    const imminentToken = issueToken(licenceKeys.privateKey, licenceStatus.systemId, null, imminent);
    await browserLicenceDb.query('UPDATE system_licence SET token=$1 WHERE id=1', [imminentToken]);
    await evaluate('document.dispatchEvent(new Event("visibilitychange"))');
    await waitFor(`new Promise((resolve, reject) => {
      const request = indexedDB.open('primeops', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('workspace').objectStore('workspace').get('system-licence-v1:http://127.0.0.1:${port}');
        read.onsuccess = () => { resolve(read.result?.token === ${JSON.stringify(imminentToken)}); db.close(); };
        read.onerror = () => { reject(read.error); db.close(); };
      };
    })`);
    await cdp('Network.enable');
    await cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await waitFor('document.querySelector("#licence-screen")?.hidden === false');
    assert.equal(await evaluate('document.querySelector("#app-shell").hidden && document.querySelector("#auth-screen").hidden'), true);
    assert.equal(await evaluate(`new Promise((resolve, reject) => {
      const request = indexedDB.open('primeops', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('workspace').objectStore('workspace').get('state');
        read.onsuccess = () => { resolve(JSON.stringify(read.result) === window.licenceWorkBefore); db.close(); };
      };
    })`), true);
    await cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const browserRenewal = issueToken(licenceKeys.privateKey, licenceStatus.systemId, imminentToken);
    await evaluate(`document.querySelector('#licence-screen [data-open-licence]').click();
      document.querySelector('#licence-form [name=token]').value = ${JSON.stringify(browserRenewal)};
      document.querySelector('#licence-form').requestSubmit();`);
    await waitFor('document.querySelector("#app-shell")?.hidden === false');
    assert.equal((await request('/api/license')).token, browserRenewal);
  }
});
