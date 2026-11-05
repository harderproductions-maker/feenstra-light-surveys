const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client, Pool } = require('pg');
const { migrateLeasing, argumentsFor } = require('./migrate-leasing.cjs');

test('leasing migration requires explicit company scope and defaults to read-only checks', () => {
  assert.deepEqual(argumentsFor(['--company', 'CLIENT-A']), { apply: false, companyCode: 'CLIENT-A' });
  assert.deepEqual(argumentsFor(['--all-companies', '--apply']), { apply: true, companyCode: undefined });
  for (const args of [[], ['--apply'], ['--company', '../private'], ['--all-companies', '--company', 'CLIENT-A'], ['--all-companies', '--check', '--apply'], ['--reset']]) {
    assert.throws(() => argumentsFor(args));
  }
});

test('additive leasing migration preserves existing records and enforces lease/unit/deposit isolation', {
  skip: !process.env.TEST_DATABASE_URL, timeout: 60000
}, async (t) => {
  const database = `fg_leasing_test_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.href, max: 3 });
  const disconnections = [];
  pool.on('connect', (client) => {
    disconnections.push(new Promise((resolve) => client.once('end', resolve)));
  });
  t.after(async () => {
    await pool.end();
    await Promise.all(disconnections);
    await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
  });
  const tenantSchema = `company_${crypto.randomBytes(16).toString('hex')}`;
  await pool.query(`CREATE TABLE public.companies(code TEXT PRIMARY KEY,schema_name TEXT NOT NULL);
    INSERT INTO public.companies VALUES('FIRST','public'),('SECOND','${tenantSchema}');
    CREATE SCHEMA "${tenantSchema}"`);
  async function base(schema) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO "${schema}",pg_catalog`);
      await client.query(`CREATE TABLE app_users(id TEXT PRIMARY KEY,unit_number TEXT NOT NULL DEFAULT '');
        CREATE TABLE app_properties(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE);
        CREATE TABLE check_templates(id TEXT PRIMARY KEY);
        CREATE TABLE maintenance_tickets(id TEXT PRIMARY KEY,property_id TEXT NOT NULL REFERENCES app_properties(id),unit_number TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
        CREATE TABLE operation_records(id UUID PRIMARY KEY,property_id TEXT NOT NULL REFERENCES app_properties(id),kind TEXT NOT NULL,data JSONB NOT NULL);
        CREATE TABLE shared_workspace(id INTEGER PRIMARY KEY,data JSONB NOT NULL);
        INSERT INTO app_users VALUES('admin','Original unit label');
        INSERT INTO app_properties VALUES('north','North'),('south','South');
        INSERT INTO maintenance_tickets(id,property_id,unit_number) VALUES('old-ticket','north','Original unit label');
        INSERT INTO shared_workspace VALUES(1,'{"buildingChecks":[{"id":"original-inspection"}]}');
        INSERT INTO operation_records VALUES('00000000-0000-4000-8000-000000000001','north','meters','{"reading":123,"unit":"kWh"}')`);
      await client.query('COMMIT');
    } finally { client.release(); }
  }
  await base('public'); await base(tenantSchema);
  const initialCheck = await migrateLeasing(pool);
  assert(initialCheck.every((row) => row.status === 'pending' && !row.extensionReady));
  assert.equal((await pool.query("SELECT to_regclass('public.app_units') AS name")).rows[0].name, null);
  await assert.rejects(migrateLeasing(pool, { apply: true }), /requires btree_gist/);
  assert.equal((await pool.query("SELECT to_regclass('public.leasing_schema_migrations') AS name")).rows[0].name, null);
  await pool.query('CREATE EXTENSION btree_gist WITH SCHEMA public');
  assert((await migrateLeasing(pool, { apply: true })).every((row) => row.status === 'applied'));
  assert((await migrateLeasing(pool, { apply: true })).every((row) => row.status === 'already_applied'));
  assert.equal((await pool.query("SELECT unit_number,leasing_unit_id FROM public.maintenance_tickets WHERE id='old-ticket'")).rows[0].unit_number, 'Original unit label');
  assert.equal((await pool.query("SELECT data->>'unit' AS unit FROM public.operation_records")).rows[0].unit, 'kWh');
  assert.deepEqual((await pool.query('SELECT data FROM public.shared_workspace')).rows[0].data, { buildingChecks: [{ id: 'original-inspection' }] });
  const uuid = () => crypto.randomUUID();
  const first = uuid(), second = uuid(), expired = uuid(), tenant1 = uuid(), tenant2 = uuid();
  await pool.query(`INSERT INTO public.app_units(id,property_id,unit_number) VALUES('north-101','north','101'),('south-101','south','101'),('north-102','north','102');
    INSERT INTO public.leasing_tenants(id,first_name,last_name) VALUES('${tenant1}','Test','Tenant'),('${tenant2}','Other','Occupant')`);
  await assert.rejects(pool.query("UPDATE public.app_units SET reserved_until=CURRENT_DATE+1 WHERE id='north-101'"), { code: '23514' });
  await assert.rejects(pool.query("INSERT INTO public.app_units(id,property_id,unit_number) VALUES('duplicate','north',' 101 ')"), { code: '23505' });
  const lease = async (id, number, unit = 'north-101', building = 'north') => pool.query(`INSERT INTO public.leasing_leases
    (id,lease_number,property_id,unit_id,starts_on,ends_on,monthly_rental_cents,deposit_required_cents)
    VALUES($1,$2,$3,$4,CURRENT_DATE-30,CURRENT_DATE+180,100000,10000)`, [id, number, building, unit]);
  await assert.rejects(lease(uuid(), 'INVALID', 'north-101', 'south'), { code: '23503' });
  await lease(first, 'L-001'); await lease(second, 'L-002');
  assert.equal((await pool.query("SELECT occupancy_state FROM public.leasing_unit_occupancy WHERE id='north-101'")).rows[0].occupancy_state, 'vacant');
  await pool.query("UPDATE public.leasing_leases SET state='active',activated_at=NOW() WHERE id=$1", [first]);
  await assert.rejects(pool.query("UPDATE public.leasing_leases SET state='active',activated_at=NOW() WHERE id=$1", [second]), { code: '23P01' });
  await pool.query(`INSERT INTO public.leasing_lease_tenants(lease_id,tenant_id,is_primary) VALUES($1,$2,true),($1,$3,false)`, [first, tenant1, tenant2]);
  await assert.rejects(pool.query(`INSERT INTO public.leasing_applications(id,tenant_id,property_id,unit_id,status,lease_id)
    VALUES($1,$2,'north','north-101','lease_created',$3)`, [uuid(), tenant1, second]), { code: '23503' });
  await pool.query(`INSERT INTO public.leasing_applications(id,tenant_id,property_id,unit_id,status,lease_id)
    VALUES($1,$2,'north','north-101','lease_created',$3)`, [uuid(), tenant1, first]);
  await assert.rejects(pool.query('UPDATE public.leasing_lease_tenants SET is_primary=true WHERE lease_id=$1 AND tenant_id=$2', [first, tenant2]), { code: '23505' });
  assert.equal((await pool.query("SELECT occupancy_state FROM public.leasing_unit_occupancy WHERE id='north-101'")).rows[0].occupancy_state, 'occupied');
  await pool.query("UPDATE public.app_units SET manual_state='notice_given',state_reason='Notice received' WHERE id='north-101'");
  assert.equal((await pool.query("SELECT occupancy_state FROM public.leasing_unit_occupancy WHERE id='north-101'")).rows[0].occupancy_state, 'notice_given');
  await pool.query("UPDATE public.leasing_leases SET state='terminated',terminated_on=CURRENT_DATE-1,terminated_at=NOW(),termination_reason='Agreed early termination' WHERE id=$1", [first]);
  assert.equal((await pool.query('SELECT status FROM public.leasing_lease_summary WHERE id=$1', [first])).rows[0].status, 'terminated');
  assert.equal((await pool.query("SELECT occupancy_state FROM public.leasing_unit_occupancy WHERE id='north-101'")).rows[0].occupancy_state, 'vacant');
  await pool.query("UPDATE public.leasing_leases SET state='active',activated_at=NOW(),starts_on=CURRENT_DATE WHERE id=$1", [second]);
  await lease(expired, 'L-EXPIRED', 'north-102');
  await pool.query("UPDATE public.leasing_leases SET state='active',activated_at=NOW(),ends_on=CURRENT_DATE-1 WHERE id=$1", [expired]);
  assert.equal((await pool.query('SELECT status FROM public.leasing_lease_summary WHERE id=$1', [expired])).rows[0].status, 'expired');
  assert.equal((await pool.query("SELECT occupancy_state FROM public.leasing_unit_occupancy WHERE id='north-102'")).rows[0].occupancy_state, 'vacant');
  await pool.query("UPDATE public.app_units SET manual_state='maintenance',state_reason='Painting' WHERE id='north-102'");
  assert.equal((await pool.query("SELECT occupancy_state FROM public.leasing_unit_occupancy WHERE id='north-102'")).rows[0].occupancy_state, 'maintenance');
  await pool.query("UPDATE public.app_units SET manual_state='reserved',state_reason='Approved reservation',reserved_until=CURRENT_DATE+7 WHERE id='south-101'");
  assert.equal((await pool.query("SELECT occupancy_state FROM public.leasing_unit_occupancy WHERE id='south-101'")).rows[0].occupancy_state, 'reserved');
  await pool.query("INSERT INTO public.app_units(id,property_id,unit_number) VALUES('north-103','north','103')");
  const future = uuid(), concurrent = uuid();
  await lease(future, 'L-FUTURE', 'north-103'); await lease(concurrent, 'L-CONCURRENT', 'north-103');
  await pool.query('UPDATE public.leasing_leases SET starts_on=CURRENT_DATE+1 WHERE id=ANY($1::uuid[])', [[future, concurrent]]);
  const connection1 = await pool.connect(), connection2 = await pool.connect();
  try {
    await connection1.query('BEGIN'); await connection2.query('BEGIN');
    await connection1.query("UPDATE public.leasing_leases SET state='active',activated_at=NOW() WHERE id=$1", [future]);
    const conflictingActivation = assert.rejects(connection2.query("UPDATE public.leasing_leases SET state='active',activated_at=NOW() WHERE id=$1", [concurrent]), { code: '23P01' });
    await connection1.query('COMMIT');
    await conflictingActivation;
    await connection2.query('ROLLBACK');
  } finally { connection1.release(); connection2.release(); }
  assert.equal((await pool.query("SELECT occupancy_state FROM public.leasing_unit_occupancy WHERE id='north-103'")).rows[0].occupancy_state, 'reserved');
  const receipt = uuid(), refund = uuid();
  await pool.query(`INSERT INTO public.leasing_deposit_entries(id,lease_id,kind,amount_cents,reference,paid_on,created_by)
    VALUES($1,$2,'receipt',6000,'TEST-RECEIPT',CURRENT_DATE,'admin'),($3,$2,'refund',1000,'TEST-REFUND',CURRENT_DATE,'admin')`, [receipt, first, refund]);
  const deposits = (await pool.query('SELECT paid_cents,refunded_cents,outstanding_cents,held_cents FROM public.leasing_deposit_summary WHERE lease_id=$1', [first])).rows[0];
  assert.deepEqual(deposits, { paid_cents: '6000', refunded_cents: '1000', outstanding_cents: '4000', held_cents: '5000' });
  await assert.rejects(pool.query('UPDATE public.leasing_deposit_entries SET voided_at=NOW(),voided_by=$1 WHERE id=$2', ['admin', receipt]), { code: '23514' });
  await assert.rejects(pool.query(`INSERT INTO public.leasing_deposit_refunds(id,lease_id,amount_cents,status,reason,payment_entry_id,created_by)
    VALUES($1,$2,1000,'paid','Wrong lease',$3,'admin')`, [uuid(), second, refund]), { code: '23503' });
  await pool.query(`INSERT INTO public.leasing_deposit_refunds(id,lease_id,amount_cents,status,reason,payment_entry_id,created_by)
    VALUES($1,$2,1000,'paid','Approved refund',$3,'admin')`, [uuid(), first, refund]);
  await pool.query("UPDATE public.leasing_deposit_entries SET voided_at=NOW(),voided_by='admin',void_reason='Test reversal' WHERE id=$1", [receipt]);
  assert.equal((await pool.query('SELECT paid_cents,held_cents FROM public.leasing_deposit_summary WHERE lease_id=$1', [first])).rows[0].held_cents, '-1000');
  await pool.query('UPDATE public.leasing_deposit_entries SET voided_at=NULL,voided_by=NULL,void_reason=NULL WHERE id=$1', [receipt]);
  await pool.query(`UPDATE public.maintenance_tickets SET leasing_unit_id='north-101',leasing_lease_id=$1,leasing_tenant_id=$2 WHERE id='old-ticket'`, [first, tenant1]);
  await assert.rejects(pool.query("UPDATE public.maintenance_tickets SET leasing_unit_id='south-101' WHERE id='old-ticket'"), { code: '23503' });
  await assert.rejects(pool.query("UPDATE public.maintenance_tickets SET leasing_lease_id=$1 WHERE id='old-ticket'", [second]), { code: '23503' });
  await pool.query("UPDATE public.operation_records SET leasing_unit_id='north-101',leasing_lease_id=$1", [first]);
  await assert.rejects(pool.query("UPDATE public.operation_records SET leasing_unit_id='south-101'"), { code: '23503' });
  assert.equal((await pool.query(`SELECT COUNT(*)::integer AS count FROM "${tenantSchema}".leasing_tenants`)).rows[0].count, 0);
  assert.equal((await pool.query(`SELECT leasing_unit_id FROM "${tenantSchema}".maintenance_tickets WHERE id='old-ticket'`)).rows[0].leasing_unit_id, null);
  const task = uuid();
  await pool.query(`INSERT INTO public.leasing_renewal_tasks(id,lease_id,lease_revision,days_before,due_on) VALUES($1,$2,1,90,CURRENT_DATE)`, [task, second]);
  await assert.rejects(pool.query(`INSERT INTO public.leasing_renewal_tasks(id,lease_id,lease_revision,days_before,due_on) VALUES($1,$2,1,90,CURRENT_DATE)`, [uuid(), second]), { code: '23505' });
  const before = (await pool.query('SELECT checksum FROM public.leasing_schema_migrations')).rows[0].checksum;
  await pool.query("UPDATE public.leasing_schema_migrations SET checksum='changed'");
  await assert.rejects(migrateLeasing(pool), /checksum differs/);
  await pool.query('UPDATE public.leasing_schema_migrations SET checksum=$1', [before]);
  const pendingSchema = `company_${crypto.randomBytes(16).toString('hex')}`, conflictSchema = `company_${crypto.randomBytes(16).toString('hex')}`;
  await pool.query(`CREATE SCHEMA "${pendingSchema}"; CREATE SCHEMA "${conflictSchema}";
    INSERT INTO public.companies VALUES('A-PENDING','${pendingSchema}'),('Z-CONFLICT','${conflictSchema}')`);
  await base(pendingSchema); await base(conflictSchema);
  await pool.query(`CREATE TABLE "${conflictSchema}".app_units(id TEXT PRIMARY KEY)`);
  await assert.rejects(migrateLeasing(pool, { apply: true }), { code: '42P07' });
  assert.equal((await pool.query('SELECT to_regclass($1) AS name', [`${pendingSchema}.app_units`])).rows[0].name, null);
  assert.equal((await pool.query('SELECT to_regclass($1) AS name', [`${pendingSchema}.leasing_schema_migrations`])).rows[0].name, null);
});
