const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { mount } = require('./company-features.cjs');

async function fixture(t, { enabled = ['lighting', 'tickets'], role = 'admin', pending = false, setupComplete = true } = {}) {
  const data = {
    enabled, setupComplete,
    requests: pending ? [{ id: '00000000-0000-4000-8000-000000000001', features: ['assets'], status: 'pending',
      feeCents: 10000, simulatedPaymentStatus: 'unpaid', simulatedPaidCents: 0 }] : [],
    savedRecords: [{ id: 'saved-survey' }]
  };
  const statements = [];
  const pool = {
    async query(sql, values) {
      statements.push(sql);
      if (sql.startsWith('SELECT enabled')) return { rows: [{ enabled: [...data.enabled], setupComplete: data.setupComplete }] };
      if (sql.includes("FROM feature_requests WHERE status='pending'")) return { rows: data.requests.filter((row) => row.status === 'pending') };
      if (sql.includes("FROM feature_requests WHERE id=$1 AND status='pending' FOR UPDATE")) {
        return { rows: data.requests.filter((row) => row.id === values[0] && row.status === 'pending')
          .map((row) => ({ ...row, fee_cents: row.feeCents })) };
      }
      if (sql.includes('FROM feature_requests ORDER BY')) return { rows: structuredClone(data.requests) };
      if (sql.startsWith('UPDATE company_features SET enabled=$1 WHERE')) {
        data.enabled = [...values[0]];
        return { rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO feature_requests')) {
        data.requests.push({ id: values[0], features: values[1], initialSetup: values[2], feeCents: values[3], status: 'pending',
          simulatedPaymentStatus: values[5], simulatedPaidCents: 0 });
        return { rowCount: 1 };
      }
      if (sql.startsWith('UPDATE feature_requests SET simulated_payment_status=')) {
        const request = data.requests.find((row) => row.id === values[2]);
        Object.assign(request, { simulatedPaymentStatus: values[0], simulatedPaidCents: values[1] });
        return { rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const app = express();
  app.use(express.json());
  mount(app, {
    pool, withTransaction: (action) => action(pool),
    authenticate: (req, res, next) => {
      if (!role) return res.status(401).json({ error: 'Sign in.' });
      req.user = { id: 'admin-id', role }; next();
    },
    apiError: (res, status, error) => res.status(status).json({ error })
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  async function post(path, body) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/company-features/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  }
  return { data, statements, post };
}

test('client admin removes active features immediately without deleting records or pending requests', async (t) => {
  const { data, statements, post } = await fixture(t, { pending: true });
  const result = await post('remove', { features: ['lighting'] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.enabled, ['tickets']);
  assert.deepEqual(data.savedRecords, [{ id: 'saved-survey' }]);
  assert.equal(data.requests[0].status, 'pending');
  assert.equal(data.setupComplete, true);
  assert(statements.some((sql) => sql.endsWith('FOR UPDATE')));
  assert.equal(statements.filter((sql) => /^(UPDATE|INSERT|DELETE)/.test(sql)).length, 1);
});

test('all features can be removed and reactivation still requests approval at the normal fee', async (t) => {
  const { data, post } = await fixture(t);
  assert.equal((await post('remove', { features: ['lighting', 'tickets'] })).status, 200);
  assert.deepEqual(data.enabled, []);
  const request = await post('requests', { features: ['lighting'] });
  assert.equal(request.status, 200);
  assert.equal(request.body.status, 'pending');
  assert.equal(request.body.feeCents, 10000);
  assert.deepEqual(data.enabled, []);
  assert.equal(data.requests[0].initialSetup, false);
});

test('non-admin profiles cannot remove features', async (t) => {
  for (const role of [null, 'user', 'building_manager', 'portfolio_manager', 'operations_manager', 'maintenance_manager', 'maintenance_assistant', 'technician']) {
    const { data, post } = await fixture(t, { role });
    assert.equal((await post('remove', { features: ['lighting'] })).status, role ? 403 : 401);
    assert.deepEqual(data.enabled, ['lighting', 'tickets']);
  }
});

test('invalid or stale feature removals fail without changing enabled features', async (t) => {
  const { data, post } = await fixture(t);
  for (const body of [{}, { features: null }, { features: [] }, { features: 'lighting' }, { features: ['unknown'] }, { features: ['lighting', 'lighting'] }]) {
    assert.equal((await post('remove', body)).status, 400);
    assert.deepEqual(data.enabled, ['lighting', 'tickets']);
  }
  assert.equal((await post('remove', { features: ['lighting', 'assets'] })).status, 409);
  assert.deepEqual(data.enabled, ['lighting', 'tickets']);
});

test('feature fee simulation records success, partial and declined test outcomes without activation', async (t) => {
  for (const [outcome, status, paid] of [['success', 'paid', 10000], ['partial', 'partial', 5000], ['declined', 'declined', 0]]) {
    const { data, post } = await fixture(t, { pending: true });
    const result = await post('simulate-payment', { requestId: data.requests[0].id, outcome });
    assert.equal(result.status, 200);
    assert.equal(result.body.requests[0].simulatedPaymentStatus, status);
    assert.equal(result.body.requests[0].simulatedPaidCents, paid);
    assert.deepEqual(result.body.enabled, ['lighting', 'tickets']);
    assert.equal(data.requests[0].status, 'pending');
  }
});

test('feature fee simulation rejects free setup, stale requests and non-admins', async (t) => {
  const { post } = await fixture(t, { pending: true, role: 'maintenance_manager' });
  assert.equal((await post('simulate-payment', { requestId: '00000000-0000-4000-8000-000000000001', outcome: 'success' })).status, 403);
  const free = await fixture(t, { setupComplete: false });
  const initial = await free.post('requests', { features: ['assets'] });
  assert.equal((await free.post('simulate-payment', { requestId: initial.body.requestId, outcome: 'success' })).status, 409);
  assert.equal((await free.post('simulate-payment', { requestId: '00000000-0000-4000-8000-000000000002', outcome: 'success' })).status, 409);
});
