import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLaundryReport, reportSelections, snapshotEntries } from './laundry.mjs';
import { aggregateParts, reportHtml } from './appliance-report.mjs';

const point = { latitude: -25.75, longitude: 28.19, accuracy: 10, capturedAt: '2026-10-30T08:00:00Z', mocked: false };
const audit = { started: point, completed: point, durationMs: 0, offlineCompleted: true };
function entry(number, parts = []) {
  return {
    machineNumber: String(number), serialNumber: `SERIAL-${number}`, modelNumber: 'SWNMN2SP303SW01', status: parts.length ? 'needs_repair' : 'working',
    notes: '', parts, photo: { source: 'camera', data: `data:image/jpeg;base64,${Buffer.from(`photo-${number}`).toString('base64')}`, capturedAt: point.capturedAt }, checkAudit: audit
  };
}
function body(entries) { return { propertyId: 'building', applianceType: 'Washer', expectedCount: entries.length, entries, checkAudit: audit }; }

test('supports 40 or 200 distinct machines and requires status, audit and camera evidence for checked machines', () => {
  for (const count of [40, 200]) assert.equal(validateLaundryReport(body(Array.from({ length: count }, (_, n) => entry(n + 1)))).entries.length, count);
  const good = body([entry(1)]);
  for (const invalid of [
    { ...good, entries: [] }, { ...good, expectedCount: 201 }, { ...good, expectedCount: 0 },
    { ...good, expectedCount: 1.5 }, { ...good, applianceType: 'Oven' },
    { ...body([entry(1), entry(2)]), expectedCount: 1 },
    body([entry(1), { ...entry(2), machineNumber: ' 1 ' }]),
    body([entry(1), { ...entry(2), machineNumber: '01' }]),
    body([entry(1), { ...entry(2), photo: entry(1).photo }]),
    ...[
      { machineNumber: '' }, { serialNumber: '' }, { serialNumber: undefined }, { serialNumber: 'x'.repeat(101) },
      { status: '' }, { photo: null }, { checkAudit: null },
      { photo: { ...entry(1).photo, source: 'gallery' } },
      { photo: { ...entry(1).photo, capturedAt: '2026-10-29T08:00:00Z' } },
      { parts: [{ id: 'belt', quantity: 1 }] }
    ].map((change) => body([{ ...entry(1), ...change }]))
  ]) assert.throws(() => validateLaundryReport(invalid));
});

test('reports may check only available machines while retaining the total present and unassessed count', () => {
  for (const applianceType of ['Washer', 'Dryer']) {
    const clean = validateLaundryReport({ ...body([entry(3)]), applianceType, expectedCount: 10 });
    assert.equal(clean.entries.length, 1);
    assert.equal(clean.expectedCount, 10);
    const html = reportHtml({ id: 'partial', created_at: point.capturedAt, building_name: 'North',
      appliance_type: applianceType, entries: clean.entries, expected_count: clean.expectedCount });
    assert(html.includes('1 of 10 declared machines checked'));
    assert(html.includes('Not checked: 9. These machines have not been assessed.'));
    assert(!html.includes('<h2>Machine 1</h2>'));
  }
});

test('parts are per-machine, snapshot once and total across machine references without units', () => {
  const report = body([entry(1), entry(2, [{ id: 'belt', quantity: 2 }]), entry(3, [{ id: 'belt', quantity: 3 }])]);
  const clean = validateLaundryReport(report);
  assert.equal(reportSelections(clean).length, 1);
  const entries = snapshotEntries(clean.entries, [{ id: 'belt', name: 'Belt', part_number: 'B1' }]);
  const saved = { id: 'r', created_at: point.capturedAt, building_name: 'North', appliance_type: 'Washer', expected_count: 3, entries };
  assert.equal(aggregateParts([saved])[0].quantity, 5);
  assert.deepEqual(aggregateParts([saved])[0].references.map((ref) => ref.machine), ['2', '3']);
  const full = reportHtml(saved);
  assert(full.includes('3 of 3 declared machines'));
  assert(full.includes('2 need repair'));
  assert.match(full, /<h2>Machine 1<\/h2>\s*<p><span[^>]*>Working<\/span>/);
  assert.match(full, /<h2>Machine 2<\/h2>\s*<p><span[^>]*>Needs repair<\/span>/);
  assert(full.includes('data:image/jpeg;base64,'));
  assert(!full.includes('Apartment'));
  assert(!full.includes('28.19'));
  assert(reportHtml(saved, true).includes('28.19'));
});
