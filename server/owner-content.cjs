const crypto = require('node:crypto');
const { validateTemplate } = require('./check-templates.cjs');

function mountOwnerContent(app, { pool, authenticateOwner, route }) {
  app.get('/api/license/owner/content', authenticateOwner, route(async (_req, res) => {
    const { rows: properties } = await pool.query('SELECT id,name,city FROM app_properties WHERE active=TRUE ORDER BY name');
    const { rows: templates } = await pool.query('SELECT id,title,questions,source_columns AS "sourceColumns",property_ids AS "propertyIds",active FROM check_templates WHERE active=TRUE ORDER BY title');
    res.json({ properties, templates });
  }));
  app.post('/api/license/owner/buildings', authenticateOwner, route(async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const city = typeof req.body?.city === 'string' ? req.body.city.trim() : '';
    if (!name || name.length > 120 || city.length > 120) throw Object.assign(new Error('Enter building name and city, up to 120 characters each.'), { status: 400 });
    try {
      const { rows } = await pool.query('INSERT INTO app_properties(id,name,city) VALUES($1,$2,$3) RETURNING id,name,city', [crypto.randomUUID(), name, city]);
      res.status(201).json({ property: rows[0] });
    } catch (error) {
      if (error.code === '23505') throw Object.assign(new Error('Building name already exists in this company.'), { status: 409 });
      throw error;
    }
  }));
  app.post('/api/license/owner/checklists', authenticateOwner, route(async (req, res) => {
    let data;
    try { data = validateTemplate(req.body); }
    catch (error) { throw Object.assign(error, { status: 400 }); }
    const { rows } = await pool.query('SELECT id FROM app_properties WHERE id=ANY($1::TEXT[]) AND active=TRUE', [data.propertyIds]);
    if (rows.length !== data.propertyIds.length) throw Object.assign(new Error('Choose buildings in the selected company.'), { status: 403 });
    const id = crypto.randomUUID();
    await pool.query('INSERT INTO check_templates(id,title,questions,property_ids,source_columns) VALUES($1,$2,$3::jsonb,$4,$5::jsonb)',
      [id, data.title, JSON.stringify(data.questions), data.propertyIds, JSON.stringify(data.sourceColumns)]);
    res.status(201).json({ id });
  }));
}
module.exports = { mountOwnerContent };
