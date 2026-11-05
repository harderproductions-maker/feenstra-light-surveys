import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateParts, combinedReportHtml } from './appliance-report.mjs';

const reports = [
  { id: 'one', building_name: 'North', unit_number: '1', model_number: 'Washer', parts: [
    { name: 'Belt', part_number: '200923', quantity: 2 },
    { name: 'Switch', part_number: '204696', quantity: 1 }
  ] },
  { id: 'two', building_name: 'South', unit_number: '2', model_number: 'Washer', pending_sync: true, parts: [
    { name: 'Belt', part_number: '200923', quantity: 3 }
  ] }
];

test('replacement parts totals quantities and retains every location', () => {
  const parts = aggregateParts(reports);
  assert.equal(parts.length, 2);
  assert.equal(parts.find((part) => part.part_number === '200923').quantity, 5);
  const html = combinedReportHtml(reports, 'parts');
  for (const text of ['<td>5</td>', 'North / Machine Legacy entry', 'South / Machine Legacy entry', '200923', '204696', 'PROVISIONAL']) assert(html.includes(text), text);
  assert(!html.includes('Unit '));
  assert(!html.includes('supplier'));
  assert.throws(() => combinedReportHtml([], 'parts'));
});

test('parts ordering keeps conflicting historical descriptions separate and escapes references', () => {
  const rows = reports.map((report) => structuredClone(report));
  rows[1].parts[0].name = 'Different belt';
  rows[1].building_name = '<script>';
  assert.equal(aggregateParts(rows).length, 3);
  assert(combinedReportHtml(rows, 'parts').includes('&lt;script&gt;'));
});

test('unnumbered catalogue items stay distinct and exports flag numbers pending confirmation', () => {
  const pending = [{
    id: 'r', created_at: '2026-10-30T08:00:00Z', parts: [
      { id: 'one', name: 'Pump', part_number: '', quantity: 2 },
      { id: 'two', name: 'Pump', part_number: '', quantity: 3 },
      { id: 'one', name: 'Pump', part_number: '', quantity: 1 }
    ]
  }];
  const groups = aggregateParts(pending);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((part) => part.quantity), [3, 3]);
  const html = combinedReportHtml(pending, 'parts');
  assert(html.includes('Part number pending'));
  assert(html.includes('must be confirmed before ordering'));
  assert(combinedReportHtml(pending, 'full').includes('Part number pending'));
});
