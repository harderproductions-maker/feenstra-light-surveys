const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');
const bootstrapClient = require('./bootstrap-client.json');
const legacy = require('../www/legacy-identifiers.json');

const schema = `DO $$ BEGIN
  IF to_regclass('public.companies') IS NULL AND to_regclass('public.${legacy.registryTable}') IS NOT NULL THEN
    ALTER TABLE public.${legacy.registryTable} RENAME TO companies;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS companies (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  schema_name TEXT NOT NULL UNIQUE,
  test_renewal_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO companies(code,name,schema_name) VALUES('${bootstrapClient.code}','${bootstrapClient.name}','public') ON CONFLICT DO NOTHING;`;

function createCompanies({ controlPool, databaseUrl, reportsRoot }) {
  const context = new AsyncLocalStorage();
  const pools = new Map();
  const initial = bootstrapClient;
  const current = () => context.getStore() || initial;
  function companyPool(company = current()) {
    if (company.schema_name === 'public') return controlPool;
    if (!/^company_[a-f0-9]{32}$/.test(company.schema_name)) throw new Error('Invalid company database schema.');
    if (!pools.has(company.code)) pools.set(company.code, new Pool({
      connectionString: databaseUrl, options: `-csearch_path=${company.schema_name},pg_catalog`,
      max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000
    }));
    return pools.get(company.code);
  }
  const pool = { query: (...args) => companyPool().query(...args), connect: () => companyPool().connect() };
  async function find(code) {
    if (!/^[A-Z0-9][A-Z0-9-]{1,39}$/.test(code || '')) throw Object.assign(new Error('Enter a valid company code.'), { status: 400 });
    const { rows } = await controlPool.query('SELECT * FROM companies WHERE code=$1', [code]);
    if (!rows[0]) throw Object.assign(new Error('Company not found. Check the company code.'), { status: 404 });
    return rows[0];
  }
  async function resolve(identifier) {
    if (typeof identifier !== 'string' || !identifier.trim() || identifier.trim().length > 120) {
      throw Object.assign(new Error('Enter your client code or company name.'), { status: 400 });
    }
    const entered = identifier.trim();
    const { rows } = await controlPool.query(
      'SELECT code,name FROM companies WHERE UPPER(code)=UPPER($1) OR LOWER(name)=LOWER($1)', [entered]
    );
    const exactCode = rows.find((company) => company.code === entered.toUpperCase());
    if (exactCode) return exactCode;
    if (!rows.length) throw Object.assign(new Error('Client not found. Check your client code or company name.'), { status: 404 });
    if (rows.length > 1) throw Object.assign(new Error('More than one company has that name. Enter your unique client code.'), { status: 409 });
    return rows[0];
  }
  async function middleware(req, res, next) {
    try {
      let code = bootstrapClient.code;
      const match = /^\/c\/([^/]+)(\/.*|$)/.exec(req.url);
      if (match) {
        code = decodeURIComponent(match[1]).toUpperCase();
        req.url = match[2] || '/';
        if (!req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
        if (req.path.startsWith('/api/license/owner')) return res.status(404).json({ error: 'Use PrimeOps Administration at /admin/.' });
      } else if (req.path.startsWith('/api/license/owner') && req.path !== '/api/license/owner/companies'
          && (req.query.companyCode || req.body?.companyCode)) {
        code = String(req.query.companyCode || req.body.companyCode).toUpperCase();
      }
      const company = await find(code);
      req.company = company;
      return context.run(company, next);
    } catch (error) {
      if (!error.status) console.error('Company routing failed:', error.message);
      return res.status(error.status || 503).json({ error: error.status ? error.message : 'Company service unavailable.' });
    }
  }
  async function create({ code, name, adminUsername, adminPassword, subscriptionPlan = 'basic', billingProfile }, initialise) {
    const plan = require('./subscriptions.cjs').planFor(subscriptionPlan);
    if (billingProfile !== undefined) {
      billingProfile = require('./platform-accounts.cjs').debtorProfile(billingProfile);
      require('./invoice-documents.cjs').clientDetails(billingProfile);
    }
    code = String(code || '').trim().toUpperCase();
    name = typeof name === 'string' ? name.trim() : '';
    const email = String(adminUsername || '').trim().toLowerCase();
    if (!/^[A-Z0-9][A-Z0-9-]{1,39}$/.test(code) || !name || name.length > 120 || !email || email.length > 100
        || typeof adminPassword !== 'string' || adminPassword.length < 12 || Buffer.byteLength(adminPassword) > 72) {
      throw Object.assign(new Error('Enter company name/code, admin username and a 12-72 byte password.'), { status: 400 });
    }
    const company = { code, name, schema_name: `company_${crypto.randomUUID().replaceAll('-', '')}` };
    const client = await controlPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(7204101)');
      const { rows } = await client.query('SELECT code FROM companies WHERE code=$1', [code]);
      if (rows[0]) throw Object.assign(new Error('Company code already registered.'), { status: 409 });
      await client.query(`CREATE SCHEMA "${company.schema_name}"`);
      // Initialise inside the transaction so a failed registration exposes no partial company.
      await client.query(`SET LOCAL search_path TO "${company.schema_name}",pg_catalog`);
      await context.run(company, () => initialise({ email, password: adminPassword, catalog: [], client, subscriptionPlan, newCompany: true }));
      await client.query('SET LOCAL search_path TO public,pg_catalog');
      await client.query(`INSERT INTO public.companies(code,name,schema_name,billing_test_account,billing_monthly_fee_cents,billing_starts_on,billing_profile)
        VALUES($1,$2,$3,FALSE,$4,(NOW() AT TIME ZONE 'UTC')::date,$5)`,
      [code, name, company.schema_name, plan.monthlyFeeCents, billingProfile || {}]);
      await client.query('COMMIT');
      return { code, name };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  return { pool, current, middleware, create, context, resolve,
    primaryCode: bootstrapClient.code,
    isPrimary: () => current().schema_name === 'public',
    reportsRoot: () => current().schema_name === 'public' ? reportsRoot
      : path.join(path.resolve(process.env.COMPANY_REPORTS_ROOT || `${reportsRoot}-companies`), current().schema_name),
    list: async () => (await controlPool.query('SELECT code,name,active,test_renewal_enabled,created_at FROM companies ORDER BY name')).rows,
    run: async (code, action) => context.run(await find(code), action),
    testingEnabled: async () => (await controlPool.query('SELECT test_renewal_enabled FROM companies WHERE code=$1', [current().code])).rows[0]?.test_renewal_enabled === true,
    updateTesting: async (enabled) => controlPool.query('UPDATE companies SET test_renewal_enabled=$1 WHERE code=$2', [enabled, current().code])
  };
}
module.exports = { schema, createCompanies };
