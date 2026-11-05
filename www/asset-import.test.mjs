import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { assetTable, mappedAssets, readAssetFile } from './asset-import.mjs';
import { assetDue, operationsReport } from './operations-tools.mjs';
const require = createRequire(import.meta.url);
const { defaultChecklist, answersFor, meterHistory, sourceData } = require('../server/operations-tracking.cjs');
const buildings = [{ id: 'north', name: 'North' }, { id: 'south', name: 'South' }];
test('asset import maps conservative headers and retains every original column without inventing identities', async () => {
  const table = assetTable([['Asset tag', 'Description', 'Building', 'Purchase value'], ['P1', 'Pump', 'North', 1234]]);
  const records = mappedAssets(table, table.mapping, buildings, { propertyId: '', category: 'Plant', intervalDays: 30, nextInspectionOn: '2026-11-03' });
  assert.equal(records[0].data.assetTag, 'P1');
  assert.equal(records[0].propertyId, 'north');
  assert.equal(records[0].data.category, 'Plant');
  assert.deepEqual(records[0].source.cells, ['P1', 'Pump', 'North', '1234']);
  assert.deepEqual(sourceData(records[0].source), records[0].source);
  assert.throws(() => mappedAssets(table, table.mapping, [buildings[1]], { propertyId: '', category: '', intervalDays: 0 }), /outside your access/);
  assert.throws(() => mappedAssets(table, { ...table.mapping, assetTag: -1 }, buildings, { intervalDays: 30 }), /Map an asset tag/);
  assert.throws(() => assetTable([['Tag'], ...Array.from({ length: 501 }, () => ['x'])]), /500 assets/);
  assert.throws(() => assetTable([['one line']]), /header row/);
  const calls = [];
  for (const ext of ['xlsx', 'pdf', 'docx', 'png']) {
    const reader = async () => { calls.push(ext); return [['Asset tag', 'Asset name'], ['OCR-P1', 'OCR Pump']]; };
    const result = await readAssetFile(new File(['fixture'], `assets.${ext}`), { readSpreadsheet: reader, readPdf: reader, readImage: reader, readDocx: reader });
    assert.equal(result.rows[0][0], 'OCR-P1');
  }
  assert.deepEqual(calls, ['xlsx', 'pdf', 'docx', 'png']);
});
test('asset checklist validation, due reminders and reports preserve evidence safely', () => {
  const data = { assetTag: 'P1', name: '<Pump>', location: 'Plant', nextInspectionOn: '2026-11-02' };
  const checklist = defaultChecklist(data);
  assert(checklist.questions[0].label.includes('P1'));
  assert(checklist.questions.some((question) => question.label.includes('seals')));
  const answers = Object.fromEntries(checklist.questions.map((question) => [question.id, 'pass']));
  assert.deepEqual(answersFor(checklist, answers), answers);
  assert.throws(() => answersFor(checklist, {}), /Answer/);
  assert.throws(() => answersFor(checklist, { ...answers, 'default-0': 'invented' }), /valid answer/);
  assert.throws(() => sourceData({ columns: ['Tag'], cells: [] }), /matching/);
  const record = { id: 'asset1', kind: 'assets', property_id: 'north', building_name: 'North', status: 'active', data };
  assert.equal(assetDue(record, '2026-11-03'), 'OVERDUE inspection');
  assert.equal(assetDue({ ...record, status: 'retired' }, '2026-11-03'), '');
  const html = operationsReport('assets', [record], { asset: record, checklist, history: [{ kind: 'inspection', happenedOn: '2026-11-03',
    actor: '<script>', detail: { notes: 'test', checklist, answers, photos: [] } }] });
  assert(html.includes('&lt;Pump&gt;')); assert(html.includes('&lt;script&gt;'));
  assert(html.includes(checklist.questions[1].label)); assert(!html.includes('<script>'));
});
test('meter history calculates scoped chronological consumption, never across units/buildings or resets', () => {
  const reading = (id, value, time, extra = {}) => ({ id, kind: 'meters', property_id: 'north',
    data: { meterReference: 'W1', meterType: 'water', unit: 'm3', reading: value, readAt: `2026-11-03T${time}:00.000Z`, ...extra } });
  const rows = meterHistory([reading('third', 130.45, '12:00'), reading('first', 0, '10:00'), reading('second', 100.1, '11:00'),
    reading('reset', 1, '13:00', { reset: 'yes' }), reading('decrease', 0, '14:00'),
    { ...reading('other-building', 500, '15:00'), property_id: 'south' }]);
  assert.equal(rows.find((row) => row.id === 'first').consumption, null);
  assert.equal(rows.find((row) => row.id === 'second').consumption, 100.1);
  assert.equal(rows.find((row) => row.id === 'third').consumption, 30.35);
  assert.equal(rows.find((row) => row.id === 'reset').consumption, null);
  assert.match(rows.find((row) => row.id === 'decrease').readingWarning, /decreased/);
  assert.equal(rows.find((row) => row.id === 'other-building').previousReading, null);
});
