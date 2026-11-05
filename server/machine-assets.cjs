const crypto = require('node:crypto');

const schema = `
  CREATE TABLE IF NOT EXISTS appliance_assets (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL REFERENCES app_properties(id),
    appliance_type TEXT NOT NULL CHECK(appliance_type IN ('Washer','Dryer')),
    machine_number TEXT NOT NULL,
    machine_key TEXT NOT NULL,
    serial_number TEXT NOT NULL,
    model_number TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    retired_at TIMESTAMPTZ,
    last_checked_at TIMESTAMPTZ NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS appliance_asset_slot ON appliance_assets(property_id,appliance_type,machine_key) WHERE active;
  CREATE UNIQUE INDEX IF NOT EXISTS appliance_asset_serial ON appliance_assets(UPPER(serial_number));
  CREATE TABLE IF NOT EXISTS appliance_part_events (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL REFERENCES appliance_reports(id),
    asset_id TEXT NOT NULL REFERENCES appliance_assets(id),
    part_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('ordered','replaced')),
    quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 999),
    created_by TEXT NOT NULL REFERENCES app_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

const fail = (status, message) => Object.assign(new Error(message), { status });

async function recordEntries(client, body, entries) {
  const { machineNumberKey } = await import('../www/laundry.mjs');
  // Serialize registration and replacement so concurrent/offline checks cannot steal a serial or slot.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('appliance-asset-registration'))");
  for (const entry of entries) {
    const key = machineNumberKey(entry.machineNumber);
    const { rows } = await client.query(`SELECT * FROM appliance_assets
      WHERE property_id=$1 AND appliance_type=$2 AND machine_key=$3 AND active FOR UPDATE`,
    [body.propertyId, body.applianceType, key]);
    let asset = rows[0];
    if (!entry.serialNumber) throw fail(400, `Enter the serial number for machine ${entry.machineNumber}.`);
    const serial = entry.serialNumber.trim();
    const checkedAt = entry.checkAudit.completed.capturedAt;
    if (asset && asset.serial_number.toUpperCase() !== serial.toUpperCase()) {
      if (entry.replaceAssetId !== asset.id) throw fail(409, `Machine ${entry.machineNumber} has a different serial. Choose Replace machine explicitly.`);
      if (Date.parse(checkedAt) < Date.parse(asset.last_checked_at)) throw fail(409, 'A newer check exists. Refresh the asset register before replacing this machine.');
      await client.query('UPDATE appliance_assets SET active=FALSE,retired_at=$2 WHERE id=$1', [asset.id, checkedAt]);
      asset = null;
    } else if (entry.replaceAssetId) {
      throw fail(409, 'The replacement machine changed or its serial is unchanged. Refresh the asset register.');
    }
    if (!asset) {
      const duplicate = await client.query('SELECT id FROM appliance_assets WHERE UPPER(serial_number)=UPPER($1)', [serial]);
      if (duplicate.rows.length) throw fail(409, 'This serial number is already registered. Verify the building, machine number and serial.');
      const result = await client.query(`INSERT INTO appliance_assets
        (id,property_id,appliance_type,machine_number,machine_key,serial_number,model_number,registered_at,last_checked_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
      [crypto.randomUUID(), body.propertyId, body.applianceType, entry.machineNumber, key, serial, entry.modelNumber, checkedAt]);
      asset = result.rows[0];
    } else {
      if (Date.parse(checkedAt) < Date.parse(asset.registered_at)) throw fail(409, 'This check predates the registered machine. Review the saved draft.');
      await client.query(`UPDATE appliance_assets SET model_number=CASE WHEN last_checked_at <= $2 THEN $3 ELSE model_number END,
        last_checked_at=GREATEST(last_checked_at,$2) WHERE id=$1`, [asset.id, checkedAt, entry.modelNumber]);
    }
    entry.assetId = asset.id;
  }
}

function mount(app, { pool, authenticate, requireAdmin, requireReports, accessibleProperties, hasFullAccess, withTransaction, apiError }) {
  async function load(user) {
    const properties = await accessibleProperties(user);
    const ids = properties.map((property) => property.id);
    const [assets, reports, events] = await Promise.all([
      pool.query('SELECT * FROM appliance_assets WHERE property_id=ANY($1::TEXT[]) ORDER BY machine_number,registered_at', [ids]),
      pool.query(`SELECT id,property_id,created_at,
        (SELECT jsonb_agg(jsonb_build_object('assetId',e->'assetId','machineNumber',e->'machineNumber','serialNumber',e->'serialNumber',
          'status',e->'status','parts',e->'parts','checkAudit',jsonb_build_object('completed',jsonb_build_object('capturedAt',e->'checkAudit'->'completed'->'capturedAt'))))
          FROM jsonb_array_elements(r.entries) e) AS entries
        FROM appliance_reports r WHERE property_id=ANY($1::TEXT[]) ORDER BY created_at,id`, [ids]),
      pool.query(`SELECT e.* FROM appliance_part_events e JOIN appliance_assets a ON a.id=e.asset_id
        WHERE a.property_id=ANY($1::TEXT[]) ORDER BY e.created_at,e.id`, [ids])
    ]);
    const { assetSummary } = await import('../www/machine-assets.mjs');
    return { properties, assets: assets.rows, reports: reports.rows, events: events.rows, ...assetSummary(assets.rows, reports.rows, events.rows) };
  }

  app.get('/api/appliance-assets', authenticate, requireReports, async (req, res) => {
    try {
      const data = await load(req.user);
      if (!hasFullAccess(req.user)) {
        data.reports = data.reports.map((report) => ({ ...report, entries: report.entries?.map(({ checkAudit, ...entry }) => entry) }));
        const withoutCheckTimes = ({ registered_at, retired_at, last_checked_at, last_checked, ...asset }) => asset;
        data.assets = data.assets.map(withoutCheckTimes);
        data.machines = data.machines.map(withoutCheckTimes);
      }
      res.set('Cache-Control', 'private, no-store');
      return res.json(data);
    } catch (error) {
      console.error('Asset register load failed:', error.message);
      return apiError(res, 503, 'Could not load the machine asset register.');
    }
  });

  app.post('/api/appliance-assets/parts', authenticate, requireReports, async (req, res) => {
    const { reportId, assetId, partId, action, quantity } = req.body || {};
    if (![reportId, assetId, partId].every((id) => typeof id === 'string' && id.length > 0 && id.length <= 100)
        || !['ordered', 'replaced'].includes(action) || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      return apiError(res, 400, 'Choose a requested part, ordered/replaced action and quantity from 1 to 999.');
    }
    if (action === 'ordered' && !hasFullAccess(req.user)) return apiError(res, 403, 'Only MMs and admins can mark parts ordered.');
    try {
      const properties = await accessibleProperties(req.user);
      const event = await withTransaction(async (client) => {
        const { rows } = await client.query('SELECT * FROM appliance_reports WHERE id=$1 FOR UPDATE', [reportId]);
        const report = rows[0];
        if (!report || !properties.some((property) => property.id === report.property_id)) throw fail(404, 'Part request not found in your buildings.');
        const entry = report.entries?.find((entry) => entry.assetId === assetId);
        const part = entry?.parts.find((part) => part.id === partId);
        if (!part) throw fail(404, 'Requested machine part not found.');
        const totals = await client.query(`SELECT action,SUM(quantity)::integer AS quantity FROM appliance_part_events
          WHERE report_id=$1 AND asset_id=$2 AND part_id=$3 GROUP BY action`, [reportId, assetId, partId]);
        const ordered = totals.rows.find((row) => row.action === 'ordered')?.quantity || 0;
        const replaced = totals.rows.find((row) => row.action === 'replaced')?.quantity || 0;
        if (action === 'ordered' ? ordered + quantity > part.quantity : replaced + quantity > ordered) {
          throw fail(409, action === 'ordered' ? 'Quantity exceeds the outstanding request.' : 'Only ordered quantities can be marked replaced.');
        }
        const result = await client.query(`INSERT INTO appliance_part_events(id,report_id,asset_id,part_id,action,quantity,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [crypto.randomUUID(), reportId, assetId, partId, action, quantity, req.user.id]);
        return result.rows[0];
      });
      return res.status(201).json({ event });
    } catch (error) {
      if (error.status) return apiError(res, error.status, error.message);
      console.error('Asset part action failed:', error.message);
      return apiError(res, 503, 'Could not record the part action.');
    }
  });

  app.get('/api/appliance-assets/export', authenticate, requireAdmin, async (req, res) => {
    try {
      const data = await load(req.user);
      const { assetWorkbook } = require('./machine-workbook.cjs');
      const bytes = await assetWorkbook(data);
      res.set('Cache-Control', 'private, no-store');
      return res.json({ filename: 'Machine-asset-report.xlsx', base64: Buffer.from(bytes).toString('base64') });
    } catch (error) {
      console.error('Asset workbook export failed:', error.message);
      return apiError(res, 503, 'Could not create the Excel asset report.');
    }
  });
  return { recordEntries };
}

module.exports = { schema, mount, recordEntries };
