import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { extractBillingRows, importBillingFile } from './billing-import.mjs';
test('billing extraction preserves uncertainty and requires independent VAT review', () => {
  const extracted = extractBillingRows([['Company name:', 'Acme'], ['VAT Number: 4123456789'], ['Billing address', '1 Road', 'Town'],
    ['Accounts email', 'accounts@example.test'], ['Email', 'conflicting@example.test'], ['VAT registered', 'yes']]);
  assert.equal(extracted.fields.legalName, 'Acme');
  assert.equal(extracted.fields.billingAddress, '1 Road, Town');
  assert.equal(extracted.fields.vatNumber, '4123456789');
  assert.equal(extracted.fields.contactEmail, undefined);
  assert.equal(extracted.fields.vatRegistered, undefined);
  assert(extracted.text.includes('conflicting@example.test'));
});
test('billing documents use real Word/CSV/text and shared PDF/spreadsheet/OCR readers', async () => {
  const rows = [['Legal name', 'Client Ltd'], ['Billing address', '1 Road'], ['Accounts email', 'client@example.test']];
  const zip = new JSZip();
  zip.file('word/document.xml', `<w:document xmlns:w="urn:test"><w:body>${rows.map((row) => `<w:p><w:r><w:t>${row.join(': ')}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  const doc = await zip.generateAsync({ type: 'uint8array' });
  const docx = new File([doc], 'billing.docx');
  // The shared browser Word reader needs DOMParser; parsing is exercised in Chromium integration.
  await assert.rejects(importBillingFile(docx, {}), /DOMParser/);
  for (const ext of ['txt', 'csv', 'pdf', 'xlsx', 'png']) {
    const text = rows.map((row) => row.join(ext === 'csv' ? ',' : ': ')).join('\n');
    const result = await importBillingFile(new File([text], `billing.${ext}`), { readPdf: async () => rows,
      readSpreadsheet: async () => rows, readImage: async () => rows });
    assert.equal(result.fields.legalName, 'Client Ltd', ext);
    assert.equal(result.fields.contactEmail, 'client@example.test', ext);
  }
  await assert.rejects(importBillingFile({ name: 'large.pdf', size: 26 * 1024 * 1024 }, {}), /25 MB/);
  await assert.rejects(importBillingFile(new File(['x'], 'billing.exe'), {}), /Supported files/);
  await assert.rejects(importBillingFile(new File([''], 'billing.txt'), {}), /No readable/);
});
