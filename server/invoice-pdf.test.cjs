const test = require('node:test');
const assert = require('node:assert/strict');
const { invoicePdf, invoicePdfDownload, filename } = require('./invoice-pdf.cjs');

const invoice = {
  reference: 'PO-000123', description: 'PrimeOps monthly service', serviceMonth: '2026-11-01',
  issuedOn: '2026-11-03', dueOn: '2026-12-03', paidCents: 5000, outstandingCents: 6500,
  document: {
    seller: { legalName: 'Test Property Services', registrationNumber: 'REG-123', vatRegistered: true, vatNumber: '4123456789',
      address: '1 Test Road\nPretoria', email: 'accounts@example.test', phone: '0123456789', terms: 'Pay by bank transfer. Reference your invoice number.' },
    customer: { legalName: 'Client Property Ltd', registrationNumber: 'CLIENT-123', vatRegistered: false,
      address: '2 Client Road\nJohannesburg', email: 'client@example.test', contactName: 'Accounts department', phone: '0111234567' },
    totalCents: 11500, subtotalCents: 10000, vatCents: 1500, vatBasisPoints: 1500
  }
};

async function readPdf(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  const pages = [];
  try {
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const { items } = await page.getTextContent();
      pages.push({ text: items.map((item) => item.str).join(' '), items, height: page.view[3], width: page.view[2] });
    }
    return pages;
  } finally { await pdf.destroy(); }
}

test('download is an actual single-page A4 PDF with invoice identity, taxes and payment balances', async () => {
  const download = await invoicePdfDownload(invoice);
  assert.equal(download.contentType, 'application/pdf');
  assert.equal(download.filename, 'Invoice-PO-000123.pdf');
  const bytes = Buffer.from(download.base64, 'base64');
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const pages = await readPdf(bytes);
  assert.equal(pages.length, 1, 'Ordinary invoices must fit one page, without blank footer pages');
  assert(Math.abs(pages[0].width - 595.28) < 1);
  assert(Math.abs(pages[0].height - 841.89) < 1);
  for (const text of ['PRIMEOPS', 'TAX INVOICE', invoice.reference, 'PAYMENT DUE', 'REG-123', '4123456789',
    'Client Property Ltd', 'CLIENT-123', '2026-11-03', '2026-12-03', '2026-11', '15%', '115,00', '50,00', '65,00', 'Page 1 of 1']) {
    assert(pages[0].text.includes(text), text);
  }
  for (const item of pages[0].items.filter((item) => item.str?.trim())) {
    assert(item.transform[5] > 15 && item.transform[5] < 820, `Text outside the page: ${item.str}`);
    assert(item.transform[4] >= 47 && item.transform[4] + item.width <= 549, `Text outside horizontal margins: ${item.str}`);
  }
});

test('long details paginate without losing text and retain unicode, void/paid status and safe filenames', async () => {
  const terms = Array.from({ length: 60 }, (_, index) => `Payment instruction ${index + 1}: quote your invoice.`).join('\n');
  const long = { ...invoice, reference: '../Invoice <123>', voidedAt: '2026-11-03', outstandingCents: 0,
    document: { ...invoice.document, seller: { ...invoice.document.seller, terms }, customer: { ...invoice.document.customer, legalName: 'Société Côte Properties' } } };
  const pages = await readPdf(await invoicePdf(long));
  assert(pages.length >= 2);
  const text = pages.map((page) => page.text).join(' ');
  assert(text.includes('Société Côte Properties'));
  assert(text.includes('VOID'));
  assert(text.includes('Payment instruction 60'));
  assert(text.includes(`Page ${pages.length} of ${pages.length}`));
  assert(!filename(long.reference).includes('/'));
  assert(!filename(long.reference).includes('<'));
  const paid = await readPdf(await invoicePdf({ ...invoice, outstandingCents: 0, paidCents: 11500 }));
  assert(paid[0].text.includes('PAID'));
  assert.throws(() => invoicePdf({ ...invoice, document: null }), /legacy invoice/);
});
