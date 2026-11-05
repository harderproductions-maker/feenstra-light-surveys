import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leasingImportFields, leasingImportTable, mappedLeasingRows, suggestedImportBuilding, suggestedImportKind } from './leasing-import.mjs';
test('leasing import maps readable spreadsheet/PDF tables while retaining unmapped source cells', () => {
  const table = leasingImportTable([['Report title'], ['Building', 'Unit number', 'Description', 'Legacy code'], ['North', 101, 'Room', 'KEEP']], 'units', 2);
  const row = mappedLeasingRows(table, table.mapping)[0];
  assert.equal(row.building, 'North');
  assert.equal(row.number, '101');
  assert.equal(row.description, 'Room');
  assert.equal(table.rows[0][3], 'KEEP');
});
test('example unit audit maps compact headers and requires an explicitly selected assigned building', () => {
  const table = leasingImportTable([['North building audit'], ['UnitNumber', 'Floor', 'UnitType', 'Bedrooms', 'Bathrooms', 'ParkingBays', 'FloorArea', 'Status'],
    ['A001', 1, 'Studio', 0, 1, 1, 35, 'Vacant']], 'units');
  const properties = [{ id: 'north', name: 'North' }, { id: 'south', name: 'South' }];
  assert.equal(table.header, 2);
  assert.equal(suggestedImportBuilding(table, 'audit.xlsx', properties), 'north');
  assert.throws(() => mappedLeasingRows(table, table.mapping, { properties }), /Select the assigned building/);
  assert.equal(leasingImportFields.units[0], 'number');
  assert.equal(Object.keys(mappedLeasingRows(table, table.mapping, { properties, propertyId: 'north' })[0])[0], 'number');
  assert.equal(suggestedImportKind(table.headingRows.concat([table.columns])), 'units');
  assert.deepEqual(mappedLeasingRows(table, table.mapping, { properties, propertyId: 'north' }), [{
    building: 'North', number: 'A001', floor: '1', unitType: 'Studio', bedrooms: '0', bathrooms: '1', parkingBays: '1',
    floorArea: '35', status: 'Vacant', description: ''
  }]);
  const mixed = leasingImportTable([['Building', 'UnitNumber'], ['South', 'A001']], 'units');
  assert.throws(() => mappedLeasingRows(mixed, mixed.mapping, { properties, propertyId: 'north' }), /does not match/);
  assert.throws(() => mappedLeasingRows(table, table.mapping, { properties, propertyId: 'unassigned' }), /Select the assigned/);
});
test('building matching does not guess among ambiguous titles or overlapping names', () => {
  const table = leasingImportTable([['UnitNumber', 'Floor'], ['A001', 1]], 'units');
  assert.equal(suggestedImportBuilding(table, 'North-South-audit.xlsx', [{ id: 'north', name: 'North' }, { id: 'south', name: 'South' }]), '');
});
test('leasing import rejects unreadable, oversized and header-only data rather than fabricating records', () => {
  for (const rows of [[], [['Only header']], ['text'], [['A'], ...Array.from({ length: 501 }, () => ['x'])]]) {
    assert.throws(() => leasingImportTable(rows, 'tenants'));
  }
  assert.throws(() => leasingImportTable([['A'], ['x']], 'passwords'));
});
test('parking audit maps bay columns and is recognised as a parking audit', () => {
  const rows = [['BayNumber', 'Level', 'BayType', 'AssignedUnit', 'Status'], ['P01', 'B1', 'Covered', 'A001', 'Allocated']];
  assert.equal(suggestedImportKind(rows), 'parking');
  const table = leasingImportTable(rows, 'parking');
  assert.deepEqual(mappedLeasingRows(table, table.mapping, { properties: [{ id: 'north', name: 'North' }], propertyId: 'north' }), [{
    bayNumber: 'P01', level: 'B1', bayType: 'Covered', unit: 'A001', status: 'Allocated', notes: '', building: 'North' }]);
  assert.equal(leasingImportFields.parking[0], 'bayNumber');
});
