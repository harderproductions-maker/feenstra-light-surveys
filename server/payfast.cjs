const crypto = require('node:crypto');
const express = require('express');
const { money } = require('./platform-accounts.cjs');
const schema = `
CREATE TABLE IF NOT EXISTS public.platform_checkouts (
  id UUID PRIMARY KEY,
  company_code TEXT NOT NULL REFERENCES public.companies(code),
  invoice_id UUID NOT NULL REFERENCES public.platform_invoices(id),
  amount_cents INTEGER NOT NULL,
  sandbox BOOLEAN NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);`;
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, '+');
function parameterString(entries) { return entries.filter(([key]) => key !== 'signature').map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&'); }
function signature(entries, passphrase) {
  const data = parameterString(entries);
  return crypto.createHash('md5').update(`${data}${passphrase ? `&passphrase=${encode(passphrase)}` : ''}`).digest('hex');
}
function configuration(env = process.env) {
  if (!env.PAYFAST_MERCHANT_ID || !env.PAYFAST_MERCHANT_KEY || !env.PAYFAST_PASSPHRASE || !env.PUBLIC_APP_URL) return null;
  const url = new URL(env.PUBLIC_APP_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('PUBLIC_APP_URL must be the public HTTPS origin without a path.');
  if (!['true', 'false'].includes(env.PAYFAST_SANDBOX)) throw new Error('Set PAYFAST_SANDBOX explicitly to true or false.');
  return { merchantId: env.PAYFAST_MERCHANT_ID, merchantKey: env.PAYFAST_MERCHANT_KEY, passphrase: env.PAYFAST_PASSPHRASE,
    origin: url.origin, sandbox: env.PAYFAST_SANDBOX === 'true',
    base: env.PAYFAST_SANDBOX === 'true' ? 'https://sandbox.payfast.co.za' : 'https://www.payfast.co.za' };
}
function createPayfast({ pool, companies, platformAccounts, fetchRemote = fetch, getConfiguration = configuration }) {
  const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
  function mountNotify(app) {
    app.post('/api/payments/payfast/notify', express.text({ type: 'application/x-www-form-urlencoded', limit: '32kb' }), async (req, res) => {
      try {
        const config = getConfiguration();
        if (!config) throw invalid('Payfast is not configured.', 503);
        if (typeof req.body !== 'string') throw invalid('Invalid Payfast notification.');
        const entries = [...new URLSearchParams(req.body)];
        const body = Object.fromEntries(entries);
        if (entries.length !== Object.keys(body).length
            || entries.some(([key, value]) => !/^[a-z0-9_]+$/.test(key) || value.length > 2000)) throw invalid('Invalid Payfast notification fields.');
        const expected = signature(entries, config.passphrase);
        if (!/^[a-f0-9]{32}$/.test(body.signature || '') || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(body.signature))) throw invalid('Invalid Payfast signature.', 403);
        if (body.merchant_id !== config.merchantId || body.payment_status !== 'COMPLETE' || !/^[0-9a-f-]{36}$/i.test(body.m_payment_id || '')
            || !/^\d{1,40}$/.test(body.pf_payment_id || '')) throw invalid('Invalid Payfast payment details.');
        const amount = money(body.amount_gross);
        const response = await fetchRemote(`${config.base}/eng/query/validate`, { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: parameterString(entries),
          signal: AbortSignal.timeout(10000), redirect: 'error' });
        if (!response.ok || (await response.text()).trim() !== 'VALID') throw invalid('Payfast could not confirm the payment notification.', 503);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { rows: checkouts } = await client.query('SELECT * FROM public.platform_checkouts WHERE id=$1 FOR UPDATE', [body.m_payment_id]);
          const checkout = checkouts[0];
          if (!checkout || checkout.amount_cents !== amount || checkout.sandbox !== config.sandbox) throw invalid('Payment amount or checkout does not match.', 409);
          const { rows: clients } = await client.query('SELECT code,billing_test_account FROM public.companies WHERE code=$1 FOR UPDATE', [checkout.company_code]);
          if (clients[0]?.billing_test_account) throw invalid('TEST / DEMO accounts cannot settle real payments.', 409);
          if (checkout.status === 'paid') {
            if (checkout.provider_id !== body.pf_payment_id) throw invalid('Checkout already settled by a different payment.', 409);
          } else {
            if (checkout.sandbox) {
              await client.query("UPDATE public.platform_checkouts SET status='test_complete',provider_id=$1,paid_at=NOW() WHERE id=$2", [body.pf_payment_id, checkout.id]);
            } else {
              const { rows } = await client.query(`SELECT i.amount_cents,i.voided_at,
                COALESCE((SELECT SUM(p.amount_cents) FROM public.platform_payments p WHERE p.invoice_id=i.id AND p.reversed_at IS NULL),0)::integer AS paid
                FROM public.platform_invoices i WHERE i.id=$1 AND i.company_code=$2`, [checkout.invoice_id, checkout.company_code]);
              const invoice = rows[0], receiptId = crypto.randomUUID();
              // Keep a real extra/late receipt as credit rather than losing money received after an invoice was settled or voided.
              await client.query(`INSERT INTO public.platform_credits(id,company_code,reference,amount_cents,paid_on,created_by)
                VALUES($1,$2,$3,$4,(NOW() AT TIME ZONE 'UTC')::date,'Payfast')`,
                [receiptId, checkout.company_code, `PAYFAST-${body.pf_payment_id}`, amount]);
              const allocated = invoice && !invoice.voided_at ? Math.min(amount, invoice.amount_cents - invoice.paid) : 0;
              if (allocated > 0) await client.query(`INSERT INTO public.platform_payments(id,invoice_id,company_code,reference,amount_cents,paid_on,created_by,credit_id)
                VALUES($1,$2,$3,$4,$5,(NOW() AT TIME ZONE 'UTC')::date,'Payfast',$6)`,
                [crypto.randomUUID(), checkout.invoice_id, checkout.company_code, `PAYFAST-ALLOC-${body.pf_payment_id}`, allocated, receiptId]);
              const allocations = await platformAccounts.allocateCredit(client, checkout.company_code);
              await client.query("UPDATE public.platform_checkouts SET status='paid',provider_id=$1,paid_at=NOW() WHERE id=$2", [body.pf_payment_id, checkout.id]);
              await client.query('UPDATE public.companies SET billing_revision=billing_revision+1 WHERE code=$1', [checkout.company_code]);
              await client.query(`INSERT INTO public.platform_account_events(id,company_code,actor,actor_role,action,detail)
                VALUES($1,$2,'Payfast','payment_provider','card_payment',$3)`,
                [crypto.randomUUID(), checkout.company_code, { checkoutId: checkout.id, invoiceId: checkout.invoice_id, amountCents: amount, providerId: body.pf_payment_id, creditId: receiptId, allocations }]);
            }
          }
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
        res.status(200).send('OK');
      } catch (error) {
        console.error('Payfast notification rejected:', error.message);
        res.status(error.status || 503).json({ error: error.status ? error.message : 'Payment verification unavailable. Payfast should retry.' });
      }
    });
  }
  function mountClient(app, { authenticate }) {
    app.get('/api/platform-account/payment-options', authenticate, (_req, res) => {
      try {
        const config = getConfiguration();
        res.json({ configured: !!config, sandbox: config?.sandbox ?? true, provider: 'Payfast',
          message: config ? config.sandbox ? 'Payfast sandbox only: test payments do not settle real invoices.' : 'Secure card checkout hosted by Payfast.' : 'Card payments are not configured. Contact PrimeOps for payment arrangements.' });
      } catch (error) {
        console.error('Payfast setup failed:', error.message);
        res.status(503).json({ error: 'Card payment configuration needs attention. Contact PrimeOps.' });
      }
    });
    app.post('/api/platform-account/checkout', authenticate, async (req, res) => {
      try {
        if (req.user.role !== 'admin') throw invalid('Only the main client administrator can pay platform invoices.', 403);
        const config = getConfiguration();
        if (!config) throw invalid('Card payments are not configured. Contact PrimeOps.', 503);
        const account = await platformAccounts.statement(companies.current().code);
        if (account.company.testAccount) throw invalid('TEST / DEMO accounts cannot collect real payments.', 409);
        const invoice = account.invoices.find((item) => item.id === req.body?.invoiceId && !item.voidedAt && item.outstandingCents > 0);
        if (!invoice) throw invalid('Choose an unpaid invoice for this client.', 404);
        const id = crypto.randomUUID(), fields = { merchant_id: config.merchantId, merchant_key: config.merchantKey,
          return_url: `${config.origin}/?payment=returned`, cancel_url: `${config.origin}/?payment=cancelled`,
          notify_url: `${config.origin}/api/payments/payfast/notify`, m_payment_id: id,
          amount: (invoice.outstandingCents / 100).toFixed(2), item_name: `PrimeOps ${invoice.reference}`.slice(0, 100), payment_method: 'cc' };
        fields.signature = signature(Object.entries(fields), config.passphrase);
        await pool.query(`INSERT INTO public.platform_checkouts(id,company_code,invoice_id,amount_cents,sandbox) VALUES($1,$2,$3,$4,$5)`,
          [id, companies.current().code, invoice.id, invoice.outstandingCents, config.sandbox]);
        res.status(201).json({ action: `${config.base}/eng/process`, fields, sandbox: config.sandbox });
      } catch (error) {
        console.error('Card checkout failed:', error.message);
        res.status(error.status || 503).json({ error: error.status ? error.message : 'Could not start card checkout. Retry.' });
      }
    });
    app.post('/api/platform-account/simulate-payment', authenticate, async (req, res) => {
      try {
        if (req.user.role !== 'admin') throw invalid('Only the main client administrator can simulate billing.', 403);
        const result = await platformAccounts.simulateTestPayment(companies.current().code, req.user.email, req.body || {});
        res.json(result);
      } catch (error) {
        console.error('Test payment simulation failed:', error.message);
        res.status(error.status || 503).json({ error: error.status ? error.message : 'Could not simulate this test payment. Retry.' });
      }
    });
  }
  return { mountNotify, mountClient };
}
module.exports = { schema, createPayfast, signature, parameterString, configuration };
