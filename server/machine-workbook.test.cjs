const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { assetWorkbook } = require('./machine-workbook.cjs');

test('asset export is a real styled Excel workbook with distinct building tabs, serials, history and reconciled quantities', async () => {
  const { assetSummary } = await import('../www/machine-assets.mjs');
  const assets = [{ id: 'm', property_id: 'a', appliance_type: 'Washer', machine_number: '001', serial_number: '000123', model_number: 'Model', active: true }];
  const reports = [{ id: 'r', property_id: 'a', created_at: '2026-10-30T08:00:00Z',
    entries: [{ assetId: 'm', machineNumber: '001', serialNumber: '000123', status: 'needs_repair', parts: [{ id: 'p', name: 'Belt', part_number: '0007', quantity: 3 }] }] }];
  const events = [{ report_id: 'r', asset_id: 'm', part_id: 'p', quantity: 2, action: 'ordered', created_by: 'manager', created_at: '2026-10-31T08:00:00Z' }];
  const name = "Building / []: test ' name with a very long ending";
  const data = { properties: [{ id: 'a', name }, { id: 'b', name }], assets, reports, events, ...assetSummary(assets, reports, events) };
  const bytes = await assetWorkbook(data);
  assert.equal(Buffer.from(bytes).subarray(0, 2).toString(), 'PK');
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  assert.equal(book.worksheets.length, 3);
  assert.notEqual(book.worksheets[1].name, book.worksheets[2].name);
  assert(book.worksheets.every((sheet) => sheet.name.length <= 31));
  const sheet = book.worksheets[1];
  assert.equal(sheet.getCell('A7').value, '001');
  assert.equal(sheet.getCell('C7').value, '000123');
  assert.equal(sheet.getCell('G7').value, 1);
  assert.equal(sheet.getCell('I7').value, 3);
  assert.equal(sheet.getCell('J7').value, 2);
  assert.equal(sheet.getCell('K7').value, 0);
  assert.equal(sheet.views[0].state, 'frozen');
  assert.equal(sheet.pageSetup.orientation, 'landscape');
  const cells = sheet.getSheetValues().flat(2);
  assert(cells.includes('Inspection history'));
  assert(cells.includes('Part order / replacement audit trail'));
  assert(cells.includes('0007'));
  assert.equal(book.worksheets[2].getCell('B2').value, name);
});
