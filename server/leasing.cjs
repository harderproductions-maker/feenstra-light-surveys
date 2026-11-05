const crypto = require('node:crypto');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const { inflateSync } = require('node:zlib');
const managerRoles = require('../www/manager-roles.json');
const accountAccess = import('../www/account-access.mjs');

const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const signatureConsent = 'I consent to sign this exact lease version and its listed documents electronically. I understand this is a test signature, not a certified digital signature.';
const text = (value, label, max = 160, required = true) => {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw invalid(`Enter ${label} (up to ${max} characters).`);
  return value.trim();
};
const date = (value, label = 'a date') => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString().slice(0, 10) !== value || value < '2000-01-01' || value > '2100-12-31') throw invalid(`Enter ${label} between 2000 and 2100.`);
  return value;
};
const cents = (value, allowZero = true) => {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 1000000000) throw invalid('Enter a valid amount in cents, up to R10,000,000.');
  return value;
};
const uuid = (value) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw invalid('Choose a valid record.');
  return value;
};
function revision(body, row) {
  if (!Number.isSafeInteger(body.revision) || body.revision !== row.revision) throw invalid('This record changed. Refresh before saving.', 409);
}
function documentInput(body) {
  const name = text(body.name, 'a PDF or DOCX filename', 200).replace(/[^\w .()-]/g, '_');
  if (!['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(body.contentType)
    || typeof body.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data) || body.data.length > 34952536) throw invalid('Upload a PDF or DOCX of at most 25 MB.');
  const bytes = Buffer.from(body.data, 'base64');
  if (!bytes.length || bytes.length > 26214400 || bytes.toString('base64') !== body.data) throw invalid('Invalid document encoding or size.');
  if (body.contentType === 'application/pdf' ? bytes.subarray(0, 5).toString() !== '%PDF-' : bytes.subarray(0, 2).toString() !== 'PK') throw invalid('The document content does not match its type.');
  return { name, bytes, type: body.contentType, digest: crypto.createHash('sha256').update(bytes).digest('hex') };
}
function digest(lease, documents) {
  return crypto.createHash('sha256').update(JSON.stringify({
    id: lease.id, revision: lease.revision, number: lease.lease_number, unit: lease.unit_id,
    start: lease.starts_on, end: lease.ends_on, rent: lease.monthly_rental_cents, deposit: lease.deposit_required_cents,
    notes: lease.notes, tenants: lease.tenant_ids, holder: lease.holder_id, occupants: [lease.occupant_count, lease.occupant_names], documents: documents.map((doc) => [doc.id, doc.sha256])
  })).digest('hex');
}
function signatureInput(value) {
  if (typeof value !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value) || value.length > 300000) throw invalid('Draw a PNG signature (maximum 200 KB).');
  const bytes = Buffer.from(value.split(',')[1], 'base64');
  if (bytes.length < 100 || bytes.length > 200000 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString() !== 'IHDR') throw invalid('Invalid signature image.');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), colour = bytes[25];
  if (!width || width > 1600 || !height || height > 800 || bytes[24] !== 8 || ![2, 6].includes(colour) || bytes[26] || bytes[27] || bytes[28]) throw invalid('Draw a non-interlaced RGB/RGBA signature up to 1600 x 800 pixels.');
  const parts = [];
  let offset = 8, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.subarray(offset + 4, offset + 8).toString();
    if (offset + 12 + length > bytes.length) throw invalid('Truncated signature image.');
    if (type === 'IDAT') parts.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended || !parts.length || offset !== bytes.length) throw invalid('Incomplete signature image.');
  const stride = width * (colour === 6 ? 4 : 3) + 1, expected = stride * height;
  let decoded;
  try { decoded = inflateSync(Buffer.concat(parts), { maxOutputLength: expected }); }
  catch { throw invalid('Signature image pixels could not be decoded. Draw the signature again.'); }
  if (decoded.length !== expected || Array.from({ length: height }, (_, i) => decoded[i * stride]).some((filter) => filter > 4)) throw invalid('Invalid signature image pixels.');
  return bytes;
}
function periods(start, end) {
  const output = [];
  for (let month = start.slice(0, 7); month <= end.slice(0, 7);) {
    output.push(month);
    const d = new Date(`${month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    month = d.toISOString().slice(0, 7);
    if (output.length > 1200) throw invalid('Billing interval is too large.');
  }
  return output;
}
function unitAuditInput(body) {
  const count = (value, label) => {
    if (value === '' || value === undefined || value === null) return null;
    if (!/^\d{1,3}$/.test(String(value)) || Number(value) > 100) throw invalid(`Enter ${label} as a whole number from 0 to 100, or leave it blank.`);
    return Number(value);
  };
  let area = null;
  if (body.floorArea !== '' && body.floorArea !== undefined && body.floorArea !== null) {
    if (!/^\d+(?:\.\d{1,2})?$/.test(String(body.floorArea)) || Number(body.floorArea) > 1000000) throw invalid('Floor area must be 0-1,000,000 square metres with up to two decimals.');
    area = Number(body.floorArea);
  }
  const state = text(body.status || '', 'an audit status', 80, false).toLowerCase().replace(/[\s-]+/g, '_');
  if (!['', 'vacant', 'occupied', 'reserved', 'maintenance', 'notice_given'].includes(state)) throw invalid('Audit status must be Vacant, Occupied, Reserved, Maintenance or Notice given; correct other source values in the preview.');
  return [text(body.floor || '', 'a floor', 80, false), text(body.unitType || '', 'a unit type', 100, false),
    count(body.bedrooms, 'bedrooms'), count(body.bathrooms, 'bathrooms'), count(body.parkingBays, 'parking bays'), area, state];
}
const parkingStates = { '': '', vacant: 'vacant', available: 'vacant', free: 'vacant', open: 'vacant', allocated: 'allocated', assigned: 'allocated',
  occupied: 'allocated', taken: 'allocated', let: 'allocated', reserved: 'reserved', visitor: 'visitor', visitors: 'visitor', maintenance: 'maintenance' };
function parkingInput(body, hasUnit) {
  const raw = text(body.status || '', 'a bay status', 80, false).toLowerCase().replace(/[\s-]+/g, '_');
  if (!(raw in parkingStates)) throw invalid('Bay status must be Vacant, Allocated, Reserved, Visitor or Maintenance; correct other source values in the preview.');
  const state = parkingStates[raw] || (hasUnit ? 'allocated' : '');
  return [text(body.bayNumber, 'a bay number', 80), text(body.level || '', 'a parking level', 80, false),
    text(body.bayType || '', 'a bay type', 100, false), state, text(body.notes || '', 'bay notes', 1000, false)];
}
const blank = (value) => value === '' || value === undefined || value === null;
function mount(app, { pool, withTransaction, authenticate, accessibleProperties, companies }) {
  const enabled = () => String(process.env.LEASING_TEST_COMPANIES || '').split(',').map((code) => code.trim()).includes(companies.current().code);
  const route = (action, staff = true) => [authenticate, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      if (!enabled()) throw invalid('Leasing testing has not been enabled for this client.', 403);
      if (staff && !['admin', ...managerRoles].includes(req.user.role)) throw invalid('A leasing administrator or manager must perform this action.', 403);
      req.leasingProperties = (await accessibleProperties(req.user)).map((row) => row.id);
      await action(req, res);
    } catch (error) {
      console.error('Leasing request failed:', error.message);
      const conflict = ['23505', '23P01'].includes(error.code);
      res.status(error.status || (conflict ? 409 : 503)).json({ error: error.status ? error.message : conflict
        ? 'A duplicate code, unit, lease number or overlapping active lease exists. Refresh and check dates.'
        : 'Leasing could not complete this request. Reconnect and retry; no partial change was saved.' });
    }
  }];
  const scopeProperty = (req, id) => {
    if (!req.leasingProperties.includes(id)) throw invalid('Choose an assigned active building.', 403);
  };
  async function unit(req, id, db = pool, lock = false) {
    const row = (await db.query(`SELECT * FROM app_units WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    if (!row) throw invalid('Unit not found.', 404);
    scopeProperty(req, row.property_id);
    return row;
  }
  async function lease(req, id, db = pool, lock = false) {
    uuid(id);
    const row = (await db.query(`SELECT l.*,l.starts_on::text,l.ends_on::text,l.terminated_on::text,l.notice_on::text,
      ARRAY(SELECT tenant_id::text FROM leasing_lease_tenants WHERE lease_id=l.id ORDER BY tenant_id) AS tenant_ids,
      (SELECT tenant_id::text FROM leasing_lease_tenants WHERE lease_id=l.id AND is_primary LIMIT 1) AS holder_id
      FROM leasing_leases l WHERE l.id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    if (!row) throw invalid('Lease not found.', 404);
    scopeProperty(req, row.property_id);
    if (req.user.role === 'user' && !(await db.query(`SELECT 1 FROM leasing_lease_tenants lt JOIN leasing_tenants t ON t.id=lt.tenant_id
      WHERE lt.lease_id=$1 AND t.user_id=$2`, [id, req.user.id])).rowCount) throw invalid('This lease does not belong to your account.', 403);
    return row;
  }
  async function event(db, req, action, refs, detail = {}) {
    await db.query(`INSERT INTO leasing_events(tenant_id,lease_id,unit_id,parking_bay_id,actor_id,action,detail) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [refs.tenant || null, refs.lease || null, refs.unit || null, refs.bay || null, req.user.id, action, detail]);
  }
  const docs = async (id, db = pool) => (await db.query(`SELECT id,original_name,content_type,octet_length(data) AS size,sha256,created_at
    FROM leasing_test_documents WHERE lease_id=$1 ORDER BY id`, [id])).rows;
  async function snapshot(req) {
    const properties = await accessibleProperties(req.user);
    const ids = properties.map((row) => row.id), resident = req.user.role === 'user';
    const leases = (await pool.query(`SELECT l.*,l.starts_on::text,l.ends_on::text,l.notice_on::text,l.terminated_on::text,
      ARRAY(SELECT tenant_id::text FROM leasing_lease_tenants WHERE lease_id=l.id ORDER BY tenant_id) AS tenant_ids,
      (SELECT tenant_id::text FROM leasing_lease_tenants WHERE lease_id=l.id AND is_primary LIMIT 1) AS holder_id,
      p.name AS building_name,u.unit_number,s.status FROM leasing_leases l JOIN leasing_lease_summary s ON s.id=l.id JOIN app_properties p ON p.id=l.property_id
      JOIN app_units u ON u.id=l.unit_id WHERE l.property_id=ANY($1::text[]) AND
      ($2::boolean OR EXISTS(SELECT 1 FROM leasing_lease_tenants lt JOIN leasing_tenants t ON t.id=lt.tenant_id WHERE lt.lease_id=l.id AND t.user_id=$3))
      ORDER BY l.created_at DESC`, [ids, !resident, req.user.id])).rows;
    const leaseIds = leases.map((row) => row.id);
    const tenants = (await pool.query(`SELECT id,tenant_code,property_id,user_id,first_name,last_name,phone,email,status,revision
      FROM leasing_tenants WHERE property_id=ANY($1::text[]) AND ($2 OR user_id=$3) ORDER BY tenant_code`, [ids, !resident, req.user.id])).rows;
    const units = resident ? [] : (await pool.query(`SELECT u.*,u.reserved_until::text,
      a.floor,a.unit_type,a.bedrooms,a.bathrooms,a.parking_bays,a.floor_area,a.audit_status,
      (SELECT count(*)::int FROM leasing_parking_bays b WHERE b.unit_id=u.id AND b.active) AS allocated_parking_bays,
      CASE WHEN EXISTS(SELECT 1 FROM leasing_leases l WHERE l.unit_id=u.id AND l.occupied_during @> CURRENT_DATE AND l.notice_on IS NOT NULL)
        THEN 'notice_given' ELSE u.occupancy_state END AS occupancy_state
      FROM leasing_unit_occupancy u JOIN app_units a ON a.id=u.id WHERE u.property_id=ANY($1::text[]) ORDER BY u.property_id,u.unit_number`, [ids])).rows;
    const parking = resident ? [] : (await pool.query(`SELECT b.*,u.unit_number FROM leasing_parking_bays b LEFT JOIN app_units u ON u.id=b.unit_id
      WHERE b.property_id=ANY($1::text[]) AND b.active ORDER BY b.property_id,b.bay_number`, [ids])).rows;
    const portfolios = resident ? [] : (await pool.query(`SELECT DISTINCT f.* FROM app_portfolios f JOIN app_properties p ON p.portfolio_id=f.id
      WHERE p.id=ANY($1::text[]) OR ($2 AND NOT EXISTS(SELECT 1 FROM app_properties WHERE portfolio_id=f.id))`, [ids, req.user.role === 'admin'])).rows;
    const buildings = (await pool.query('SELECT id,name,city,portfolio_id FROM app_properties WHERE id=ANY($1::text[]) ORDER BY name', [ids])).rows;
    const ledger = (await pool.query(`SELECT e.*,e.entry_date::text FROM leasing_test_ledger e WHERE e.lease_id=ANY($1::uuid[]) ORDER BY e.entry_date,e.created_at`, [leaseIds])).rows;
    const schedule = (await pool.query(`SELECT s.*,s.starts_on::text,s.ends_on::text,u.property_id,u.unit_number FROM leasing_test_schedule s
      JOIN app_units u ON u.id=s.unit_id WHERE u.property_id=ANY($1::text[]) AND ($2 OR s.lease_id=ANY($3::uuid[]))
      ORDER BY s.starts_on`, [ids, !resident, leaseIds])).rows;
    const templates = resident ? [] : (await pool.query(`SELECT id,original_name,sha256,content_type,created_at FROM leasing_test_documents WHERE is_template ORDER BY created_at DESC`)).rows;
    const reminders = leases.filter((row) => row.state === 'active' && row.ends_on <= new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10))
      .map((row) => ({ leaseId: row.id, leaseNumber: row.lease_number, endsOn: row.ends_on, noticeOn: row.notice_on }));
    const balances = leases.map((row) => {
      const entries = ledger.filter((item) => item.lease_id === row.id && !item.voided_at);
      const balance = entries.reduce((sum, item) => sum + (['rent', 'charge'].includes(item.kind) ? 1 : ['payment', 'credit'].includes(item.kind) ? -1 : 0) * Number(item.amount_cents), 0);
      const deposit = entries.reduce((sum, item) => sum + (item.kind === 'deposit_receipt' ? 1 : item.kind === 'deposit_refund' ? -1 : 0) * Number(item.amount_cents), 0);
      return { leaseId: row.id, leaseNumber: row.lease_number, balanceCents: balance, depositCents: deposit, depositRequiredCents: Number(row.deposit_required_cents) };
    });
    const users = resident ? [] : (await pool.query(`SELECT u.id,u.email,u.display_name AS name,u.unit_number,
      ARRAY(SELECT property_id FROM user_properties WHERE user_id=u.id) AS property_ids FROM app_users u
      WHERE u.role='user' AND u.active AND EXISTS(SELECT 1 FROM user_properties up WHERE up.user_id=u.id AND up.property_id=ANY($1::text[]))
      AND NOT EXISTS(SELECT 1 FROM user_properties up WHERE up.user_id=u.id AND NOT(up.property_id=ANY($1::text[])))`, [ids])).rows;
    return { testMode: true, canManage: !resident, canBill: !resident && (await accountAccess).canUseSection(req.user, 'billing'),
      properties: buildings, portfolios, units, parking, tenants, leases, ledger, schedule, templates, reminders, balances, users };
  }
  app.get('/api/leasing', ...route(async (req, res) => res.json(await snapshot(req)), false));
  app.post('/api/leasing/portfolios', ...route(async (req, res) => {
    if (req.user.role !== 'admin') throw invalid('Only the main client administrator manages portfolios.', 403);
    const id = crypto.randomUUID(), name = text(req.body.name, 'a portfolio name');
    await pool.query('INSERT INTO app_portfolios(id,name,created_by) VALUES($1,$2,$3)', [id, name, req.user.id]);
    res.status(201).json({ id });
  }));
  app.put('/api/leasing/buildings/:id', ...route(async (req, res) => {
    if (req.user.role !== 'admin') throw invalid('Only the main client administrator assigns portfolios.', 403);
    scopeProperty(req, req.params.id);
    const portfolio = req.body.portfolioId || null;
    if (portfolio && !(await pool.query('SELECT 1 FROM app_portfolios WHERE id=$1 AND active', [portfolio])).rowCount) throw invalid('Choose an active portfolio.');
    await pool.query('UPDATE app_properties SET portfolio_id=$1 WHERE id=$2', [portfolio, req.params.id]);
    res.json({ saved: true });
  }));
  app.post('/api/leasing/units', ...route(async (req, res) => {
    scopeProperty(req, req.body.propertyId);
    const id = crypto.randomUUID();
    await withTransaction(async (db) => {
      await db.query('INSERT INTO app_units(id,property_id,unit_number,description,created_by) VALUES($1,$2,$3,$4,$5)',
        [id, req.body.propertyId, text(req.body.number, 'a unit number', 80), text(req.body.description || '', 'unit details', 1000, false), req.user.id]);
      await db.query('UPDATE app_units SET floor=$1,unit_type=$2,bedrooms=$3,bathrooms=$4,parking_bays=$5,floor_area=$6,audit_status=$7 WHERE id=$8',
        [...unitAuditInput(req.body), id]);
      await event(db, req, 'unit_created', { unit: id });
    });
    res.status(201).json({ id });
  }));
  app.put('/api/leasing/units/:id', ...route(async (req, res) => {
    await withTransaction(async (db) => {
      const row = await unit(req, req.params.id, db, true); revision(req.body, row);
      const state = req.body.state || null;
      if (state && !['reserved', 'notice_given', 'maintenance'].includes(state)) throw invalid('Choose a valid unit state.');
      const until = req.body.reservedUntil ? date(req.body.reservedUntil) : null;
      if (until && state !== 'reserved') throw invalid('A reservation end requires Reserved state.');
      await db.query(`UPDATE app_units SET unit_number=$1,description=$2,manual_state=$3,state_reason=$4,reserved_until=$5,revision=revision+1,updated_at=NOW() WHERE id=$6`,
        [text(req.body.number, 'a unit number', 80), text(req.body.description || '', 'unit details', 1000, false), state,
          text(req.body.reason || '', 'a reason', 2000, !!state), until, row.id]);
      await db.query('UPDATE app_units SET floor=$1,unit_type=$2,bedrooms=$3,bathrooms=$4,parking_bays=$5,floor_area=$6,audit_status=$7 WHERE id=$8',
        [...unitAuditInput({ floor: row.floor, unitType: row.unit_type, bedrooms: row.bedrooms, bathrooms: row.bathrooms,
          parkingBays: row.parking_bays, floorArea: row.floor_area, status: row.audit_status, ...req.body }), row.id]);
      await event(db, req, 'unit_updated', { unit: row.id }, { state, reason: req.body.reason || '' });
    });
    res.json({ saved: true });
  }));
  async function bayUnit(db, propertyId, { unitId, unitNumber }) {
    if (blank(unitId) && blank(unitNumber)) return null;
    const row = (await db.query(`SELECT id FROM app_units WHERE property_id=$1 AND active AND ${unitId ? 'id=$2' : 'lower(btrim(unit_number))=lower(btrim($2))'}`,
      [propertyId, unitId || text(unitNumber, 'an assigned unit', 80)])).rows[0];
    if (!row) throw invalid('The assigned unit was not found in this building. Add or import the building audit units first.');
    return row.id;
  }
  app.post('/api/leasing/parking', ...route(async (req, res) => {
    scopeProperty(req, req.body.propertyId);
    const id = crypto.randomUUID();
    await withTransaction(async (db) => {
      const unitId = await bayUnit(db, req.body.propertyId, { unitId: req.body.unitId });
      await db.query(`INSERT INTO leasing_parking_bays(id,property_id,bay_number,level,bay_type,status,notes,unit_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, req.body.propertyId, ...parkingInput(req.body, !!unitId), unitId, req.user.id]);
      await event(db, req, 'parking_bay_created', { unit: unitId, bay: id });
    });
    res.status(201).json({ id });
  }));
  app.put('/api/leasing/parking/:id', ...route(async (req, res) => {
    uuid(req.params.id);
    await withTransaction(async (db) => {
      const row = (await db.query('SELECT * FROM leasing_parking_bays WHERE id=$1 AND active FOR UPDATE', [req.params.id])).rows[0];
      if (!row) throw invalid('Parking bay not found.', 404);
      scopeProperty(req, row.property_id); revision(req.body, row);
      if (req.body.remove === true) {
        await db.query('UPDATE leasing_parking_bays SET active=FALSE,revision=revision+1,updated_at=NOW() WHERE id=$1', [row.id]);
        await event(db, req, 'parking_bay_removed', { unit: row.unit_id, bay: row.id }, { bayNumber: row.bay_number });
        return;
      }
      const unitId = await bayUnit(db, row.property_id, { unitId: req.body.unitId });
      await db.query(`UPDATE leasing_parking_bays SET bay_number=$1,level=$2,bay_type=$3,status=$4,notes=$5,unit_id=$6,revision=revision+1,updated_at=NOW() WHERE id=$7`,
        [...parkingInput(req.body, !!unitId), unitId, row.id]);
      await event(db, req, 'parking_bay_updated', { unit: unitId || row.unit_id, bay: row.id }, { previousUnit: row.unit_id });
    });
    res.json({ saved: true });
  }));
  async function tenantInput(req, db) {
    scopeProperty(req, req.body.propertyId);
    const userId = req.body.userId || null;
    if (userId) {
      const { rows } = await db.query(`SELECT u.* FROM app_users u WHERE id=$1 AND role='user' AND active
        AND EXISTS(SELECT 1 FROM user_properties WHERE user_id=u.id AND property_id=$2)
        AND NOT EXISTS(SELECT 1 FROM user_properties WHERE user_id=u.id AND property_id<>$2)`, [userId, req.body.propertyId]);
      if (!rows[0]) throw invalid('Link an active resident account assigned only to this building.');
    }
    const email = text(req.body.email || '', 'an email', 254, false);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('Enter a valid email address.');
    const status = req.body.status || 'pending_approval';
    if (!['pending_approval', 'active', 'former'].includes(status)) throw invalid('Choose a tenant status.');
    return [req.body.propertyId, userId, text(req.body.code, 'a tenant code', 80), text(req.body.firstName, 'a first name', 100),
      text(req.body.lastName, 'a last name', 100), text(req.body.phone || '', 'a phone', 40, false), email, status];
  }
  app.post('/api/leasing/tenants', ...route(async (req, res) => {
    const id = crypto.randomUUID();
    await withTransaction(async (db) => {
      const values = await tenantInput(req, db);
      await db.query(`INSERT INTO leasing_tenants(id,property_id,user_id,tenant_code,first_name,last_name,phone,email,status,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, ...values, req.user.id]);
      await event(db, req, 'tenant_created', { tenant: id });
    });
    res.status(201).json({ id });
  }));
  app.put('/api/leasing/tenants/:id', ...route(async (req, res) => {
    await withTransaction(async (db) => {
      const row = (await db.query('SELECT * FROM leasing_tenants WHERE id=$1 FOR UPDATE', [uuid(req.params.id)])).rows[0];
      if (!row) throw invalid('Tenant not found.', 404);
      scopeProperty(req, row.property_id); revision(req.body, row);
      const values = await tenantInput(req, db);
      if (row.property_id !== req.body.propertyId && (await db.query('SELECT 1 FROM leasing_lease_tenants WHERE tenant_id=$1', [row.id])).rowCount) throw invalid('A tenant with lease history must retain their building. Create a separate tenancy for another building.');
      if (row.user_id !== (req.body.userId || null) && (await db.query(`SELECT 1 FROM leasing_lease_tenants lt JOIN leasing_test_signatures s ON s.lease_id=lt.lease_id WHERE lt.tenant_id=$1`, [row.id])).rowCount) throw invalid('A signed tenancy must keep its linked account.');
      await db.query(`UPDATE leasing_tenants SET property_id=$1,user_id=$2,tenant_code=$3,first_name=$4,last_name=$5,phone=$6,email=$7,status=$8,
        revision=revision+1,updated_at=NOW() WHERE id=$9`, [...values, row.id]);
      await event(db, req, 'tenant_updated', { tenant: row.id });
    });
    res.json({ saved: true });
  }));
  async function leaseValues(req, db) {
    const u = await unit(req, req.body.unitId, db, true);
    if (!u.active) throw invalid('Choose an active unit.');
    if (req.body.propertyId && req.body.propertyId !== u.property_id) throw invalid('Choose a unit in the selected building.');
    const start = date(req.body.startsOn), end = date(req.body.endsOn);
    if (end < start) throw invalid('Lease end must not precede its start.');
    const number = text(req.body.number, 'a lease number', 120);
    let holder = req.body.holderId || null;
    if (!holder && !req.body.newHolder && Array.isArray(req.body.tenantIds)) holder = req.body.tenantIds[0] || null;
    const others = req.body.coTenantIds ?? (Array.isArray(req.body.tenantIds) && !req.body.holderId ? req.body.tenantIds.slice(1) : []);
    if (!Array.isArray(others) || others.length > 19) throw invalid('Choose up to 19 co-tenants.');
    const existing = [...(holder ? [holder] : []), ...others].map(uuid);
    if (new Set(existing).size !== existing.length) throw invalid('The lease holder and co-tenants must be different people.');
    const tenants = (await db.query('SELECT id FROM leasing_tenants WHERE id=ANY($1::uuid[]) AND property_id=$2 AND status<>$3', [existing, u.property_id, 'former'])).rows;
    if (tenants.length !== existing.length) throw invalid('Every tenant must belong to this unit building and not be Former.');
    if (!holder) {
      const h = req.body.newHolder;
      if (!h || typeof h !== 'object' || Array.isArray(h)) throw invalid('Choose the lease holder or enter the new lease holder details.');
      holder = crypto.randomUUID();
      const values = await tenantInput({ ...req, body: { ...h, code: h.code || `${number}-H`, propertyId: u.property_id, status: 'active' } }, db);
      await db.query(`INSERT INTO leasing_tenants(id,property_id,user_id,tenant_code,first_name,last_name,phone,email,status,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [holder, ...values, req.user.id]);
      await event(db, req, 'tenant_created', { tenant: holder }, { asLeaseHolder: true });
    }
    const ids = [holder, ...others.map(uuid)];
    const occupants = req.body.occupants === undefined || req.body.occupants === '' ? ids.length : req.body.occupants;
    if (!/^\d{1,2}$/.test(String(occupants)) || Number(occupants) < 1 || Number(occupants) > 50) throw invalid('Enter the number of occupants as a whole number from 1 to 50.');
    if (Number(occupants) < ids.length) throw invalid(`The number of occupants must include the lease holder and every co-tenant (at least ${ids.length}).`);
    return { u, ids, values: [number, u.property_id, u.id, start, end,
      cents(req.body.rentCents), cents(req.body.depositCents), text(req.body.notes || '', 'lease notes', 8000, false)],
      occupancy: [Number(occupants), text(req.body.occupantNames || '', 'occupant names', 4000, false)] };
  }
  app.post('/api/leasing/leases', ...route(async (req, res) => {
    const id = crypto.randomUUID();
    await withTransaction(async (db) => {
      const { u, ids, values, occupancy } = await leaseValues(req, db);
      const previous = req.body.renewedFromId ? await lease(req, req.body.renewedFromId, db, true) : null;
      if (previous && (previous.unit_id !== u.id || values[3] <= (previous.terminated_on || previous.ends_on) || previous.state === 'draft')) throw invalid('A renewal must follow the previous non-draft lease in the same unit.');
      await db.query(`INSERT INTO leasing_leases(id,lease_number,property_id,unit_id,starts_on,ends_on,monthly_rental_cents,deposit_required_cents,notes,renewed_from_id,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, ...values, previous?.id || null, req.user.id]);
      await db.query('UPDATE leasing_leases SET occupant_count=$1,occupant_names=$2 WHERE id=$3', [...occupancy, id]);
      for (const [index, tenant] of ids.entries()) await db.query('INSERT INTO leasing_lease_tenants(lease_id,tenant_id,is_primary) VALUES($1,$2,$3)', [id, tenant, index === 0]);
      await event(db, req, previous ? 'lease_renewal_created' : 'lease_created', { lease: id, unit: u.id }, { renewedFromId: previous?.id || null });
    });
    res.status(201).json({ id });
  }));
  app.put('/api/leasing/leases/:id', ...route(async (req, res) => {
    await withTransaction(async (db) => {
      const row = await lease(req, req.params.id, db, true); revision(req.body, row);
      if (row.state !== 'draft') throw invalid('Activated leases retain their terms. Use a renewal for new terms.');
      const { u, ids, values, occupancy } = await leaseValues(req, db);
      if (u.id !== row.unit_id) throw invalid('A lease must keep its unit. Create another draft for a different unit.');
      await db.query(`UPDATE leasing_leases SET lease_number=$1,property_id=$2,unit_id=$3,starts_on=$4,ends_on=$5,monthly_rental_cents=$6,deposit_required_cents=$7,notes=$8,
        occupant_count=$9,occupant_names=$10,revision=revision+1,updated_at=NOW() WHERE id=$11`, [...values, ...occupancy, row.id]);
      await db.query('DELETE FROM leasing_lease_tenants WHERE lease_id=$1', [row.id]);
      for (const [index, tenant] of ids.entries()) await db.query('INSERT INTO leasing_lease_tenants(lease_id,tenant_id,is_primary) VALUES($1,$2,$3)', [row.id, tenant, index === 0]);
      await event(db, req, 'lease_edited', { lease: row.id });
    });
    res.json({ saved: true });
  }));
  app.post('/api/leasing/leases/:id/actions', ...route(async (req, res) => {
    await withTransaction(async (db) => {
      const row = await lease(req, req.params.id, db, true); revision(req.body, row);
      const action = req.body.action;
      if (action === 'activate') {
        if (row.state !== 'draft') throw invalid('Only a draft can be activated.');
        if (!(await db.query('SELECT 1 FROM leasing_lease_tenants WHERE lease_id=$1', [row.id])).rowCount) throw invalid('Add tenants before activation.');
        await db.query("UPDATE leasing_leases SET state='active',activated_at=NOW(),revision=revision+1,updated_at=NOW() WHERE id=$1", [row.id]);
      } else if (action === 'notice') {
        if (row.state !== 'active') throw invalid('Only an active lease can receive notice.');
        const notice = date(req.body.date);
        if (notice < row.starts_on || notice > row.ends_on) throw invalid('Vacate date must fall within the lease period.');
        const reason = text(req.body.reason, 'a notice reason', 2000);
        await db.query('UPDATE leasing_leases SET notice_on=$1,notice_reason=$2,revision=revision+1,updated_at=NOW() WHERE id=$3', [notice, reason, row.id]);
        await db.query("UPDATE leasing_test_schedule SET status='cancelled',revision=revision+1 WHERE lease_id=$1 AND kind='vacate' AND title='Vacate notice' AND status='planned'", [row.id]);
        await db.query(`INSERT INTO leasing_test_schedule(id,unit_id,lease_id,kind,title,starts_on,ends_on,notes,created_by)
          VALUES($1,$2,$3,'vacate','Vacate notice',$4,$4,$5,$6)`, [crypto.randomUUID(), row.unit_id, row.id, notice, reason, req.user.id]);
      } else if (action === 'terminate') {
        if (row.state !== 'active') throw invalid('Only an active lease can be terminated.');
        const end = date(req.body.date), reason = text(req.body.reason, 'a termination reason', 2000);
        if (end < row.starts_on || end > row.ends_on) throw invalid('Termination date must fall within the lease period.');
        const posted = await db.query(`SELECT 1 FROM leasing_test_ledger WHERE lease_id=$1 AND kind IN ('rent','charge') AND NOT(voided_at IS NOT NULL) AND entry_date>$2 LIMIT 1`, [row.id, end]);
        if (posted.rowCount) throw invalid('Void simulated charges after the termination date before terminating.');
        await db.query("UPDATE leasing_leases SET state='terminated',terminated_on=$1,terminated_at=NOW(),termination_reason=$2,revision=revision+1,updated_at=NOW() WHERE id=$3", [end, reason, row.id]);
      } else throw invalid('Choose Activate, Notice or Terminate.');
      await event(db, req, `lease_${action}`, { lease: row.id, unit: row.unit_id }, { date: req.body.date || null, reason: req.body.reason || '' });
    });
    res.json({ saved: true });
  }));
  app.get('/api/leasing/leases/:id', ...route(async (req, res) => {
    const row = await lease(req, req.params.id);
    const documents = await docs(row.id), documentDigest = digest(row, documents);
    const signatures = (await pool.query(`SELECT id,party,signer_name,signed_at,document_digest FROM leasing_test_signatures WHERE lease_id=$1 ORDER BY signed_at`, [row.id])).rows;
    const events = (await pool.query(`SELECT e.action,e.detail,e.created_at,u.display_name AS actor FROM leasing_events e LEFT JOIN app_users u ON u.id=e.actor_id WHERE lease_id=$1 ORDER BY e.id`, [row.id])).rows;
    const charges = (await pool.query('SELECT *,starts_on::text,ends_on::text FROM leasing_lease_charges WHERE lease_id=$1 ORDER BY created_at', [row.id])).rows;
    res.json({ lease: row, documents, documentDigest, signatures, events, charges, consent: signatureConsent, testMode: true });
  }, false));
  app.post('/api/leasing/documents', ...route(async (req, res) => {
    const document = documentInput(req.body), id = crypto.randomUUID();
    await withTransaction(async (db) => {
      const row = req.body.leaseId ? await lease(req, req.body.leaseId, db, true) : null;
      if (!row && req.user.role !== 'admin') throw invalid('Only the main client administrator uploads shared lease templates.', 403);
      if (row) revision(req.body, row);
      await db.query(`INSERT INTO leasing_test_documents(id,lease_id,property_id,is_template,original_name,content_type,data,sha256,uploaded_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, row?.id || null, row?.property_id || null, !row, document.name, document.type, document.bytes, document.digest, req.user.id]);
      if (row) {
        await db.query('UPDATE leasing_leases SET revision=revision+1,updated_at=NOW() WHERE id=$1', [row.id]);
        await event(db, req, 'lease_document_uploaded', { lease: row.id }, { id, sha256: document.digest, name: document.name });
      }
    });
    res.status(201).json({ id });
  }));
  app.post('/api/leasing/leases/:id/template', ...route(async (req, res) => {
    await withTransaction(async (db) => {
      const row = await lease(req, req.params.id, db, true); revision(req.body, row);
      const template = (await db.query('SELECT * FROM leasing_test_documents WHERE id=$1 AND is_template', [uuid(req.body.templateId)])).rows[0];
      if (!template) throw invalid('Template not found.', 404);
      await db.query(`INSERT INTO leasing_test_documents(id,lease_id,property_id,original_name,content_type,data,sha256,uploaded_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [crypto.randomUUID(), row.id, row.property_id, template.original_name, template.content_type, template.data, template.sha256, req.user.id]);
      await db.query('UPDATE leasing_leases SET revision=revision+1,updated_at=NOW() WHERE id=$1', [row.id]);
      await event(db, req, 'template_attached', { lease: row.id }, { templateId: template.id });
    });
    res.json({ saved: true });
  }));
  app.get('/api/leasing/documents/:id', ...route(async (req, res) => {
    const row = (await pool.query('SELECT * FROM leasing_test_documents WHERE id=$1', [uuid(req.params.id)])).rows[0];
    if (!row) throw invalid('Document not found.', 404);
    if (row.lease_id) await lease(req, row.lease_id);
    else if (req.user.role === 'user') throw invalid('Templates are for leasing staff.', 403);
    res.type(row.content_type).attachment(row.original_name).send(row.data);
  }, false));
  app.post('/api/leasing/leases/:id/sign', ...route(async (req, res) => {
    await withTransaction(async (db) => {
      const row = await lease(req, req.params.id, db, true);
      const documents = await docs(row.id, db), currentDigest = digest(row, documents);
      if (!documents.length) throw invalid('Attach the lease document before signing.');
      if (req.body.digest !== currentDigest) throw invalid('The lease changed. Review the current document version before signing.', 409);
      if (req.body.consent !== true) throw invalid('Explicit electronic-signature consent is required.');
      const party = req.user.role === 'user' ? 'tenant' : 'landlord';
      if (party === 'landlord' && !['admin', ...managerRoles].includes(req.user.role)) throw invalid('A leasing manager must sign for the landlord.', 403);
      const name = text(req.body.name, 'the signer full name', 160);
      const bytes = signatureInput(req.body.signature);
      if (row.state === 'terminated') throw invalid('A terminated lease cannot be signed.');
      const charges = (await db.query('SELECT * FROM leasing_lease_charges WHERE lease_id=$1 ORDER BY id', [row.id])).rows;
      await db.query(`INSERT INTO leasing_test_signatures(id,lease_id,document_digest,signer_id,signer_name,party,consent,signed_snapshot,signature)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [crypto.randomUUID(), row.id, currentDigest, req.user.id, name, party, signatureConsent, { lease: row, documents, charges }, bytes]);
      await event(db, req, 'electronic_signature', { lease: row.id }, { party, name, digest: currentDigest, consent: signatureConsent });
    });
    res.status(201).json({ saved: true, testMode: true });
  }, false));
  const canBill = async (req) => {
    if (!(await accountAccess).canUseSection(req.user, 'billing')) throw invalid('Billing permission and the client Billing feature are required.', 403);
  };
  app.post('/api/leasing/import', ...route(async (req, res) => {
    const { kind, rows, source, sourceName, batchId } = req.body;
    uuid(batchId);
    if (!['buildings', 'units', 'parking', 'tenants', 'leases', 'schedule', 'balances'].includes(kind) || !Array.isArray(rows) || !rows.length || rows.length > 500) throw invalid('Choose 1-500 reviewed rows and a supported register.');
    if (req.body.reviewed !== true) throw invalid('Review all imported rows and explicitly confirm them before saving.');
    if (['units', 'parking', 'tenants', 'leases', 'schedule'].includes(kind)) {
      if (typeof req.body.propertyId !== 'string' || !req.body.propertyId) throw invalid('Select the assigned building this file belongs to.');
      scopeProperty(req, req.body.propertyId);
    }
    text(sourceName, 'the source filename', 200);
    if (!source || !Array.isArray(source.columns) || !source.columns.length || source.columns.length > 30
      || source.columns.some((v) => typeof v !== 'string' || v.length > 150) || !Array.isArray(source.rows) || source.rows.length !== rows.length
      || source.rows.some((row) => !Array.isArray(row) || row.length !== source.columns.length || row.some((v) => typeof v !== 'string' || v.length > 2000))) throw invalid('Source rows must match the imported records and contain at most 30 columns and 2,000 characters per cell.');
    const requestDigest = crypto.createHash('sha256').update(JSON.stringify([kind, rows, source, sourceName, req.body.propertyId])).digest('hex');
    let importedIds, outcome;
    await withTransaction(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(7204103)');
      const previous = (await db.query('SELECT * FROM leasing_test_imports WHERE id=$1', [batchId])).rows[0];
      if (previous) {
        if (previous.request_digest !== requestDigest || previous.imported_by !== req.user.id) throw invalid('Import batch was changed. Preview it again.', 409);
        importedIds = previous.record_ids;
        outcome = previous.source.outcome || { created: importedIds.length, updated: 0 };
        return;
      }
      const buildings = await accessibleProperties(req.user, db);
      const findBuilding = (value) => {
        const key = text(value || req.body.propertyId, 'a building name or ID').toLowerCase();
        const matches = buildings.filter((p) => p.id.toLowerCase() === key || p.name.toLowerCase() === key);
        if (matches.length !== 1) throw invalid('Building is missing, ambiguous or outside your assigned access.');
        if (req.body.propertyId && matches[0].id !== req.body.propertyId) throw invalid('The row building does not match the selected building. Import separate buildings in separate batches.');
        return matches[0].id;
      };
      const findUnit = async (row) => {
        const propertyId = findBuilding(row.building);
        const number = text(row.unit, 'a unit number', 80);
        const result = await db.query('SELECT id FROM app_units WHERE property_id=$1 AND lower(unit_number)=lower($2) AND active', [propertyId, number]);
        if (!result.rows[0]) throw invalid('Unit not found. Import units before leases or schedules.');
        return result.rows[0].id;
      };
      const findLease = async (number) => {
        const row = (await db.query('SELECT id FROM leasing_leases WHERE lower(lease_number)=lower($1)', [text(number, 'a lease number', 120)])).rows[0];
        if (!row) throw invalid('Lease not found. Import lease drafts before schedules or balances.');
        return lease(req, row.id, db);
      };
      const moneyValue = (value, optional = false) => {
        if (optional && (value === '' || value === undefined)) return 0;
        if (!/^\d+(?:\.\d{1,2})?$/.test(String(value))) throw invalid('Amounts must use a decimal point, no currency symbol or thousands separator.');
        return cents(Math.round(Number(value) * 100));
      };
      importedIds = []; outcome = { created: 0, updated: 0 };
      const seen = new Set();
      const once = (key, label) => {
        if (seen.has(key)) throw invalid(`${label} appears more than once in this file.`);
        seen.add(key);
      };
      const kept = (value, current) => blank(value) ? current ?? '' : value;
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        let id = crypto.randomUUID();
        try {
          if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalid('Invalid imported row.');
          if (kind === 'buildings') {
            if (req.user.role !== 'admin') throw invalid('Only the main administrator imports new buildings.', 403);
            await db.query('INSERT INTO app_properties(id,name,city) VALUES($1,$2,$3)', [id, text(row.name, 'a building name'), text(row.city || '', 'a city', 160, false)]);
          } else if (kind === 'units') {
            const propertyId = findBuilding(row.building), number = text(row.number, 'a unit number', 80);
            once(`${propertyId}|${number.toLowerCase()}`, `Unit ${number}`);
            const existing = (await db.query('SELECT * FROM app_units WHERE property_id=$1 AND lower(btrim(unit_number))=lower(btrim($2)) FOR UPDATE', [propertyId, number])).rows[0];
            if (existing) {
              if (!existing.active) throw invalid(`Unit ${number} is archived. Restore it before updating it by import.`);
              const audit = unitAuditInput({ floor: kept(row.floor, existing.floor), unitType: kept(row.unitType, existing.unit_type),
                bedrooms: kept(row.bedrooms, existing.bedrooms), bathrooms: kept(row.bathrooms, existing.bathrooms), parkingBays: kept(row.parkingBays, existing.parking_bays),
                floorArea: kept(row.floorArea, existing.floor_area), status: kept(row.status, existing.audit_status) });
              await db.query(`UPDATE app_units SET floor=$1,unit_type=$2,bedrooms=$3,bathrooms=$4,parking_bays=$5,floor_area=$6,audit_status=$7,
                description=$8,revision=revision+1,updated_at=NOW() WHERE id=$9`,
                [...audit, text(kept(row.description, existing.description), 'unit details', 1000, false), existing.id]);
              await event(db, req, 'unit_audit_updated', { unit: existing.id }, { batchId, before: { floor: existing.floor, unitType: existing.unit_type,
                bedrooms: existing.bedrooms, bathrooms: existing.bathrooms, parkingBays: existing.parking_bays, floorArea: existing.floor_area, status: existing.audit_status } });
              id = existing.id; outcome.updated++;
            } else {
              await db.query('INSERT INTO app_units(id,property_id,unit_number,description,created_by) VALUES($1,$2,$3,$4,$5)',
                [id, propertyId, number, text(row.description || '', 'unit details', 1000, false), req.user.id]);
              await db.query('UPDATE app_units SET floor=$1,unit_type=$2,bedrooms=$3,bathrooms=$4,parking_bays=$5,floor_area=$6,audit_status=$7 WHERE id=$8',
                [...unitAuditInput(row), id]);
              await event(db, req, 'unit_imported', { unit: id }, { batchId });
              outcome.created++;
            }
          } else if (kind === 'parking') {
            const propertyId = findBuilding(row.building), number = text(row.bayNumber, 'a bay number', 80);
            once(`${propertyId}|${number.toLowerCase()}`, `Parking bay ${number}`);
            const existing = (await db.query('SELECT * FROM leasing_parking_bays WHERE property_id=$1 AND lower(btrim(bay_number))=lower(btrim($2)) FOR UPDATE', [propertyId, number])).rows[0];
            const unitId = blank(row.unit) ? (existing?.active ? existing.unit_id : null) : await bayUnit(db, propertyId, { unitNumber: row.unit });
            const values = parkingInput({ bayNumber: number, level: kept(row.level, existing?.level), bayType: kept(row.bayType, existing?.bay_type),
              status: kept(row.status, existing?.active ? existing.status : ''), notes: kept(row.notes, existing?.notes) }, !!unitId);
            if (existing) {
              await db.query(`UPDATE leasing_parking_bays SET bay_number=$1,level=$2,bay_type=$3,status=$4,notes=$5,unit_id=$6,active=TRUE,
                revision=revision+1,updated_at=NOW() WHERE id=$7`, [...values, unitId, existing.id]);
              await event(db, req, 'parking_bay_audit_updated', { unit: unitId || existing.unit_id, bay: existing.id }, { batchId,
                before: { level: existing.level, bayType: existing.bay_type, unitId: existing.unit_id, status: existing.status, active: existing.active } });
              id = existing.id; outcome.updated++;
            } else {
              await db.query(`INSERT INTO leasing_parking_bays(id,property_id,bay_number,level,bay_type,status,notes,unit_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [id, propertyId, ...values, unitId, req.user.id]);
              await event(db, req, 'parking_bay_imported', { unit: unitId, bay: id }, { batchId });
              outcome.created++;
            }
          } else if (kind === 'tenants') {
            const values = await tenantInput({ ...req, body: { ...row, propertyId: findBuilding(row.building), status: 'pending_approval' } }, db);
            await db.query(`INSERT INTO leasing_tenants(id,property_id,user_id,tenant_code,first_name,last_name,phone,email,status,created_by)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, ...values, req.user.id]);
            await event(db, req, 'tenant_imported', { tenant: id }, { batchId });
          } else if (kind === 'leases') {
            const propertyId = findBuilding(row.building), unitId = await findUnit(row);
            const codes = text(row.tenantCodes, 'tenant code(s)', 2000).split(';').map((code) => code.trim());
            const found = (await db.query('SELECT id,lower(tenant_code) AS code FROM leasing_tenants WHERE lower(tenant_code)=ANY($1::text[]) AND property_id=$2', [codes.map((code) => code.toLowerCase()), propertyId])).rows;
            const matches = codes.map((code) => found.find((t) => t.code === code.toLowerCase()));
            if (matches.some((t) => !t)) throw invalid('Tenant codes must match existing profiles in this building. Put the lease holder first and separate multiple codes with semicolons.');
            const { values, ids, occupancy } = await leaseValues({ ...req, body: { ...row, unitId, holderId: matches[0].id, coTenantIds: matches.slice(1).map((t) => t.id),
              newHolder: undefined, rentCents: moneyValue(row.rent), depositCents: moneyValue(row.deposit, true) } }, db);
            await db.query(`INSERT INTO leasing_leases(id,lease_number,property_id,unit_id,starts_on,ends_on,monthly_rental_cents,deposit_required_cents,notes,created_by,occupant_count,occupant_names)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, ...values, req.user.id, ...occupancy]);
            for (const [i, tenant] of ids.entries()) await db.query('INSERT INTO leasing_lease_tenants(lease_id,tenant_id,is_primary) VALUES($1,$2,$3)', [id, tenant, i === 0]);
            await event(db, req, 'lease_imported_as_draft', { lease: id, unit: unitId }, { batchId });
          } else if (kind === 'schedule') {
            const u = await findUnit(row), l = row.leaseNumber ? await findLease(row.leaseNumber) : null;
            if (l && l.unit_id !== u) throw invalid('Scheduled lease and unit must match.');
            const start = date(row.startsOn), end = date(row.endsOn);
            if (end < start || !['move_in', 'vacate', 'inspection', 'renovation', 'maintenance'].includes(row.kind)) throw invalid('Choose valid schedule dates and type.');
            await db.query(`INSERT INTO leasing_test_schedule(id,unit_id,lease_id,kind,title,starts_on,ends_on,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [id, u, l?.id || null, row.kind, text(row.title, 'a schedule title'), start, end, text(row.notes || '', 'notes', 2000, false), req.user.id]);
            await event(db, req, 'schedule_imported', { unit: u, lease: l?.id }, { batchId });
          } else {
            await canBill(req);
            const l = await findLease(row.leaseNumber);
            if (!['charge', 'credit', 'deposit_receipt'].includes(row.kind)) throw invalid('Opening balances support charge, credit or deposit_receipt only.');
            const entryDate = date(row.date);
            if (entryDate > new Date().toISOString().slice(0, 10)) throw invalid('Opening balances cannot be future dated.');
            await db.query(`INSERT INTO leasing_test_ledger(id,lease_id,kind,amount_cents,entry_date,description,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
              [id, l.id, row.kind, cents(moneyValue(row.amount), false), entryDate, `TEST imported: ${text(row.description, 'an opening balance reference', 450)}`, req.user.id]);
            await event(db, req, 'opening_balance_imported', { lease: l.id }, { batchId });
          }
          if (!['units', 'parking'].includes(kind)) outcome.created++;
          importedIds.push(id);
        } catch (error) {
          if (!error.status && !['23505', '23P01'].includes(error.code)) throw error;
          throw invalid(`Import row ${index + 1}: ${error.status ? error.message : 'duplicate code, unit or lease number. No rows were imported.'}`, error.status || 409);
        }
      }
      await db.query(`INSERT INTO leasing_test_imports(id,kind,source_name,request_digest,source,record_ids,imported_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [batchId, kind, sourceName, requestDigest, { ...source, selectedBuildingId: req.body.propertyId || null, reviewedRows: rows, outcome }, importedIds, req.user.id]);
    });
    res.status(201).json({ imported: importedIds.length, ...outcome, ids: importedIds, testMode: true });
  }));
  app.post('/api/leasing/leases/:id/charges', ...route(async (req, res) => {
    await canBill(req);
    await withTransaction(async (db) => {
      const row = await lease(req, req.params.id, db, true);
      if (row.state !== 'draft') throw invalid('Add recurring charges to the draft before activation.');
      const start = date(req.body.startsOn), end = date(req.body.endsOn);
      if (start < row.starts_on || end > row.ends_on || end < start) throw invalid('Charge dates must fall within the lease.');
      if (!['monthly', 'once_off'].includes(req.body.frequency)) throw invalid('Choose a charge frequency.');
      await db.query(`INSERT INTO leasing_lease_charges(id,lease_id,description,amount_cents,frequency,starts_on,ends_on)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [crypto.randomUUID(), row.id, text(req.body.description, 'a charge description', 500), cents(req.body.amountCents, false), req.body.frequency, start, end]);
      await db.query('UPDATE leasing_leases SET revision=revision+1 WHERE id=$1', [row.id]);
      await event(db, req, 'recurring_charge_added', { lease: row.id });
    });
    res.status(201).json({ saved: true });
  }));
  app.post('/api/leasing/leases/:id/billing', ...route(async (req, res) => {
    await canBill(req);
    let inserted = 0;
    await withTransaction(async (db) => {
      const row = await lease(req, req.params.id, db, true);
      if (!row.activated_at) throw invalid('Activate the lease before running simulated recurring billing.');
      const through = date(req.body.through);
      if (through > new Date().toISOString().slice(0, 10)) throw invalid('Simulated billing cannot be posted in advance.');
      const end = [through, row.ends_on, row.terminated_on || '2100-12-31'].sort()[0];
      if (end < row.starts_on) throw invalid('No billable lease period has started.');
      const add = async (kind, amount, description, month, chargeId, entryDate) => {
        if (!Number(amount)) return;
        const result = await db.query(`INSERT INTO leasing_test_ledger(id,lease_id,kind,amount_cents,entry_date,description,service_month,recurring_charge_id,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`, [crypto.randomUUID(), row.id, kind, amount, entryDate, description, month, chargeId, req.user.id]);
        inserted += result.rowCount;
      };
      for (const month of periods(row.starts_on, end)) {
        const due = month === row.starts_on.slice(0, 7) ? row.starts_on : `${month}-01`;
        await add('rent', row.monthly_rental_cents, `TEST monthly rent ${month} (full month; no proration)`, month, null, due);
      }
      const charges = (await db.query('SELECT *,starts_on::text,ends_on::text FROM leasing_lease_charges WHERE lease_id=$1', [row.id])).rows;
      for (const charge of charges) {
        const start = charge.starts_on || row.starts_on, stop = [charge.ends_on || end, end].sort()[0];
        if (start > stop) continue;
        for (const month of charge.frequency === 'once_off' ? [start.slice(0, 7)] : periods(start, stop)) {
          await add('charge', charge.amount_cents, `TEST ${charge.description}`, month, charge.id, month === start.slice(0, 7) ? start : `${month}-01`);
        }
      }
      await event(db, req, 'simulated_billing_run', { lease: row.id }, { through, inserted });
    });
    res.json({ inserted, testMode: true });
  }));
  app.post('/api/leasing/leases/:id/ledger', ...route(async (req, res) => {
    await canBill(req);
    const kind = req.body.kind;
    if (!['charge', 'payment', 'credit', 'deposit_receipt', 'deposit_refund'].includes(kind)) throw invalid('Choose a simulated transaction type.');
    const amount = cents(req.body.amountCents, false), entryDate = date(req.body.date);
    if (entryDate > new Date().toISOString().slice(0, 10)) throw invalid('Transactions cannot be future dated.');
    await withTransaction(async (db) => {
      const row = await lease(req, req.params.id, db, true);
      if (kind === 'deposit_refund') {
        const balance = (await db.query(`SELECT COALESCE(SUM(CASE WHEN kind='deposit_receipt' THEN amount_cents ELSE -amount_cents END),0) AS balance
          FROM leasing_test_ledger WHERE lease_id=$1 AND kind IN ('deposit_receipt','deposit_refund') AND voided_at IS NULL`, [row.id])).rows[0].balance;
        if (amount > Number(balance)) throw invalid('The refund exceeds the simulated deposit held.');
      }
      await db.query(`INSERT INTO leasing_test_ledger(id,lease_id,kind,amount_cents,entry_date,description,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [crypto.randomUUID(), row.id, kind, amount, entryDate, text(req.body.description, 'a transaction description/reference', 500), req.user.id]);
      await event(db, req, 'simulated_transaction', { lease: row.id }, { kind, amountCents: amount });
    });
    res.status(201).json({ saved: true, testMode: true });
  }));
  app.post('/api/leasing/leases/:id/ledger/:entry/void', ...route(async (req, res) => {
    await canBill(req);
    await withTransaction(async (db) => {
      const row = await lease(req, req.params.id, db, true);
      const reason = text(req.body.reason, 'a void reason', 500);
      const result = await db.query('UPDATE leasing_test_ledger SET voided_at=NOW(),void_reason=$1 WHERE id=$2 AND lease_id=$3 AND voided_at IS NULL RETURNING kind,amount_cents',
        [reason, uuid(req.params.entry), row.id]);
      if (!result.rowCount) throw invalid('Transaction already voided or not found.', 409);
      const balance = (await db.query(`SELECT COALESCE(SUM(CASE WHEN kind='deposit_receipt' THEN amount_cents ELSE -amount_cents END),0) AS balance FROM leasing_test_ledger
        WHERE lease_id=$1 AND kind IN ('deposit_receipt','deposit_refund') AND voided_at IS NULL`, [row.id])).rows[0].balance;
      if (Number(balance) < 0) throw invalid('Void the related refund first; deposits held cannot become negative.');
      await event(db, req, 'simulated_transaction_voided', { lease: row.id }, { id: req.params.entry, reason });
    });
    res.json({ saved: true });
  }));
  app.post('/api/leasing/schedule', ...route(async (req, res) => {
    const id = crypto.randomUUID();
    await withTransaction(async (db) => {
      const u = await unit(req, req.body.unitId, db, true);
      const l = req.body.leaseId ? await lease(req, req.body.leaseId, db) : null;
      if (l && l.unit_id !== u.id) throw invalid('Choose a lease for the selected unit.');
      if (!['move_in', 'vacate', 'inspection', 'renovation', 'maintenance'].includes(req.body.kind)) throw invalid('Choose a schedule type.');
      const start = date(req.body.startsOn), end = date(req.body.endsOn);
      if (end < start) throw invalid('Schedule end must not precede its start.');
      await db.query(`INSERT INTO leasing_test_schedule(id,unit_id,lease_id,kind,title,starts_on,ends_on,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, u.id, l?.id || null, req.body.kind, text(req.body.title, 'a schedule title'), start, end, text(req.body.notes || '', 'schedule notes', 2000, false), req.user.id]);
      await event(db, req, 'schedule_created', { unit: u.id, lease: l?.id }, { id, kind: req.body.kind });
    });
    res.status(201).json({ id });
  }));
  app.put('/api/leasing/schedule/:id', ...route(async (req, res) => {
    await withTransaction(async (db) => {
      const row = (await db.query('SELECT * FROM leasing_test_schedule WHERE id=$1 FOR UPDATE', [uuid(req.params.id)])).rows[0];
      if (!row) throw invalid('Schedule not found.', 404);
      await unit(req, row.unit_id, db); revision(req.body, row);
      if (!['planned', 'in_progress', 'completed', 'cancelled'].includes(req.body.status)) throw invalid('Choose a schedule status.');
      const start = date(req.body.startsOn), end = date(req.body.endsOn);
      if (end < start) throw invalid('Schedule end must not precede start.');
      await db.query('UPDATE leasing_test_schedule SET starts_on=$1,ends_on=$2,status=$3,notes=$4,revision=revision+1,updated_at=NOW() WHERE id=$5',
        [start, end, req.body.status, text(req.body.notes || '', 'schedule notes', 2000, false), row.id]);
      await event(db, req, 'schedule_updated', { unit: row.unit_id, lease: row.lease_id }, { id: row.id, status: req.body.status });
    });
    res.json({ saved: true });
  }));
  async function report(req, leaseId) {
    const data = await snapshot(req), selected = leaseId ? await lease(req, leaseId) : null;
    const documents = selected ? await docs(selected.id) : [];
    const signatures = selected ? (await pool.query('SELECT * FROM leasing_test_signatures WHERE lease_id=$1 ORDER BY signed_at', [selected.id])).rows : [];
    const pdf = new PDFDocument({ margin: 40, bufferPages: true });
    const chunks = [];
    const done = new Promise((resolve, reject) => { pdf.on('data', (chunk) => chunks.push(chunk)); pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject); });
    pdf.fontSize(18).text('PrimeOps - Leasing TEST REPORT');
    pdf.fontSize(10).text('SIMULATED BILLING ONLY. No money collected or emails sent. Drawn signatures are not certified digital signatures.');
    pdf.text(`Client: ${companies.current().code} | Generated: ${new Date().toISOString()}`);
    for (const row of data.leases.filter((item) => !selected || item.id === selected.id)) {
      pdf.moveDown().fontSize(13).text(`${row.lease_number} - ${row.building_name} / ${row.unit_number}`);
      pdf.fontSize(10).text(`${row.starts_on} to ${row.ends_on} | ${row.status} | Monthly rent R${(Number(row.monthly_rental_cents) / 100).toFixed(2)} | Deposit R${(Number(row.deposit_required_cents) / 100).toFixed(2)}`);
      const person = (t) => `${t.first_name} ${t.last_name} (${t.tenant_code})`;
      const holder = data.tenants.find((t) => t.id === row.holder_id), coTenants = data.tenants.filter((t) => row.tenant_ids.includes(t.id) && t.id !== row.holder_id);
      pdf.text(`Lease holder: ${holder ? person(holder) : 'Not recorded'}${coTenants.length ? ` | Co-tenants: ${coTenants.map(person).join(', ')}` : ''}`);
      pdf.text(`Number of occupants: ${row.occupant_count}${row.occupant_names ? ` | Occupants: ${row.occupant_names.replace(/\s*\n\s*/g, '; ')}` : ''}`);
      if (row.notes) pdf.text(row.notes);
      const balance = data.balances.find((item) => item.leaseId === row.id);
      pdf.text(`TEST balance: R${(balance.balanceCents / 100).toFixed(2)} | TEST deposit held: R${(balance.depositCents / 100).toFixed(2)}`);
      for (const entry of data.ledger.filter((item) => item.lease_id === row.id)) pdf.text(`${entry.entry_date} | ${entry.kind} | R${(Number(entry.amount_cents) / 100).toFixed(2)} | ${entry.description}${entry.voided_at ? ' [VOID]' : ''}`);
    }
    if (!selected) {
      for (const p of data.properties) {
        pdf.moveDown().fontSize(13).text(`${p.name}: building unit audit`);
        pdf.fontSize(9).text('Unit number | Floor | Unit type | Bedrooms | Bathrooms | Parking bays | Allocated bays | Floor area (m2) | Audit status | Live occupancy');
        for (const u of data.units.filter((row) => row.property_id === p.id)) pdf.text([u.unit_number, u.floor, u.unit_type, u.bedrooms, u.bathrooms, u.parking_bays,
          u.allocated_parking_bays, u.floor_area, u.audit_status, u.occupancy_state].map((v) => v ?? '').join(' | '));
        const bays = data.parking.filter((row) => row.property_id === p.id);
        if (bays.length) {
          pdf.moveDown().fontSize(11).text(`${p.name}: parking audit`);
          pdf.fontSize(9).text('Bay number | Level | Bay type | Assigned unit | Status | Notes');
          for (const b of bays) pdf.text([b.bay_number, b.level, b.bay_type, b.unit_number, b.status, b.notes].map((v) => v ?? '').join(' | '));
        }
      }
      pdf.fontSize(10);
    }
    pdf.moveDown().text('Schedules');
    for (const row of data.schedule.filter((item) => !selected || item.lease_id === selected.id)) pdf.text(`${row.starts_on} to ${row.ends_on} | Unit ${row.unit_number} | ${row.kind}: ${row.title} | ${row.status} | ${row.notes}`);
    if (selected) {
      const currentDigest = digest(selected, documents);
      pdf.addPage().fontSize(14).text('Document and electronic-signature audit');
      pdf.fontSize(9).text(`Current version digest: ${currentDigest}`);
      for (const doc of documents) pdf.text(`${doc.original_name}\nSHA-256: ${doc.sha256}`);
      for (const s of signatures) {
        pdf.moveDown().text(`${s.party}: ${s.signer_name} | Account ${s.signer_id} | ${s.signed_at.toISOString()}`);
        pdf.text(`Signed digest: ${s.document_digest}\n${s.document_digest === currentDigest ? 'CURRENT VERSION' : 'HISTORICAL VERSION - not current acceptance'}\n${s.consent}`);
        const signed = s.signed_snapshot.lease;
        pdf.text(`Accepted terms: ${signed.lease_number} | ${signed.starts_on} to ${signed.ends_on} | rent ${signed.monthly_rental_cents} cents | deposit ${signed.deposit_required_cents} cents | revision ${signed.revision}`);
        if (signed.notes) pdf.text(signed.notes);
        for (const doc of s.signed_snapshot.documents) pdf.text(`Accepted document ${doc.original_name}: ${doc.sha256}`);
        for (const charge of s.signed_snapshot.charges) pdf.text(`Accepted charge ${charge.description}: ${charge.amount_cents} cents / ${charge.frequency}`);
        if (pdf.y > 650) pdf.addPage();
        pdf.image(s.signature, { fit: [180, 65] }); pdf.moveDown(5);
      }
      const events = (await pool.query('SELECT action,detail,created_at,actor_id FROM leasing_events WHERE lease_id=$1 ORDER BY id', [selected.id])).rows;
      pdf.addPage().text('Lease audit history');
      for (const e of events) pdf.fontSize(9).text(`${e.created_at.toISOString()} | ${e.actor_id} | ${e.action} | ${JSON.stringify(e.detail)}`);
    }
    pdf.end();
    return done;
  }
  app.get('/api/leasing/export/:format', ...route(async (req, res) => {
    if (!['pdf', 'xlsx', 'zip'].includes(req.params.format)) throw invalid('Choose PDF, Excel or lease ZIP.');
    const id = req.query.leaseId || null;
    if (id) await lease(req, id);
    if (req.params.format === 'pdf') return res.type('application/pdf').attachment('PrimeOps-Leasing-TEST.pdf').send(await report(req, id));
    if (req.params.format === 'zip') {
      if (!id) throw invalid('Choose a lease for its document package.');
      const zip = new JSZip();
      zip.file('PrimeOps-lease-summary-and-signatures.pdf', await report(req, id));
      for (const doc of (await pool.query('SELECT id,original_name,data FROM leasing_test_documents WHERE lease_id=$1', [id])).rows) zip.file(`${doc.id}-${doc.original_name}`, doc.data);
      for (const signature of (await pool.query('SELECT id,signature FROM leasing_test_signatures WHERE lease_id=$1', [id])).rows) zip.file(`signatures/${signature.id}.png`, signature.signature);
      return res.type('application/zip').attachment('PrimeOps-Lease-TEST.zip').send(await zip.generateAsync({ type: 'nodebuffer' }));
    }
    const data = await snapshot(req);
    const leaseIds = data.leases.filter((row) => !id || row.id === id).map((row) => row.id);
    const unitIds = data.units.map((row) => row.id), tenantIds = data.tenants.map((row) => row.id);
    const charges = (await pool.query('SELECT * FROM leasing_lease_charges WHERE lease_id=ANY($1::uuid[])', [leaseIds])).rows;
    const documents = (await pool.query(`SELECT id,lease_id,property_id,is_template,original_name,content_type,sha256,uploaded_by,created_at
      FROM leasing_test_documents WHERE lease_id=ANY($1::uuid[]) OR ($2 AND is_template)`, [leaseIds, req.user.role === 'admin' && !id])).rows;
    const signatures = (await pool.query(`SELECT id,lease_id,document_digest,signer_id,signer_name,party,consent,signed_at,signed_snapshot
      FROM leasing_test_signatures WHERE lease_id=ANY($1::uuid[])`, [leaseIds])).rows;
    const events = (await pool.query(`SELECT * FROM leasing_events WHERE lease_id=ANY($1::uuid[]) OR
      ($4 AND (unit_id=ANY($2::text[]) OR tenant_id=ANY($3::uuid[]) OR parking_bay_id=ANY($5::uuid[]))) ORDER BY id`,
      [leaseIds, unitIds, tenantIds, !id && req.user.role !== 'user', data.parking.map((row) => row.id)])).rows;
    const imports = req.user.role === 'admin' && !id ? (await pool.query('SELECT * FROM leasing_test_imports ORDER BY created_at')).rows : [];
    const sourceRows = imports.flatMap((batch) => batch.source.rows.map((cells, index) => ({
      batchId: batch.id, sourceName: batch.source_name, kind: batch.kind, importedBy: batch.imported_by,
      importedAt: batch.created_at, recordId: batch.record_ids[index], row: index + 1,
      columns: batch.source.columns, ...Object.fromEntries(cells.map((cell, i) => [`source_${i + 1}`, cell])),
      ...Object.fromEntries(Object.entries(batch.source.reviewedRows[index]).map(([field, value]) => [`reviewed_${field}`, value]))
    })));
    const buildingName = (propertyId) => data.properties.find((p) => p.id === propertyId)?.name || '';
    const units = data.units.map((u) => ({ unit_number: u.unit_number, floor: u.floor, unit_type: u.unit_type, bedrooms: u.bedrooms, bathrooms: u.bathrooms,
      parking_bays: u.parking_bays, floor_area: u.floor_area, audit_status: u.audit_status, allocated_parking_bays: u.allocated_parking_bays,
      occupancy_state: u.occupancy_state, building: buildingName(u.property_id), ...u }));
    const parking = data.parking.map((b) => ({ bay_number: b.bay_number, level: b.level, bay_type: b.bay_type, unit_number: b.unit_number || '',
      status: b.status, notes: b.notes, building: buildingName(b.property_id), ...b }));
    const book = new ExcelJS.Workbook();
    book.creator = 'PrimeOps';
    for (const [title, rows] of Object.entries({ Properties: data.properties, Portfolios: data.portfolios, 'Units (building audit)': units, 'Parking audit': parking, Tenants: data.tenants,
      Leases: data.leases.filter((row) => !id || row.id === id), 'TEST ledger': data.ledger.filter((row) => !id || row.lease_id === id),
      'TEST balances': data.balances.filter((row) => !id || row.leaseId === id), Schedules: data.schedule.filter((row) => !id || row.lease_id === id),
      Reminders: data.reminders.filter((row) => !id || row.leaseId === id), 'Recurring charges': charges, Documents: documents,
      'Signature audit': signatures, 'Activity audit': events, 'Import source rows': sourceRows })) {
      const sheet = book.addWorksheet(title);
      sheet.addRow(['PRIMEOPS TEST DATA - SIMULATED BILLING - NO COLLECTION']);
      const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      sheet.addRow(keys);
      for (const row of rows) sheet.addRow(keys.map((key) => {
        const value = row[key];
        return value instanceof Date ? value : value && typeof value === 'object' ? JSON.stringify(value) : value ?? '';
      }));
      sheet.views = [{ state: 'frozen', ySplit: 2 }];
    }
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('PrimeOps-Leasing-TEST.xlsx').send(Buffer.from(await book.xlsx.writeBuffer()));
  }, false));
}
module.exports = { mount, date, cents, documentInput, digest, periods, signatureInput, signatureConsent, unitAuditInput };
