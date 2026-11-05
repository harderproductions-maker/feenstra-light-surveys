const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const invoiceDocuments = require('./invoice-documents.cjs');

const schema = `
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS billing_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS billing_override_until TIMESTAMPTZ;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS billing_override_reason TEXT;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS billing_profile JSONB NOT NULL DEFAULT '{}';
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS billing_monthly_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK(billing_monthly_fee_cents BETWEEN 0 AND 999999999);
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS billing_starts_on DATE;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS billing_ends_on DATE;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS billing_test_account BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS billing_error TEXT;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS billing_demo_initialized BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS billing_simulated_blocked BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS public.platform_invoices (
  id UUID PRIMARY KEY,
  company_code TEXT NOT NULL REFERENCES public.companies(code),
  reference TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 999999999),
  issued_on DATE NOT NULL,
  due_on DATE NOT NULL CHECK(due_on >= issued_on),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_at TIMESTAMPTZ,
  UNIQUE(company_code,reference)
);
CREATE TABLE IF NOT EXISTS public.platform_payments (
  id UUID PRIMARY KEY,
  invoice_id UUID NOT NULL REFERENCES public.platform_invoices(id),
  company_code TEXT NOT NULL REFERENCES public.companies(code),
  reference TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 999999999),
  paid_on DATE NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reversed_at TIMESTAMPTZ,
  UNIQUE(company_code,reference)
);
CREATE INDEX IF NOT EXISTS platform_invoices_company ON public.platform_invoices(company_code);
CREATE INDEX IF NOT EXISTS platform_payments_invoice ON public.platform_payments(invoice_id);
ALTER TABLE public.platform_invoices ADD COLUMN IF NOT EXISTS service_month DATE;
CREATE UNIQUE INDEX IF NOT EXISTS platform_invoice_service_month ON public.platform_invoices(company_code,service_month) WHERE voided_at IS NULL AND service_month IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.platform_credits (
  id UUID PRIMARY KEY,
  company_code TEXT NOT NULL REFERENCES public.companies(code),
  reference TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 999999999),
  paid_on DATE NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reversed_at TIMESTAMPTZ,
  UNIQUE(company_code,reference)
);
ALTER TABLE public.platform_payments ADD COLUMN IF NOT EXISTS credit_id UUID REFERENCES public.platform_credits(id);
CREATE INDEX IF NOT EXISTS platform_payments_credit ON public.platform_payments(credit_id);
CREATE TABLE IF NOT EXISTS public.platform_account_events (
  id UUID PRIMARY KEY,
  company_code TEXT NOT NULL REFERENCES public.companies(code),
  actor TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  detail JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.platform_test_payment_simulations (
  id UUID PRIMARY KEY,
  company_code TEXT NOT NULL REFERENCES public.companies(code),
  invoice_id UUID NOT NULL REFERENCES public.platform_invoices(id),
  outcome TEXT NOT NULL CHECK(outcome IN ('success','partial','declined','block')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;

const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const today = () => new Date().toISOString().slice(0, 10);
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw invalid('Enter a valid calendar date.');
  }
  return value;
}
function money(value) {
  if (typeof value !== 'string' || !/^\d{1,7}(?:\.\d{1,2})?$/.test(value)) throw invalid('Enter a positive rand amount with at most two decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents < 1 || cents > 999999999) throw invalid('The amount must be between R0.01 and R9,999,999.99.');
  return cents;
}
function month(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || Number(value.slice(0, 4)) < 1900) throw invalid('Choose a valid billing month.');
  return date(`${value}-01`);
}
function text(value, label, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw invalid(`Enter ${label} (up to ${max} characters).`);
  return value.trim();
}
function supervisor(user) { return ['owner', 'supervisor'].includes(user.role); }
function debtorProfile(body) {
  const result = {};
  for (const [field, max] of Object.entries({ legalName: 160, registrationNumber: 80, vatNumber: 80, billingAddress: 1000,
    contactName: 120, contactEmail: 200, contactPhone: 80, internalNotes: 2000 })) {
    if (typeof body?.[field] !== 'string' || body[field].trim().length > max) throw invalid(`Enter valid debtor ${field} (up to ${max} characters).`);
    result[field] = body[field].trim();
  }
  if (!result.legalName) throw invalid('Enter the debtor company/legal name.');
  if (result.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.contactEmail)) throw invalid('Enter a valid accounts contact email address.');
  if (typeof body.vatRegistered !== 'boolean') throw invalid('Confirm whether the client is VAT registered.');
  if (body.vatRegistered && !/^\d{10}$/.test(result.vatNumber)) throw invalid('Enter the client ten-digit VAT number.');
  result.vatRegistered = body.vatRegistered;
  if (!Number.isInteger(body.paymentTermsDays) || body.paymentTermsDays < 0 || body.paymentTermsDays > 365) throw invalid('Payment terms must be between 0 and 365 days.');
  result.paymentTermsDays = body.paymentTermsDays;
  return result;
}

const invoiceQuery = `SELECT i.id,i.company_code AS "companyCode",i.reference,i.description,
  i.amount_cents AS "amountCents",i.issued_on::text AS "issuedOn",i.due_on::text AS "dueOn",
  i.voided_at AS "voidedAt",i.created_by AS "createdBy",i.service_month::text AS "serviceMonth",i.document,
  i.email_status AS "emailStatus",i.email_error AS "emailError",i.emailed_at AS "emailedAt",
  COALESCE(SUM(p.amount_cents) FILTER (WHERE p.reversed_at IS NULL),0)::integer AS "paidCents",
  CASE WHEN i.voided_at IS NOT NULL THEN 0
    ELSE i.amount_cents-COALESCE(SUM(p.amount_cents) FILTER (WHERE p.reversed_at IS NULL),0)::integer END AS "outstandingCents"
  FROM public.platform_invoices i LEFT JOIN public.platform_payments p ON p.invoice_id=i.id`;
const paymentQuery = `SELECT id,company_code AS "companyCode",invoice_id AS "invoiceId",reference,amount_cents AS "amountCents",
  paid_on::text AS "paidOn",created_by AS "createdBy",reversed_at AS "reversedAt",credit_id AS "creditId" FROM public.platform_payments`;
const creditQuery = `SELECT c.id,c.company_code AS "companyCode",c.reference,c.amount_cents AS "amountCents",c.paid_on::text AS "paidOn",
  c.created_by AS "createdBy",c.reversed_at AS "reversedAt",
  CASE WHEN c.reversed_at IS NOT NULL THEN 0 ELSE c.amount_cents-COALESCE(SUM(p.amount_cents) FILTER(WHERE p.reversed_at IS NULL),0)::integer END AS "availableCents"
  FROM public.platform_credits c LEFT JOIN public.platform_payments p ON p.credit_id=c.id`;
const companyBillingFields = `code,name,active,billing_revision AS revision,billing_override_until AS "overrideUntil",
  billing_override_reason AS "overrideReason",billing_profile AS "debtorProfile",billing_monthly_fee_cents AS "monthlyFeeCents",
  billing_starts_on::text AS "startsOn",billing_ends_on::text AS "endsOn",
  billing_test_account AS "testAccount",billing_error AS "billingError",
  billing_simulated_blocked AS "simulatedBlocked"`;

function recurringPeriods(company, now = new Date()) {
  if (company.active === false || !company.startsOn || company.monthlyFeeCents <= 0) return [];
  const last = now.toISOString().slice(0, 7);
  const periods = [];
  let period = `${company.startsOn.slice(0, 7)}-01`;
  while (period.slice(0, 7) <= last && (!company.endsOn || period <= company.endsOn)) {
    const issuedOn = period < company.startsOn ? company.startsOn : period;
    if (issuedOn <= now.toISOString().slice(0, 10)) periods.push({ serviceMonth: period, issuedOn });
    const next = new Date(`${period}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    period = next.toISOString().slice(0, 10);
  }
  return periods;
}

function forecast(company, invoices, prepaidCents, now = new Date()) {
  const first = now.toISOString().slice(0, 7), day = now.toISOString().slice(0, 10);
  let credit = prepaidCents, coveredThrough = null, coveredMonths = 0, contiguous = true;
  const months = Array.from({ length: 12 }, (_, index) => {
    const period = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + index, 1)).toISOString().slice(0, 7);
    const recurring = invoices.find((invoice) => !invoice.voidedAt && invoice.serviceMonth?.slice(0, 7) === period);
    const eligible = company.active !== false && company.startsOn && period >= company.startsOn.slice(0, 7)
      && (!company.endsOn || period <= company.endsOn.slice(0, 7));
    const expectedFee = eligible ? company.monthlyFeeCents : 0;
    const extras = invoices.filter((invoice) => !invoice.voidedAt && !invoice.serviceMonth && invoice.dueOn.slice(0, 7) === period);
    const expectedCents = (recurring?.amountCents ?? expectedFee) + extras.reduce((sum, invoice) => sum + invoice.amountCents, 0);
    const paidCents = (recurring?.paidCents || 0) + extras.reduce((sum, invoice) => sum + invoice.paidCents, 0);
    const unpaidCents = (recurring ? (recurring.dueOn < day ? 0 : recurring.outstandingCents) : expectedFee)
      + extras.reduce((sum, invoice) => sum + (invoice.dueOn < day ? 0 : invoice.outstandingCents), 0);
    const creditCents = Math.min(credit, unpaidCents);
    credit -= creditCents;
    const collectCents = unpaidCents - creditCents;
    const overdueCents = (recurring && recurring.dueOn < day ? recurring.outstandingCents : 0)
      + extras.reduce((sum, invoice) => sum + (invoice.dueOn < day ? invoice.outstandingCents : 0), 0);
    if (expectedCents > 0) {
      if (contiguous && collectCents === 0 && overdueCents === 0) { coveredThrough = period; coveredMonths++; }
      else contiguous = false;
    }
    return { month: period, expectedCents, paidCents, creditCents, collectCents, overdueCents };
  });
  const futurePaidCents = invoices.filter((invoice) => !invoice.voidedAt && invoice.serviceMonth?.slice(0, 7) > first)
    .reduce((sum, invoice) => sum + invoice.paidCents, 0);
  return { months, coveredThrough, coveredMonths, paidAhead: prepaidCents > 0 || futurePaidCents > 0,
    paidAheadCents: prepaidCents + futurePaidCents,
    projectedCents: months.reduce((sum, item) => sum + item.expectedCents, 0),
    projectedCollectionCents: months.reduce((sum, item) => sum + item.collectCents, 0) };
}
function accountFigures(company, invoices, payments, credits, now) {
  const totals = balances(invoices, company.overrideUntil, now);
  if (company.testAccount) {
    totals.demoWouldBlock = totals.blocked;
    totals.blocked = company.simulatedBlocked === true;
  }
  const receipts = [...payments.filter((payment) => !payment.creditId && !payment.reversedAt), ...credits.filter((credit) => !credit.reversedAt)];
  totals.incomeCents = receipts.reduce((sum, receipt) => sum + receipt.amountCents, 0);
  totals.monthIncomeCents = receipts.filter((receipt) => receipt.paidOn.slice(0, 7) === now.toISOString().slice(0, 7)).reduce((sum, receipt) => sum + receipt.amountCents, 0);
  totals.prepaidCents = credits.reduce((sum, receipt) => sum + receipt.availableCents, 0);
  const overdue = invoices.filter((invoice) => !invoice.voidedAt && invoice.outstandingCents > 0 && invoice.dueOn < now.toISOString().slice(0, 10));
  totals.oldestOverdueOn = overdue.map((invoice) => invoice.dueOn).sort()[0] || null;
  totals.daysOverdue = totals.oldestOverdueOn ? Math.floor((Date.parse(now.toISOString().slice(0, 10)) - Date.parse(totals.oldestOverdueOn)) / 86400000) : 0;
  for (const value of [totals.incomeCents, totals.monthIncomeCents, totals.prepaidCents]) if (!Number.isSafeInteger(value)) throw new Error('Account totals exceed supported precision.');
  return { ...totals, forecast: forecast(company, invoices, totals.prepaidCents, now) };
}

function balances(invoices, overrideUntil, now = new Date()) {
  const result = { invoicedCents: 0, incomeCents: 0, monthIncomeCents: 0, outstandingCents: 0, arrearsCents: 0, blockingCents: 0 };
  const day = now.toISOString().slice(0, 10);
  for (const invoice of invoices) {
    if (invoice.voidedAt) continue;
    result.invoicedCents += invoice.amountCents;
    result.incomeCents += invoice.paidCents;
    result.outstandingCents += invoice.outstandingCents;
    if (invoice.dueOn < day) result.arrearsCents += invoice.outstandingCents;
    // The due date and seven subsequent complete UTC calendar days remain usable.
    if (now.getTime() >= Date.parse(invoice.dueOn) + 8 * 86400000) result.blockingCents += invoice.outstandingCents;
  }
  if (Object.values(result).some((value) => !Number.isSafeInteger(value))) throw new Error('Account totals exceed supported precision.');
  return { ...result, blocked: result.blockingCents > 0 && !(overrideUntil && new Date(overrideUntil) > now) };
}

function createPlatformAccounts({ pool, companies, invoiceTransport }) {
  const documents = invoiceDocuments.createInvoiceDocuments({ pool, transport: invoiceTransport });
  async function initialiseDemoBilling(code, planId) {
    const plan = require('./subscriptions.cjs').planFor(planId);
    await pool.query(`UPDATE public.companies SET billing_monthly_fee_cents=$1,
      billing_starts_on=CASE WHEN billing_demo_initialized THEN billing_starts_on ELSE (NOW() AT TIME ZONE 'UTC')::date END,
      billing_ends_on=CASE WHEN billing_demo_initialized THEN billing_ends_on ELSE NULL END,
      billing_demo_initialized=TRUE,billing_revision=billing_revision+1
      WHERE code=$2 AND billing_test_account=TRUE AND (billing_demo_initialized=FALSE OR billing_monthly_fee_cents<>$1)`,
    [plan.monthlyFeeCents, code]);
  }
  let generatingInvoices = false;
  async function generateRecurringInvoices(code, now = new Date()) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT ${companyBillingFields} FROM public.companies WHERE code=$1 FOR UPDATE`, [code]);
      if (!rows[0]) throw invalid('Client account not found.', 404);
      const company = rows[0], issued = [];
      for (const period of recurringPeriods(company, now)) {
        // A voided service invoice stays corrected; automation must not recreate it.
        const { rows: existing } = await client.query('SELECT id FROM public.platform_invoices WHERE company_code=$1 AND service_month=$2', [code, period.serviceMonth]);
        if (existing.length) continue;
        const terms = company.debtorProfile.paymentTermsDays ?? 30;
        if (!Number.isInteger(terms) || terms < 0 || terms > 365) throw invalid('Correct the client payment terms before automatic billing.', 409);
        const due = new Date(`${period.issuedOn}T00:00:00Z`);
        due.setUTCDate(due.getUTCDate() + terms);
        const prepared = await documents.prepare(client, code, company.monthlyFeeCents, { testOnly: company.testAccount });
        const id = crypto.randomUUID();
        await client.query(`INSERT INTO public.platform_invoices(id,company_code,reference,description,amount_cents,issued_on,due_on,created_by,service_month,document,email_status)
          VALUES($1,$2,$3,$4,$5,$6,$7,'Automatic subscription billing',$8,$9,$10)`,
        [id, code, prepared.reference, `${company.testAccount ? 'TEST / DEMO - ' : ''}PrimeOps monthly subscription`, company.monthlyFeeCents, period.issuedOn,
          due.toISOString().slice(0, 10), period.serviceMonth, prepared.document,
          company.testAccount ? 'test_only' : documents.emailConfigured() ? 'pending' : 'not_configured']);
        issued.push({ invoiceId: id, reference: prepared.reference, amountCents: company.monthlyFeeCents, ...period });
      }
      if (issued.length) {
        const creditAllocations = await allocateCredit(client, code);
        await client.query(`INSERT INTO public.platform_account_events(id,company_code,actor,actor_role,action,detail)
          VALUES($1,$2,'Automatic subscription billing','system','subscription_invoices',$3)`,
        [crypto.randomUUID(), code, { invoices: issued, creditAllocations }]);
      }
      if (issued.length || company.billingError) await client.query(`UPDATE public.companies SET billing_error=NULL,
        billing_revision=billing_revision+1 WHERE code=$1`, [code]);
      await client.query('COMMIT');
      if (issued.length) scheduleInvoiceDelivery();
      return { issued: issued.length, error: null };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async function billCompany(code) {
    try { return await generateRecurringInvoices(code); }
    catch (error) {
      console.error(`Automatic subscription billing failed for ${code}:`, error.message);
      const message = error.status ? error.message : 'Automatic billing failed. Contact the platform owner to retry.';
      await pool.query(`UPDATE public.companies SET billing_error=$1,billing_revision=billing_revision+1
        WHERE code=$2 AND billing_error IS DISTINCT FROM $1`, [message, code]);
      return { issued: 0, error: message };
    }
  }
  async function runRecurringBilling() {
    if (generatingInvoices) return;
    generatingInvoices = true;
    try {
      const { rows } = await pool.query('SELECT code FROM public.companies WHERE active=TRUE');
      for (const company of rows) await billCompany(company.code);
    } finally { generatingInvoices = false; }
  }
  function startRecurringBilling() {
    const run = () => { void runRecurringBilling().catch((error) => console.error('Automatic billing worker failed:', error.message)); };
    run();
    const timer = setInterval(run, 60000);
    timer.unref();
  }
  let sendingPendingInvoices = false;
  let invoiceDeliveryRequested = false;
  async function sendPendingInvoices() {
    if (sendingPendingInvoices) { invoiceDeliveryRequested = true; return; }
    sendingPendingInvoices = true;
    try {
      do {
        invoiceDeliveryRequested = false;
        const { rows } = await pool.query(`${invoiceQuery} WHERE i.voided_at IS NULL
          AND EXISTS (SELECT 1 FROM public.companies c WHERE c.code=i.company_code AND c.billing_test_account=FALSE)
          AND (i.email_status='pending' OR (i.email_status='sending' AND i.email_attempt_at<NOW()-INTERVAL '2 minutes'))
          GROUP BY i.id ORDER BY i.created_at LIMIT 10`);
        for (const invoice of rows) await documents.deliver(invoice, { automatic: true });
      } while (invoiceDeliveryRequested);
    } finally { sendingPendingInvoices = false; }
  }
  function scheduleInvoiceDelivery() {
    setImmediate(() => {
      void sendPendingInvoices().catch((error) => console.error('Pending invoice delivery failed:', error.message));
    });
  }
  function startInvoiceDelivery() {
    scheduleInvoiceDelivery();
    const timer = setInterval(scheduleInvoiceDelivery, 30000);
    timer.unref();
  }
  async function readSnapshot(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async function statement(code, database, includeHistory = true) {
    if (!database) return readSnapshot((client) => statement(code, client, includeHistory));
    const { rows: clients } = await database.query(`SELECT ${companyBillingFields} FROM public.companies WHERE code=$1`, [code]);
    if (!clients[0]) throw invalid('Client account not found.', 404);
    const { rows: invoices } = await database.query(`${invoiceQuery} WHERE i.company_code=$1 GROUP BY i.id ORDER BY i.due_on,i.created_at,i.id`, [code]);
    const { rows: payments } = await database.query(`${paymentQuery} WHERE company_code=$1 ORDER BY paid_on DESC,created_at DESC,id`, [code]);
    const { rows: credits } = await database.query(`${creditQuery} WHERE c.company_code=$1 GROUP BY c.id ORDER BY c.paid_on,c.created_at,c.id`, [code]);
    const now = new Date();
    const totals = accountFigures(clients[0], invoices, payments, credits, now);
    const { rows: settings } = await database.query('SELECT seller FROM public.platform_invoice_settings WHERE id=1');
    const readiness = invoiceDocuments.invoiceReadiness(settings[0]?.seller, clients[0].debtorProfile);
    const events = includeHistory ? (await database.query(`SELECT actor,actor_role AS "actorRole",action,detail,created_at AS "createdAt"
      FROM public.platform_account_events WHERE company_code=$1 ORDER BY created_at DESC,id DESC`, [code])).rows : undefined;
    return { company: clients[0], currency: 'ZAR', graceDays: 7, asOf: now.toISOString(), ...totals, invoiceReadiness: readiness, invoices, payments, credits, ...(includeHistory ? { events } : {}) };
  }
  async function access(code) {
    const { rows } = await pool.query(`SELECT c.billing_override_until > NOW() AS extended,c.billing_test_account AS "testAccount",
      EXISTS (SELECT 1 FROM public.platform_invoices i WHERE i.company_code=c.code AND i.voided_at IS NULL
        AND (i.due_on + 8)::timestamp AT TIME ZONE 'UTC' <= NOW()
        AND i.amount_cents > COALESCE((SELECT SUM(p.amount_cents) FROM public.platform_payments p
          WHERE p.invoice_id=i.id AND p.reversed_at IS NULL),0)) AS overdue,
      c.billing_simulated_blocked AS "simulatedBlocked"
      FROM public.companies c WHERE c.code=$1`, [code]);
    if (!rows[0]) throw invalid('Client account not found.', 404);
    return { blocked: rows[0].testAccount ? rows[0].simulatedBlocked : rows[0].overdue && !rows[0].extended };
  }
  async function simulateTestPayment(code, actor, { simulationId, invoiceId, outcome, amountCents }) {
    if (!/^[0-9a-f-]{36}$/i.test(simulationId || '') || !/^[0-9a-f-]{36}$/i.test(invoiceId || '')
        || !['success', 'partial', 'declined', 'block'].includes(outcome)) {
      throw invalid('Choose a valid test invoice and simulated payment outcome.');
    }
    const client = await pool.connect();
    let simulatedAmount = 0;
    try {
      await client.query('BEGIN');
      const { rows: companiesRows } = await client.query(`SELECT billing_test_account AS "testAccount",billing_simulated_blocked AS "simulatedBlocked"
        FROM public.companies WHERE code=$1 FOR UPDATE`, [code]);
      if (!companiesRows[0]) throw invalid('Client account not found.', 404);
      if (!companiesRows[0].testAccount) throw invalid('Payment simulation is available only for TEST / DEMO accounts.', 403);
      const { rows: previous } = await client.query('SELECT * FROM public.platform_test_payment_simulations WHERE id=$1 FOR UPDATE', [simulationId]);
      if (previous[0]) {
        if (previous[0].company_code !== code || previous[0].invoice_id !== invoiceId
            || previous[0].outcome !== outcome || (outcome === 'partial' && previous[0].amount_cents !== amountCents)) {
          throw invalid('This test payment ID was already used for a different action.', 409);
        }
        await client.query('COMMIT');
        return { outcome, amountCents: previous[0].amount_cents, duplicate: true };
      }
      const { rows: invoices } = await client.query(`SELECT id,amount_cents AS "amountCents",voided_at AS "voidedAt"
        FROM public.platform_invoices WHERE id=$1 AND company_code=$2 FOR UPDATE`, [invoiceId, code]);
      const invoice = invoices[0];
      if (!invoice) throw invalid('Invoice not found for this client.', 404);
      if (invoice.voidedAt) throw invalid('A voided test invoice cannot be used in the simulator.', 409);
      const { rows: paidRows } = await client.query(`SELECT COALESCE(SUM(amount_cents) FILTER(WHERE reversed_at IS NULL),0)::integer AS paid
        FROM public.platform_payments WHERE invoice_id=$1`, [invoiceId]);
      const outstanding = invoice.amountCents - paidRows[0].paid;
      if (outstanding <= 0) throw invalid('This invoice is already paid in full.');
      if (outcome === 'success') simulatedAmount = outstanding;
      if (outcome === 'partial') {
        if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents >= outstanding) throw invalid('A partial test payment must be less than the outstanding amount.');
        simulatedAmount = amountCents;
      }
      if (outcome === 'block') {
        await client.query('UPDATE public.companies SET billing_simulated_blocked=TRUE WHERE code=$1', [code]);
      } else if (outcome === 'success' || outcome === 'partial') {
        await client.query(`INSERT INTO public.platform_payments(id,invoice_id,company_code,reference,amount_cents,paid_on,created_by)
          VALUES($1,$2,$3,$4,$5,$6,'TEST SIMULATION')`,
        [crypto.randomUUID(), invoiceId, code, `SIM-${simulationId}`, simulatedAmount, today()]);
        if (outcome === 'success' && companiesRows[0].simulatedBlocked) {
          await client.query('UPDATE public.companies SET billing_simulated_blocked=FALSE WHERE code=$1', [code]);
        }
      }
      await client.query(`INSERT INTO public.platform_test_payment_simulations(id,company_code,invoice_id,outcome,amount_cents)
        VALUES($1,$2,$3,$4,$5)`, [simulationId, code, invoiceId, outcome, simulatedAmount]);
      await client.query(`INSERT INTO public.platform_account_events(id,company_code,actor,actor_role,action,detail)
        VALUES($1,$2,$3,'client_admin','test_payment_simulation',$4)`,
      [crypto.randomUUID(), code, actor, { simulationId, invoiceId, outcome, amountCents: simulatedAmount }]);
      await client.query('UPDATE public.companies SET billing_revision=billing_revision+1 WHERE code=$1', [code]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') throw invalid('This test payment was already recorded. Refresh the statement.', 409);
      throw error;
    } finally { client.release(); }
    return { outcome, amountCents: simulatedAmount };
  }
  async function summary(database) {
    if (!database) return readSnapshot(summary);
    const { rows: clients } = await database.query(`SELECT ${companyBillingFields} FROM public.companies ORDER BY name`);
    const { rows: invoices } = await database.query(`${invoiceQuery} GROUP BY i.id`);
    const { rows: payments } = await database.query(paymentQuery);
    const { rows: credits } = await database.query(`${creditQuery} GROUP BY c.id`);
    const now = new Date();
    const accounts = clients.map((client) => ({ ...client, ...accountFigures(client,
      invoices.filter((invoice) => invoice.companyCode === client.code), payments.filter((payment) => payment.companyCode === client.code),
      credits.filter((credit) => credit.companyCode === client.code), now) }));
    const totals = {};
    const liveAccounts = accounts.filter((account) => !account.testAccount);
    for (const key of ['invoicedCents', 'incomeCents', 'monthIncomeCents', 'outstandingCents', 'arrearsCents', 'prepaidCents']) {
      totals[key] = liveAccounts.reduce((sum, account) => sum + account[key], 0);
      if (!Number.isSafeInteger(totals[key])) throw new Error('Platform totals exceed supported precision.');
    }
    const months = forecast({ active: false }, [], 0, now).months.map((row, index) => {
      const result = { month: row.month };
      for (const key of ['expectedCents', 'paidCents', 'creditCents', 'collectCents', 'overdueCents']) {
        result[key] = liveAccounts.reduce((sum, account) => sum + account.forecast.months[index][key], 0);
        if (!Number.isSafeInteger(result[key])) throw new Error('Forecast totals exceed supported precision.');
      }
      return result;
    });
    return { currency: 'ZAR', asOf: now.toISOString(), ...totals, forecast: { months,
      projectedCents: months.reduce((sum, row) => sum + row.expectedCents, 0), projectedCollectionCents: months.reduce((sum, row) => sum + row.collectCents, 0) },
      overdueClients: liveAccounts.filter((client) => client.arrearsCents > 0).length,
      prepaidClients: liveAccounts.filter((client) => client.forecast.paidAhead).length,
      blockedClients: liveAccounts.filter((client) => client.blocked).length, accounts };
  }
  async function allocateCredit(client, code) {
    const { rows: credits } = await client.query(`${creditQuery} WHERE c.company_code=$1 AND c.reversed_at IS NULL GROUP BY c.id ORDER BY c.paid_on,c.created_at,c.id`, [code]);
    const { rows: invoices } = await client.query(`${invoiceQuery} WHERE i.company_code=$1 AND i.voided_at IS NULL GROUP BY i.id ORDER BY i.due_on,i.created_at,i.id`, [code]);
    const allocations = [];
    for (const credit of credits) for (const invoice of invoices) {
      const cents = Math.min(credit.availableCents, invoice.outstandingCents);
      if (cents <= 0) continue;
      const id = crypto.randomUUID();
      await client.query(`INSERT INTO public.platform_payments(id,invoice_id,company_code,reference,amount_cents,paid_on,created_by,credit_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, invoice.id, code, `CREDIT:${id}`, cents, today(), credit.createdBy, credit.id]);
      credit.availableCents -= cents; invoice.outstandingCents -= cents;
      allocations.push({ creditId: credit.id, invoiceId: invoice.id, amountCents: cents });
    }
    return allocations;
  }
  async function mutate(req, action, work) {
    const code = req.body?.companyCode;
    if (code !== companies.current().code) throw invalid('Open the client account first.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT billing_revision FROM public.companies WHERE code=$1 FOR UPDATE', [code]);
      if (!rows[0] || !Number.isInteger(req.body?.revision) || rows[0].billing_revision !== req.body.revision) {
        throw invalid('The account changed. Refresh its statement before saving.', 409);
      }
      const detail = await work(client, code);
      const allocations = await allocateCredit(client, code);
      if (allocations.length) detail.creditAllocations = allocations;
      await client.query('UPDATE public.companies SET billing_revision=billing_revision+1 WHERE code=$1', [code]);
      await client.query(`INSERT INTO public.platform_account_events(id,company_code,actor,actor_role,action,detail) VALUES($1,$2,$3,$4,$5,$6)`,
        [crypto.randomUUID(), code, req.platformUser.username, req.platformUser.role, action, detail]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') throw invalid('That reference or monthly service invoice is already recorded for this client.', 409);
      throw error;
    } finally { client.release(); }
    return statement(code);
  }
  function mountOwner(app, { authenticateOwner, route, rateLimit }) {
    documents.mount(app, { authenticateOwner, route });
    const base = '/api/license/owner/accounts';
    const requireSupervisor = (req, res, next) => supervisor(req.platformUser) ? next()
      : res.status(403).json({ error: 'Only the PrimeOps owner or a supervisor can issue/correct invoices or authorise payment agreements.' });
    const confirmPassword = async (req, res, next) => {
      try {
        const password = req.body?.password;
        if (typeof password !== 'string' || Buffer.byteLength(password) > 72 || !await bcrypt.compare(password, req.platformUser.passwordHash)) {
          return res.status(403).json({ error: 'Your platform password is incorrect. The account was not changed.' });
        }
        return next();
      } catch (error) {
        console.error('Account authorisation failed:', error.message);
        return res.status(503).json({ error: 'Could not verify account authorisation. Retry.' });
      }
    };
    app.get(base, authenticateOwner, route(async (req, res) => {
      res.json(req.query.companyCode ? await statement(companies.current().code) : await summary());
    }));
    app.post(`${base}/invoices`, authenticateOwner, requireSupervisor, route(async (req, res) => {
      const { reference, description, amount, issuedOn, dueOn } = req.body || {};
      const serviceMonth = req.body?.serviceMonth ? month(req.body.serviceMonth) : null;
      const ref = reference ? text(reference, 'an invoice reference') : null, detail = text(description, 'an invoice description', 500);
      if (ref && /^PO-\d+$/i.test(ref)) throw invalid('PO-number references are reserved for automatic invoice numbering. Leave the reference blank.');
      const cents = money(amount), issued = date(issuedOn), due = date(dueOn);
      if (issued > today() || due < issued) throw invalid('Invoice date cannot be in the future; due date cannot be before invoice date.');
      let issuedId;
      let emailPending = documents.emailConfigured(), testOnly = false;
      const result = await mutate(req, 'invoice', async (client, code) => {
        const id = crypto.randomUUID();
        const { rows } = await client.query('SELECT billing_test_account FROM public.companies WHERE code=$1', [code]);
        testOnly = rows[0].billing_test_account;
        if (testOnly) emailPending = false;
        const prepared = await documents.prepare(client, code, cents, { testOnly });
        await client.query(`INSERT INTO public.platform_invoices(id,company_code,reference,description,amount_cents,issued_on,due_on,created_by,service_month,document,email_status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, code, ref || prepared.reference, detail, cents, issued, due, req.platformUser.username, serviceMonth, prepared.document,
          testOnly ? 'test_only' : emailPending ? 'pending' : 'not_configured']);
        issuedId = id;
        return { invoiceId: id, reference: ref || prepared.reference, amountCents: cents, issuedOn: issued, dueOn: due, serviceMonth };
      });
      const delivery = testOnly ? { status: 'test_only', message: 'TEST / DEMO invoice recorded. No email or real payment collection.' } : emailPending
        ? { status: 'pending', message: 'Account balance updated. Invoice email is queued separately.' }
        : { status: 'not_configured', message: 'Account balance updated. SMTP is not configured; no email was sent.' };
      res.status(201).json({ ...result, issuedInvoiceId: issuedId, delivery });
      if (emailPending) scheduleInvoiceDelivery();
    }));
    app.get(`${base}/invoice`, authenticateOwner, route(async (req, res) => {
      if (req.query.companyCode !== companies.current().code) throw invalid('Open a client account first.');
      const result = await statement(companies.current().code);
      const invoice = result.invoices.find((item) => item.id === req.query.id);
      if (!invoice) throw invalid('Invoice not found.', 404);
      res.json(req.query.format === 'pdf' ? await invoiceDocuments.invoicePdfDownload(invoice) : { html: await invoiceDocuments.invoiceHtml(invoice) });
    }));
    app.post(`${base}/send`, authenticateOwner, requireSupervisor, route(async (req, res) => {
      if (req.body?.companyCode !== companies.current().code) throw invalid('Open a client account first.');
      const result = await statement(companies.current().code);
      if (result.company.testAccount) throw invalid('TEST / DEMO invoices cannot be emailed. No real charge is payable.', 409);
      const invoice = result.invoices.find((item) => item.id === req.body?.invoiceId);
      if (!invoice) throw invalid('Invoice not found.', 404);
      res.json({ delivery: await documents.deliver(invoice) });
    }));
    app.put(`${base}/plan`, authenticateOwner, requireSupervisor, route(async (req, res) => {
      const fee = req.body?.monthlyFee === '0' || req.body?.monthlyFee === '0.00' ? 0 : money(req.body?.monthlyFee);
      const starts = month(req.body?.startsOn), ends = req.body?.endsOn ? month(req.body.endsOn) : null;
      if (ends && ends < starts) throw invalid('The last billing month cannot be before the first billing month.');
      res.json(await mutate(req, 'forecast_plan', async (client, code) => {
        const { rows } = await client.query('SELECT billing_test_account,billing_monthly_fee_cents FROM public.companies WHERE code=$1', [code]);
        if (rows[0].billing_monthly_fee_cents !== fee) {
          throw invalid('Subscription prices follow the approved tier. Change the subscription plan instead.', 409);
        }
        await client.query('UPDATE public.companies SET billing_monthly_fee_cents=$1,billing_starts_on=$2,billing_ends_on=$3 WHERE code=$4', [fee, starts, ends, code]);
        return { monthlyFeeCents: fee, startsOn: starts, endsOn: ends };
      }));
    }));
    app.post(`${base}/prepayments`, authenticateOwner, route(async (req, res) => {
      const ref = text(req.body?.reference, 'a bank/payment reference'), cents = money(req.body?.amount), paid = date(req.body?.paidOn);
      if (paid > today()) throw invalid('Payment date cannot be in the future.');
      res.status(201).json(await mutate(req, 'prepayment', async (client, code) => {
        if ((await client.query('SELECT id FROM public.platform_payments WHERE company_code=$1 AND reference=$2', [code, ref])).rows.length) {
          throw invalid('That payment reference is already recorded for this client.', 409);
        }
        const id = crypto.randomUUID();
        await client.query(`INSERT INTO public.platform_credits(id,company_code,reference,amount_cents,paid_on,created_by)
          VALUES($1,$2,$3,$4,$5,$6)`, [id, code, ref, cents, paid, req.platformUser.username]);
        return { creditId: id, reference: ref, amountCents: cents, paidOn: paid };
      }));
    }));
    app.put(`${base}/profile`, authenticateOwner, requireSupervisor, route(async (req, res) => {
      const profile = debtorProfile(req.body?.profile);
      res.json(await mutate(req, 'debtor_profile', async (client, code) => {
        await client.query('UPDATE public.companies SET billing_profile=$1 WHERE code=$2', [profile, code]);
        return { fields: Object.keys(profile) };
      }));
    }));
    app.post(`${base}/payments`, authenticateOwner, route(async (req, res) => {
      const { invoiceId, reference, amount, paidOn } = req.body || {};
      const ref = text(reference, 'a bank/payment reference'), cents = money(amount), paid = date(paidOn);
      if (paid > today()) throw invalid('Payment date cannot be in the future.');
      if (!/^[0-9a-f-]{36}$/i.test(invoiceId || '')) throw invalid('Choose an unpaid invoice for this client.');
      res.status(201).json(await mutate(req, 'payment', async (client, code) => {
        if ((await client.query('SELECT id FROM public.platform_credits WHERE company_code=$1 AND reference=$2', [code, ref])).rows.length) {
          throw invalid('That payment reference is already recorded for this client.', 409);
        }
        const { invoices } = await statement(code, client, false);
        const invoice = invoices.find((item) => item.id === invoiceId && !item.voidedAt);
        if (!invoice) throw invalid('Choose an unpaid invoice for this client.', 404);
        if (cents > invoice.outstandingCents) throw invalid('Payment exceeds the unpaid amount on this invoice. Split payments across their invoices.');
        if (paid < invoice.issuedOn) throw invalid('Payment date cannot be before its invoice date.');
        const id = crypto.randomUUID();
        await client.query(`INSERT INTO public.platform_payments(id,invoice_id,company_code,reference,amount_cents,paid_on,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, invoiceId, code, ref, cents, paid, req.platformUser.username]);
        return { paymentId: id, invoiceId, reference: ref, amountCents: cents, paidOn: paid };
      }));
    }));
    app.post(`${base}/extension`, rateLimit, authenticateOwner, requireSupervisor, confirmPassword, route(async (req, res) => {
      const reason = text(req.body?.reason, 'the payment agreement/reason', 500);
      const until = req.body?.until;
      if (until !== null && (typeof until !== 'string' || !Number.isFinite(Date.parse(until))
          || new Date(until).toISOString() !== until || Date.parse(until) <= Date.now())) throw invalid('Choose a future extension expiry, or revoke the extension.');
      res.json(await mutate(req, until === null ? 'extension_revoked' : 'extension', async (client, code) => {
        await client.query('UPDATE public.companies SET billing_override_until=$1,billing_override_reason=$2 WHERE code=$3', [until, reason, code]);
        return { until, reason };
      }));
    }));
    app.post(`${base}/correction`, rateLimit, authenticateOwner, requireSupervisor, confirmPassword, route(async (req, res) => {
      const { kind, id } = req.body || {};
      const reason = text(req.body?.reason, 'a correction reason', 500);
      if (!['invoice', 'payment', 'credit'].includes(kind) || !/^[0-9a-f-]{36}$/i.test(id || '')) throw invalid('Choose an invoice, payment or advance receipt to correct.');
      res.json(await mutate(req, { invoice: 'invoice_voided', payment: 'payment_reversed', credit: 'prepayment_reversed' }[kind], async (client, code) => {
        if (kind === 'invoice') {
          const { rows } = await client.query(`UPDATE public.platform_invoices i SET voided_at=NOW() WHERE i.id=$1 AND i.company_code=$2
            AND i.voided_at IS NULL AND NOT EXISTS(SELECT 1 FROM public.platform_payments p WHERE p.invoice_id=i.id AND p.reversed_at IS NULL)
            RETURNING id`, [id, code]);
          if (!rows[0]) throw invalid('Invoice unavailable, already voided, or has payments. Reverse payments before voiding.', 409);
        } else if (kind === 'credit') {
          const { rows } = await client.query('UPDATE public.platform_credits SET reversed_at=NOW() WHERE id=$1 AND company_code=$2 AND reversed_at IS NULL RETURNING id', [id, code]);
          if (!rows[0]) throw invalid('Advance receipt unavailable or already reversed.', 409);
          await client.query('UPDATE public.platform_payments SET reversed_at=NOW() WHERE credit_id=$1 AND company_code=$2 AND reversed_at IS NULL', [id, code]);
        } else {
          const { rows } = await client.query(`UPDATE public.platform_payments SET reversed_at=NOW() WHERE id=$1 AND company_code=$2 AND reversed_at IS NULL AND credit_id IS NULL RETURNING id`, [id, code]);
          if (!rows[0]) throw invalid('Payment unavailable or already reversed.', 409);
        }
        return { id, kind, reason };
      }));
    }));
  }
  function mountClient(app, { authenticate }) {
    app.get('/api/platform-account/revision', authenticate, async (req, res) => {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only the main client administrator can view the PrimeOps account.' });
      try {
        const { rows } = await pool.query('SELECT billing_revision AS revision FROM public.companies WHERE code=$1', [companies.current().code]);
        if (!rows[0]) throw invalid('Client account not found.', 404);
        res.json(rows[0]);
      } catch (error) {
        console.error('Client account revision failed:', error.message);
        res.status(error.status || 503).json({ error: error.status ? error.message : 'Could not check your account balance. Retry.' });
      }
    });
    app.put('/api/platform-account/profile', authenticate, async (req, res) => {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only the main client administrator can update billing details.' });
      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const code = companies.current().code;
          const { rows } = await client.query('SELECT billing_profile,billing_revision FROM public.companies WHERE code=$1 FOR UPDATE', [code]);
          if (!Number.isInteger(req.body?.revision) || rows[0].billing_revision !== req.body.revision) throw invalid('Your billing account changed. Reload the statement before saving.', 409);
          const previous = rows[0].billing_profile;
          const profile = debtorProfile({ ...req.body?.profile, paymentTermsDays: previous.paymentTermsDays ?? 30, internalNotes: previous.internalNotes || '' });
          invoiceDocuments.clientDetails(profile);
          await client.query('UPDATE public.companies SET billing_profile=$1,billing_revision=billing_revision+1 WHERE code=$2', [profile, code]);
          await client.query(`INSERT INTO public.platform_account_events(id,company_code,actor,actor_role,action,detail) VALUES($1,$2,$3,'client_admin','client_billing_details',$4)`,
            [crypto.randomUUID(), code, req.user.email, { userId: req.user.id, fields: Object.keys(profile).filter((field) => !['internalNotes', 'paymentTermsDays'].includes(field)) }]);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
        res.json({ saved: true });
      } catch (error) {
        console.error('Client billing details failed:', error.message);
        res.status(error.status || 503).json({ error: error.status ? error.message : 'Could not save billing details. Retry.' });
      }
    });
    app.get('/api/platform-account/invoice/:id', authenticate, async (req, res) => {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only the main client administrator can view platform invoices.' });
      try {
        const result = await statement(companies.current().code, undefined, false);
        const invoice = result.invoices.find((item) => item.id === req.params.id);
        if (!invoice) throw invalid('Invoice not found.', 404);
        res.json(req.query.format === 'pdf' ? await invoiceDocuments.invoicePdfDownload(invoice) : { html: await invoiceDocuments.invoiceHtml(invoice) });
      } catch (error) {
        console.error('Client invoice failed:', error.message);
        res.status(error.status || 503).json({ error: error.status ? error.message : 'Could not load the invoice. Retry.' });
      }
    });
    app.get('/api/platform-account', authenticate, async (req, res) => {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only the client main administrator can view the PrimeOps account.' });
      try {
        const result = await statement(companies.current().code, undefined, false);
        delete result.company.overrideReason;
        delete result.company.debtorProfile.internalNotes;
        for (const record of [...result.invoices, ...result.payments, ...result.credits]) {
          delete record.createdBy;
          delete record.emailError;
        }
        res.json(result);
      } catch (error) {
        console.error('Client statement failed:', error.message);
        res.status(error.status || 503).json({ error: error.status ? error.message : 'Could not load your PrimeOps statement. Retry.' });
      }
    });
  }
  return { access, statement, summary, allocateCredit, simulateTestPayment, mountOwner, mountClient, startInvoiceDelivery, sendPendingInvoices,
    generateRecurringInvoices, billCompany, runRecurringBilling, startRecurringBilling, initialiseDemoBilling };
}
module.exports = { schema, createPlatformAccounts, balances, money, date, forecast, accountFigures, recurringPeriods, debtorProfile };
