const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const fields = `u.id,u.email,u.display_name AS name,u.role,u.unit_number AS "unitNumber",u.resident_type AS "residentType",
  u.active,u.sections,u.admin_rights AS "adminRights",u.auth_version AS "credentialVersion",
  ARRAY(SELECT property_id FROM user_properties WHERE user_id=u.id ORDER BY property_id) AS "propertyIds"`;
const version = (user) => crypto.createHash('sha256').update(JSON.stringify(user)).digest('hex');
function mount(app, { pool, withTransaction, companies, authenticateOwner, route, rateLimit, validateUserInput, updateAccount, createAccount }) {
  const base = '/api/license/owner/operators';
  app.get(base, authenticateOwner, route(async (req, res) => {
    if (req.query.companyCode !== companies.current().code) throw invalid('Open a client account first.');
    const { rows: users } = await pool.query(`SELECT ${fields} FROM app_users u WHERE u.role <> 'user' ORDER BY display_name,id`);
    const { rows: properties } = await pool.query('SELECT id,name FROM app_properties WHERE active=TRUE ORDER BY name');
    res.json({ users: users.map((user) => ({ ...user, version: version(user) })), properties,
      sections: (await import('../www/account-access.mjs')).accountSections, companyCode: companies.current().code });
  }));
  app.post(base, authenticateOwner, rateLimit, route(async (req, res) => {
    if (req.body?.companyCode !== companies.current().code) throw invalid('Open a client account first.');
    if (!req.body?.role || req.body.role === 'user') throw invalid('Create student and tenant accounts from the client app, not the owner console.', 403);
    const input = await validateUserInput(req, res, true);
    if (!input) return;
    try {
      const passwordHash = await bcrypt.hash(input.password, 12);
      const user = await withTransaction(async (client) => {
        const created = await createAccount(client, input, passwordHash);
        await client.query(`INSERT INTO public.platform_account_events(id,company_code,actor,actor_role,action,detail)
          VALUES($1,$2,$3,$4,'operator_created',$5)`,
        [crypto.randomUUID(), companies.current().code, req.platformUser.username, req.platformUser.role,
          { userId: created.id, role: input.role, propertyIds: input.propertyIds, sections: input.sections, adminRights: input.adminRights }]);
        return created;
      });
      res.status(201).json({ user });
    } catch (error) {
      if (error.code === '23505') throw invalid('An account with that username already exists.', 409);
      throw error;
    }
  }));
  app.put(`${base}/:id/password`, authenticateOwner, rateLimit, route(async (req, res) => {
    if (req.body?.companyCode !== companies.current().code) throw invalid('Open a client account first.');
    const { newPassword, confirmPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 12 || Buffer.byteLength(newPassword) > 72) {
      throw invalid('Use a new client password of at least 12 characters and at most 72 bytes.');
    }
    if (confirmPassword !== newPassword) throw invalid('New passwords do not match.');
    await withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT ${fields} FROM app_users u WHERE u.id=$1 FOR UPDATE`, [req.params.id]);
      const user = rows[0];
      if (!user) throw invalid('Account not found in this client.', 404);
      if (user.role === 'user') throw invalid('Manage student and tenant accounts from the client app.', 403);
      if (user.role === 'admin' && !['owner', 'supervisor'].includes(req.platformUser.role)) {
        throw invalid('Only the PrimeOps owner or a supervisor can reset the main client administrator password.', 403);
      }
      if (req.body.version !== version(user)) throw invalid('The account changed. Refresh operators before resetting its password.', 409);
      const hash = await bcrypt.hash(newPassword, 12);
      await client.query(`UPDATE app_users SET password_hash=$1,auth_version=auth_version+1,password_managed_in_app=TRUE WHERE id=$2`, [hash, user.id]);
      await client.query(`INSERT INTO public.platform_account_events(id,company_code,actor,actor_role,action,detail)
        VALUES($1,$2,$3,$4,'client_password_reset',$5)`,
      [crypto.randomUUID(), companies.current().code, req.platformUser.username, req.platformUser.role, { userId: user.id, role: user.role }]);
    });
    res.json({ saved: true });
  }));
  app.put(`${base}/:id`, authenticateOwner, route(async (req, res) => {
    if (req.body?.companyCode !== companies.current().code) throw invalid('Open a client account first.');
    if (!req.body?.role || req.body.role === 'user') throw invalid('Manage student and tenant accounts from the client app.', 403);
    if (typeof req.body?.active !== 'boolean') throw invalid('Choose the operator active status.');
    const input = await validateUserInput(req, res, false);
    if (!input) return;
    try {
      const user = await withTransaction(async (client) => {
        const { rows } = await client.query(`SELECT ${fields} FROM app_users u WHERE u.id=$1 FOR UPDATE`, [req.params.id]);
        if (!rows[0]) throw invalid('Operator not found in this client account.', 404);
        if (rows[0].role === 'user') throw invalid('Manage student and tenant accounts from the client app.', 403);
        if (typeof req.body?.version !== 'string' || req.body.version !== version(rows[0])) throw invalid('The operator changed. Refresh operators before saving.', 409);
        const updated = await updateAccount(client, req.params.id, input, req.body.active);
        await client.query(`INSERT INTO public.platform_account_events(id,company_code,actor,actor_role,action,detail)
          VALUES($1,$2,$3,$4,'operator_updated',$5)`, [crypto.randomUUID(), companies.current().code, req.platformUser.username, req.platformUser.role,
          { userId: req.params.id, previousRole: rows[0].role, role: input.role, propertyIds: input.propertyIds, active: req.body.active,
            sections: input.sections, adminRights: input.adminRights }]);
        return updated;
      });
      res.json({ user });
    } catch (error) {
      if (error.code === '23505') throw invalid('An account with that username already exists.', 409);
      throw error;
    }
  }));
}
module.exports = { mount };
