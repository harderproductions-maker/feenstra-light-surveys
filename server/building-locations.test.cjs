const { test } = require('node:test');
const assert = require('node:assert/strict');
const { locations, seedLocations } = require('./building-locations.cjs');

test('researched pins have source links, distinct property IDs and valid South African coordinates', () => {
  const properties = require('./building-catalog.json');
  assert.equal(locations.length, 15);
  assert.equal(new Set(locations.map((location) => location.propertyId)).size, locations.length);
  for (const location of locations) {
    assert(properties.some((property) => property.id === location.propertyId));
    assert(location.latitude < -22 && location.latitude > -35);
    assert(location.longitude > 16 && location.longitude < 33);
    assert.equal(new URL(location.source).protocol, 'https:');
  }
  assert(!locations.some((location) => location.propertyId === 'apex-studios'));
  const pin = (id) => locations.find((location) => location.propertyId === id);
  assert.equal(pin('braamfontein-central').latitude, pin('crescent-studios').latitude);
  assert.equal(pin('braamfontein-central').longitude, pin('crescent-studios').longitude);
  assert.equal(pin('richmond-central').latitude, pin('the-richmond').latitude);
  assert.equal(pin('richmond-central').longitude, pin('the-richmond').longitude);
  assert.match(pin('richmond-central').note, /confirm on site/);
});

test('startup seeds active matching properties at 100 metres without overwriting existing pins', async () => {
  const calls = [];
  await seedLocations({ query: async (sql, values) => calls.push({ sql, values }) });
  assert.equal(calls.length, locations.length);
  for (const [index, call] of calls.entries()) {
    assert.match(call.sql, /WHERE id=\$1 AND active=TRUE/);
    assert.match(call.sql, /ON CONFLICT\(property_id\) DO NOTHING/);
    assert.deepEqual(call.values, [locations[index].propertyId, locations[index].latitude, locations[index].longitude, 100]);
  }
  await assert.rejects(seedLocations({ query: async () => { throw new Error('Database unavailable'); } }), /Database unavailable/);
});
