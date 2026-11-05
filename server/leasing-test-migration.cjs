const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { migrateLeasing, argumentsFor } = require('./migrate-leasing.cjs');

async function provision(pool, companyCode) {
  if (!/^[A-Z0-9][A-Z0-9-]{1,39}$/.test(companyCode || '')) throw new Error('Provisioning requires one explicit registered company code.');
  await migrateLeasing(pool, { apply: true, companyCode });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    await client.query('SELECT pg_advisory_xact_lock(7204102)');
    const { rows } = await client.query('SELECT schema_name FROM public.companies WHERE code=$1', [companyCode]);
    const schema = rows[0]?.schema_name;
    if (schema !== 'public' && !/^company_[a-f0-9]{32}$/.test(schema || '')) throw new Error('Invalid client schema.');
    await client.query(`SET LOCAL search_path TO "${schema}",pg_catalog`);
    for (const version of ['002-leasing-test', '003-unit-audits', '004-parking-audits', '005-lease-occupants']) {
      const sql = await fs.readFile(path.join(__dirname, `leasing-migrations/${version}.sql`), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const existing = (await client.query('SELECT checksum FROM leasing_schema_migrations WHERE version=$1', [version])).rows[0];
      if (existing && existing.checksum !== checksum) throw new Error(`Applied ${version} migration checksum differs.`);
      if (!existing) {
        await client.query(sql);
        await client.query('INSERT INTO leasing_schema_migrations(version,checksum) VALUES($1,$2)', [version, checksum]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
async function main() {
  const { companyCode, apply } = argumentsFor(process.argv.slice(2));
  if (!companyCode || !apply) throw new Error('Use --company CLIENT-CODE --apply after backing up the database. Test provisioning never selects all companies.');
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL privately to the existing PostgreSQL database.');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try { await provision(pool, companyCode); console.log(`Leasing test schema ready for ${companyCode}. Enable the feature and explicit runtime allowlist separately.`); }
  finally { await pool.end(); }
}
if (require.main === module) main().catch((error) => { console.error('Leasing test provisioning failed:', error.message); process.exitCode = 1; });
module.exports = { provision };
