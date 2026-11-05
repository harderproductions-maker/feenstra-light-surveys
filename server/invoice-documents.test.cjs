const test = require('node:test');
const assert = require('node:assert/strict');
const { sellerDetails, clientDetails, invoiceReadiness, invoiceAmounts, invoiceHtml, createInvoiceDocuments } = require('./invoice-documents.cjs');
const seller = { legalName: 'Test Seller', registrationNumber: 'REG-1', vatNumber: '4123456789', address: '1 Test Road',
  email: 'accounts@example.test', phone: '0123456789', terms: 'Pay by the due date.', jurisdiction: 'ZA', vatRegistered: true, vatBasisPoints: 1500 };
const customer = clientDetails({ legalName: 'Client <script>', registrationNumber: 'CLIENT-1', billingAddress: '2 Client Road',
  contactEmail: 'client@example.test', contactName: 'Accounts', contactPhone: '', vatRegistered: false, vatNumber: '' });
const invoice = { id: 'test-id', reference: 'PO-000001', description: 'Monthly <service>', issuedOn: '2026-01-01', dueOn: '2026-01-31',
  amountCents: 11500, paidCents: 0, outstandingCents: 11500, serviceMonth: '2026-01-01',
  document: { seller: sellerDetails(seller), customer, ...invoiceAmounts(11500, seller) } };
test('invoice readiness identifies seller and client setup independently without exposing private details', () => {
  const missing = invoiceReadiness({}, {});
  assert.equal(missing.ready, false);
  assert.equal(missing.seller.ready, false);
  assert.equal(missing.client.ready, false);
  const profile = { legalName: 'Client', billingAddress: 'Test address', contactEmail: 'client@example.test', vatRegistered: false };
  assert.equal(invoiceReadiness(seller, profile).ready, true);
  assert.equal(invoiceReadiness({}, profile).client.ready, true);
  assert.equal(invoiceReadiness(seller, {}).seller.ready, true);
  assert(!JSON.stringify(invoiceReadiness(seller, profile)).includes('client@example.test'));
});
test('invoices require explicit jurisdiction, seller VAT and reviewed client identity', () => {
  assert.throws(() => sellerDetails({ ...seller, jurisdiction: 'GB' }), /South Africa/);
  assert.throws(() => sellerDetails({ ...seller, vatRegistered: undefined }), /Confirm/);
  assert.throws(() => sellerDetails({ ...seller, vatNumber: 'invalid' }), /ten-digit/);
  assert.throws(() => sellerDetails({ ...seller, vatRegistered: false }), /zero/);
  assert.throws(() => clientDetails({ legalName: 'Client' }), /supply\/review/);
  assert.deepEqual(invoiceAmounts(11500, seller), { totalCents: 11500, subtotalCents: 10000, vatCents: 1500, vatBasisPoints: 1500 });
  assert.deepEqual(invoiceAmounts(99, { vatRegistered: false }), { totalCents: 99, subtotalCents: 99, vatCents: 0, vatBasisPoints: 0 });
  const amounts = invoiceAmounts(999999999, seller);
  assert.equal(amounts.subtotalCents + amounts.vatCents, 999999999);
});
test('branded tax invoice includes full identity, serial, dates, quantity, totals and escaped content', async () => {
  const html = await invoiceHtml(invoice);
  for (const value of ['Tax invoice', 'PO-000001', '4123456789', '1 Test Road', '2 Client Road', '2026-01-01', '2026-01-31',
    '1 service', '15%', 'Client &lt;script&gt;', 'Monthly &lt;service&gt;', 'PRIMEOPS']) assert(html.includes(value), value);
  assert(!html.includes('<script>'));
  await assert.rejects(invoiceHtml({ ...invoice, document: null }), /legacy invoice/);
  const paid = await invoiceHtml({ ...invoice, paidCents: 11500, outstandingCents: 0 });
  assert(paid.includes('PAID'));
  assert((await invoiceHtml({ ...invoice, voidedAt: '2026-01-02' })).includes('VOID'));
});
test('email persists explicit acceptance/failure and sends the immutable billing identity', async () => {
  const changes = [], sent = [];
  const pool = { query: async (sql, values) => { changes.push({ sql, values }); return { rows: [{ id: invoice.id }] }; } };
  const service = createInvoiceDocuments({ pool, transport: { sendMail: async (mail) => { sent.push(mail); return { accepted: ['client@example.test'], rejected: [] }; } } });
  assert.equal((await service.deliver(invoice)).status, 'accepted');
  assert.equal(sent[0].to, customer.email);
  assert(sent[0].html.includes('PO-000001'));
  assert.equal(sent[0].attachments[0].contentType, 'application/pdf');
  assert.equal(sent[0].attachments[0].content.subarray(0, 5).toString(), '%PDF-');
  assert.equal(sent[0].attachments[0].filename, 'Invoice-PO-000001.pdf');
  assert(changes.some(({ sql }) => sql.includes("email_status='accepted'")));
  const failed = createInvoiceDocuments({ pool, transport: { sendMail: async () => ({ accepted: [], rejected: ['client@example.test'] }) } });
  assert.equal((await failed.deliver(invoice)).status, 'failed');
  assert(changes.some(({ sql }) => sql.includes("email_status='failed'")));
  await assert.rejects(createInvoiceDocuments({ pool: { query: async () => ({ rows: [] }) } }).deliver(invoice), /already sending/);
});
