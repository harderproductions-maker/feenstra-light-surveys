import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { residentLabel, residentTypeField, operationIds } from './operations.mjs';
const require = createRequire(import.meta.url);
const { validateData } = require('../server/operations.cjs');
const catalog = require('./operations-catalog.json');

test('resident labels respect client terminology and distinguish both resident types', () => {
  assert.equal(residentLabel(undefined, true), 'Students');
  assert.equal(residentLabel({ residentMode: 'tenants' }), 'Tenant');
  assert.equal(residentLabel({ residentMode: 'both' }, true), 'Students / tenants');
  assert.equal(residentLabel({ residentMode: 'both' }, false, 'tenant'), 'Tenant');
  assert.equal(residentTypeField({ residentMode: 'tenants' }), '');
  assert.match(residentTypeField({ residentMode: 'both' }, 'tenant'), /value="tenant" selected/);
});
test('operation catalogues have unique activated IDs and enforce required typed fields', () => {
  assert.deepEqual(operationIds, ['security', 'residents', 'meters', 'assets', 'incidents', 'contractors']);
  const features = require('./feature-catalog.json');
  for (const module of catalog) {
    assert(features.some((feature) => feature.id === module.id));
    assert(module.transitions[module.initialStatus]);
    assert.throws(() => validateData(module, {}), /required/);
  }
});
test('meter readings validate actual numeric values, including zero, and valid dates', () => {
  const module = catalog.find((item) => item.id === 'meters');
  const data = { meterReference: 'W1', meterType: 'water', reading: 0, unit: 'm3', readAt: '2026-11-03T10:00:00.000Z' };
  assert.equal(validateData(module, data).reading, 0);
  for (const reading of [NaN, -1, Infinity, '10', null]) assert.throws(() => validateData(module, { ...data, reading }), /valid non-negative/);
  assert.throws(() => validateData(module, { ...data, readAt: '2026-11-03T10:00' }), /valid reading date/);
  assert.throws(() => validateData(module, { ...data, meterType: 'invented' }), /Choose a valid/);
});
test('contractor records reject reversed/invalid dates and invalid email', () => {
  const module = catalog.find((item) => item.id === 'contractors');
  const data = { name: 'Contractor', trade: 'Plumbing', contactPerson: 'Contact', phone: '0123456789', startsOn: '2026-11-03', endsOn: '2026-11-04', email: 'office@example.test' };
  assert.equal(validateData(module, data).endsOn, data.endsOn);
  assert.throws(() => validateData(module, { ...data, endsOn: '2026-11-02' }), /before its start/);
  assert.throws(() => validateData(module, { ...data, startsOn: '2026-02-30' }), /valid work starts/);
  assert.throws(() => validateData(module, { ...data, email: 'not-an-email' }), /valid email/);
});
