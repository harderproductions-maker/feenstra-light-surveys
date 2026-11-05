const crypto = require('node:crypto');
const managerRoles = require('../www/manager-roles.json');
const { validateTemplate } = require('./check-templates.cjs');
const schema = `
ALTER TABLE operation_records ADD COLUMN IF NOT EXISTS asset_checklist JSONB;
ALTER TABLE operation_records ADD COLUMN IF NOT EXISTS asset_source JSONB;
CREATE TABLE IF NOT EXISTS asset_activity (
  id UUID PRIMARY KEY,
  asset_id UUID NOT NULL REFERENCES operation_records(id),
  actor_id TEXT NOT NULL REFERENCES app_users(id),
  kind TEXT NOT NULL CHECK(kind IN ('inspection','fault','repair','maintenance','transfer','checklist')),
  happened_on DATE NOT NULL,
  detail JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS asset_activity_asset ON asset_activity(asset_id,created_at);
ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS source_asset_id UUID REFERENCES operation_records(id);
ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS source_asset_activity_id UUID REFERENCES asset_activity(id);
ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS asset_snapshot JSONB;
CREATE INDEX IF NOT EXISTS maintenance_tickets_asset ON maintenance_tickets(source_asset_id);
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_tickets_asset_activity ON maintenance_tickets(source_asset_activity_id) WHERE source_asset_activity_id IS NOT NULL;
`;
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const today = () => new Date().toISOString().slice(0, 10);
function calendarDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString().slice(0, 10) !== value) throw invalid(`Enter a valid ${label}.`);
  return value;
}
function defaultChecklist(data) {
  const identity = `${data.name} ${data.category}`.toLowerCase();
  const additional = [
    [/pump|water|tank|plumb/, ['Visible pipes, connections and seals checked for leaks', 'Unusual noise/vibration and recorded service requirements reviewed']],
    [/generat|electri|power/, ['Visible cables, labels and enclosures checked without opening live equipment', 'Service records and recorded alarm indications reviewed']],
    [/fire|extinguisher|hose/, ['Access, identification, visible indicator and service label checked', 'Expiry/service requirements referred to a competent fire-service provider']],
    [/gate|motor|security|access|cctv/, ['Mountings, obstructions and visible damage checked', 'Safety/access functions and service records reviewed by an authorised person']],
    [/air.?condition|hvac|ventilat/, ['Visible vents, filters and drainage checked for obstruction or leaks', 'Service records and reported operation/noise reviewed']]
  ].filter(([pattern]) => pattern.test(identity)).flatMap(([, questions]) => questions);
  return { title: `${data.name} inspection`.slice(0, 150), questions: [
    `Asset identity matches tag ${data.assetTag}`,
    'Visible condition is satisfactory; no damage or leaks',
    'Normal operation checked safely by an authorised person',
    'Guards, labels and accessible safety features are intact',
    'Service/maintenance requirements reviewed',
    ...additional
  ].map((label, index) => ({ id: `default-${index}`, label, type: 'pass-fail-na', required: true, photo: false })) };
}
function sourceData(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value.columns) || !value.columns.length || value.columns.length > 30 || !Array.isArray(value.cells)
      || value.cells.length !== value.columns.length || [...value.columns, ...value.cells].some((cell) => typeof cell !== 'string' || cell.length > 2000)) {
    throw invalid('Imported asset source must have matching columns/cells (maximum 30 columns, 2000 characters per cell).');
  }
  return { columns: value.columns, cells: value.cells };
}
function answersFor(checklist, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw invalid('Complete the inspection checklist.');
  const result = {};
  for (const question of checklist.questions) {
    const value = answers[question.id];
    if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw invalid(`Answer: ${question.label}`);
    const choices = { 'pass-fail-na': ['pass', 'fail', 'na'], 'yes-no': ['yes', 'no'], 'yes-no-na': ['yes', 'no', 'na'] };
    if (choices[question.type] && !choices[question.type].includes(value)) throw invalid(`Choose a valid answer: ${question.label}`);
    if (['number', 'rating'].includes(question.type) && (!Number.isFinite(Number(value)) || (question.type === 'rating' && (Number(value) < 0 || Number(value) > 10)))) throw invalid(`Enter a valid number: ${question.label}`);
    if (question.type === 'date') calendarDate(value, question.label);
    result[question.id] = value.trim();
  }
  return result;
}
function meterHistory(rows) {
  const previous = new Map(), values = new Map();
  for (const row of [...rows].filter((item) => item.kind === 'meters').sort((a, b) => a.data.readAt.localeCompare(b.data.readAt))) {
    const data = row.data, key = `${row.property_id}:${data.meterReference.trim().toLowerCase()}:${data.meterType}:${data.unit.trim().toLowerCase()}`;
    const prior = previous.get(key);
    const consumption = prior && data.reset !== 'yes' && data.reading >= prior.reading
      ? Number((data.reading - prior.reading).toFixed(6)) : null;
    values.set(row.id, { previousReading: prior?.reading ?? null, previousReadAt: prior?.readAt ?? null, consumption,
      readingWarning: prior && data.reset !== 'yes' && data.reading < prior.reading ? 'Reading decreased; check for an unrecorded reset or incorrect reading.' : '' });
    previous.set(key, data);
  }
  return rows.map((row) => row.kind === 'meters' ? { ...row, ...values.get(row.id) } : row);
}
function mount(app, { pool, withTransaction, authenticate, scope, validateData, route, isValidJpeg }) {
  const base = '/api/operations/:kind';
  const management = (req) => { if (!['admin', ...managerRoles].includes(req.user.role)) throw invalid('Only client administrators/managers can import, transfer assets or edit checklists.', 403); };
  async function asset(req, client) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) throw invalid('Choose a valid asset.');
    const { module, propertyIds } = await scope(req, client);
    if (module.id !== 'assets') throw invalid('This action is for assets only.', 404);
    const { rows } = await client.query("SELECT * FROM operation_records WHERE id=$1 AND kind='assets' FOR UPDATE", [req.params.id]);
    if (!rows[0] || !propertyIds.includes(rows[0].property_id)) throw invalid('Asset not found in your building access.', 404);
    if (!Number.isSafeInteger(req.body?.revision) || rows[0].revision !== req.body.revision) throw invalid('This asset changed. Refresh before saving.', 409);
    return { record: rows[0], propertyIds };
  }
  async function recordActivity(client, req, record, kind, day, detail) {
    await client.query(`INSERT INTO asset_activity(id,asset_id,actor_id,kind,happened_on,detail) VALUES($1,$2,$3,$4,$5,$6)`,
      [crypto.randomUUID(), record.id, req.user.id, kind, day, detail]);
    await client.query('UPDATE operation_records SET revision=revision+1,updated_at=NOW() WHERE id=$1', [record.id]);
    await client.query('INSERT INTO operation_events(record_id,actor_id,action) VALUES($1,$2,$3)', [record.id, req.user.id, kind]);
  }
  function photos(value) {
    if (!Array.isArray(value) || value.length > 5) throw invalid('Attach at most five JPEG evidence photos.');
    return value.map((photo) => {
      if (typeof photo !== 'string' || photo.length > 683000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(photo)) throw invalid('Evidence photos must be JPEG images no larger than 500 KB each.');
      const bytes = Buffer.from(photo.slice(23), 'base64');
      if (bytes.length > 500 * 1024 || !isValidJpeg(bytes)) throw invalid('An evidence photo is not a complete JPEG.');
      return photo;
    });
  }
  app.post(`${base}/import`, authenticate, route(async (req, res) => {
    management(req);
    const rows = req.body?.assets;
    if (!Array.isArray(rows) || !rows.length || rows.length > 500 || req.body?.reviewed !== true
        || JSON.stringify(rows).length > 5 * 1024 * 1024) throw invalid('Review 1-500 assets before importing (maximum 5 MB of reviewed data).');
    await withTransaction(async (client) => {
      const { module, propertyIds } = await scope(req, client);
      if (module.id !== 'assets') throw invalid('Only asset registers can be imported here.', 404);
      for (const [index, row] of rows.entries()) {
        if (!propertyIds.includes(row?.propertyId)) throw invalid(`Row ${index + 1}: choose an assigned building.`, 403);
        const data = validateData(module, row.data), id = crypto.randomUUID();
        await client.query(`INSERT INTO operation_records(id,kind,property_id,created_by,data,status,asset_checklist,asset_source)
          VALUES($1,'assets',$2,$3,$4,'active',$5,$6)`,
          [id, row.propertyId, req.user.id, data, defaultChecklist(data), sourceData(row.source)]);
        await client.query("INSERT INTO operation_events(record_id,actor_id,action) VALUES($1,$2,'imported')", [id, req.user.id]);
      }
    });
    res.status(201).json({ imported: rows.length });
  }));
  app.get(`${base}/:id/history`, authenticate, route(async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) throw invalid('Choose a valid asset.');
    const { module, propertyIds } = await scope(req);
    if (module.id !== 'assets') throw invalid('Asset history not found.', 404);
    const { rows: assets } = await pool.query("SELECT * FROM operation_records WHERE id=$1 AND kind='assets' AND property_id=ANY($2::text[])", [req.params.id, propertyIds]);
    if (!assets[0]) throw invalid('Asset not found in your building access.', 404);
    const { rows } = await pool.query(`SELECT a.id,a.kind,a.happened_on::text AS "happenedOn",a.detail,a.created_at AS "createdAt",u.display_name AS actor
      FROM asset_activity a JOIN app_users u ON u.id=a.actor_id WHERE a.asset_id=$1 ORDER BY a.happened_on DESC,a.created_at DESC`, [req.params.id]);
    const { canUseSection } = await import('../www/account-access.mjs');
    let tickets = [];
    if (['admin', ...managerRoles].includes(req.user.role) && canUseSection(req.user, 'tickets')) {
      const result = await pool.query(`SELECT id,subject,status,created_at AS "createdAt",completed_at AS "completedAt",source_asset_activity_id AS "activityId"
        FROM maintenance_tickets WHERE source_asset_id=$1 AND property_id=ANY($2::text[]) ORDER BY created_at DESC`, [req.params.id, propertyIds]);
      tickets = result.rows;
    }
    res.json({ asset: assets[0], checklist: assets[0].asset_checklist || defaultChecklist(assets[0].data), history: rows, tickets });
  }));
  app.put(`${base}/:id/checklist`, authenticate, route(async (req, res) => {
    management(req);
    await withTransaction(async (client) => {
      const { record } = await asset(req, client);
      let validated;
      try { validated = validateTemplate({ ...req.body.checklist, propertyIds: [record.property_id] }); }
      catch (error) { throw invalid(error.message); }
      const checklist = { title: validated.title, questions: validated.questions, ...(validated.sourceColumns ? { sourceColumns: validated.sourceColumns } : {}) };
      await client.query('UPDATE operation_records SET asset_checklist=$1 WHERE id=$2', [checklist, record.id]);
      await recordActivity(client, req, record, 'checklist', today(), { checklist });
    });
    res.json({ saved: true });
  }));
  app.post(`${base}/:id/activity`, authenticate, route(async (req, res) => {
    await withTransaction(async (client) => {
      const { record } = await asset(req, client), body = req.body;
      if (record.status === 'retired') throw invalid('This asset is retired. Reactivate it before recording work.', 409);
      if (!['inspection', 'fault', 'repair', 'maintenance'].includes(body.kind)) throw invalid('Choose an inspection, fault, repair or maintenance entry.');
      const day = calendarDate(body.happenedOn, 'activity date');
      if (day > today()) throw invalid('Completed work cannot be dated in the future.');
      if (typeof body.notes !== 'string' || body.notes.trim().length > 4000 || (body.kind !== 'inspection' && !body.notes.trim())) throw invalid('Enter work/fault notes (up to 4000 characters).');
      const detail = { notes: body.notes.trim(), photos: photos(body.photos ?? []), asset: { ...record.data, propertyId: record.property_id } };
      if (body.kind === 'inspection') {
        const checklist = record.asset_checklist || defaultChecklist(record.data);
        detail.checklist = checklist; detail.answers = answersFor(checklist, body.answers);
        if (checklist.questions.some((question) => question.photo) && !detail.photos.length) throw invalid('This inspection checklist requires photographic evidence.');
        if (!['good', 'fair', 'poor', 'unserviceable'].includes(body.condition)) throw invalid('Choose the inspected asset condition.');
        detail.condition = body.condition;
        if (record.data.lastInspectionOn && day < record.data.lastInspectionOn) throw invalid('Inspection date is before the last inspection. Add a maintenance note for older work.');
        let next = body.nextInspectionOn ? calendarDate(body.nextInspectionOn, 'next inspection date') : '';
        if (!next && record.data.inspectionIntervalDays) {
          const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + record.data.inspectionIntervalDays); next = date.toISOString().slice(0, 10);
        }
        if (next && next <= day) throw invalid('Next inspection must follow the completed inspection.');
        detail.nextInspectionOn = next;
        await client.query('UPDATE operation_records SET data=$1 WHERE id=$2', [{ ...record.data, condition: body.condition, lastInspectionOn: day, nextInspectionOn: next }, record.id]);
      }
      await recordActivity(client, req, record, body.kind, day, detail);
    });
    res.status(201).json({ saved: true });
  }));
  app.post(`${base}/:id/transfer`, authenticate, route(async (req, res) => {
    management(req);
    await withTransaction(async (client) => {
      const { record, propertyIds } = await asset(req, client), body = req.body;
      if (!propertyIds.includes(body.propertyId)) throw invalid('You need access to both the source and destination building.', 403);
      if (typeof body.location !== 'string' || body.location.trim().length > 150 || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 2000) throw invalid('Enter a destination location and transfer reason.');
      const { rows: buildings } = await client.query('SELECT id,name FROM app_properties WHERE id=ANY($1::text[])', [[record.property_id, body.propertyId]]);
      const detail = { fromBuilding: buildings.find((item) => item.id === record.property_id).name,
        toBuilding: buildings.find((item) => item.id === body.propertyId).name, fromLocation: record.data.location, toLocation: body.location.trim(), reason: body.reason.trim() };
      await client.query('UPDATE operation_records SET property_id=$1,data=$2 WHERE id=$3', [body.propertyId, { ...record.data, location: body.location.trim() }, record.id]);
      await recordActivity(client, req, record, 'transfer', today(), detail);
    });
    res.json({ saved: true });
  }));
  return { photos };
}
module.exports = { schema, calendarDate, defaultChecklist, sourceData, answersFor, meterHistory, mount };
