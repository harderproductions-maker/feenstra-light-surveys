const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Client, Pool } = require('pg');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { provision } = require('./leasing-test-migration.cjs');
const { date, cents, periods, documentInput, signatureInput, unitAuditInput } = require('./leasing.cjs');
const bootstrap = require('./bootstrap-client.json');

test('leasing validates exact dates, amounts, month boundaries and document signatures', () => {
  for (const value of ['2026-02-30', '01/02/2026', '1999-12-31', undefined]) assert.throws(() => date(value));
  assert.equal(date('2024-02-29'), '2024-02-29');
  for (const value of [-1, 0.1, '100', NaN, 1000000001]) assert.throws(() => cents(value));
  assert.deepEqual(periods('2025-12-20', '2026-02-02'), ['2025-12', '2026-01', '2026-02']);
  assert.throws(() => documentInput({ name: 'lease.pdf', contentType: 'application/pdf', data: Buffer.from('not a pdf').toString('base64') }), /content/);
  assert.throws(() => signatureInput('data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(100)]).toString('base64')), /signature image/);
  assert.deepEqual(unitAuditInput({ floor: '1', unitType: 'Studio', bedrooms: '0', bathrooms: '1', parkingBays: '1', floorArea: '35', status: 'Vacant' }),
    ['1', 'Studio', 0, 1, 1, 35, 'vacant']);
  for (const body of [{ bedrooms: '-1' }, { bathrooms: '1.5' }, { floorArea: '35m2' }, { status: 'unrecognised' }]) assert.throws(() => unitAuditInput(body));
});

test('leasing test workflows preserve live billing, enforce scope, import atomically and export signed lease audit', {
  skip: !process.env.TEST_DATABASE_URL, timeout: 120000
}, async (t) => {
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await admin.connect();
  const name = `primeops_leasing_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = `/${name}`;
  const db = new Pool({ connectionString: url.href });
  const disconnections = [];
  db.on('connect', (client) => disconnections.push(new Promise((resolve) => client.once('end', resolve))));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'primeops-leasing-test-'));
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
  const child = spawn(process.execPath, ['server/index.cjs'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url.href, ADMIN_PORT: '0', ADMIN_HOST: '127.0.0.1', PORT: String(port),
      JWT_SECRET: crypto.randomBytes(32).toString('hex'), ADMIN_EMAIL: 'admin', ADMIN_PASSWORD: 'test-password',
      REPORTS_ROOT: directory, COMPANY_REPORTS_ROOT: path.join(directory, 'companies'), LICENSE_PUBLIC_KEY_FILE: '',
      LEASING_TEST_COMPANIES: `${bootstrap.code},SECOND` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (v) => { output += v; }); child.stderr.on('data', (v) => { output += v; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await db.end(); await Promise.all(disconnections);
    await admin.query(`DROP DATABASE "${name}"`); await admin.end();
    await fs.rm(directory, { recursive: true, force: true });
  });
  for (let i = 0; !output.includes('private administration listening on'); i++) {
    if (i > 300 || child.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const base = `http://127.0.0.1:${port}`;
  const privateBase = `http://127.0.0.1:${output.match(/administration listening on 127\.0\.0\.1:(\d+)/)[1]}`;
  async function request(route, { method = 'GET', body, token, company, status = 200, binary = false } = {}) {
    const origin = route.startsWith('/api/license/owner') ? privateBase : base;
    const response = await fetch(`${origin}${company ? `/c/${company}` : ''}${route}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000)
    });
    const result = binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
    assert.equal(response.status, status, `${method} ${route}: ${binary ? result.subarray(0, 100) : JSON.stringify(result)}\n${output.slice(-2000)}`);
    return result;
  }
  const post = (route, body, options = {}) => request(route, { method: 'POST', body, ...options });
  const put = (route, body, options = {}) => request(route, { method: 'PUT', body, ...options });
  await post('/api/license/owner/register', { adminUsername: 'admin', adminPassword: 'test-password', ownerUsername: 'owner', ownerPassword: 'owner-test-password' }, { status: 201 });
  const owner = (await post('/api/license/owner/login', { username: 'owner', password: 'owner-test-password' })).token;
  const token = (await post('/api/auth/login', { email: 'admin', password: 'test-password' })).token;
  await db.query('CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public');
  await provision(db, bootstrap.code); await provision(db, bootstrap.code);
  const auth = { token };
  const buildings = (await request('/api/properties', auth)).properties;
  const building = buildings[0].id, outside = buildings[1].id;
  const { id: u } = await post('/api/leasing/units', { propertyId: building, number: 'TEST-101' }, { ...auth, status: 201 });
  const { id: u2 } = await post('/api/leasing/units', { propertyId: outside, number: 'TEST-201' }, { ...auth, status: 201 });
  const resident = (await post('/api/users', { email: 'resident', name: 'Resident', password: 'test-password', role: 'user', unitNumber: 'TEST-101', propertyIds: [building] }, { ...auth, status: 201 })).user;
  const residentToken = (await post('/api/auth/login', { email: 'resident', password: 'test-password' })).token;
  await post('/api/users', { email: 'office', name: 'Office', password: 'test-password', role: 'office_admin', propertyIds: [building] }, { ...auth, status: 201 });
  const office = (await post('/api/auth/login', { email: 'office', password: 'test-password' })).token;
  const tenant = await post('/api/leasing/tenants', { propertyId: building, userId: resident.id, code: 'TENANT-1', firstName: 'Test', lastName: 'Resident', status: 'active' }, { ...auth, status: 201 });
  const start = `${new Date().toISOString().slice(0, 7)}-01`, end = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10), today = new Date().toISOString().slice(0, 10);
  const terms = { unitId: u, number: 'LEASE-1', tenantIds: [tenant.id], startsOn: start, endsOn: end, rentCents: 500000, depositCents: 500000 };
  const l = await post('/api/leasing/leases', terms, { ...auth, status: 201 });
  await post('/api/leasing/leases', { ...terms, unitId: u2, number: 'FOREIGN-TENANT' }, { ...auth, status: 400 });
  await post('/api/leasing/leases', { ...terms, propertyId: building, unitId: u2, number: 'MISMATCHED-BUILDING' }, { ...auth, status: 400 });
  await post('/api/leasing/units', { propertyId: outside, number: 'FORBIDDEN' }, { token: office, status: 403 });
  await post('/api/leasing/units', { propertyId: building, number: 'RESIDENT-CANNOT-CREATE' }, { token: residentToken, status: 403 });
  await post(`/api/leasing/leases/${l.id}/charges`, { description: 'Utilities', amountCents: 25000, frequency: 'monthly', startsOn: start, endsOn: end }, { ...auth, status: 201 });
  let detail = await request(`/api/leasing/leases/${l.id}`, auth);
  await post(`/api/leasing/leases/${l.id}/actions`, { action: 'activate', revision: 1 }, { ...auth, status: 409 });
  await post(`/api/leasing/leases/${l.id}/actions`, { action: 'activate', revision: detail.lease.revision }, auth);
  const overlapping = await post('/api/leasing/leases', { ...terms, number: 'OVERLAP' }, { ...auth, status: 201 });
  await post(`/api/leasing/leases/${overlapping.id}/actions`, { action: 'activate', revision: 1 }, { ...auth, status: 409 });
  const before = (await db.query('SELECT count(*) FROM billing_entries')).rows[0].count;
  assert.equal((await post(`/api/leasing/leases/${l.id}/billing`, { through: today }, auth)).inserted, 2);
  assert.equal((await post(`/api/leasing/leases/${l.id}/billing`, { through: today }, auth)).inserted, 0);
  await post(`/api/leasing/leases/${l.id}/ledger`, { kind: 'deposit_receipt', amountCents: 50000, date: today, description: 'TEST receipt' }, { ...auth, status: 201 });
  await post(`/api/leasing/leases/${l.id}/ledger`, { kind: 'deposit_refund', amountCents: 50001, date: today, description: 'Too much' }, { ...auth, status: 400 });
  assert.equal((await db.query('SELECT count(*) FROM billing_entries')).rows[0].count, before);
  const snapshot = await request('/api/leasing', auth);
  assert.equal(snapshot.units.find((row) => row.id === u).occupancy_state, 'occupied');
  assert.equal(snapshot.balances.find((row) => row.leaseId === l.id).balanceCents, 525000);
  assert.equal((await request('/api/leasing', { token: office })).units.some((row) => row.id === u2), false);
  assert.equal((await request('/api/leasing', { token: residentToken })).tenants.length, 1);
  detail = await request(`/api/leasing/leases/${l.id}`, auth);
  await post(`/api/leasing/leases/${l.id}/actions`, { action: 'notice', revision: detail.lease.revision, date: end, reason: 'Moving out' }, auth);
  const work = await post('/api/leasing/schedule', { unitId: u, leaseId: l.id, kind: 'renovation', title: 'Repaint', startsOn: end, endsOn: end }, { ...auth, status: 201 });
  await put(`/api/leasing/schedule/${work.id}`, { revision: 1, startsOn: end, endsOn: end, status: 'in_progress' }, auth);
  const pdf = new PDFDocument(); const chunks = [];
  const pdfReady = new Promise((resolve) => { pdf.on('data', (b) => chunks.push(b)); pdf.on('end', () => resolve(Buffer.concat(chunks))); });
  pdf.text('TEST lease supplied for automated tests only.'); pdf.end();
  const file = (await pdfReady).toString('base64');
  detail = await request(`/api/leasing/leases/${l.id}`, auth);
  await post('/api/leasing/documents', { leaseId: l.id, revision: detail.lease.revision, name: 'test-lease.pdf', contentType: 'application/pdf', data: file }, { ...auth, status: 201 });
  detail = await request(`/api/leasing/leases/${l.id}`, auth);
  await post(`/api/leasing/leases/${l.id}/sign`, { name: 'Test', consent: false }, { token: residentToken, status: 409 });
  if (process.env.CHROMIUM) {
    await t.test('browser leasing navigation, editable registers, import preview and drawn signature work on a phone layout', async (t) => {
      const { cdp, evaluate, waitFor, errors } = await require('./browser-test-helper.cjs').browserSession(t, process.env.CHROMIUM, ['--headless']);
      await cdp('Page.navigate', { url: base });
      await waitFor('!!document.querySelector("#login-form [name=company]")');
      await evaluate(`localStorage.setItem('primeops-token',${JSON.stringify(token)})`);
      await cdp('Page.reload');
      await waitFor('!document.querySelector("#app-shell")?.hidden');
      await evaluate('document.querySelector("[data-view=leasing]").click()');
      await waitFor('!!document.querySelector("[data-lease-selector]")');
      await evaluate(`document.querySelector('[data-lease-selector]').value=${JSON.stringify(l.id)};document.querySelector('[data-lease-selector]').dispatchEvent(new Event('change',{bubbles:true}))`);
      await waitFor('!!document.querySelector("[data-signature]")');
      const image = await evaluate(`(() => {const canvas=document.querySelector('[data-signature]');const ctx=canvas.getContext('2d');ctx.fillStyle='black';ctx.font='40px sans-serif';ctx.fillText('Test signer',20,90);return canvas.toDataURL('image/png');})()`);
      await post(`/api/leasing/leases/${l.id}/sign`, { name: 'Test Resident', consent: true, digest: detail.documentDigest, signature: image }, { token: residentToken, status: 201 });
      await post(`/api/leasing/leases/${l.id}/sign`, { name: 'Office Signer', consent: true, digest: detail.documentDigest, signature: image }, { token: office, status: 201 });
      await post(`/api/leasing/leases/${l.id}/sign`, { name: 'Office Signer', consent: true, digest: 'stale', signature: image }, { token: office, status: 409 });
      await evaluate('document.querySelector("#leasing-tab-import").click()');
      await evaluate(`(() => {const form=document.querySelector('[data-leasing-form=import-read]');form.elements.kind.value='units';form.elements.propertyId.value=${JSON.stringify(building)};
        const transfer=new DataTransfer();transfer.items.add(new File(['UnitNumber,Floor,UnitType,Bedrooms,Bathrooms,ParkingBays,FloorArea,Status\\nIMPORT-BROWSER,1,Studio,0,1,1,35,Vacant'], 'units.csv',{type:'text/csv'}));
        form.elements.document.files=transfer.files;form.requestSubmit();})()`);
      await waitFor('!!document.querySelector("[data-leasing-form=import-map]")');
      await evaluate('document.querySelector("[data-leasing-form=import-map]").requestSubmit()');
      await waitFor('!!document.querySelector("[data-leasing-form=import-save] [data-import-row]")');
      assert.equal(await evaluate('document.querySelector("[data-import-field=number]").value'), 'IMPORT-BROWSER');
      assert.equal(await evaluate('document.querySelector("[data-import-field=building]").value'), buildings[0].name);
      assert.equal(await evaluate('document.querySelector("[data-import-field=unitType]").value'), 'Studio');
      assert.equal(await evaluate('document.querySelector("[data-leasing-form=import-save] thead th").textContent'), 'number');
      assert.equal(await evaluate('[...document.querySelector("[data-leasing-form=import-read]").elements.kind.options].map((o) => o.textContent).includes("Parking audit")'), true);
      await evaluate(`(() => {const form=document.querySelector('[data-leasing-form=import-save]');form.elements.reviewed.checked=true;form.requestSubmit();})()`);
      await waitFor('document.querySelector("[data-leasing-status]")?.textContent.includes("existing records updated")');
      const sourceBook = new ExcelJS.Workbook();
      sourceBook.addWorksheet('Ignore').addRow(['Not this sheet']);
      const sheet = sourceBook.addWorksheet('Units');
      sheet.addRow(['Building', 'Unit number', 'Description']);
      sheet.addRow([buildings[0].name, 'XLSX-PREVIEW', 'Excel imported unit']);
      const spreadsheet = Buffer.from(await sourceBook.xlsx.writeBuffer()).toString('base64');
      const tablePdf = new PDFDocument();
      const tableChunks = [];
      const tableReady = new Promise((resolve) => { tablePdf.on('data', (b) => tableChunks.push(b)); tablePdf.on('end', () => resolve(Buffer.concat(tableChunks).toString('base64'))); });
      tablePdf.fontSize(10).text('Building', 40, 50).text('Unit number', 240, 50).text('Description', 370, 50);
      tablePdf.text(buildings[0].name, 40, 75).text('PDF-PREVIEW', 240, 75).text('PDF imported unit', 370, 75);
      tablePdf.end();
      for (const [filename, encoded, worksheet, expectedNumber] of [
        ['units.xlsx', spreadsheet, 2, 'XLSX-PREVIEW'], ['units.pdf', await tableReady, 1, 'PDF-PREVIEW']
      ]) {
        await evaluate(`document.querySelector("#leasing-tab-import").click()`);
        await evaluate(`(() => {const form=document.querySelector('[data-leasing-form=import-read]');form.elements.kind.value='units';form.elements.propertyId.value=${JSON.stringify(building)};form.elements.sheet.value=${worksheet};
          const bytes=Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0));const transfer=new DataTransfer();
          transfer.items.add(new File([bytes],${JSON.stringify(filename)}));form.elements.document.files=transfer.files;form.requestSubmit();})()`);
        await waitFor('!!document.querySelector("[data-leasing-form=import-map]")');
        await evaluate('document.querySelector("[data-leasing-form=import-map]").requestSubmit()');
        await waitFor('!!document.querySelector("[data-leasing-form=import-save] [data-import-row]")');
        assert.equal(await evaluate('document.querySelector("[data-import-field=number]").value'), expectedNumber);
        await evaluate(`(() => {const form=document.querySelector('[data-leasing-form=import-save]');form.elements.reviewed.checked=true;form.requestSubmit();})()`);
        await waitFor('document.querySelector("[data-leasing-status]")?.textContent.includes("existing records updated")');
      }
      await cdp('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth+1'), true);
      assert.deepEqual(errors, []);
    });
  }
  const pdfExport = await request(`/api/leasing/export/pdf?leaseId=${l.id}`, { ...auth, binary: true });
  assert.equal(pdfExport.subarray(0, 5).toString(), '%PDF-');
  const zip = await request(`/api/leasing/export/zip?leaseId=${l.id}`, { token: residentToken, binary: true });
  assert.equal(zip.subarray(0, 2).toString(), 'PK');
  const xlsx = await request('/api/leasing/export/xlsx', { ...auth, binary: true });
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(xlsx);
  assert(workbook.getWorksheet('TEST ledger').rowCount > 2);
  const batch = { batchId: crypto.randomUUID(), kind: 'units', propertyId: building, sourceName: 'old-system.xlsx', reviewed: true,
    rows: [{ building: buildings[0].name, number: 'IMPORTED', description: 'Original import', floor: '2', unitType: 'Studio', bedrooms: '0', bathrooms: '1', parkingBays: '1', floorArea: '35', status: 'Vacant' }],
    source: { columns: ['Building', 'Number', 'Original unused'], rows: [[buildings[0].name, 'IMPORTED', 'Kept for audit']] } };
  const firstImport = await post('/api/leasing/import', batch, { ...auth, status: 201 });
  assert.deepEqual(await post('/api/leasing/import', batch, { ...auth, status: 201 }), firstImport);
  const auditUnit = (await request('/api/leasing', auth)).units.find((u) => u.id === firstImport.ids[0]);
  assert.equal(auditUnit.property_id, building);
  assert.equal(auditUnit.unit_type, 'Studio');
  assert.equal(auditUnit.floor, '2');
  assert.equal(auditUnit.bedrooms, 0);
  assert.equal(Number(auditUnit.floor_area), 35);
  assert.equal(auditUnit.audit_status, 'vacant');
  await put(`/api/leasing/units/${auditUnit.id}`, { number: auditUnit.unit_number, revision: auditUnit.revision, floor: '3', unitType: 'One bedroom',
    bedrooms: '1', bathrooms: '1', parkingBays: '0', floorArea: '48.50', status: 'Occupied' }, auth);
  const editedAudit = (await request('/api/leasing', auth)).units.find((u) => u.id === auditUnit.id);
  assert.equal(editedAudit.floor, '3');
  assert.equal(editedAudit.audit_status, 'occupied');
  assert.equal(editedAudit.occupancy_state, 'vacant');
  assert.equal(Number(editedAudit.floor_area), 48.5);
  await post('/api/leasing/import', { ...batch, batchId: crypto.randomUUID(), rows: [{ ...batch.rows[0], number: 'INVALID-AUDIT', bedrooms: '-1' }] }, { ...auth, status: 400 });
  assert.equal((await db.query("SELECT 1 FROM app_units WHERE unit_number='INVALID-AUDIT'")).rowCount, 0);
  await post('/api/leasing/import', { ...batch, batchId: crypto.randomUUID(), propertyId: undefined }, { ...auth, status: 400 });
  await post('/api/leasing/import', { ...batch, batchId: crypto.randomUUID(), propertyId: outside }, { ...auth, status: 400 });
  await post('/api/leasing/import', { ...batch, batchId: crypto.randomUUID(), propertyId: outside }, { token: office, status: 403 });
  await post('/api/leasing/import', { ...batch, batchId: crypto.randomUUID(), reviewed: false }, { ...auth, status: 400 });
  await post('/api/leasing/import', { ...batch, batchId: crypto.randomUUID(), rows: [{ building: buildings[0].name, number: 'ATOMIC-ROLLBACK' }, { ...batch.rows[0], bedrooms: 'x' }],
    source: { columns: ['Number'], rows: [['ATOMIC-ROLLBACK'], ['IMPORTED']] } }, { ...auth, status: 400 });
  assert.equal((await db.query("SELECT 1 FROM app_units WHERE unit_number='ATOMIC-ROLLBACK'")).rowCount, 0);
  await post('/api/leasing/import', { ...batch, batchId: crypto.randomUUID(), rows: [batch.rows[0], batch.rows[0]],
    source: { columns: ['Number'], rows: [['IMPORTED'], ['IMPORTED']] } }, { ...auth, status: 400 });
  const reimport = await post('/api/leasing/import', { ...batch, batchId: crypto.randomUUID(), rows: [{ ...batch.rows[0], floor: '4', unitType: '', status: 'Reserved' },
    { building: buildings[0].name, number: 'AUDIT-NEW', floor: '1' }], source: { columns: ['Number'], rows: [['IMPORTED'], ['AUDIT-NEW']] } }, { ...auth, status: 201 });
  assert.equal(reimport.created, 1); assert.equal(reimport.updated, 1); assert.equal(reimport.ids[0], auditUnit.id);
  const reimported = (await request('/api/leasing', auth)).units.find((u) => u.id === auditUnit.id);
  assert.equal(reimported.floor, '4'); assert.equal(reimported.audit_status, 'reserved'); assert.equal(reimported.unit_type, 'One bedroom');
  assert.equal(reimported.revision, editedAudit.revision + 1);
  const parkingBatch = { batchId: crypto.randomUUID(), kind: 'parking', propertyId: building, sourceName: 'parking-audit.xlsx', reviewed: true,
    rows: [{ building: buildings[0].name, bayNumber: 'P01', level: 'B1', bayType: 'Covered', unit: 'IMPORTED', status: '' },
      { building: buildings[0].name, bayNumber: 'P02', level: 'B1', bayType: 'Visitor', unit: '', status: 'Available' }],
    source: { columns: ['BayNumber'], rows: [['P01'], ['P02']] } };
  assert.equal((await post('/api/leasing/import', parkingBatch, { ...auth, status: 201 })).created, 2);
  let parkingSnapshot = await request('/api/leasing', auth);
  const p01 = parkingSnapshot.parking.find((b) => b.bay_number === 'P01');
  assert.equal(p01.unit_number, 'IMPORTED'); assert.equal(p01.status, 'allocated');
  assert.equal(parkingSnapshot.parking.find((b) => b.bay_number === 'P02').status, 'vacant');
  assert.equal(parkingSnapshot.units.find((u) => u.id === auditUnit.id).allocated_parking_bays, 1);
  await post('/api/leasing/import', { ...parkingBatch, batchId: crypto.randomUUID(), rows: [{ ...parkingBatch.rows[1], unit: 'NO-SUCH-UNIT' }],
    source: { columns: ['BayNumber'], rows: [['P02']] } }, { ...auth, status: 400 });
  const parkingUpdate = await post('/api/leasing/import', { ...parkingBatch, batchId: crypto.randomUUID(), rows: [{ ...parkingBatch.rows[1], unit: 'IMPORTED', status: '' }],
    source: { columns: ['BayNumber'], rows: [['P02']] } }, { ...auth, status: 201 });
  assert.equal(parkingUpdate.updated, 1);
  assert.equal((await request('/api/leasing', auth)).units.find((u) => u.id === auditUnit.id).allocated_parking_bays, 2);
  await put(`/api/leasing/parking/${p01.id}`, { remove: true, revision: p01.revision }, auth);
  await post('/api/leasing/parking', { propertyId: building, bayNumber: 'P03', unitId: auditUnit.id, level: 'B2' }, { ...auth, status: 201 });
  await post('/api/leasing/parking', { propertyId: outside, bayNumber: 'P04' }, { token: office, status: 403 });
  parkingSnapshot = await request('/api/leasing', auth);
  assert.equal(parkingSnapshot.parking.some((b) => b.bay_number === 'P01'), false);
  assert.equal(parkingSnapshot.units.find((u) => u.id === auditUnit.id).allocated_parking_bays, 2);
  const importRows = async (kind, rows) => {
    const propertyId = rows[0].building ? (await db.query('SELECT id FROM app_properties WHERE name=$1', [rows[0].building])).rows[0]?.id : undefined;
    return post('/api/leasing/import', { batchId: crypto.randomUUID(), kind, rows, propertyId, reviewed: true, sourceName: 'migration.csv',
      source: { columns: ['Legacy value'], rows: rows.map((row) => [JSON.stringify(row)]) } }, { ...auth, status: 201 });
  };
  await importRows('buildings', [{ name: 'Imported building', city: 'Test city' }]);
  await importRows('units', [{ building: 'Imported building', number: '1' }]);
  await importRows('tenants', [{ building: 'Imported building', code: 'IMPORTED-TENANT', firstName: 'New', lastName: 'Tenant' }]);
  await importRows('leases', [{ building: 'Imported building', unit: '1', number: 'IMPORTED-LEASE', tenantCodes: 'IMPORTED-TENANT', startsOn: start, endsOn: end, rent: '1200.00', deposit: '2400.00' }]);
  await importRows('schedule', [{ building: 'Imported building', unit: '1', leaseNumber: 'IMPORTED-LEASE', kind: 'renovation', title: 'Imported works', startsOn: start, endsOn: end }]);
  await importRows('balances', [{ leaseNumber: 'IMPORTED-LEASE', kind: 'charge', amount: '300.00', date: today, description: 'Opening arrears' }]);
  const importedSnapshot = await request('/api/leasing', auth);
  assert.equal(importedSnapshot.leases.find((row) => row.lease_number === 'IMPORTED-LEASE').state, 'draft');
  assert.equal(importedSnapshot.balances.find((row) => row.leaseNumber === 'IMPORTED-LEASE').balanceCents, 30000);
  const importExport = new ExcelJS.Workbook();
  await importExport.xlsx.load(await request('/api/leasing/export/xlsx', { ...auth, binary: true }));
  assert(importExport.getWorksheet('Import source rows').rowCount > 7);
  const exportedUnits = importExport.getWorksheet('Units (building audit)');
  const exportedHeaders = exportedUnits.getRow(2).values;
  assert.equal(exportedHeaders[1], 'unit_number');
  assert.equal(importExport.getWorksheet('Parking audit').getRow(2).values[1], 'bay_number');
  for (const key of ['property_id', 'floor', 'unit_type', 'bedrooms', 'bathrooms', 'parking_bays', 'floor_area', 'audit_status']) assert(exportedHeaders.includes(key));
  await post('/api/license/owner/companies', { code: 'SECOND', name: 'Second test client', adminUsername: 'admin', adminPassword: 'second-test-password' }, { token: owner, status: 201 });
  await provision(db, 'SECOND');
  const secondSchema = (await db.query("SELECT schema_name FROM companies WHERE code='SECOND'")).rows[0].schema_name;
  await db.query(`UPDATE "${secondSchema}".company_features SET enabled=ARRAY['leasing','billing']`);
  const secondToken = (await post('/api/auth/login', { email: 'admin', password: 'second-test-password' }, { company: 'SECOND' })).token;
  assert.equal((await request('/api/leasing', { token: secondToken, company: 'SECOND' })).leases.length, 0);
  await request(`/api/leasing/leases/${l.id}`, { token: secondToken, company: 'SECOND', status: 404 });
  assert.equal((await db.query('SELECT count(*) FROM billing_entries')).rows[0].count, before);
});
