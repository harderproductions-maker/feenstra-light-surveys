const crypto = require('node:crypto');
const catalog = require('../www/operations-catalog.json');
const tracking = require('./operations-tracking.cjs');
const managerRoles = require('../www/manager-roles.json');

const schema = `CREATE TABLE IF NOT EXISTS company_operations_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  resident_mode TEXT NOT NULL DEFAULT 'students' CHECK(resident_mode IN ('students','tenants','both')),
  security_phone TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1
);
INSERT INTO company_operations_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS operation_records (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('security','residents','meters','assets','incidents','contractors')),
  property_id TEXT NOT NULL REFERENCES app_properties(id),
  created_by TEXT NOT NULL REFERENCES app_users(id),
  data JSONB NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS operation_records_scope_idx ON operation_records(kind,property_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS operation_asset_tag_unique ON operation_records(property_id,lower(data->>'assetTag')) WHERE kind='assets';
CREATE TABLE IF NOT EXISTS operation_events (
  id BIGSERIAL PRIMARY KEY,
  record_id UUID NOT NULL REFERENCES operation_records(id),
  actor_id TEXT NOT NULL REFERENCES app_users(id),
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);${tracking.schema}`;
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const manager = (user) => ['admin', ...managerRoles].includes(user.role);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function settings(pool) {
  const { rows } = await pool.query(`SELECT resident_mode AS "residentMode",security_phone AS "securityPhone",revision
    FROM company_operations_settings WHERE id=1`);
  if (!rows[0]) throw invalid('Client settings are unavailable. Contact the administrator.', 503);
  return rows[0];
}
function validateData(module, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Enter the record details.');
  const data = {};
  for (const field of module.fields) {
    const raw = input[field.id];
    if (raw === undefined || raw === '') {
      if (field.required) throw invalid(`${field.label} is required.`);
      data[field.id] = '';
      continue;
    }
    if (field.type === 'number') {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > Number.MAX_SAFE_INTEGER) throw invalid(`Enter a valid non-negative ${field.label.toLowerCase()}.`);
      data[field.id] = raw;
      continue;
    }
    if (typeof raw !== 'string' || (field.max && raw.trim().length > field.max) || (field.required && !raw.trim())) throw invalid(`Enter a valid ${field.label.toLowerCase()}.`);
    const value = raw.trim();
    if (field.type === 'select' && !field.options.includes(value)) throw invalid(`Choose a valid ${field.label.toLowerCase()}.`);
    if (field.type === 'datetime-local' && (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) throw invalid(`Enter a valid ${field.label.toLowerCase()}.`);
    if (field.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw invalid(`Enter a valid ${field.label.toLowerCase()}.`);
    if (field.type === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw invalid('Enter a valid email address.');
    data[field.id] = value;
  }
  if (module.id === 'contractors' && data.endsOn < data.startsOn) throw invalid('Work end date cannot be before its start.');
  if (module.id === 'assets' && data.inspectionIntervalDays !== '' && (!Number.isInteger(data.inspectionIntervalDays) || data.inspectionIntervalDays > 3650)) throw invalid('Inspection interval must be a whole number between 0 and 3650 days.');
  if (module.id === 'meters' && data.reset === 'yes' && !data.notes) throw invalid('Explain the meter reset/replacement in notes.');
  return data;
}
function mount(app, { pool, withTransaction, authenticate, accessibleProperties, apiError, isValidJpeg }) {
  const route = (action) => async (req, res) => {
    try { await action(req, res); }
    catch (error) {
      console.error('Client operations failed:', error.message);
      apiError(res, error.code === '23505' ? 409 : error.status || 503, error.code === '23505'
        ? 'This asset tag already exists in this building.' : error.status ? error.message : 'Could not save or load client operations. Reconnect and retry.');
    }
  };
  app.get('/api/company-settings', authenticate, route(async (_req, res) => res.json(await settings(pool))));
  app.put('/api/company-settings', authenticate, route(async (req, res) => {
    if (req.user.role !== 'admin') throw invalid('Only the client administrator can change company settings.', 403);
    const { residentMode, securityPhone, revision } = req.body || {};
    if (!['students', 'tenants', 'both'].includes(residentMode) || typeof securityPhone !== 'string'
        || (securityPhone !== '' && (!/^\+?[0-9 ()-]{3,40}$/.test(securityPhone) || securityPhone.replace(/\D/g, '').length < 3)) || !Number.isSafeInteger(revision)) {
      throw invalid('Choose Students, Tenants or Both and a valid security phone number (or leave it blank).');
    }
    const { rowCount } = await pool.query(`UPDATE company_operations_settings SET resident_mode=$1,security_phone=$2,revision=revision+1 WHERE id=1 AND revision=$3`,
      [residentMode, securityPhone.trim(), revision]);
    if (!rowCount) throw invalid('Company settings changed. Refresh before saving.', 409);
    res.json(await settings(pool));
  }));
  async function scope(req, database = pool) {
    const module = catalog.find((item) => item.id === req.params.kind);
    if (!module) throw invalid('Unknown operation type.', 404);
    if ((['assets', 'meters'].includes(module.id) && !['admin', ...managerRoles, 'maintenance_assistant'].includes(req.user.role))
        || (module.id === 'contractors' && !manager(req.user))) throw invalid('Your role cannot use this operation.', 403);
    const properties = await accessibleProperties(req.user, database);
    return { module, propertyIds: properties.map((property) => property.id) };
  }
  const evidence = tracking.mount(app, { pool, withTransaction, authenticate, scope, validateData, route, isValidJpeg });
  app.get('/api/operations/:kind/:id/photos', authenticate, route(async (req, res) => {
    const { module, propertyIds } = await scope(req);
    if (module.id !== 'meters' || !uuid.test(req.params.id)) throw invalid('Meter photo not found.', 404);
    const { rows } = await pool.query(`SELECT data->'photos' AS photos FROM operation_records WHERE id=$1 AND kind='meters' AND property_id=ANY($2::text[])`, [req.params.id, propertyIds]);
    if (!rows[0]) throw invalid('Meter reading not found in your building access.', 404);
    res.json({ photos: rows[0].photos || [] });
  }));
  app.get('/api/operations/:kind', authenticate, route(async (req, res) => {
    const { module, propertyIds } = await scope(req);
    const all = manager(req.user) || ['assets', 'meters'].includes(module.id);
    const { rows } = await pool.query(`SELECT r.*,r.data-'photos' AS data,COALESCE(jsonb_array_length(r.data->'photos'),0) AS photo_count,p.name AS building_name,u.display_name AS created_by_name,u.unit_number,
      COALESCE((SELECT json_agg(json_build_object('action',e.action,'at',e.created_at,'actor',actor.display_name) ORDER BY e.id)
        FROM operation_events e JOIN app_users actor ON actor.id=e.actor_id WHERE e.record_id=r.id),'[]'::json) AS events
      FROM operation_records r JOIN app_properties p ON p.id=r.property_id JOIN app_users u ON u.id=r.created_by
      WHERE r.kind=$1 AND r.property_id=ANY($2::TEXT[]) AND ($3 OR r.created_by=$4) ORDER BY r.created_at DESC`,
    [module.id, propertyIds, all, req.user.id]);
    res.json({ records: tracking.meterHistory(rows), settings: await settings(pool) });
  }));
  app.post('/api/operations/:kind', authenticate, route(async (req, res) => {
    const record = await withTransaction(async (client) => {
      const { module, propertyIds } = await scope(req, client);
      if (!propertyIds.includes(req.body?.propertyId)) throw invalid('Choose one of your assigned buildings.', 403);
      const data = validateData(module, req.body?.data);
      if (module.id === 'meters') {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`meter:${req.body.propertyId}:${data.meterReference.toLowerCase()}`]);
        const { rows } = await client.query(`SELECT data FROM operation_records WHERE kind='meters' AND property_id=$1 AND lower(data->>'meterReference')=$2 ORDER BY data->>'readAt' DESC LIMIT 1`,
          [req.body.propertyId, data.meterReference.toLowerCase()]);
        const last = rows[0]?.data;
        if (Date.parse(data.readAt) > Date.now() + 60000) throw invalid('Meter readings cannot be dated in the future.');
        if (last && (last.meterType !== data.meterType || last.unit.toLowerCase() !== data.unit.toLowerCase())) throw invalid('This meter already uses a different type/unit. Keep the existing units or use a new meter reference.');
        if (last && data.readAt <= last.readAt) throw invalid('Reading date must follow this meter\'s latest reading. Duplicate or backdated readings are not saved.', 409);
        if (last && data.reading < last.reading && data.reset !== 'yes') throw invalid('Reading decreased. Correct it or explicitly record a reset/replacement with notes.');
        const photos = evidence.photos(req.body?.photos ?? []);
        if (photos.length > 1) throw invalid('Attach one clear meter photo per reading.');
        data.photos = photos;
      }
      const id = crypto.randomUUID();
      const { rows } = await client.query(`INSERT INTO operation_records(id,kind,property_id,created_by,data,status)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [id, module.id, req.body.propertyId, req.user.id, data, module.initialStatus]);
      await client.query('INSERT INTO operation_events(record_id,actor_id,action) VALUES($1,$2,$3)', [id, req.user.id, module.initialStatus]);
      return rows[0];
    });
    res.status(201).json({ record });
  }));
  app.put('/api/operations/:kind/:id', authenticate, route(async (req, res) => {
    if (!uuid.test(req.params.id)) throw invalid('Choose a valid record.');
    const record = await withTransaction(async (client) => {
      const { module, propertyIds } = await scope(req, client);
      const { rows } = await client.query('SELECT * FROM operation_records WHERE id=$1 AND kind=$2 FOR UPDATE', [req.params.id, module.id]);
      const previous = rows[0];
      const owns = previous?.created_by === req.user.id;
      if (!previous || !propertyIds.includes(previous.property_id) || (!manager(req.user) && !owns && !['assets', 'meters'].includes(module.id))) throw invalid('Record not found in your building access.', 404);
      if (!Number.isSafeInteger(req.body?.revision) || previous.revision !== req.body.revision) throw invalid('This record changed. Refresh before saving.', 409);
      let data = previous.data, next = previous.status, event;
      if (req.body.data !== undefined) {
        if (!['assets', 'contractors'].includes(module.id) || !manager(req.user)) throw invalid('Only managers can edit asset or contractor details.', 403);
        data = validateData(module, req.body.data);
        if (module.id === 'assets' && previous.data.lastInspectionOn) data.lastInspectionOn = previous.data.lastInspectionOn;
        if (module.id === 'assets' && data.nextInspectionOn && data.lastInspectionOn && data.nextInspectionOn <= data.lastInspectionOn) throw invalid('Next inspection date must follow the last completed inspection.');
        event = 'details_updated';
      } else {
        next = req.body?.status;
        const cancelOwn = module.id === 'residents' && owns && next === 'cancelled';
        const maintainAsset = module.id === 'assets' && req.user.role === 'maintenance_assistant';
        if (!manager(req.user) && !cancelOwn && !maintainAsset) throw invalid('A client administrator or manager must review this record.', 403);
        if (!module.transitions[previous.status]?.includes(next)) throw invalid('That status change is not allowed. Visitors must be approved before check-in.', 409);
        event = next;
      }
      const { rows: updated } = await client.query(`UPDATE operation_records SET data=$1,status=$2,revision=revision+1,updated_at=NOW() WHERE id=$3 RETURNING *`,
        [data, next, previous.id]);
      await client.query('INSERT INTO operation_events(record_id,actor_id,action) VALUES($1,$2,$3)', [previous.id, req.user.id, event]);
      return updated[0];
    });
    res.json({ record });
  }));
}
module.exports = { schema, settings, validateData, mount };
