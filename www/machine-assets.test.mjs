import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetSummary } from './machine-assets.mjs';
import { partsForMachine, snapshotEntries } from './laundry.mjs';
import { projectView } from './offline-views.mjs';
import { benchmarkLabel, assetPanel } from './machine-assets.js';

const assets = [
  { id: 'old', property_id: 'a', appliance_type: 'Washer', machine_number: '1', machine_key: '1', serial_number: 'OLD', active: false },
  { id: 'new', property_id: 'a', appliance_type: 'Washer', machine_number: '1', machine_key: '1', serial_number: 'NEW', active: true },
  { id: 'other', property_id: 'b', appliance_type: 'Dryer', machine_number: '1', machine_key: '1', serial_number: 'OTHER', active: true }
];
const part = { id: 'belt', name: 'Belt', part_number: 'B-1', quantity: 2 };
function check(id, assetId, status, day, parts = []) {
  return { id, property_id: assets.find((asset) => asset.id === assetId)?.property_id || 'a', created_at: `2026-10-${day}T08:00:00Z`,
    entries: [{ assetId, machineNumber: '1', status, parts }] };
}
const reports = [
  check('r1', 'old', 'needs_repair', 10, [part]),
  check('r2', 'old', 'needs_repair', 11),
  check('r3', 'old', 'working', 12),
  check('r4', 'old', 'needs_repair', 13),
  check('r5', 'new', 'needs_repair', 14),
  check('r6', 'other', 'working', 15),
  check('legacy', undefined, 'needs_repair', 16)
];
const events = [
  { report_id: 'r1', asset_id: 'old', part_id: 'belt', action: 'ordered', quantity: 2 },
  { report_id: 'r1', asset_id: 'old', part_id: 'belt', action: 'replaced', quantity: 1 }
];

test('counts breakdown episodes chronologically, keeps retired serial history, ranks buildings and reconciles actual part events', () => {
  const data = assetSummary(assets, reports.toReversed(), events);
  assert.equal(data.machines.find((machine) => machine.id === 'old').breakdowns, 2);
  assert.equal(data.machines.find((machine) => machine.id === 'new').breakdowns, 1);
  assert.equal(data.buildings[0].property_id, 'a');
  assert.equal(data.buildings[0].breakdowns, 3);
  assert.equal(data.buildings[0].needs_repair, 1);
  assert.equal(data.unlinkedChecks, 1);
  assert.deepEqual(data.buildings[0].parts, [{ name: 'Belt', part_number: 'B-1', requested: 2, ordered: 2, replaced: 1 }]);
  assert.equal(data.requests[0].serial_number, 'OLD');
});

test('only active parts of the chosen type are selectable and prices never enter report snapshots', () => {
  const catalogue = ['Washer', 'Dryer', 'Combo'].map((type) => ({
    id: type, name: type, machine_type: type, active: true, benchmark_prices: [{ supplier: 'Shop', price: 250 }]
  }));
  catalogue.push({ id: 'disabled', machine_type: 'Washer', active: false }, { id: 'unclassified', active: true });
  assert.deepEqual(partsForMachine(catalogue, 'Washer').map((part) => part.id), ['Washer']);
  assert.deepEqual(partsForMachine(catalogue, 'Dryer').map((part) => part.id), ['Dryer']);
  const snapshot = snapshotEntries([{ parts: [{ id: 'Washer', quantity: 1 }] }], catalogue);
  assert(!JSON.stringify(snapshot).includes('benchmark_prices'));
  assert(!JSON.stringify(snapshot).includes('250'));
  assert.match(benchmarkLabel(catalogue[0]), /Shop: 250.00/);
});

test('equal check timestamps use received order and do not invent extra breakdown episodes', () => {
  const checks = ['needs_repair', 'needs_repair', 'working', 'needs_repair'].map((status, index) => {
    const report = check(`r${4 - index}`, 'new', status, 20 + index);
    report.entries[0].checkAudit = { completed: { capturedAt: '2026-10-19T08:00:00Z' } };
    return report;
  });
  assert.equal(assetSummary(assets, checks.toReversed(), []).machines.find((machine) => machine.id === 'new').breakdowns, 2);
});

test('offline asset projections are building-scoped and reuse serials from queued registrations', () => {
  const cache = { '/api/appliance-assets': { at: '2026-10-10', value: {
    assets, reports, events, properties: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  } } };
  const entry = { machineNumber: '2', serialNumber: 'OFFLINE-2', modelNumber: 'Model', status: 'needs_repair',
    parts: [], checkAudit: { completed: { capturedAt: '2026-10-20T08:00:00Z' } } };
  const job = { path: '/api/appliance-reports', method: 'POST', state: 'pending', localId: 'offline-report',
    createdAt: '2026-10-20T08:00:00Z', body: { propertyId: 'a', applianceType: 'Washer', entries: [entry] } };
  cache['/api/appliance-parts'] = { value: { parts: [] } };
  const result = projectView('/api/appliance-assets', cache, [job], { role: 'technician', propertyIds: ['a'] });
  assert(result.assets.every((asset) => asset.property_id === 'a'));
  assert.equal(result.assets.find((asset) => asset.machine_number === '2').serial_number, 'OFFLINE-2');
  assert.equal(result.buildings[0].breakdowns, 4);
  const panel = assetPanel(result, false, (value) => String(value));
  assert(!panel.includes('data-asset-export'));
  assert(!panel.includes('value="ordered"'));
  assert(panel.includes('OFFLINE-2'));
});
