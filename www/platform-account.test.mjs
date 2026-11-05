import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statementHtml, statementLedgerHtml } from './platform-account.mjs';

test('client statements show real invoices, payments and escaped client data, without internal agreement reasons', () => {
  const html = statementHtml({
    company: { name: '<script>client</script>', overrideReason: 'Internal agreement note', overrideUntil: '2026-11-15T00:00:00Z' },
    blocked: false, asOf: '2026-11-10T00:00:00Z', outstandingCents: 12500, arrearsCents: 12500, incomeCents: 5000,
    invoices: [{ id: 'invoice', reference: 'INV-1', description: '<img src=x>', amountCents: 17500, paidCents: 5000,
      outstandingCents: 12500, issuedOn: '2026-10-01', dueOn: '2026-10-08', document: { customer: {} } }],
    payments: [{ invoiceId: 'invoice', reference: 'BANK-1', paidOn: '2026-10-10', amountCents: 5000, reversedAt: '2026-11-09' }]
  });
  assert(html.includes('INV-1'));
  assert(html.includes('BANK-1'));
  assert(html.includes('REVERSED'));
  assert.match(html, /125[,.]00/);
  assert(html.includes('&lt;script&gt;'));
  assert(html.includes('&lt;img'));
  assert(!html.includes('<script>'));
  assert(!html.includes('Internal agreement note'));
  assert(html.includes('data-download-platform-invoice="invoice"'));
});

test('automatic ledger refresh does not replace the client billing details form', () => {
  const html = statementLedgerHtml({ company: { name: 'Client' }, invoices: [], payments: [], credits: [],
    outstandingCents: 0, arrearsCents: 0, incomeCents: 0, asOf: '2026-11-03T00:00:00Z' });
  assert(!html.includes('data-client-billing'));
  assert(!html.includes('data-billing-document'));
  assert(html.includes('No invoices.'));
});

test('incomplete billing details are visible and invoice refresh remains available', () => {
  const html = statementHtml({
    company: { name: 'Client', revision: 1, debtorProfile: {} },
    invoiceReadiness: { client: { ready: false } }, blocked: false, asOf: '2026-11-03T00:00:00Z',
    outstandingCents: 0, arrearsCents: 0, incomeCents: 0, invoices: [], payments: [], credits: []
  });
  assert(html.includes('Billing details needed:'));
  assert(html.includes('<details open>'));
  assert(html.includes('data-refresh-platform-statement'));
});

test('presentation statements show demo charges and PDFs without live payment actions or blocking threats', () => {
  const html = statementHtml({
    company: { name: 'Demo client', testAccount: true, debtorProfile: {} },
    invoiceReadiness: { client: { ready: false } }, blocked: false, asOf: '2026-11-03T00:00:00Z',
    outstandingCents: 45000, arrearsCents: 45000, incomeCents: 0,
    invoices: [{ id: 'demo', reference: 'DEMO-PO-000001', description: 'TEST / DEMO subscription',
      amountCents: 45000, paidCents: 0, outstandingCents: 45000, issuedOn: '2026-10-01', dueOn: '2026-10-31', document: { testOnly: true } }],
    payments: [], credits: []
  });
  assert(html.includes('TEST / DEMO BILLING'));
  assert(html.includes('No money is collected.'));
  assert(html.includes('DEMO-PO-000001'));
  assert.match(html, /450[,.]00/);
  assert(html.includes('data-download-platform-invoice="demo"'));
  assert(!html.includes('data-pay-platform-invoice'));
  assert(html.includes('data-simulate-platform-payment="demo"'));
  assert(html.includes('data-simulate-billing-block'));
  assert(!html.includes('Unpaid invoices block access'));
  assert(!html.includes('Billing details needed:'));
});

test('live client statements never expose test payment controls', () => {
  const html = statementLedgerHtml({
    company: { name: 'Live client', testAccount: false }, blocked: false,
    invoices: [{ id: 'live', reference: 'LIVE-1', description: 'Subscription', amountCents: 10000,
      paidCents: 0, outstandingCents: 10000, issuedOn: '2026-10-01', dueOn: '2026-10-31' }],
    payments: [], credits: [], outstandingCents: 10000, arrearsCents: 0, incomeCents: 0, asOf: '2026-11-03T00:00:00Z'
  });
  assert(!html.includes('data-simulate-platform-payment'));
  assert(!html.includes('data-simulate-billing-block'));
  assert(html.includes('data-pay-platform-invoice="live"'));
});
