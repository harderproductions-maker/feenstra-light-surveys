const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { once } = require('node:events');
const { Client, Pool } = require('pg');
const accountsModule = require('./platform-accounts.cjs');
const companiesModule = require('./companies.cjs');
const subscriptions = require('./subscriptions.cjs');
const documents = require('./invoice-documents.cjs');

const seller = { legalName: 'Billing Test Seller', registrationNumber: '', vatNumber: '', address: 'Seller address',
  email: 'seller@example.test', phone: '', terms: 'Pay by the due date.', jurisdiction: 'ZA', vatRegistered: false, vatBasisPoints: 0 };
const profile = { legalName: 'Billing Test Client', registrationNumber: '', vatNumber: '', billingAddress: 'Client address',
  contactEmail: 'client@example.test', contactPhone: '', contactName: 'Accounts', vatRegistered: false, paymentTermsDays: 30, internalNotes: '' };

test('subscription tiers have the exact monthly rand prices', () => {
  assert.deepEqual(subscriptions.plans.map(({ id, monthlyFeeCents }) => [id, monthlyFeeCents]), [
    ['basic', 45000], ['building-managers', 85000], ['operations', 150000]
  ]);
});

test('calendar billing starts on registration without proration and catches up only through the current month', () => {
  const company = { active: true, testAccount: false, monthlyFeeCents: 45000, startsOn: '2026-11-23', endsOn: null };
  assert.deepEqual(accountsModule.recurringPeriods(company, new Date('2027-01-01T00:00:00Z')), [
    { serviceMonth: '2026-11-01', issuedOn: '2026-11-23' },
    { serviceMonth: '2026-12-01', issuedOn: '2026-12-01' },
    { serviceMonth: '2027-01-01', issuedOn: '2027-01-01' }
  ]);
  for (const change of [{ active: false }, { monthlyFeeCents: 0 }, { startsOn: null }]) {
    assert.deepEqual(accountsModule.recurringPeriods({ ...company, ...change }), []);
  }
  assert.deepEqual(accountsModule.recurringPeriods(company, new Date('2026-11-22T23:59:59Z')), []);
  assert.equal(accountsModule.recurringPeriods({ ...company, endsOn: '2026-12-01' }, new Date('2027-02-01Z')).length, 2);
  assert.deepEqual(accountsModule.recurringPeriods({ ...company, startsOn: '2027-12-31' }, new Date('2028-02-29Z')), [
    { serviceMonth: '2027-12-01', issuedOn: '2027-12-31' },
    { serviceMonth: '2028-01-01', issuedOn: '2028-01-01' },
    { serviceMonth: '2028-02-01', issuedOn: '2028-02-01' }
  ]);
});

test('live registration, monthly invoices, retries, tier changes and existing test accounts', {
  skip: !process.env.TEST_DATABASE_URL, timeout: 60000
}, async (t) => {
  const database = `primeops_billing_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.href });
  let server, tenantPool;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    if (tenantPool) await tenantPool.end();
    await pool.end();
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(companiesModule.schema);
  await pool.query("INSERT INTO public.companies(code,name,schema_name) VALUES('EXISTING','Existing test client','company_existing')");
  await pool.query(accountsModule.schema);
  await pool.query(documents.schema);
  await pool.query('UPDATE public.platform_invoice_settings SET seller=$1', [seller]);
  // Reapplying the migration must never turn existing tests into live accounts.
  await pool.query(accountsModule.schema);
  const companies = companiesModule.createCompanies({ controlPool: pool, databaseUrl: url.href, reportsRoot: '/unused' });
  const service = accountsModule.createPlatformAccounts({ pool, companies });
  const otherWorker = accountsModule.createPlatformAccounts({ pool, companies });
  async function create(code, subscriptionPlan, billingProfile = profile) {
    return companies.create({ code, name: code, adminUsername: 'admin', adminPassword: 'test-password-123',
      subscriptionPlan, billingProfile }, async ({ client }) => {
      await client.query('CREATE TABLE app_users(id TEXT PRIMARY KEY,active BOOLEAN NOT NULL DEFAULT TRUE,display_name TEXT)');
      await client.query(subscriptions.schema);
      await client.query('INSERT INTO company_subscription(id,plan) VALUES(1,$1)', [subscriptionPlan]);
    });
  }
  for (const plan of subscriptions.plans) {
    const code = plan.id.toUpperCase();
    await create(code, plan.id);
    const registered = (await pool.query('SELECT billing_test_account,billing_starts_on::text,billing_monthly_fee_cents FROM public.companies WHERE code=$1', [code])).rows[0];
    assert.equal(registered.billing_test_account, false);
    assert.equal(registered.billing_starts_on, new Date().toISOString().slice(0, 10));
    assert.equal(registered.billing_monthly_fee_cents, plan.monthlyFeeCents);
    await pool.query('UPDATE public.companies SET billing_starts_on=$1 WHERE code=$2', ['2026-11-23', code]);
    assert.equal((await service.generateRecurringInvoices(code, new Date('2026-11-23Z'))).issued, 1);
    const first = (await service.statement(code)).invoices[0];
    assert.equal(first.amountCents, plan.monthlyFeeCents);
    assert.equal(first.issuedOn, '2026-11-23');
    assert.equal(first.dueOn, '2026-12-23');
    assert.equal(first.serviceMonth, '2026-11-01');
    assert.equal(first.emailStatus, 'not_configured');
    assert.equal(first.document.totalCents, plan.monthlyFeeCents);
    assert.equal(first.document.customer.email, profile.contactEmail);
    assert.equal(first.document.seller.legalName, seller.legalName);
    const concurrent = await Promise.all([
      service.generateRecurringInvoices(code, new Date('2027-01-01Z')),
      otherWorker.generateRecurringInvoices(code, new Date('2027-01-01Z'))
    ]);
    assert.equal(concurrent.reduce((sum, item) => sum + item.issued, 0), 2);
    assert.equal((await service.statement(code)).invoices.length, 3);
    assert.equal((await service.generateRecurringInvoices(code, new Date('2027-01-31Z'))).issued, 0);
    const pdf = await documents.invoicePdfDownload(first);
    assert(pdf);
  }
  await pool.query(`UPDATE public.companies SET billing_monthly_fee_cents=100,billing_starts_on='2020-01-01'
    WHERE code='EXISTING'`);
  await service.initialiseDemoBilling('EXISTING', 'basic');
  const demoSetup = (await service.statement('EXISTING')).company;
  assert.equal(demoSetup.testAccount, true);
  assert.equal(demoSetup.monthlyFeeCents, 45000);
  assert.equal(demoSetup.startsOn, new Date().toISOString().slice(0, 10));
  await pool.query(`UPDATE public.companies SET billing_starts_on='2020-01-23',billing_ends_on='2020-01-01' WHERE code='EXISTING'`);
  const beforeDemo = await service.summary();
  let demoEmails = 0;
  const demoService = accountsModule.createPlatformAccounts({ pool, companies,
    invoiceTransport: { sendMail: async () => { demoEmails++; return { accepted: ['demo@example.test'] }; } } });
  assert.equal((await demoService.generateRecurringInvoices('EXISTING', new Date('2020-01-23Z'))).issued, 1);
  await demoService.sendPendingInvoices();
  const demo = await service.statement('EXISTING');
  assert.equal(demo.invoices.length, 1);
  assert.equal(demo.invoices[0].amountCents, 45000);
  assert.equal(demo.invoices[0].document.testOnly, true);
  assert.equal(demo.invoices[0].emailStatus, 'test_only');
  assert.match(demo.invoices[0].reference, /^DEMO-PO-/);
  assert.match(await documents.invoiceHtml(demo.invoices[0]), /TEST \/ DEMO invoice - nothing payable/);
  const demoPdf = await documents.invoicePdfDownload(demo.invoices[0]);
  assert.equal(Buffer.from(demoPdf.base64, 'base64').subarray(0, 5).toString(), '%PDF-');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfDocument = await getDocument({ data: new Uint8Array(Buffer.from(demoPdf.base64, 'base64')), useSystemFonts: true }).promise;
  const demoText = (await (await pdfDocument.getPage(1)).getTextContent()).items.map((item) => item.str).join(' ');
  assert.match(demoText, /TEST \/ DEMO/);
  assert.match(demoText, /DO NOT PAY/);
  await pdfDocument.destroy();
  assert.equal(demoEmails, 0);
  assert.equal(demo.blocked, false);
  assert.equal(demo.demoWouldBlock, true);
  assert.equal((await service.access('EXISTING')).blocked, false);
  assert.equal((await service.summary()).outstandingCents, beforeDemo.outstandingCents);
  const demoDocuments = documents.createInvoiceDocuments({ pool, transport: { sendMail: async () => { demoEmails++; } } });
  await assert.rejects(demoDocuments.deliver(demo.invoices[0]), /cannot be emailed/);
  await service.initialiseDemoBilling('EXISTING', 'basic');
  assert.equal((await service.statement('EXISTING')).company.startsOn, '2020-01-23');
  await pool.query(accountsModule.schema);
  assert.equal((await service.statement('BASIC')).company.testAccount, false);

  const basic = await service.statement('BASIC');
  await pool.query('UPDATE public.platform_invoices SET voided_at=NOW() WHERE id=$1', [basic.invoices[0].id]);
  assert.equal((await service.generateRecurringInvoices('BASIC', new Date('2027-01-01Z'))).issued, 0);
  await pool.query(`UPDATE public.companies SET active=FALSE WHERE code='BASIC'`);
  assert.equal((await service.generateRecurringInvoices('BASIC', new Date('2027-02-01Z'))).issued, 0);
  await pool.query(`UPDATE public.companies SET active=TRUE,billing_ends_on='2027-01-01' WHERE code='BASIC'`);
  assert.equal((await service.generateRecurringInvoices('BASIC', new Date('2027-02-01Z'))).issued, 0);

  await create('MISSING-DETAILS', 'basic', undefined);
  await pool.query("UPDATE public.companies SET billing_profile='{}' WHERE code='MISSING-DETAILS'");
  const failed = await service.billCompany('MISSING-DETAILS');
  assert.match(failed.error, /client must supply/);
  assert.equal((await service.statement('MISSING-DETAILS')).invoices.length, 0);
  assert.equal((await service.statement('MISSING-DETAILS')).company.billingError, failed.error);
  await pool.query("UPDATE public.companies SET billing_profile=$1 WHERE code='MISSING-DETAILS'", [profile]);
  await service.runRecurringBilling();
  assert.equal((await service.statement('MISSING-DETAILS')).company.billingError, null);
  assert.equal((await service.statement('MISSING-DETAILS')).invoices.length, 1);

  await create('CREDIT', 'basic');
  await pool.query(`INSERT INTO public.platform_credits(id,company_code,reference,amount_cents,paid_on,created_by)
    VALUES($1,'CREDIT','ADVANCE',90000,CURRENT_DATE,'test')`, [crypto.randomUUID()]);
  await service.billCompany('CREDIT');
  const credited = await service.statement('CREDIT');
  assert.equal(credited.outstandingCents, 0);
  assert.equal(credited.prepaidCents, 45000);
  assert.equal(credited.incomeCents, 90000);

  // Exercise the real plan approval route with a tenant transaction.
  const app = express(); app.use(express.json()); app.use(companies.middleware);
  require('./payfast.cjs').createPayfast({ pool, companies, platformAccounts: service,
    getConfiguration: () => ({ origin: 'https://example.test', merchantId: 'test', merchantKey: 'test',
      passphrase: 'test', sandbox: false, base: 'https://www.payfast.co.za' }) })
    .mountClient(app, { authenticate: (req, _res, next) => { req.user = { role: 'admin' }; next(); } });
  const { rows: tenant } = await pool.query("SELECT schema_name FROM public.companies WHERE code='CREDIT'");
  tenantPool = new Pool({ connectionString: url.href, options: `-csearch_path=${tenant[0].schema_name},pg_catalog` });
  const withTransaction = async (work) => {
    const client = await tenantPool.connect();
    try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  subscriptions.mountOwner(app, { pool: tenantPool, companies, withTransaction,
    authenticateOwner: (_req, _res, next) => next(),
    route: (action) => async (req, res) => {
      try { await action(req, res); }
      catch (error) { res.status(error.status || 500).json({ error: error.message }); }
    } });
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const demoCheckout = await fetch(`http://127.0.0.1:${server.address().port}/c/EXISTING/api/platform-account/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invoiceId: demo.invoices[0].id })
  });
  assert.equal(demoCheckout.status, 409);
  assert.match((await demoCheckout.json()).error, /TEST \/ DEMO/);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/license/owner/subscription`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyCode: 'CREDIT', plan: 'operations' })
  });
  assert.equal(response.status, 200, await response.text());
  const changed = await service.statement('CREDIT');
  assert.equal(changed.company.monthlyFeeCents, 150000);
  assert.equal(changed.invoices[0].amountCents, 45000);
  const future = new Date(); future.setUTCDate(1); future.setUTCMonth(future.getUTCMonth() + 1);
  await service.generateRecurringInvoices('CREDIT', future);
  const upgraded = (await service.statement('CREDIT')).invoices.find((invoice) => invoice.serviceMonth.slice(0, 7) === future.toISOString().slice(0, 7));
  assert.equal(upgraded.amountCents, 150000);
});
