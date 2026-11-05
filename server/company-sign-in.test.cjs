const test = require('node:test');
const assert = require('node:assert/strict');
const { createCompanies } = require('./companies.cjs');

test('client lookup accepts an exact code or case-insensitive company name without exposing internal fields', async () => {
  const companies = createCompanies({
    controlPool: { query: async (sql, values) => {
      assert.equal(sql, 'SELECT code,name FROM companies WHERE UPPER(code)=UPPER($1) OR LOWER(name)=LOWER($1)');
      assert.deepEqual(values, ['Example Company']);
      return { rows: [{ code: 'EXAMPLE', name: 'Example Company' }] };
    } }
  });
  assert.deepEqual(await companies.resolve(' Example Company '), { code: 'EXAMPLE', name: 'Example Company' });
});

test('duplicate company names require a unique code, with code taking priority over name', async () => {
  const companies = createCompanies({
    controlPool: { query: async () => ({ rows: [{ code: 'ONE', name: 'Shared Name' }, { code: 'TWO', name: 'Shared Name' }] }) }
  });
  await assert.rejects(companies.resolve('Shared Name'), { status: 409 });
  assert.equal((await companies.resolve('one')).code, 'ONE');
});

test('invalid and unknown company inputs fail explicitly', async () => {
  let queries = 0;
  const companies = createCompanies({ controlPool: { query: async () => { queries++; return { rows: [] }; } } });
  for (const identifier of [undefined, null, {}, '', ' ', 'x'.repeat(121)]) {
    await assert.rejects(companies.resolve(identifier), { status: 400 });
  }
  assert.equal(queries, 0);
  await assert.rejects(companies.resolve('Unknown'), { status: 404 });
});
