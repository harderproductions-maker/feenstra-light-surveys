const crypto = require('node:crypto');
const catalog = require('../www/feature-catalog.json');
const schema = `CREATE TABLE IF NOT EXISTS company_features (
  id INTEGER PRIMARY KEY CHECK(id=1),
  enabled TEXT[] NOT NULL DEFAULT '{}',
  setup_complete BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS feature_requests (
  id UUID PRIMARY KEY,
  features TEXT[] NOT NULL,
  initial_setup BOOLEAN NOT NULL,
  fee_cents INTEGER NOT NULL,
  requested_by TEXT NOT NULL REFERENCES app_users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  simulated_payment_status TEXT NOT NULL DEFAULT 'unpaid',
  simulated_paid_cents INTEGER NOT NULL DEFAULT 0,
  simulated_payment_at TIMESTAMPTZ
);
ALTER TABLE feature_requests ADD COLUMN IF NOT EXISTS simulated_payment_status TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE feature_requests ADD COLUMN IF NOT EXISTS simulated_paid_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feature_requests ADD COLUMN IF NOT EXISTS simulated_payment_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS feature_one_pending ON feature_requests ((TRUE)) WHERE status='pending';`;
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
function validateFeatures(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > catalog.length
      || new Set(ids).size !== ids.length || ids.some((id) => !catalog.some((item) => item.id === id))) {
    throw invalid('Select available features without duplicates.');
  }
  return ids;
}
async function state(pool, forUpdate = false) {
  const { rows } = await pool.query(`SELECT enabled,setup_complete AS "setupComplete" FROM company_features WHERE id=1${forUpdate ? ' FOR UPDATE' : ''}`);
  if (!rows[0]) throw invalid('Feature setup is unavailable. Contact the owner.', 503);
  return rows[0];
}
async function snapshot(pool) {
  const current = await state(pool);
  const { rows } = await pool.query(`SELECT id,features,initial_setup AS "initialSetup",fee_cents AS "feeCents",status,
    simulated_payment_status AS "simulatedPaymentStatus",simulated_paid_cents AS "simulatedPaidCents",
    simulated_payment_at AS "simulatedPaymentAt",created_at
    FROM feature_requests ORDER BY created_at DESC LIMIT 20`);
  return { ...current, catalog, extraFeatureFeeCents: 10000, requests: rows };
}
async function submit(client, features, userId) {
  validateFeatures(features);
  const current = await state(client, true);
  if (!current.setupComplete && features.length > 5) throw invalid('Choose 1-5 features for initial setup.');
  if (features.some((id) => current.enabled.includes(id))) throw invalid('Select only features that are not already active.');
  const { rows } = await client.query("SELECT id,features FROM feature_requests WHERE status='pending'");
  if (rows[0]) {
    if (JSON.stringify([...rows[0].features].sort()) !== JSON.stringify([...features].sort())) throw invalid('A different feature request awaits owner approval.', 409);
    return { requestId: rows[0].id, status: 'pending' };
  }
  const id = crypto.randomUUID();
  const feeCents = current.setupComplete ? features.length * 10000 : 0;
  await client.query(`INSERT INTO feature_requests(id,features,initial_setup,fee_cents,requested_by,simulated_payment_status)
    VALUES($1,$2,$3,$4,$5,$6)`, [id, features, !current.setupComplete, feeCents, userId, feeCents ? 'unpaid' : 'not_required']);
  return { requestId: id, status: 'pending', feeCents };
}
function mount(app, { pool, withTransaction, authenticate, apiError }) {
  const route = (action) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { await action(req, res); }
    catch (error) {
      console.error('Company features failed:', error.message);
      apiError(res, error.status || 503, error.status ? error.message : 'Feature service unavailable. Retry.');
    }
  };
  app.get('/api/company-features', authenticate, route(async (_req, res) => res.json(await snapshot(pool))));
  app.post('/api/company-features/remove', authenticate, route(async (req, res) => {
    if (req.user.role !== 'admin') throw invalid('A company administrator must remove features.', 403);
    validateFeatures(req.body?.features);
    await withTransaction(async (client) => {
      const current = await state(client, true);
      if (req.body.features.some((id) => !current.enabled.includes(id))) {
        throw invalid('Feature selections changed. Refresh before removing features.', 409);
      }
      await client.query('UPDATE company_features SET enabled=$1 WHERE id=1',
        [current.enabled.filter((id) => !req.body.features.includes(id))]);
    });
    res.json(await snapshot(pool));
  }));
  app.post('/api/company-features/requests', authenticate, route(async (req, res) => {
    if (req.user.role !== 'admin') throw invalid('A company administrator must choose features.', 403);
    res.json(await withTransaction((client) => submit(client, req.body?.features, req.user.id)));
  }));
  app.post('/api/company-features/simulate-payment', authenticate, route(async (req, res) => {
    if (req.user.role !== 'admin') throw invalid('A company administrator must simulate feature fees.', 403);
    if (!/^[0-9a-f-]{36}$/i.test(req.body?.requestId || '')
        || !['success', 'partial', 'declined'].includes(req.body?.outcome)) throw invalid('Choose a pending feature request and simulated outcome.');
    await withTransaction(async (client) => {
      const { rows } = await client.query("SELECT * FROM feature_requests WHERE id=$1 AND status='pending' FOR UPDATE", [req.body.requestId]);
      const request = rows[0];
      if (!request) throw invalid('Feature request already reviewed. Refresh.', 409);
      if (request.fee_cents < 1) throw invalid('No simulated fee is due for the initial feature setup.', 409);
      const paid = req.body.outcome === 'success' ? request.fee_cents
        : req.body.outcome === 'partial' ? Math.floor(request.fee_cents / 2) : 0;
      if (req.body.outcome === 'partial' && paid < 1) throw invalid('The fee is too small to simulate a partial payment.');
      await client.query(`UPDATE feature_requests SET simulated_payment_status=$1,simulated_paid_cents=$2,
        simulated_payment_at=NOW() WHERE id=$3`, [req.body.outcome === 'success' ? 'paid' : req.body.outcome, paid, request.id]);
    });
    res.json(await snapshot(pool));
  }));
}
function mountOwner(app, { pool, withTransaction, authenticateOwner, route }) {
  app.get('/api/license/owner/features', authenticateOwner, route(async (_req, res) => res.json(await snapshot(pool))));
  app.post('/api/license/owner/features-review', authenticateOwner, route(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.body?.requestId || '') || typeof req.body?.approve !== 'boolean') throw invalid('Choose a pending feature request and approve or decline.');
    await withTransaction(async (client) => {
      const current = await state(client, true);
      const { rows } = await client.query("SELECT * FROM feature_requests WHERE id=$1 AND status='pending' FOR UPDATE", [req.body.requestId]);
      const request = rows[0];
      if (!request) throw invalid('Request already reviewed. Refresh.', 409);
      if (req.body.approve) {
        validateFeatures(request.features);
        if (request.initial_setup !== !current.setupComplete || request.features.some((id) => current.enabled.includes(id))) {
          throw invalid('The company setup changed. Decline this request and select again.', 409);
        }
        await client.query('UPDATE company_features SET enabled=$1,setup_complete=TRUE WHERE id=1', [[...current.enabled, ...request.features]]);
      }
      await client.query('UPDATE feature_requests SET status=$2,reviewed_at=NOW() WHERE id=$1', [request.id, req.body.approve ? 'approved' : 'declined']);
    });
    res.json(await snapshot(pool));
  }));
}
module.exports = { schema, catalog, state, mount, mountOwner };
