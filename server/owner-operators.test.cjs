const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const { once } = require('node:events');
const { mount } = require('./owner-operators.cjs');

async function fixture(t, { role = 'owner', failure, existingUser } = {}) {
  const { accountBuildingIds, managerRoles } = await import('../www/account-access.mjs');
  const app = express(), created = [], events = [];
  let capacity = 0;
  app.use(express.json());
  mount(app, {
    pool: {
      async query(sql) {
        if (sql.includes('FROM app_users')) {
          assert(sql.includes("u.role <> 'user'"));
          return { rows: existingUser && existingUser.role !== 'user' ? [existingUser] : [] };
        }
        return { rows: [{ id: 'one', name: 'One' }] };
      }
    },
    companies: { current: () => ({ code: 'CLIENT' }) },
    authenticateOwner(req, res, next) {
      if (!['owner', 'supervisor', 'administrator'].includes(role)) return res.status(401).json({ error: 'Platform sign-in required.' });
      req.platformUser = { username: 'platform-user', role }; next();
    },
    rateLimit: (_req, _res, next) => next(),
    route: (action) => async (req, res) => {
      try { await action(req, res); }
      catch (error) { res.status(error.status || 503).json({ error: error.message }); }
    },
    async validateUserInput(req, res, required) {
      assert.equal(required, req.method === 'POST');
      try {
        const input = req.body;
        if (!['user', ...managerRoles, 'maintenance_assistant', 'technician'].includes(input.role)) throw new Error('Invalid role.');
        return { ...input, propertyIds: accountBuildingIds(input.role, input.propertyIds) };
      } catch (error) { res.status(400).json({ error: error.message }); return null; }
    },
    withTransaction: async (action) => {
      const start = created.length;
      try {
        return await action({
          async query(sql, values) {
            if (sql.includes('SELECT')) return { rows: existingUser ? [existingUser] : [] };
            assert(sql.includes('platform_account_events'));
            if (failure === 'audit') throw new Error('Audit unavailable.');
            events.push(values);
            return { rowCount: 1 };
          }
        });
      } catch (error) { created.length = start; throw error; }
    },
    async updateAccount(_client, id, input) {
      created.push({ id, role: input.role });
      return created.at(-1);
    },
    async createAccount(_client, input, hash) {
      capacity++;
      if (failure === 'capacity') throw Object.assign(new Error('User limit reached.'), { status: 409 });
      if (failure === 'duplicate') throw Object.assign(new Error('Duplicate.'), { code: '23505' });
      if (input.propertyIds.includes('foreign')) throw Object.assign(new Error('Building not available.'), { status: 400 });
      assert.notEqual(hash, input.password);
      assert.equal(await bcrypt.compare(input.password, hash), true);
      const user = { id: 'created-user', role: input.role, property_ids: input.propertyIds };
      created.push(user);
      return user;
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const body = { companyCode: 'CLIENT', email: 'new-worker', name: 'New worker', password: 'test-password',
    role: 'building_manager', propertyIds: ['one', 'two'], sections: ['tickets'], adminRights: false };
  async function post(overrides = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/license/owner/operators`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...overrides }),
      signal: AbortSignal.timeout(10000)
    });
    return { status: response.status, body: await response.json() };
  }
  async function request(path = '?companyCode=CLIENT', body) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/license/owner/operators${path}`, {
      method: body ? 'PUT' : 'GET', headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify({ ...body, companyCode: 'CLIENT' }) : undefined
    });
    return { status: response.status, body: await response.json() };
  }
  return { post, request, created, events, capacity: () => capacity };
}

test('Owner and platform staff create assigned client users with hashed passwords and audit history', async (t) => {
  for (const role of ['owner', 'supervisor', 'administrator']) {
    const app = await fixture(t, { role });
    const result = await app.post();
    assert.equal(result.status, 201);
    assert.deepEqual(result.body.user.property_ids, ['one', 'two']);
    assert.equal(result.body.user.role, 'building_manager');
    assert.equal(app.capacity(), 1);
    assert.equal(app.events[0][3], role);
    assert.equal(JSON.stringify(app.events).includes('test-password'), false);
    assert.equal(JSON.stringify(result.body).includes('password'), false);
  }
});

test('creation requires platform authentication, matching client, buildings and valid non-admin roles', async (t) => {
  const anonymous = await fixture(t, { role: null });
  assert.equal((await anonymous.post()).status, 401);
  const app = await fixture(t);
  for (const invalid of [{ companyCode: 'OTHER' }, { propertyIds: [] }, { propertyIds: ['foreign'] }, { role: 'admin' }]) {
    assert.equal((await app.post(invalid)).status, 400);
    assert.equal(app.created.length, 0);
    assert.equal(app.events.length, 0);
  }
});

test('owner can create office administrators without resident details but cannot create residents or omit the staff role', async (t) => {
  const app = await fixture(t);
  for (const role of ['user', undefined, null, '']) {
    const result = await app.post({ role, unitNumber: 'A1', propertyIds: ['one'] });
    assert.equal(result.status, 403);
    assert.match(result.body.error, /client app/);
  }
  assert.equal(app.capacity(), 0);
  assert.equal((await app.post({ role: 'office_admin', sections: ['leasing', 'billing'] })).status, 201);
  assert.equal(app.created[0].role, 'office_admin');
});

test('owner lists exclude residents and resident edits, conversions and password resets are rejected', async (t) => {
  const app = await fixture(t, { existingUser: { id: 'resident', role: 'user' } });
  assert.deepEqual((await app.request()).body.users, []);
  for (const role of ['user', 'office_admin']) {
    const result = await app.request('/resident', { role, active: true, propertyIds: ['one'] });
    assert.equal(result.status, 403);
    assert.match(result.body.error, /client app/);
  }
  const password = await app.request('/resident/password', { newPassword: 'new-test-password', confirmPassword: 'new-test-password' });
  assert.equal(password.status, 403);
  assert.equal(app.created.length, 0);
  assert.equal(app.events.length, 0);
});

test('capacity and duplicate failures are explicit and failed audit rolls creation back', async (t) => {
  for (const failure of ['capacity', 'duplicate', 'audit']) {
    const app = await fixture(t, { failure });
    assert.equal((await app.post()).status, failure === 'audit' ? 503 : 409);
    assert.equal(app.created.length, 0);
    assert.equal(app.events.length, 0);
  }
});
