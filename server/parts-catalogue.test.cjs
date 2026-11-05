const { test } = require('node:test');
const assert = require('node:assert/strict');
const read = require('read-excel-file/node').default;
const { spreadsheetParts, publicPart, seedBenchmark } = require('./parts-catalogue.cjs');

test('bundled benchmark matches every source spreadsheet row, price and alternate number exactly', async () => {
  const source = await read(require('node:path').join(__dirname, '../Docs/Speed_Queen_Parts_Price_Benchmark (1).xlsx'));
  const bundled = [{ sheet: 'Parts', data: [[], [], ['Machine Model'], ...require('./parts-benchmark.json')] }];
  const parts = spreadsheetParts(source);
  assert.deepEqual(spreadsheetParts(bundled), parts);
  assert.equal(parts.length, 13);
  assert.equal(parts.filter((part) => part.machine_type === 'Washer').length, 7);
  assert.equal(parts.filter((part) => part.machine_type === 'Dryer').length, 5);
  assert.equal(parts.filter((part) => part.machine_type === 'Combo').length, 1);
  const duplicateOEM = parts.filter((part) => part.part_number === '205217P');
  assert.equal(duplicateOEM.length, 2);
  assert.notEqual(duplicateOEM[0].id, duplicateOEM[1].id);
  assert.equal(parts.find((part) => part.name.endsWith('Drain pump')).alternate_number, '36863');
  assert.deepEqual(parts.find((part) => part.name.endsWith('Element Kit')).benchmark_prices,
    [{ supplier: 'Universe Corp', price: 5519 }, { supplier: 'Ludi Appliances', price: 6200 }, { supplier: 'LvB', price: 2900 }]);
  for (const part of parts) {
    assert(!Object.hasOwn(publicPart(part, false), 'benchmark_prices'));
    assert.deepEqual(publicPart(part, true).benchmark_prices, part.benchmark_prices);
  }
});

test('benchmark seeds preserve previously imported edits and reuse the two matching original catalogue records', async () => {
  const queries = [];
  await seedBenchmark({ query: async (sql, values) => { queries.push({ sql, values }); } });
  assert.equal(queries.length, 13);
  assert(queries.every(({ sql }) => sql.includes('WHERE appliance_parts.benchmark_prices IS NULL')));
  assert(queries.some(({ values }) => values[0] === 'speedqueen-200923'));
  assert(queries.some(({ values }) => values[0] === 'speedqueen-204696'));
});
