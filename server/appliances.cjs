const crypto = require('crypto');

const schema = `
  CREATE TABLE IF NOT EXISTS appliance_parts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    part_number TEXT NOT NULL,
    supplier TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE
  );
  CREATE TABLE IF NOT EXISTS appliance_reports (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL REFERENCES app_properties(id),
    created_by TEXT NOT NULL REFERENCES app_users(id),
    unit_number TEXT NOT NULL,
    appliance_type TEXT NOT NULL,
    model_number TEXT NOT NULL,
    fault TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    parts JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE appliance_reports ADD COLUMN IF NOT EXISTS check_audit JSONB;
  ALTER TABLE appliance_reports ADD COLUMN IF NOT EXISTS entries JSONB;
  ALTER TABLE appliance_reports ADD COLUMN IF NOT EXISTS expected_count INTEGER;
` + require('./technician-visits.cjs').schema + ';' + require('./parts-quotes.cjs').schema
  + ';' + require('./parts-catalogue.cjs').schema + ';' + require('./machine-assets.cjs').schema;

async function seedParts(pool) {
  for (const [model, number, description] of require('./speedqueen-parts.json')) {
    await pool.query(`INSERT INTO appliance_parts (id, name, part_number, supplier)
      SELECT $1, $2, $3, '' WHERE NOT EXISTS (SELECT 1 FROM appliance_parts WHERE part_number = $3)
      ON CONFLICT (id) DO NOTHING`, [`speedqueen-${number}`, `Speed Queen ${model} - ${description}`, number]);
  }
  await pool.query(require('./parts-catalogue.cjs').schema);
  await require('./parts-catalogue.cjs').seedBenchmark(pool);
}

function mount(app, { pool, authenticate, requireAdmin, accessibleProperties, hasFullAccess, withTransaction, apiError, isValidJpeg }) {
  const visits = require('./technician-visits.cjs').mount(app, { pool, authenticate, requireAdmin, accessibleProperties, withTransaction, apiError });
  require('./parts-quotes.cjs').mount(app, { pool, authenticate, requireAdmin, accessibleProperties, apiError });
  function visibleReport(report, user) {
    const { check_audit, ...details } = report;
    if (hasFullAccess(user)) return { ...details, check_audit };
    if (details.entries) details.entries = details.entries.map(({ checkAudit, photo, ...entry }) => ({
      ...entry, photo: { data: photo.data, source: photo.source }
    }));
    return details;
  }

  function requireReports(req, res, next) {
    if (req.user.role !== 'technician' && !hasFullAccess(req.user)) return apiError(res, 403, 'Appliance reports are limited to technicians and managers.');
    return next();
  }
  const assets = require('./machine-assets.cjs').mount(app, { pool, authenticate, requireAdmin, requireReports, accessibleProperties, hasFullAccess, withTransaction, apiError });

  app.get('/api/appliance-parts', authenticate, requireReports, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM appliance_parts ${hasFullAccess(req.user) ? '' : 'WHERE active = TRUE'} ORDER BY name, part_number`);
      res.set('Cache-Control', 'private, no-store');
      return res.json({ parts: rows.map((row) => require('./parts-catalogue.cjs').publicPart(row, hasFullAccess(req.user))) });
    } catch (error) {
      console.error('Parts lookup failed:', error.message);
      return apiError(res, 503, 'Could not load the parts catalogue.');
    }
  });

  app.post('/api/appliance-parts', authenticate, requireAdmin, async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const partNumber = String(req.body?.partNumber || '').trim();
    const supplier = String(req.body?.supplier || '').trim();
    const machineType = req.body?.machineType;
    if (!['Washer', 'Dryer', 'Combo'].includes(machineType)) return apiError(res, 400, 'Choose the machine type for this part.');
    if (!name || name.length > 150 || partNumber.length > 100 || supplier.length > 500) {
      return apiError(res, 400, 'Enter a part name (up to 150 characters). The optional part number must be at most 100 characters.');
    }
    try {
      const { rows } = await pool.query(
        'INSERT INTO appliance_parts (id, name, part_number, supplier, machine_type) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [crypto.randomUUID(), name, partNumber, supplier, machineType]
      );
      return res.status(201).json({ part: rows[0] });
    } catch (error) {
      console.error('Part creation failed:', error.message);
      return apiError(res, 503, 'Could not save the part.');
    }
  });

  app.put('/api/appliance-parts/:id', authenticate, requireAdmin, async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const partNumber = String(req.body?.partNumber || '').trim();
    const supplier = String(req.body?.supplier || '').trim();
    const machineType = req.body?.machineType;
    if (!['Washer', 'Dryer', 'Combo'].includes(machineType)) return apiError(res, 400, 'Choose the machine type for this part.');
    if (!name || name.length > 150 || partNumber.length > 100 || supplier.length > 500 || typeof req.body?.active !== 'boolean') {
      return apiError(res, 400, 'Enter valid part details and an active status.');
    }
    try {
      const { rows } = await pool.query(
        'UPDATE appliance_parts SET name = $2, part_number = $3, supplier = $4, active = $5, machine_type = $6 WHERE id = $1 RETURNING *',
        [req.params.id, name, partNumber, supplier, req.body.active, machineType]
      );
      if (!rows[0]) return apiError(res, 404, 'Part not found.');
      return res.json({ part: rows[0] });
    } catch (error) {
      console.error('Part update failed:', error.message);
      return apiError(res, 503, 'Could not update the part.');
    }
  });

  const reportQuery = `SELECT r.*, p.name AS building_name, u.display_name AS technician_name
    FROM appliance_reports r JOIN app_properties p ON p.id = r.property_id JOIN app_users u ON u.id = r.created_by`;

  app.post('/api/appliance-reports/export', authenticate, requireAdmin, async (req, res) => {
    const ids = req.body?.ids;
    const mode = req.body?.mode;
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some((id) => typeof id !== 'string')
        || new Set(ids).size !== ids.length || !['full', 'parts'].includes(mode)) {
      return apiError(res, 400, 'Select 1 to 200 distinct reports and a valid export type.');
    }
    try {
      const { rows } = await pool.query(`${reportQuery} WHERE r.id = ANY($1::TEXT[])
        AND ($2 OR r.property_id IN (SELECT up.property_id FROM user_properties up JOIN app_properties p ON p.id = up.property_id
          WHERE up.user_id = $3 AND p.active = TRUE)) ORDER BY r.created_at, r.id`, [ids, req.user.role === 'admin', req.user.id]);
      if (rows.length !== ids.length) return apiError(res, 404, 'One or more selected reports were not found.');
      const { combinedReportHtml } = await import('../www/appliance-report.mjs');
      res.set('Cache-Control', 'private, no-store');
      return res.json({ html: combinedReportHtml(rows, mode, true), title: mode === 'parts' ? 'Replacement-parts' : 'Appliance-reports' });
    } catch (error) {
      console.error('Combined appliance export failed:', error.message);
      return apiError(res, 503, 'Could not export the selected reports.');
    }
  });

  app.get('/api/appliance-reports', authenticate, requireReports, async (req, res) => {
    try {
      const { rows } = await pool.query(`${reportQuery} WHERE ($1 OR r.created_by = $2)
        AND ($3 OR r.property_id IN (SELECT up.property_id FROM user_properties up JOIN app_properties p ON p.id = up.property_id
          WHERE up.user_id = $2 AND p.active = TRUE))
        ORDER BY r.created_at DESC`, [hasFullAccess(req.user), req.user.id, req.user.role === 'admin']);
      res.set('Cache-Control', 'private, no-store');
      return res.json({ reports: rows.map((row) => visibleReport(row, req.user)) });
    } catch (error) {
      console.error('Appliance reports lookup failed:', error.message);
      return apiError(res, 503, 'Could not load appliance reports.');
    }
  });

  app.post('/api/appliance-reports', authenticate, requireReports, async (req, res) => {
    try {
      const { validateLaundryReport, reportSelections, snapshotEntries } = await import('../www/laundry.mjs');
      let body;
      try {
        body = validateLaundryReport(req.body || {});
      } catch (error) {
        return apiError(res, 400, error.message);
      }
      const parts = reportSelections(body);
      if (req.body.expectedParts !== undefined && (!Array.isArray(req.body.expectedParts)
          || req.body.expectedParts.length !== parts.length
          || req.body.expectedParts.some((part) => !part || typeof part.id !== 'string'))) {
        return apiError(res, 400, 'The downloaded parts snapshot is invalid. Reload the catalogue.');
      }
      for (const entry of body.entries) {
        if (!isValidJpeg(Buffer.from(entry.photo.data.split(',')[1], 'base64'))) {
          return apiError(res, 400, 'The camera photo must be a complete JPEG.');
        }
      }
      const properties = await accessibleProperties(req.user);
      if (!properties.some((property) => property.id === body.propertyId)) return apiError(res, 403, 'You do not have access to this building.');
      const report = await withTransaction(async (client) => {
        let visitId;
        try { visitId = await visits.validateReport(req.user, { ...body, visitId: req.body.visitId }, client); }
        catch (error) {
          if (!error.status) error.status = 400;
          throw error;
        }
        const { rows } = await client.query('SELECT * FROM appliance_parts WHERE id = ANY($1::TEXT[]) AND active = TRUE FOR SHARE', [parts.map((part) => part.id)]);
        if (rows.length !== parts.length) throw Object.assign(new Error('A selected part is no longer available. Reload the catalogue.'), { status: 409 });
        if (rows.some((row) => row.machine_type !== body.applianceType)) throw Object.assign(new Error('Choose only parts for the selected machine type.'), { status: 400 });
        if (req.body.expectedParts && rows.some((row) => {
          const expected = req.body.expectedParts.find((part) => part.id === row.id);
          return !expected || expected.part_number !== row.part_number || expected.supplier !== row.supplier || expected.name !== row.name;
        })) throw Object.assign(new Error('Part details changed while offline. Review the catalogue and resubmit the report.'), { status: 409 });
        const entries = snapshotEntries(body.entries, rows);
        await assets.recordEntries(client, body, entries);
        const { rows: saved } = await client.query(
          `INSERT INTO appliance_reports (id, created_by, property_id, unit_number, appliance_type, model_number, fault, notes, parts, check_audit, entries, expected_count, visit_id)
           VALUES ($1, $2, $3, '', $4, '', '', '', '[]', $5::jsonb, $6::jsonb, $7, $8) RETURNING *`,
          [crypto.randomUUID(), req.user.id, body.propertyId, body.applianceType, JSON.stringify(body.checkAudit), JSON.stringify(entries), body.expectedCount, visitId]
        );
        return saved[0];
      });
      return res.status(201).json({ report: visibleReport(report, req.user) });
    } catch (error) {
      if (error.status) return apiError(res, error.status, error.message);
      console.error('Appliance report save failed:', error.message);
      return apiError(res, 503, 'Could not save the appliance report.');
    }
  });

  app.get('/api/appliance-reports/:id/export', authenticate, requireReports, async (req, res) => {
    try {
      const { rows } = await pool.query(`${reportQuery} WHERE r.id = $1 AND ($2 OR r.created_by = $3)
        AND ($4 OR r.property_id IN (SELECT up.property_id FROM user_properties up JOIN app_properties p ON p.id = up.property_id
          WHERE up.user_id = $3 AND p.active = TRUE))`,
      [req.params.id, hasFullAccess(req.user), req.user.id, req.user.role === 'admin']);
      if (!rows[0]) return apiError(res, 404, 'Appliance report not found.');
      const { reportHtml } = await import('../www/appliance-report.mjs');
      res.set('Cache-Control', 'private, no-store');
      return res.json({ html: reportHtml(visibleReport(rows[0], req.user), hasFullAccess(req.user)), title: `Appliance-${rows[0].id}` });
    } catch (error) {
      console.error('Appliance report export failed:', error.message);
      return apiError(res, 503, 'Could not export the appliance report.');
    }
  });
}

module.exports = { schema, mount, seedParts };
