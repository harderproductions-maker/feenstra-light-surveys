const nodemailer = require('nodemailer');
const { invoicePdf, invoicePdfDownload, filename } = require('./invoice-pdf.cjs');
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const schema = `
CREATE TABLE IF NOT EXISTS public.platform_invoice_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL DEFAULT 0,
  seller JSONB NOT NULL DEFAULT '{}',
  sequence BIGINT NOT NULL DEFAULT 0
);
INSERT INTO public.platform_invoice_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
ALTER TABLE public.platform_invoices ADD COLUMN IF NOT EXISTS document JSONB;
ALTER TABLE public.platform_invoices ADD COLUMN IF NOT EXISTS email_status TEXT NOT NULL DEFAULT 'not_sent';
ALTER TABLE public.platform_invoices ADD COLUMN IF NOT EXISTS email_error TEXT;
ALTER TABLE public.platform_invoices ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ;
ALTER TABLE public.platform_invoices ADD COLUMN IF NOT EXISTS email_attempt_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS platform_issued_invoice_reference ON public.platform_invoices(reference) WHERE document IS NOT NULL;
`;
function sellerDetails(body) {
  const result = {};
  for (const [field, max] of Object.entries({ legalName: 160, registrationNumber: 80, vatNumber: 80, address: 1000, email: 200, phone: 80, terms: 1500 })) {
    if (typeof body?.[field] !== 'string' || body[field].trim().length > max) throw invalid(`Enter valid seller ${field}.`);
    result[field] = body[field].trim();
  }
  if (body.jurisdiction !== 'ZA') throw invalid('This invoice template currently supports South Africa only. Obtain local advice before using another jurisdiction.');
  if (typeof body.vatRegistered !== 'boolean') throw invalid('Confirm whether the invoicing business is VAT registered.');
  if (!result.legalName || !result.address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) throw invalid('Seller legal name, address and valid email are required.');
  if (body.vatRegistered && !/^\d{10}$/.test(result.vatNumber)) throw invalid('A South African VAT-registered seller needs its ten-digit VAT number.');
  if (!Number.isInteger(body.vatBasisPoints) || body.vatBasisPoints < 0 || body.vatBasisPoints > 3000
      || (!body.vatRegistered && body.vatBasisPoints !== 0)) throw invalid('Confirm a VAT rate between 0 and 30%, or zero when not VAT registered.');
  return { ...result, jurisdiction: 'ZA', vatRegistered: body.vatRegistered, vatBasisPoints: body.vatBasisPoints };
}
function clientDetails(profile) {
  if (!profile?.legalName || !profile.billingAddress || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.contactEmail || '')
      || typeof profile.vatRegistered !== 'boolean' || (profile.vatRegistered && !/^\d{10}$/.test(profile.vatNumber || ''))) {
    throw invalid('The client must supply/review its legal name, billing address, accounts email and VAT status before an invoice can be issued.', 409);
  }
  return { legalName: profile.legalName, registrationNumber: profile.registrationNumber, vatRegistered: profile.vatRegistered,
    vatNumber: profile.vatNumber, address: profile.billingAddress, contactName: profile.contactName,
    email: profile.contactEmail, phone: profile.contactPhone };
}
function invoiceReadiness(seller, profile) {
  const check = (validate, value) => {
    try { validate(value); return { ready: true, message: '' }; }
    catch (error) {
      if (![400, 409].includes(error.status)) throw error;
      return { ready: false, message: error.message };
    }
  };
  const sellerStatus = check(sellerDetails, seller);
  const clientStatus = check(clientDetails, profile);
  return { ready: sellerStatus.ready && clientStatus.ready, seller: sellerStatus, client: clientStatus };
}
function invoiceAmounts(totalCents, seller) {
  const rate = seller.vatRegistered ? seller.vatBasisPoints : 0;
  const vatCents = Math.round(totalCents * rate / (10000 + rate));
  return { totalCents, subtotalCents: totalCents - vatCents, vatCents, vatBasisPoints: rate };
}
async function invoiceHtml(invoice) {
  const { reportDocument, reportEscape: e } = await import('../www/report-layout.mjs');
  if (!invoice.document) throw invalid('This legacy invoice has no issued document snapshot. Contact PrimeOps.', 409);
  const { seller, customer, ...amounts } = invoice.document;
  const money = (value) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(value / 100);
  return reportDocument({
    title: invoice.reference, category: invoice.document.testOnly ? 'TEST / DEMO invoice - nothing payable' : seller.vatRegistered ? 'Tax invoice' : 'Invoice',
    subtitle: seller.legalName,
    metadata: [['Issued', invoice.issuedOn], ['Payment due', invoice.dueOn], ['Currency', 'ZAR'], ['Status', invoice.voidedAt ? 'VOID' : invoice.outstandingCents === 0 ? 'PAID' : 'PAYMENT DUE']],
    summary: [['Total payable', money(amounts.totalCents)], ['Paid / credited', money(invoice.paidCents)], ['Balance due', money(invoice.outstandingCents)]],
    body: `<h2>From</h2><p><strong>${e(seller.legalName)}</strong>\n${e(seller.address)}\nRegistration: ${e(seller.registrationNumber || 'Not applicable')}${seller.vatRegistered ? `\nVAT: ${e(seller.vatNumber)}` : '\nNot VAT registered. No VAT charged.'}\n${e(seller.email)} ${e(seller.phone)}</p>
      <h2>Bill to</h2><p><strong>${e(customer.legalName)}</strong>\n${e(customer.address)}\nRegistration: ${e(customer.registrationNumber || 'Not applicable')}${customer.vatRegistered ? `\nVAT: ${e(customer.vatNumber)}` : ''}\n${e(customer.contactName)}\n${e(customer.email)} ${e(customer.phone)}</p>
      <table><thead><tr><th>Description</th><th>Quantity</th><th class="n">Amount excluding VAT</th><th class="n">VAT</th><th class="n">Total</th></tr></thead><tbody><tr>
      <td>${e(invoice.description)}${invoice.serviceMonth ? `<small>Service month: ${e(invoice.serviceMonth.slice(0, 7))}</small>` : ''}</td><td>1 service</td><td class="n">${money(amounts.subtotalCents)}</td><td class="n">${money(amounts.vatCents)} (${amounts.vatBasisPoints / 100}%)</td><td class="n">${money(amounts.totalCents)}</td></tr></tbody></table>
      <p class="total">Total payable: ${money(amounts.totalCents)}</p><p class="notes">${e(seller.terms || 'Pay using your PrimeOps account page. Quote the invoice number when making payment.')}</p>`,
    footer: `${seller.legalName} | ${seller.email} | Invoice ${invoice.reference}`
  });
}
function createInvoiceDocuments({ pool, transport }) {
  const smtpConfigured = () => !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
  const emailConfigured = () => !!transport || smtpConfigured();
  async function settings() {
    const { rows } = await pool.query('SELECT revision,seller FROM public.platform_invoice_settings WHERE id=1');
    return { ...rows[0], emailConfigured: emailConfigured() };
  }
  async function prepare(client, code, totalCents, { testOnly = false } = {}) {
    const { rows } = await client.query('SELECT seller FROM public.platform_invoice_settings WHERE id=1 FOR UPDATE');
    let seller;
    try { seller = sellerDetails(testOnly ? { legalName: 'PrimeOps demonstration', registrationNumber: '', vatNumber: '',
      address: 'TEST / DEMO ONLY - not a tax invoice', email: 'demo@example.test', phone: '',
      terms: 'Presentation only. Do not pay this invoice. No real payment will be collected.',
      jurisdiction: 'ZA', vatRegistered: false, vatBasisPoints: 0 } : rows[0]?.seller); }
    catch { throw invalid('Configure and confirm the seller legal/VAT details in Invoice setup before issuing invoices.', 409); }
    const { rows: companies } = await client.query('SELECT billing_profile,name FROM public.companies WHERE code=$1', [code]);
    const customer = testOnly ? { legalName: companies[0]?.name, address: 'Demonstration client account',
      email: 'demo@example.test', vatRegistered: false } : clientDetails(companies[0]?.billing_profile);
    const { rows: serial } = await client.query('UPDATE public.platform_invoice_settings SET sequence=sequence+1 WHERE id=1 RETURNING sequence::text');
    return { reference: `${testOnly ? 'DEMO-' : ''}PO-${serial[0].sequence.padStart(6, '0')}`,
      document: { seller, customer, ...invoiceAmounts(totalCents, seller), ...(testOnly ? { testOnly: true } : {}) } };
  }
  async function deliver(invoice, { automatic = false } = {}) {
    if (invoice.document?.testOnly) throw invalid('TEST / DEMO invoices cannot be emailed. No real charge is payable.', 409);
    const id = invoice.id;
    const { rows } = await pool.query(`UPDATE public.platform_invoices SET email_status='sending',email_error=NULL,email_attempt_at=NOW()
      WHERE id=$1 AND voided_at IS NULL AND (email_status<>'sending' OR email_attempt_at<NOW()-INTERVAL '2 minutes')
        AND (NOT $2::boolean OR email_status='pending' OR (email_status='sending' AND email_attempt_at<NOW()-INTERVAL '2 minutes'))
      RETURNING id`, [id, automatic]);
    if (!rows[0] && automatic) return { status: 'skipped', message: 'Invoice was already claimed, delivered or voided.' };
    if (!rows[0]) throw invalid('Invoice email is already sending or the invoice is voided. Refresh before retrying.', 409);
    if (!transport && !smtpConfigured()) {
      await pool.query("UPDATE public.platform_invoices SET email_status='not_configured',email_error='SMTP is not configured.' WHERE id=$1", [id]);
      return { status: 'not_configured', message: 'Invoice available in app. SMTP is not configured; no email was sent.' };
    }
    try {
      const mailer = transport || nodemailer.createTransport({
        host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
        connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000
      });
      const html = await invoiceHtml(invoice);
      const pdf = await invoicePdf(invoice);
      const result = await mailer.sendMail({ from: process.env.SMTP_FROM, to: invoice.document.customer.email,
        replyTo: invoice.document.seller.email, subject: `Invoice ${invoice.reference} - ${invoice.document.seller.legalName}`,
        text: `Invoice ${invoice.reference}. Total ZAR ${(invoice.amountCents / 100).toFixed(2)}, due ${invoice.dueOn}. View your PrimeOps account for the invoice and payment options.`,
        html, attachments: [{ filename: filename(invoice.reference), content: pdf, contentType: 'application/pdf' }] });
      if (!result.accepted?.length || result.rejected?.length) throw new Error('The mail server did not accept the invoice recipient.');
      await pool.query("UPDATE public.platform_invoices SET email_status='accepted',email_error=NULL,emailed_at=NOW() WHERE id=$1", [id]);
      return { status: 'accepted', message: 'Invoice available in app; the email server accepted the message. Inbox delivery is not guaranteed.' };
    } catch (error) {
      console.error('Invoice email failed:', error.message);
      await pool.query("UPDATE public.platform_invoices SET email_status='failed',email_error='Email could not be sent. Check SMTP configuration and retry.' WHERE id=$1", [id]);
      return { status: 'failed', message: 'Invoice saved in app, but email failed. Check SMTP configuration and retry sending.' };
    }
  }
  function mount(app, { authenticateOwner, route }) {
    app.get('/api/license/owner/invoice-settings', authenticateOwner, route(async (_req, res) => res.json(await settings())));
    app.put('/api/license/owner/invoice-settings', authenticateOwner, route(async (req, res) => {
      if (req.platformUser.role !== 'owner') throw invalid('Only the platform owner can configure the invoice seller.', 403);
      const seller = sellerDetails(req.body?.seller);
      const { rowCount } = await pool.query('UPDATE public.platform_invoice_settings SET seller=$1,revision=revision+1 WHERE id=1 AND revision=$2', [seller, req.body?.revision]);
      if (!rowCount) throw invalid('Invoice setup changed. Refresh before saving.', 409);
      res.json(await settings());
    }));
  }
  return { settings, prepare, deliver, mount, emailConfigured };
}
module.exports = { schema, createInvoiceDocuments, sellerDetails, clientDetails, invoiceReadiness, invoiceAmounts, invoiceHtml, invoicePdfDownload };
