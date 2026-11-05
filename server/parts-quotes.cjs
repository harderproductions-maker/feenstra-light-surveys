const schema = `CREATE TABLE IF NOT EXISTS building_quote_contacts (
  property_id TEXT PRIMARY KEY REFERENCES app_properties(id),
  email TEXT NOT NULL DEFAULT '',
  suppliers JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

function mount(app, { pool, authenticate, requireAdmin, accessibleProperties, apiError }) {
  app.get('/api/building-quote-contacts', authenticate, requireAdmin, async (req, res) => {
    try {
      const properties = await accessibleProperties(req.user);
      const { rows } = await pool.query('SELECT property_id,email,suppliers FROM building_quote_contacts WHERE property_id=ANY($1::TEXT[])', [properties.map((property) => property.id)]);
      return res.json({ contacts: rows });
    } catch (error) {
      console.error('Quotation contacts load failed:', error.message);
      return apiError(res, 503, 'Could not load building quotation contacts.');
    }
  });
  app.put('/api/building-quote-contacts/:propertyId', authenticate, requireAdmin, async (req, res) => {
    try {
      const properties = await accessibleProperties(req.user);
      if (!properties.some((property) => property.id === req.params.propertyId)) return apiError(res, 403, 'You cannot change contacts for this building.');
      const { validateQuoteContacts } = await import('../www/parts-quotes.mjs');
      let contact;
      try { contact = validateQuoteContacts(req.body); }
      catch (error) { return apiError(res, 400, error.message); }
      const { rows } = await pool.query(`INSERT INTO building_quote_contacts(property_id,email,suppliers) VALUES($1,$2,$3::jsonb)
        ON CONFLICT(property_id) DO UPDATE SET email=$2,suppliers=$3::jsonb,updated_at=NOW() RETURNING property_id,email,suppliers`,
      [req.params.propertyId, contact.email, JSON.stringify(contact.suppliers)]);
      return res.json({ contact: rows[0] });
    } catch (error) {
      console.error('Quotation contacts save failed:', error.message);
      return apiError(res, 503, 'Could not save building quotation contacts.');
    }
  });
}
module.exports = { schema, mount };
