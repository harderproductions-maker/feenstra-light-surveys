const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const express = require('express');
const { Client, Pool } = require('pg');
const accountsModule = require('./platform-accounts.cjs');
const documents = require('./invoice-documents.cjs');

test('submission updates balances before slow email, reuses saved setup and recovers pending delivery', {
  skip: !process.env.TEST_DATABASE_URL, timeout: 60000
}, async (t) => {
  const name = `fg_invoice_submit_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.href });
  const disconnected = [];
  pool.on('connect', (client) => disconnected.push(new Promise((resolve) => client.once('end', resolve))));
  let releaseMail, server, sending;
  const mailGate = new Promise((resolve) => { releaseMail = resolve; });
  const sent = [];
  t.after(async () => {
    releaseMail();
    if (sending) await sending;
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await pool.end(); await Promise.all(disconnected);
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  });
  await pool.query(`CREATE TABLE public.companies(code TEXT PRIMARY KEY,name TEXT NOT NULL,active BOOLEAN NOT NULL DEFAULT TRUE);
    INSERT INTO public.companies(code,name) VALUES('TEST','Test Client')`);
  await pool.query(accountsModule.schema);
  await pool.query("UPDATE public.companies SET billing_test_account=FALSE WHERE code='TEST'");
  await pool.query(documents.schema);
  const seller = { legalName: 'Saved Seller', registrationNumber: '', vatNumber: '', address: 'Seller address',
    email: 'seller@example.test', phone: '', terms: 'Pay by the due date.', jurisdiction: 'ZA', vatRegistered: false, vatBasisPoints: 0 };
  const profile = { legalName: 'Saved Client', registrationNumber: '', vatNumber: '', billingAddress: 'Client address',
    contactEmail: 'client@example.test', contactPhone: '', contactName: 'Accounts', vatRegistered: false, paymentTermsDays: 30, internalNotes: '' };
  await pool.query('UPDATE public.platform_invoice_settings SET seller=$1', [seller]);
  await pool.query("UPDATE public.companies SET billing_profile=$1 WHERE code='TEST'", [profile]);
  const service = accountsModule.createPlatformAccounts({ pool, companies: { current: () => ({ code: 'TEST' }) },
    invoiceTransport: { sendMail: async (mail) => {
      sent.push(mail);
      await mailGate;
      return { accepted: ['client@example.test'], rejected: [] };
    } } });
  const app = express(); app.use(express.json());
  const authenticateOwner = (req, _res, next) => { req.platformUser = { role: 'owner', username: 'test-owner' }; next(); };
  const route = (action) => async (req, res) => {
    try { await action(req, res); }
    catch (error) { res.status(error.status || 500).json({ error: error.message }); }
  };
  service.mountOwner(app, { authenticateOwner, route, rateLimit: (_req, _res, next) => next() });
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/license/owner/accounts/invoices`;
  const day = new Date().toISOString().slice(0, 10);
  async function submit(revision, amount) {
    const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyCode: 'TEST', revision, amount, description: 'Monthly service', issuedOn: day, dueOn: day }),
      signal: AbortSignal.timeout(2500) });
    const result = await response.json();
    assert.equal(response.status, 201, JSON.stringify(result));
    return result;
  }
  const first = await submit(0, '125.00');
  assert.equal(first.outstandingCents, 12500);
  assert.equal(first.delivery.status, 'pending');
  assert.equal(first.invoices[0].emailStatus, 'pending');
  assert(first.issuedInvoiceId);
  assert.equal((await service.statement('TEST')).outstandingCents, 12500);
  const second = await submit(first.company.revision, '75.00');
  assert.equal(second.outstandingCents, 20000);
  assert.equal(second.invoices.length, 2);
  assert.deepEqual(second.invoices[0].document.seller, second.invoices[1].document.seller);
  assert.deepEqual(second.invoices[0].document.customer, second.invoices[1].document.customer);
  assert.notEqual(second.invoices[0].reference, second.invoices[1].reference);
  assert.equal((await service.summary()).outstandingCents, 20000);
  releaseMail();
  for (let attempt = 0; attempt < 100; attempt++) {
    const statement = await service.statement('TEST');
    if (statement.invoices.every((invoice) => invoice.emailStatus === 'accepted')) break;
    if (attempt === 99) throw new Error('Pending invoice email did not complete.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(sent.length, 2);
  // Pending rows survive creating a fresh service, as after a restart.
  const third = { ...second.invoices[0], id: crypto.randomUUID(), reference: 'RECOVERY-TEST' };
  await pool.query(`INSERT INTO public.platform_invoices(id,company_code,reference,description,amount_cents,issued_on,due_on,created_by,document,email_status)
    VALUES($1,'TEST',$2,'Restart recovery',100,$3,$3,'test-owner',$4,'pending')`, [third.id, third.reference, day, third.document]);
  const recovered = [];
  const recoveryTransport = { sendMail: async (mail) => { recovered.push(mail); return { accepted: ['client@example.test'], rejected: [] }; } };
  const restarted = accountsModule.createPlatformAccounts({ pool, companies: { current: () => ({ code: 'TEST' }) },
    invoiceTransport: recoveryTransport });
  const otherWorker = accountsModule.createPlatformAccounts({ pool, companies: { current: () => ({ code: 'TEST' }) },
    invoiceTransport: recoveryTransport });
  sending = Promise.all([restarted.sendPendingInvoices(), otherWorker.sendPendingInvoices()]);
  await sending;
  assert.equal(recovered.length, 1);
  assert(recovered[0].subject.includes('RECOVERY-TEST'));
  await restarted.sendPendingInvoices();
  assert.equal(recovered.length, 1, 'Accepted delivery must not be automatically resent');
  assert.equal((await restarted.statement('TEST')).outstandingCents, 20100);
  const failedId = crypto.randomUUID();
  await pool.query(`INSERT INTO public.platform_invoices(id,company_code,reference,description,amount_cents,issued_on,due_on,created_by,document,email_status)
    VALUES($1,'TEST','EMAIL-FAILURE','Email failure test',100,$2,$2,'test-owner',$3,'pending')`, [failedId, day, third.document]);
  let failedAttempts = 0;
  const failingWorker = accountsModule.createPlatformAccounts({ pool, companies: { current: () => ({ code: 'TEST' }) },
    invoiceTransport: { sendMail: async () => { failedAttempts++; throw new Error('Test mail service unavailable'); } } });
  await failingWorker.sendPendingInvoices();
  await failingWorker.sendPendingInvoices();
  assert.equal(failedAttempts, 1);
  const final = await failingWorker.statement('TEST');
  assert.equal(final.outstandingCents, 20200, 'Email failure must not undo the charge');
  assert.equal(final.invoices.find((invoice) => invoice.id === failedId).emailStatus, 'failed');
});
