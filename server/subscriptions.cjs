const crypto = require('node:crypto');

const plans = [
  { id: 'basic', name: 'Basic', users: '5-10 users', limit: 10, monthlyFeeCents: 45000 },
  { id: 'building-managers', name: 'Building Managers', users: '11-20 users', limit: 20, monthlyFeeCents: 85000 },
  { id: 'operations', name: 'Operations', users: 'Unlimited users', limit: null, monthlyFeeCents: 150000 }
];
const schema = `CREATE TABLE IF NOT EXISTS company_subscription (
  id INTEGER PRIMARY KEY CHECK(id=1),
  plan TEXT NOT NULL CHECK(plan IN ('basic','building-managers','operations')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS subscription_requests (
  id UUID PRIMARY KEY,
  plan TEXT NOT NULL CHECK(plan IN ('basic','building-managers','operations')),
  requested_by TEXT NOT NULL REFERENCES app_users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_one_pending ON subscription_requests ((TRUE)) WHERE status='pending';`;
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
function planFor(id) {
  const plan = plans.find((item) => item.id === id);
  if (!plan) throw invalid('Choose Basic, Building Managers or Operations.');
  return plan;
}
async function lock(client) {
  const { rows } = await client.query('SELECT plan FROM company_subscription WHERE id=1 FOR UPDATE');
  if (!rows[0]) throw invalid('Subscription setup is unavailable. Contact the owner.', 503);
  return planFor(rows[0].plan);
}
async function activeUsers(client) {
  return Number((await client.query('SELECT COUNT(*) AS count FROM app_users WHERE active=TRUE')).rows[0].count);
}
async function requireUserCapacity(client) {
  const plan = await lock(client);
  if (plan.limit !== null && await activeUsers(client) >= plan.limit) {
    throw invalid(`${plan.name} allows ${plan.limit} active users, including administrators. Deactivate an account or request a higher plan from Home > Subscribe.`, 409);
  }
}
async function snapshot(pool) {
  const { rows } = await pool.query(`SELECT s.plan,s.updated_at,
    (SELECT COUNT(*)::INTEGER FROM app_users WHERE active=TRUE) AS "activeUsers"
    FROM company_subscription s WHERE id=1`);
  if (!rows[0]) throw invalid('Subscription setup is unavailable. Contact the owner.', 503);
  const { rows: requests } = await pool.query(`SELECT r.id,r.plan,r.status,r.created_at,u.display_name AS requested_by
    FROM subscription_requests r JOIN app_users u ON u.id=r.requested_by ORDER BY r.created_at DESC LIMIT 20`);
  return { ...rows[0], plans, requests };
}
function mount(app, { pool, withTransaction, authenticate, apiError }) {
  const route = (action) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { await action(req, res); }
    catch (error) {
      console.error('Subscription failed:', error.message);
      apiError(res, error.status || 503, error.status ? error.message : 'Subscription service unavailable. Retry.');
    }
  };
  app.get('/api/subscription', authenticate, route(async (_req, res) => {
    const data = await snapshot(pool);
    res.json({ ...data, requests: data.requests.filter((item) => item.status === 'pending')
      .map(({ id, plan, status }) => ({ id, plan, status })) });
  }));
  app.post('/api/subscription/requests', authenticate, route(async (req, res) => {
    if (!['admin', ...require('../www/manager-roles.json')].includes(req.user.role)) throw invalid('A manager or administrator must request the company subscription.', 403);
    const plan = planFor(req.body?.plan);
    const result = await withTransaction(async (client) => {
      const current = await lock(client);
      if (current.id === plan.id) throw invalid('This plan is already active.', 409);
      const { rows } = await client.query("SELECT id,plan FROM subscription_requests WHERE status='pending'");
      if (rows[0]) {
        if (rows[0].plan !== plan.id) throw invalid('A different plan is awaiting owner approval.', 409);
        return { requestId: rows[0].id, status: 'pending' };
      }
      const id = crypto.randomUUID();
      await client.query('INSERT INTO subscription_requests(id,plan,requested_by) VALUES($1,$2,$3)', [id, plan.id, req.user.id]);
      return { requestId: id, status: 'pending' };
    });
    res.json(result);
  }));
}
function mountOwner(app, { pool, withTransaction, authenticateOwner, route, companies }) {
  app.get('/api/license/owner/subscription', authenticateOwner, route(async (_req, res) => res.json(await snapshot(pool))));
  app.put('/api/license/owner/subscription', authenticateOwner, route(async (req, res) => {
    const plan = planFor(req.body?.plan);
    await withTransaction(async (client) => {
      if (companies) await client.query('SELECT code FROM public.companies WHERE code=$1 FOR UPDATE', [companies.current().code]);
      await lock(client);
      const { rows } = await client.query("SELECT id,plan FROM subscription_requests WHERE status='pending'");
      const pending = rows[0];
      if (req.body?.requestId && (pending?.id !== req.body.requestId || pending.plan !== plan.id)) {
        throw invalid('This request changed or was already reviewed. Refresh.', 409);
      }
      const count = await activeUsers(client);
      if (plan.limit !== null && count > plan.limit) {
        throw invalid(`There are ${count} active users. Reduce to ${plan.limit} before choosing ${plan.name}.`, 409);
      }
      await client.query('UPDATE company_subscription SET plan=$1,updated_at=NOW() WHERE id=1', [plan.id]);
      if (companies) await client.query(`UPDATE public.companies SET billing_monthly_fee_cents=$1,
        billing_revision=billing_revision+1 WHERE code=$2`,
      [plan.monthlyFeeCents, companies.current().code]);
      if (pending) await client.query(`UPDATE subscription_requests SET status=$2,reviewed_at=NOW() WHERE id=$1`,
        [pending.id, pending.plan === plan.id ? 'approved' : 'declined']);
    });
    res.json(await snapshot(pool));
  }));
  app.post('/api/license/owner/subscription-decline', authenticateOwner, route(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.body?.requestId || '')) throw invalid('Choose a pending subscription request.');
    await withTransaction(async (client) => {
      await lock(client);
      const { rowCount } = await client.query("UPDATE subscription_requests SET status='declined',reviewed_at=NOW() WHERE id=$1 AND status='pending'", [req.body.requestId]);
      if (!rowCount) throw invalid('Request already reviewed. Refresh.', 409);
    });
    res.json({ success: true });
  }));
}
module.exports = { schema, plans, planFor, requireUserCapacity, mount, mountOwner };
