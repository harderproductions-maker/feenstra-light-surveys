const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

test('backend password resets protect main accounts, isolate clients, revoke sessions and survive restarts', {
  skip: !process.env.TEST_DATABASE_URL, timeout: 90000
}, async (t) => {
  const database = `primeops_passwords_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = `/${database}`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'primeops-passwords-'));
  const secret = crypto.randomBytes(32).toString('hex');
  let child, base, adminBase;
  async function stop() {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  }
  t.after(async () => {
    await stop();
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    await admin.end();
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function start() {
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    child = spawn(process.execPath, ['server/index.cjs'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: url.href, JWT_SECRET: secret, PORT: String(port), ADMIN_PORT: '0',
        ADMIN_HOST: '127.0.0.1', ADMIN_EMAIL: 'admin', ADMIN_PASSWORD: 'bootstrap-password-123',
        REPORTS_ROOT: path.join(directory, 'reports'), COMPANY_REPORTS_ROOT: path.join(directory, 'companies'),
        LICENSE_PUBLIC_KEY_FILE: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    for (let attempt = 0; !output.includes('private administration listening on'); attempt++) {
      if (attempt > 200 || child.exitCode !== null) throw new Error(output);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    base = `http://127.0.0.1:${port}`;
    adminBase = `http://127.0.0.1:${output.match(/private administration listening on 127\.0\.0\.1:(\d+)/)[1]}`;
  }
  const ownerPath = '/api/license/owner';
  async function request(route, { method = 'GET', body, token, company, status = 200 } = {}) {
    const origin = route.startsWith(ownerPath) ? adminBase : base;
    const response = await fetch(`${origin}${company ? `/c/${company}` : ''}${route}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    const result = await response.json();
    assert.equal(response.status, status, `${route}: ${JSON.stringify(result)}`);
    return result;
  }
  const post = (route, body, options = {}) => request(route, { method: 'POST', body, ...options });
  const login = (password, options = {}) => post('/api/auth/login', { email: 'admin', password }, options);
  await start();
  await post(`${ownerPath}/register`, { adminUsername: 'admin', adminPassword: 'bootstrap-password-123',
    ownerUsername: 'owner', ownerPassword: 'owner-password-123' }, { status: 201 });
  const owner = (await post(`${ownerPath}/login`, { username: 'owner', password: 'owner-password-123' })).token;
  const original = (await login('bootstrap-password-123')).token;
  const primary = require('./bootstrap-client.json').code;
  const operators = (code = primary) => request(`${ownerPath}/operators?companyCode=${code}`, { token: owner });
  const main = (await operators()).users.find((user) => user.role === 'admin');
  assert(main);
  const staff = await post(`${ownerPath}/staff`, { displayName: 'Password clerk', username: 'clerk',
    password: 'clerk-password-123' }, { token: owner, status: 201 });
  const clerk = (await post(`${ownerPath}/login`, { username: staff.staff.username, password: 'clerk-password-123' })).token;
  const reset = (user, newPassword, options = {}) => request(`${ownerPath}/operators/${user.id}/password`, {
    method: 'PUT', token: owner,
    body: { companyCode: primary, version: user.version, newPassword, confirmPassword: newPassword },
    ...options
  });
  await reset(main, 'new-main-password-123', { token: original, status: 401 });
  await reset(main, 'new-main-password-123', { token: clerk, status: 403 });
  await reset(main, 'short', { status: 400 });
  await reset(main, '\u00e9'.repeat(37), { status: 400 });
  await reset(main, 'new-main-password-123', { status: 400, body: { companyCode: primary,
    version: main.version, newPassword: 'new-main-password-123', confirmPassword: 'does-not-match' } });
  await reset(main, 'new-main-password-123', { status: 409, body: { companyCode: primary,
    version: 'stale', newPassword: 'new-main-password-123', confirmPassword: 'new-main-password-123' } });
  assert.deepEqual(await reset(main, 'new-main-password-123'), { saved: true });
  await request('/api/auth/me', { token: original, status: 401 });
  await login('bootstrap-password-123', { status: 401 });
  const fresh = (await login('new-main-password-123')).token;
  assert.equal((await request('/api/auth/me', { token: fresh })).user.role, 'admin');
  const updated = (await operators()).users.find((user) => user.id === main.id);
  assert.equal(updated.role, main.role);
  assert.equal(updated.active, main.active);
  assert.deepEqual(updated.propertyIds, main.propertyIds);
  assert.notEqual(updated.version, main.version);
  await reset(main, 'another-main-password-123', { status: 409 });
  const databaseClient = new Client({ connectionString: url.href });
  await databaseClient.connect();
  try {
    const { rows } = await databaseClient.query('SELECT password_hash,password_managed_in_app FROM app_users WHERE id=$1', [main.id]);
    assert.equal(await bcrypt.compare('new-main-password-123', rows[0].password_hash), true);
    assert.equal(rows[0].password_managed_in_app, true);
    const { rows: audit } = await databaseClient.query("SELECT detail FROM public.platform_account_events WHERE action='client_password_reset'");
    assert.deepEqual(audit.map((item) => item.detail), [{ userId: main.id, role: 'admin' }]);
  } finally { await databaseClient.end(); }
  await post(`${ownerPath}/companies`, { code: 'OTHER', name: 'Other Client', adminUsername: 'admin',
    adminPassword: 'other-client-password-123' }, { token: owner, status: 201 });
  await reset(updated, 'foreign-reset-password-123', { status: 404, body: { companyCode: 'OTHER',
    version: updated.version, newPassword: 'foreign-reset-password-123', confirmPassword: 'foreign-reset-password-123' } });
  await login('other-client-password-123', { company: 'OTHER' });
  const property = (await post('/api/properties', { name: 'Password Test Building', city: '' }, { token: fresh, status: 201 })).property;
  const worker = (await post('/api/users', { name: 'Client Worker', email: 'worker', password: 'old-worker-password-123',
    role: 'technician', propertyIds: [property.id] }, { token: fresh, status: 201 })).user;
  const workerToken = (await post('/api/auth/login', { email: 'worker', password: 'old-worker-password-123' })).token;
  const workerOperator = (await operators()).users.find((user) => user.id === worker.id);
  await reset(workerOperator, 'new-worker-password-123', { token: clerk });
  await request('/api/auth/me', { token: workerToken, status: 401 });
  await post('/api/auth/login', { email: 'worker', password: 'old-worker-password-123' }, { status: 401 });
  const workerFresh = (await post('/api/auth/login', { email: 'worker', password: 'new-worker-password-123' })).token;
  assert.equal((await request('/api/auth/me', { token: workerFresh })).user.role, 'technician');

  await stop();
  await start();
  await login('bootstrap-password-123', { status: 401 });
  await login('new-main-password-123');
  await request('/api/auth/me', { token: original, status: 401 });
  await post('/api/auth/login', { email: 'worker', password: 'new-worker-password-123' });
  await login('other-client-password-123', { company: 'OTHER' });
});
