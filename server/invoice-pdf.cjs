const PDFDocument = require('pdfkit');
const path = require('node:path');

const purple = '#49308a', ink = '#252238', muted = '#655f75', line = '#e3ddeb';
const fontRoot = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts');
const filename = (reference) => `Invoice-${String(reference).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100)}.pdf`;

function invoicePdf(invoice) {
  if (!invoice.document) throw Object.assign(new Error('This legacy invoice has no issued document snapshot. Contact PrimeOps.'), { status: 409 });
  const { seller, customer, totalCents, subtotalCents, vatCents, vatBasisPoints } = invoice.document;
  const money = (cents) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(cents / 100);
  const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 64, left: 48, right: 48 },
    bufferPages: true, info: { Title: `${seller.vatRegistered ? 'Tax invoice' : 'Invoice'} ${invoice.reference}`,
      Author: seller.legalName, Subject: 'PrimeOps service invoice' } });
  doc.registerFont('Regular', path.join(fontRoot, 'LiberationSans-Regular.ttf'));
  doc.registerFont('Bold', path.join(fontRoot, 'LiberationSans-Bold.ttf'));
  const chunks = [];
  const result = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
  const width = doc.page.width - 96;
  function text(value, x, y, options = {}) {
    doc.font(options.bold ? 'Bold' : 'Regular').fontSize(options.size || 10).fillColor(options.color || ink)
      .text(String(value ?? ''), x, y, { width, lineGap: 3, ...options });
  }
  function space(height) {
    if (doc.y + height > doc.page.height - 64) { doc.addPage(); doc.y = 48; }
    return doc.y;
  }
  function heading(value) {
    const y = space(35);
    text(value, 48, y + 12, { bold: true, size: 12, color: purple });
    doc.y += 12;
  }
  doc.rect(48, 48, 36, 36).fill(purple);
  text('P', 58, 52, { bold: true, size: 25, color: '#ffffff', width: 24 });
  text('PRIMEOPS', 96, 50, { bold: true, size: 17, color: purple, width: 240 });
  text('PROPERTY & OPERATIONS', 96, 73, { size: 8, color: muted, width: 240 });
  text(invoice.document.testOnly ? 'TEST / DEMO' : seller.vatRegistered ? 'TAX INVOICE' : 'INVOICE', 350, 50, { size: 19, bold: true, color: purple, width: 197, align: 'right' });
  text(invoice.reference, 330, 79, { bold: true, width: 217, align: 'right' });
  const headerBottom = Math.max(112, doc.y + 16);
  doc.moveTo(48, headerBottom).lineTo(547, headerBottom).strokeColor(purple).lineWidth(2).stroke();
  const status = invoice.voidedAt ? 'VOID' : invoice.outstandingCents === 0 ? 'PAID' : 'PAYMENT DUE';
  text(`Issued: ${invoice.issuedOn}     Due: ${invoice.dueOn}     Currency: ZAR`, 48, headerBottom + 18, { width: 380, size: 9, color: muted });
  text(status, 430, headerBottom + 18, { bold: true, color: invoice.voidedAt ? '#a13348' : purple, width: 117, align: 'right', size: 9 });
  doc.y = headerBottom + 56;
  const sellerText = [seller.legalName, seller.address, `Registration: ${seller.registrationNumber || 'Not applicable'}`,
    seller.vatRegistered ? `VAT: ${seller.vatNumber}` : 'Not VAT registered. No VAT charged.', seller.email, seller.phone].filter(Boolean).join('\n');
  const customerText = [customer.legalName, customer.address, `Registration: ${customer.registrationNumber || 'Not applicable'}`,
    customer.vatRegistered ? `VAT: ${customer.vatNumber}` : '', customer.contactName, customer.email, customer.phone].filter(Boolean).join('\n');
  doc.font('Regular').fontSize(10);
  const columnWidth = (width - 28) / 2;
  const addressHeight = Math.max(doc.heightOfString(sellerText, { width: columnWidth, lineGap: 3 }),
    doc.heightOfString(customerText, { width: columnWidth, lineGap: 3 })) + 36;
  const addressY = space(addressHeight);
  for (const [label, value, x] of [['FROM', sellerText, 48], ['BILL TO', customerText, 48 + columnWidth + 28]]) {
    text(label, x, addressY, { bold: true, size: 9, color: purple, width: columnWidth });
    text(value, x, addressY + 22, { width: columnWidth });
  }
  doc.y = addressY + addressHeight + 8;
  heading('Service details');
  const description = `${invoice.description}${invoice.serviceMonth ? `\nService month: ${invoice.serviceMonth.slice(0, 7)}` : ''}`;
  doc.font('Regular').fontSize(10);
  const descriptionHeight = doc.heightOfString(description, { width: width - 122, lineGap: 3 }) + 26;
  const tableY = space(descriptionHeight + 38);
  doc.rect(48, tableY, width, 27).fill('#f0eaf8');
  text('DESCRIPTION', 58, tableY + 8, { bold: true, size: 8, color: purple, width: width - 130 });
  text('QTY', 445, tableY + 8, { bold: true, size: 8, color: purple, width: 35, align: 'right' });
  text(description, 58, tableY + 39, { width: width - 122 });
  text('1 service', 435, tableY + 39, { width: 95, align: 'right' });
  doc.y = tableY + 27 + descriptionHeight;
  doc.moveTo(48, doc.y).lineTo(547, doc.y).strokeColor(line).lineWidth(1).stroke();
  const totalsY = space(180) + 18;
  const rows = [
    ['Subtotal excluding VAT', money(subtotalCents)], [`VAT (${vatBasisPoints / 100}%)`, money(vatCents)],
    ['INVOICE TOTAL', money(totalCents)], ['Paid / credited', money(invoice.paidCents)],
    [invoice.voidedAt ? 'BALANCE DUE (VOID)' : 'BALANCE DUE', money(invoice.outstandingCents)]
  ];
  rows.forEach(([label, amount], index) => {
    const y = totalsY + index * 29, strong = index === 2 || index === 4;
    if (strong) doc.rect(273, y - 5, 274, 27).fill(index === 4 ? purple : '#f0eaf8');
    const color = index === 4 ? '#ffffff' : ink;
    text(label, 285, y, { bold: strong, color, size: 9, width: 150 });
    text(amount, 430, y, { bold: strong, color, size: 10, width: 105, align: 'right' });
  });
  doc.y = totalsY + rows.length * 29 + 10;
  heading('Payment instructions');
  text(seller.terms || 'Pay using your PrimeOps account page. Quote the invoice number when making payment.',
    48, doc.y, { width, size: 10 });
  doc.y += 14;
  text(`Please quote ${invoice.reference} with your payment.`, 48, space(36), { size: 9, color: muted });
  const pages = doc.bufferedPageRange();
  for (let index = pages.start; index < pages.start + pages.count; index++) {
    doc.switchToPage(index);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(48, doc.page.height - 48).lineTo(547, doc.page.height - 48).strokeColor(line).lineWidth(1).stroke();
    text(`PRIMEOPS | ${invoice.reference}${invoice.document.testOnly ? ' | DEMO ONLY - DO NOT PAY' : ''}`, 48, doc.page.height - 35, { size: 8, color: muted, width: 380, lineBreak: false });
    text(`Page ${index + 1} of ${pages.count}`, 440, doc.page.height - 35, { size: 8, color: muted, width: 107, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottomMargin;
  }
  doc.end();
  return result;
}
async function invoicePdfDownload(invoice) {
  return { filename: filename(invoice.reference), contentType: 'application/pdf', base64: (await invoicePdf(invoice)).toString('base64') };
}
module.exports = { invoicePdf, invoicePdfDownload, filename };
