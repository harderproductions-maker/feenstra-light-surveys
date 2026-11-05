const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const crypto = require('node:crypto');
const net = require('node:net');
const { Client } = require('pg');
const ExcelJS = require('exceljs');

test('asset identity, breakdown history, part lifecycle, building scope and Excel permissions through the API',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async (t) => {
    const database = `fg_assets_${crypto.randomBytes(6).toString('hex')}`;
    const root = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await root.connect();
    await root.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.pathname = `/${database}`;
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const fs = require('node:fs/promises');
    const reportsRoot = await fs.mkdtemp(require('node:path').join(require('node:os').tmpdir(), 'fg-assets-'));
    const child = spawn(process.execPath, ['server/index.cjs'], {
      cwd: require('node:path').join(__dirname, '..'),
      env: { ...process.env, ADMIN_PORT: '0', ADMIN_HOST: '127.0.0.1', DATABASE_URL: url.href, PORT: String(port), REPORTS_ROOT: reportsRoot,
        JWT_SECRET: crypto.randomBytes(32).toString('hex'), ADMIN_EMAIL: 'admin', ADMIN_PASSWORD: 'test-password' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(async () => {
      if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
      await root.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      await root.end();
      await fs.rm(reportsRoot, { recursive: true, force: true });
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    for (let attempt = 0; !output.includes('listening on port'); attempt++) {
      if (attempt > 100 || child.exitCode !== null) throw new Error(`Test server failed: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    async function request(path, token, body, expected = 200, headers = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const result = await response.json();
      assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`);
      return result;
    }
    const admin = (await request('/api/auth/login', '', { email: 'admin', password: 'test-password' })).token;
    const { properties } = await request('/api/properties', admin);
    const [building, outside] = properties;
    const tokens = {};
    for (const role of ['maintenance_manager', 'technician', 'user']) {
      await request('/api/users', admin, { email: role, name: role, password: 'test-password', role,
        propertyIds: [building.id], unitNumber: '1' }, 201);
      tokens[role] = (await request('/api/auth/login', '', { email: role, password: 'test-password' })).token;
    }
    const mm = tokens.maintenance_manager, tech = tokens.technician;
    const { part } = await request('/api/appliance-parts', mm, { name: 'Test washer belt', partNumber: 'TW-1', machineType: 'Washer' }, 201);
    const managerParts = (await request('/api/appliance-parts', mm)).parts;
    const techParts = (await request('/api/appliance-parts', tech)).parts;
    assert(managerParts.some((part) => part.benchmark_prices?.length));
    assert(techParts.every((part) => !Object.hasOwn(part, 'benchmark_prices')));
    await request('/api/appliance-assets', tokens.user, undefined, 403);
    await request('/api/appliance-assets/export', tech, undefined, 403);

    function body(status, serialNumber = 'SERIAL-OLD', selections = [], propertyId = building.id) {
      const point = { latitude: -25.75, longitude: 28.19, accuracy: 8, capturedAt: new Date().toISOString(), mocked: false };
      const audit = { started: point, completed: point, durationMs: 0, offlineCompleted: false };
      return { propertyId, applianceType: 'Washer', expectedCount: 1, checkAudit: audit, entries: [{
        machineNumber: '01', serialNumber, modelNumber: 'Model', status, notes: '', parts: selections, checkAudit: audit,
        photo: { source: 'camera', capturedAt: point.capturedAt,
          data: 'data:image/jpeg;base64,' + Buffer.from([255,216,255,192,0,8,8,0,1,0,1,1,255,218,0,2,1,255,217]).toString('base64') }
      }] };
    }
    await request('/api/appliance-reports', admin, body('working', ''), 400);
    const wrongType = body('needs_repair', 'WRONG-TYPE', [{ id: part.id, quantity: 1 }]);
    wrongType.applianceType = 'Dryer';
    await request('/api/appliance-reports', admin, wrongType, 400);
    const first = (await request('/api/appliance-reports', admin, body('needs_repair', 'SERIAL-OLD', [{ id: part.id, quantity: 2 }]), 201)).report;
    const assetId = first.entries[0].assetId;
    assert(assetId);
    assert(!JSON.stringify(first).includes('benchmark_prices'));
    await request('/api/appliance-reports', admin, body('needs_repair'), 201);
    let data = await request('/api/appliance-assets', tech);
    assert(data.reports.every((report) => report.entries.every((entry) => !Object.hasOwn(entry, 'checkAudit'))));
    assert.equal(data.assets.find((asset) => asset.id === assetId).serial_number, 'SERIAL-OLD');
    assert.equal(data.machines.find((machine) => machine.id === assetId).breakdowns, 1);
    const action = { reportId: first.id, assetId, partId: part.id, quantity: 2, action: 'ordered' };
    await request('/api/appliance-assets/parts', tech, action, 403);
    await request('/api/appliance-assets/parts', tech, { ...action, quantity: 1, action: 'replaced' }, 409);
    const operation = { 'X-Operation-ID': crypto.randomUUID() };
    const ordered = await request('/api/appliance-assets/parts', mm, action, 201, operation);
    assert.deepEqual(await request('/api/appliance-assets/parts', mm, action, 201, operation), ordered);
    await request('/api/appliance-assets/parts', mm, { ...action, quantity: 1 }, 409);
    await request('/api/appliance-assets/parts', tech, { ...action, quantity: 1, action: 'replaced' }, 201);
    await request('/api/appliance-assets/parts', tech, { ...action, action: 'replaced' }, 409);
    await request('/api/appliance-reports', admin, body('working'), 201);
    await request('/api/appliance-reports', admin, body('needs_repair'), 201);
    await request('/api/appliance-reports', admin, body('working', 'SERIAL-NEW'), 409);
    const replacement = body('needs_repair', 'SERIAL-NEW');
    replacement.entries[0].replaceAssetId = assetId;
    const newReport = (await request('/api/appliance-reports', admin, replacement, 201)).report;
    assert.notEqual(newReport.entries[0].assetId, assetId);
    await request('/api/appliance-reports', admin, body('working'), 409);
    const duplicate = body('working', 'SERIAL-NEW', [], outside.id);
    await request('/api/appliance-reports', admin, duplicate, 409);
    await request('/api/appliance-reports', admin, body('needs_repair', 'OUTSIDE-SERIAL', [], outside.id), 201);
    data = await request('/api/appliance-assets', mm);
    assert(data.assets.every((asset) => asset.property_id === building.id));
    assert(data.reports.every((report) => report.property_id === building.id));
    assert.equal(data.machines.find((machine) => machine.id === assetId).breakdowns, 2);
    assert.equal(data.machines.find((machine) => machine.id === assetId).active, false);
    assert.equal(data.buildings[0].breakdowns, 3);
    assert.equal(data.buildings[0].parts[0].ordered, 2);
    assert.equal(data.buildings[0].parts[0].replaced, 1);
    await request('/api/appliance-assets/parts', mm, { ...action, assetId: newReport.entries[0].assetId }, 404);
    const outsideData = await request('/api/appliance-assets', admin);
    const outsideReport = outsideData.reports.find((report) => report.property_id === outside.id);
    await request('/api/appliance-assets/parts', mm, { ...action, reportId: outsideReport.id }, 404);
    const file = await request('/api/appliance-assets/export', mm);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(file.base64, 'base64'));
    assert.equal(book.worksheets.length, 2);
    assert.equal(book.worksheets[1].getCell('B2').value, building.name);
    assert(!JSON.stringify(book.worksheets[1].getSheetValues()).includes('OUTSIDE-SERIAL'));
  });
