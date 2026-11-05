const crypto = require('node:crypto');
const managerRoles = require('../www/manager-roles.json');
const schema = `CREATE TABLE IF NOT EXISTS check_templates (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  questions JSONB NOT NULL,
  source_columns JSONB,
  property_ids TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT REFERENCES app_users(id)
);
ALTER TABLE check_templates ADD COLUMN IF NOT EXISTS source_columns JSONB;`;
const types = ['yes-no', 'yes-no-na', 'pass-fail-na', 'date', 'number', 'rating', 'textarea', 'text'];
function validateTemplate(value) {
  if (!value || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 150
      || !Array.isArray(value.questions) || !value.questions.length || value.questions.length > 200
      || !Array.isArray(value.propertyIds) || value.propertyIds.some((id) => typeof id !== 'string' || !id || id.length > 120)) {
    throw new Error('Enter a checklist title, building selection and 1-200 questions.');
  }
  const questions = value.questions.map((question) => {
    if (!question || typeof question.label !== 'string' || !question.label.trim() || question.label.length > 1000
        || !types.includes(question.type) || typeof question.photo !== 'boolean') throw new Error('Each question needs text, a valid answer type and a photo setting.');
    if (question.sourceCells !== undefined && (!Array.isArray(value.sourceColumns) || !Array.isArray(question.sourceCells)
        || question.sourceCells.length !== value.sourceColumns.length || question.sourceCells.some((cell) => typeof cell !== 'string' || cell.length > 2000))) {
      throw new Error('Spreadsheet rows must match the column headings; each cell can contain up to 2000 characters.');
    }
    return { id: crypto.randomUUID(), label: question.label.trim(), type: question.type, photo: question.photo, required: true,
      ...(question.sourceCells ? { sourceCells: question.sourceCells } : {}) };
  });
  if (value.sourceColumns !== undefined && (!Array.isArray(value.sourceColumns) || !value.sourceColumns.length || value.sourceColumns.length > 30
      || value.sourceColumns.some((column) => typeof column !== 'string' || column.length > 150))) {
    throw new Error('Use 1-30 spreadsheet column headings of up to 150 characters.');
  }
  if (JSON.stringify(questions).length > 2 * 1024 * 1024) throw new Error('The imported checklist is too large. Split it into smaller checklists.');
  return { title: value.title.trim(), questions, propertyIds: [...new Set(value.propertyIds)], sourceColumns: value.sourceColumns || null };
}
async function seed(pool) {
  for (const template of require('./check-templates.json').templates) {
    await pool.query(`INSERT INTO check_templates(id,title,questions) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`,
      [template.id, template.title, JSON.stringify(template.questions)]);
  }
}
function mount(app, { pool, authenticate, accessibleProperties, apiError }) {
  const fail = (res, error) => {
    console.error('Checklist templates failed:', error.message);
    return apiError(res, error.status || (error.code ? 503 : 400), error.code ? 'Could not save checklist. Retry.' : error.message);
  };
  async function allowed(req, ids) {
    if (!['admin', ...managerRoles].includes(req.user.role)) throw Object.assign(new Error('Manager or administrator access is required.'), { status: 403 });
    const properties = await accessibleProperties(req.user);
    if (!ids.length && req.user.role !== 'admin') throw Object.assign(new Error('Select your assigned buildings.'), { status: 403 });
    if (ids.some((id) => !properties.some((property) => property.id === id))) throw Object.assign(new Error('Choose buildings within your access.'), { status: 403 });
  }
  app.get('/api/check-templates', authenticate, async (req, res) => {
    try {
      const ids = (await accessibleProperties(req.user)).map((property) => property.id);
      const { rows } = await pool.query(`SELECT id,title,questions,source_columns AS "sourceColumns",property_ids AS "propertyIds",active FROM check_templates
        WHERE active=TRUE AND (cardinality(property_ids)=0 OR property_ids && $1::TEXT[]) ORDER BY title`, [ids]);
      return res.json({ templates: rows });
    } catch (error) { return fail(res, error); }
  });
  app.post('/api/check-templates', authenticate, async (req, res) => {
    try {
      const data = validateTemplate(req.body);
      await allowed(req, data.propertyIds);
      const id = crypto.randomUUID();
      await pool.query(`INSERT INTO check_templates(id,title,questions,property_ids,updated_by,source_columns) VALUES($1,$2,$3::jsonb,$4,$5,$6::jsonb)`,
        [id, data.title, JSON.stringify(data.questions), data.propertyIds, req.user.id, JSON.stringify(data.sourceColumns)]);
      return res.status(201).json({ id });
    } catch (error) { return fail(res, error); }
  });
  app.put('/api/check-templates/:id/archive', authenticate, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT property_ids FROM check_templates WHERE id=$1', [req.params.id]);
      if (!rows[0]) return apiError(res, 404, 'Checklist not found.');
      await allowed(req, rows[0].property_ids);
      await pool.query('UPDATE check_templates SET active=FALSE,updated_by=$2,updated_at=NOW() WHERE id=$1', [req.params.id, req.user.id]);
      return res.json({ success: true });
    } catch (error) { return fail(res, error); }
  });
}
module.exports = { schema, seed, mount, validateTemplate };
