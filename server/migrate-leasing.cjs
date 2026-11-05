const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

const version = '001-leasing';
const validSchema = (name) => name === 'public' || /^company_[a-f0-9]{32}$/.test(name);

async function migrateLeasing(pool, { apply = false, companyCode } = {}) {
  const sql = await fs.readFile(path.join(__dirname, 'leasing-migrations', `${version}.sql`), 'utf8');
  const checksum = crypto.createHash('sha256').update(sql).digest('hex');
  const client = await pool.connect();
  try {
    await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    if (apply) await client.query('SELECT pg_advisory_xact_lock(7204102)');
    const { rows: companies } = await client.query(
      'SELECT code,schema_name FROM public.companies WHERE ($1::text IS NULL OR code=$1) ORDER BY code',
      [companyCode || null]
    );
    if (!companies.length) throw new Error('No matching registered client company was found.');
    const { rows: extensions } = await client.query(`SELECT e.extname,n.nspname AS schema
      FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='btree_gist'`);
    const extensionReady = extensions[0]?.schema === 'public';
    const results = [];
    for (const company of companies) {
      if (!validSchema(company.schema_name)) throw new Error(`Client ${company.code} has an unsupported database schema.`);
      await client.query(`SET LOCAL search_path TO "${company.schema_name}",pg_catalog`);
      const { rows: namespaces } = await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [company.schema_name]);
      if (!namespaces.length) throw new Error(`Client ${company.code} has no database schema.`);
      const { rows: tables } = await client.query(`SELECT tablename FROM pg_tables
        WHERE schemaname=$1 AND tablename=ANY($2::text[])`, [company.schema_name,
        ['app_users', 'app_properties', 'maintenance_tickets', 'operation_records', 'check_templates', 'leasing_schema_migrations']]);
      const names = new Set(tables.map((table) => table.tablename));
      const missing = ['app_users', 'app_properties', 'maintenance_tickets', 'operation_records', 'check_templates'].filter((name) => !names.has(name));
      if (missing.length) throw new Error(`Client ${company.code} is missing existing tables: ${missing.join(', ')}. Update the existing application schema first.`);
      let existing;
      if (names.has('leasing_schema_migrations')) {
        const { rows } = await client.query('SELECT checksum FROM leasing_schema_migrations WHERE version=$1', [version]);
        existing = rows[0];
      }
      if (existing && existing.checksum !== checksum) throw new Error(`Client ${company.code}: applied leasing migration checksum differs. Do not edit an applied migration; add a new version.`);
      if (existing) {
        const { rows } = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename=ANY($2::text[])`,
          [company.schema_name, ['app_portfolios', 'app_units', 'leasing_tenants', 'leasing_leases']]);
        if (rows.length !== 4) throw new Error(`Client ${company.code}: leasing migration history exists but required tables are missing.`);
        results.push({ companyCode: company.code, status: 'already_applied', extensionReady });
        continue;
      }
      if (!apply) {
        results.push({ companyCode: company.code, status: 'pending', extensionReady });
        continue;
      }
      if (!extensionReady) throw new Error(extensions.length
        ? 'btree_gist is installed outside public. A database operator must review and relocate it before applying; do not drop the extension.'
        : 'Leasing requires btree_gist installed in public. A database operator must run CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public before applying.');
      await client.query(`CREATE TABLE IF NOT EXISTS leasing_schema_migrations (
        version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(sql);
      await client.query('INSERT INTO leasing_schema_migrations(version,checksum) VALUES($1,$2)', [version, checksum]);
      results.push({ companyCode: company.code, status: 'applied', extensionReady });
    }
    await client.query('COMMIT');
    return results;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

function argumentsFor(args) {
  let apply = false, companyCode, all = false, check = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--apply') apply = true;
    else if (value === '--check') check = true;
    else if (value === '--all-companies') all = true;
    else if (value === '--company') {
      if (companyCode || !/^[A-Z0-9][A-Z0-9-]{1,39}$/.test(args[index + 1] || '')) throw new Error('Supply one valid uppercase company code after --company.');
      companyCode = args[++index];
    } else throw new Error(`Unknown argument: ${value}`);
  }
  if (check && apply) throw new Error('Choose either --check or --apply, not both.');
  if ((all && companyCode) || (!all && !companyCode)) throw new Error('Choose exactly one scope: --company CODE or --all-companies. Default mode is read-only --check; --apply changes the schema.');
  return { apply, companyCode };
}
async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL privately to the existing PostgreSQL database.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try { console.table(await migrateLeasing(pool, options)); }
  finally { await pool.end(); }
}
if (require.main === module) main().catch((error) => {
  console.error('Leasing migration failed:', error.message);
  process.exitCode = 1;
});
module.exports = { migrateLeasing, argumentsFor, version };
