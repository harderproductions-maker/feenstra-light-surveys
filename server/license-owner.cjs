const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { issueToken, verifyToken } = require('./license-token.cjs');
const legacy = require('../www/legacy-identifiers.json');

const schema = `
CREATE TABLE IF NOT EXISTS licence_owner (
  id INTEGER PRIMARY KEY CHECK(id=1),
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  private_key_encrypted TEXT NOT NULL,
  public_key TEXT NOT NULL,
  test_renewal_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE licence_owner ADD COLUMN IF NOT EXISTS key_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE licence_owner ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT 'PrimeOps owner';
CREATE TABLE IF NOT EXISTS platform_staff (
  id UUID PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'administrator' CHECK(role IN ('administrator','supervisor')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE platform_staff DROP CONSTRAINT IF EXISTS platform_staff_role_check;
ALTER TABLE platform_staff ADD CONSTRAINT platform_staff_role_check CHECK(role IN ('administrator','supervisor'));`;
const renewalSchema = `CREATE TABLE IF NOT EXISTS licence_renewal_requests (
  id UUID PRIMARY KEY,
  base_token_id TEXT NOT NULL UNIQUE,
  requested_by TEXT NOT NULL REFERENCES app_users(id),
  mode TEXT NOT NULL CHECK(mode IN ('request','test')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  result_token TEXT
);`;

function createOwnerService({ pool, ownerPool = pool, withTransaction, secret, companies, initialiseCompany, platformAccounts, clientAccounts }) {
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('A strong JWT_SECRET is required for owner licensing.');
  const encryptionKey = Buffer.from(crypto.hkdfSync('sha256', secret, 'PrimeOps-owner', 'signing-key-encryption-v1', 32));
  const legacyEncryptionKey = Buffer.from(crypto.hkdfSync('sha256', secret, legacy.ownerKeySalt, 'signing-key-encryption-v1', 32));
  const ownerSecret = Buffer.from(crypto.hkdfSync('sha256', secret, 'PrimeOps-owner', 'owner-session-v1', 32));
  const encrypt = (text) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
  };
  const decrypt = (text, version) => {
    const [iv, tag, data] = text.split('.').map((part) => Buffer.from(part, 'base64url'));
    const cipher = crypto.createDecipheriv('aes-256-gcm', version === 1 ? legacyEncryptionKey : encryptionKey, iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
  };
  const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
  const username = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
  const account = (user, role = user.role) => ({
    id: role === 'owner' ? 'owner' : user.id, username: user.username,
    displayName: user.display_name, role
  });
  const session = (user, role) => jwt.sign({ version: user.session_version }, ownerSecret,
    { subject: role === 'owner' ? 'owner' : `staff:${user.id}`, issuer: 'primeops-licence-owner', expiresIn: '2h', algorithm: 'HS256' });
  function requirePlatformOwner(req, res, next) {
    if (req.platformUser.role !== 'owner') return res.status(403).json({ error: 'Only the PrimeOps owner can manage platform staff.' });
    return next();
  }
  async function administrator(email, password, database = ownerPool) {
    const { rows } = await database.query('SELECT id,password_hash FROM app_users WHERE email=$1 AND role=$2 AND active=TRUE', [username(email), 'admin']);
    if (!rows[0] || typeof password !== 'string' || password.length > 200 || !await bcrypt.compare(password, rows[0].password_hash)) {
      throw invalid('Administrator sign-in is incorrect.', 401);
    }
    return rows[0].id;
  }
  async function manager(email, password) {
    const { rows } = await pool.query(`SELECT id,password_hash FROM app_users
      WHERE email=$1 AND role=ANY($2::text[]) AND active=TRUE`, [username(email), ['admin', ...require('../www/manager-roles.json')]]);
    if (!rows[0] || typeof password !== 'string' || password.length > 200 || !await bcrypt.compare(password, rows[0].password_hash)) {
      throw invalid('Use an active MM or administrator account.', 401);
    }
    return rows[0].id;
  }
  async function lockSystem(client) {
    const { rows } = await client.query('SELECT * FROM system_licence WHERE id=1 FOR UPDATE');
    const system = rows[0];
    if (!system) throw invalid('Licence setup is unavailable.', 503);
    if (Date.now() + 300000 < new Date(system.last_seen).getTime()) throw invalid('Correct the server date/time first.', 423);
    return system;
  }
  function baseId(system, owner) {
    return system.token ? verifyToken(system.token, owner.public_key).id : 'first-activation';
  }
  function requireBase(system, owner, expected) {
    if (expected !== baseId(system, owner)) throw invalid('The licence changed. Refresh and retry.', 409);
  }
  async function issue(client, system, owner, expected, requestId = null) {
    requireBase(system, owner, expected);
    if (requestId) {
      const { rows } = await client.query("SELECT id FROM licence_renewal_requests WHERE id=$1 AND base_token_id=$2 AND status='pending' FOR UPDATE", [requestId, expected]);
      if (!rows[0]) throw invalid('This request is no longer pending. Refresh.', 409);
    }
    const token = issueToken(crypto.createPrivateKey(decrypt(owner.private_key_encrypted, owner.key_version)), system.system_id, system.token);
    await client.query('UPDATE system_licence SET token=$1,last_seen=GREATEST(last_seen,NOW()) WHERE id=1', [token]);
    await client.query(`UPDATE licence_renewal_requests SET status='approved',reviewed_at=NOW(),result_token=$2
      WHERE base_token_id=$1 AND status='pending'`, [expected, token]);
    return token;
  }
  const attempts = new Map();
  function rateLimit(req, res, next) {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    if (attempts.size > 10000) for (const [id, value] of attempts) if (now - value.since >= 60000) attempts.delete(id);
    let bucket = attempts.get(key);
    if (!bucket || now - bucket.since >= 60000) { bucket = { since: now, count: 0 }; attempts.set(key, bucket); }
    if (++bucket.count > 10) return res.status(429).json({ error: 'Wait a minute and retry.' });
    return next();
  }
  function route(action) {
    return async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try { await action(req, res); }
      catch (error) {
        console.error('Owner licensing failed:', error.message);
        res.status(error.status || 503).json({ error: error.status ? error.message : 'Licence service unavailable. Retry.' });
      }
    };
  }
  async function authenticateOwner(req, res, next) {
    res.set('Cache-Control', 'no-store');
    try {
      const header = req.get('authorization') || '';
      if (!header.startsWith('Bearer ')) throw invalid('Sign in to PrimeOps Administration.', 401);
      let claims;
      try { claims = jwt.verify(header.slice(7), ownerSecret, { issuer: 'primeops-licence-owner', algorithms: ['HS256'] }); }
      catch { throw invalid('PrimeOps administrator sign-in expired. Sign in again.', 401); }
      const { rows } = await ownerPool.query('SELECT * FROM licence_owner WHERE id=1');
      if (!rows[0]) throw invalid('Sign in to PrimeOps Administration.', 401);
      let user = rows[0], role = 'owner';
      if (typeof claims.sub === 'string' && /^staff:[0-9a-f-]{36}$/i.test(claims.sub)) {
        const { rows: staff } = await ownerPool.query('SELECT * FROM platform_staff WHERE id=$1 AND active=TRUE', [claims.sub.slice(6)]);
        user = staff[0];
        role = user?.role;
      } else if (claims.sub !== 'owner') throw invalid('Sign in to PrimeOps Administration.', 401);
      if (!user || claims.version !== user.session_version) throw invalid('Sign in to PrimeOps Administration.', 401);
      req.licenceOwner = rows[0];
      req.platformUser = { ...account(user, role), passwordHash: user.password_hash, sessionVersion: user.session_version };
      next();
    } catch (error) {
      if (!error.status) console.error('Owner session verification failed:', error.message);
      res.status(error.status || 503).json({ error: error.status ? error.message : 'Could not verify owner sign-in.' });
    }
  }
  function mount(app, snapshot) {
    platformAccounts?.mountOwner(app, { authenticateOwner, route, rateLimit });
    if (clientAccounts) require('./owner-operators.cjs').mount(app, { pool, withTransaction, companies, authenticateOwner, route, rateLimit, ...clientAccounts });
    require('./subscriptions.cjs').mountOwner(app, { pool, withTransaction, authenticateOwner, route, companies });
    require('./company-features.cjs').mountOwner(app, { pool, withTransaction, authenticateOwner, route });
    require('./owner-content.cjs').mountOwnerContent(app, { pool, authenticateOwner, route });
    app.get('/api/license/owner/setup', route(async (_req, res) => {
      const { rows } = await ownerPool.query('SELECT EXISTS(SELECT 1 FROM licence_owner) AS registered');
      res.json({ registered: rows[0].registered });
    }));
    app.post('/api/license/owner/register', rateLimit, route(async (req, res) => {
      const { adminUsername, adminPassword, ownerUsername, ownerPassword, displayName } = req.body || {};
      const name = username(ownerUsername);
      if (!name || name.length > 100 || typeof ownerPassword !== 'string' || ownerPassword.length < 12 || Buffer.byteLength(ownerPassword) > 72) {
        throw invalid('Choose a PrimeOps administrator username and a password of 12-72 bytes.');
      }
      await administrator(adminUsername, adminPassword);
      const passwordHash = await bcrypt.hash(ownerPassword, 12);
      const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
      const client = await ownerPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(7204102)');
        const { rows } = await client.query('SELECT id FROM licence_owner WHERE id=1');
        if (rows[0]) throw invalid('PrimeOps administrator already registered. Sign in.', 409);
        const { rows: systems } = await client.query('SELECT token FROM system_licence WHERE id=1 FOR UPDATE');
        if (systems[0]?.token) throw invalid('An existing file-signed licence is active. Keep its original key; migrate it before registering a new owner key.', 409);
        await administrator(adminUsername, adminPassword, client);
        const { rows: owners } = await client.query(`INSERT INTO licence_owner(id,username,password_hash,private_key_encrypted,public_key,key_version,display_name)
          VALUES(1,$1,$2,$3,$4,2,$5) RETURNING *`, [name, passwordHash, encrypt(keys.privateKey), keys.publicKey,
          typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 120) : 'PrimeOps owner']);
        await issue(client, await lockSystem(client), owners[0], 'first-activation');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
      res.status(201).json({ registered: true });
    }));
    app.post('/api/license/owner/login', rateLimit, route(async (req, res) => {
      const { rows } = await ownerPool.query('SELECT * FROM licence_owner WHERE id=1');
      const owner = rows[0];
      const password = req.body?.password;
      const name = username(req.body?.username);
      let user = owner, role = 'owner';
      if (owner && name !== owner.username) {
        const { rows: staff } = await ownerPool.query('SELECT * FROM platform_staff WHERE username=$1 AND active=TRUE', [name]);
        user = staff[0];
        role = user?.role;
      }
      if (!owner || !user || name !== user.username || typeof password !== 'string'
          || Buffer.byteLength(password) > 72 || !await bcrypt.compare(password, user.password_hash)) throw invalid('PrimeOps administrator username or password is incorrect.', 401);
      res.json({ token: session(user, role), account: account(user, role) });
    }));
    app.get('/api/license/owner/staff', authenticateOwner, requirePlatformOwner, route(async (req, res) => {
      const { rows } = await ownerPool.query('SELECT id,username,display_name,role,active FROM platform_staff ORDER BY created_at,id');
      res.json({ owner: account(req.licenceOwner, 'owner'), staff: rows.map((user) => ({ ...account(user), active: user.active })) });
    }));
    app.post('/api/license/owner/staff', authenticateOwner, requirePlatformOwner, route(async (req, res) => {
      const { displayName, password, role = 'administrator' } = req.body || {};
      const name = username(req.body?.username);
      if (!name || name.length > 100 || typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 120
          || typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 72 || !['administrator', 'supervisor'].includes(role)) {
        throw invalid('Enter a staff name, unique username, a 12-72 byte password and an Administrator or Supervisor role.');
      }
      if (name === req.licenceOwner.username) throw invalid('That username is already registered.', 409);
      const hash = await bcrypt.hash(password, 12);
      const { rows } = await ownerPool.query(`INSERT INTO platform_staff(id,username,display_name,password_hash,role)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(username) DO NOTHING RETURNING id,username,display_name,role,active`,
      [crypto.randomUUID(), name, displayName.trim(), hash, role]);
      if (!rows[0]) throw invalid('That username is already registered.', 409);
      res.status(201).json({ staff: { ...account(rows[0]), active: rows[0].active } });
    }));
    app.put('/api/license/owner/staff/:id', authenticateOwner, requirePlatformOwner, route(async (req, res) => {
      const { active, password, role } = req.body || {};
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id) || typeof active !== 'boolean'
          || (password !== undefined && (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 72))
          || (role !== undefined && !['administrator', 'supervisor'].includes(role))) throw invalid('Choose a staff account, Administrator/Supervisor role and active status; password resets require 12-72 bytes.');
      const hash = password === undefined ? null : await bcrypt.hash(password, 12);
      const { rows } = await ownerPool.query(`UPDATE platform_staff SET active=$1,password_hash=COALESCE($2,password_hash),
        role=COALESCE($4,role),session_version=session_version+1 WHERE id=$3 RETURNING id,username,display_name,role,active`, [active, hash, req.params.id, role ?? null]);
      if (!rows[0]) throw invalid('Platform staff account not found.', 404);
      res.json({ staff: { ...account(rows[0]), active: rows[0].active } });
    }));
    app.put('/api/license/owner/password', rateLimit, authenticateOwner, route(async (req, res) => {
      const { currentPassword, newPassword } = req.body || {};
      if (typeof currentPassword !== 'string' || Buffer.byteLength(currentPassword) > 72
          || !await bcrypt.compare(currentPassword, req.platformUser.passwordHash)) {
        throw invalid('Current administrator password is incorrect.', 403);
      }
      if (typeof newPassword !== 'string' || newPassword.length < 12 || Buffer.byteLength(newPassword) > 72) {
        throw invalid('Choose a new password of at least 12 characters and no more than 72 bytes.');
      }
      if (newPassword === currentPassword) throw invalid('Choose a password different from your current password.');
      const hash = await bcrypt.hash(newPassword, 12);
      const ownerAccount = req.platformUser.role === 'owner';
      const { rowCount } = await ownerPool.query(ownerAccount ? `UPDATE licence_owner
        SET password_hash=$1,session_version=session_version+1 WHERE id=1 AND session_version=$2`
        : `UPDATE platform_staff SET password_hash=$1,session_version=session_version+1 WHERE id=$3 AND session_version=$2 AND active=TRUE`,
      ownerAccount ? [hash, req.platformUser.sessionVersion] : [hash, req.platformUser.sessionVersion, req.platformUser.id]);
      if (!rowCount) throw invalid('Administrator credentials changed. Sign in again.', 401);
      res.json({ success: true });
    }));
    app.get('/api/license/owner/dashboard', authenticateOwner, route(async (req, res) => {
      if (req.query.scope === 'platform') {
        return res.json({
          account: { id: req.platformUser.id, username: req.platformUser.username, displayName: req.platformUser.displayName, role: req.platformUser.role },
          ownership: { displayName: req.licenceOwner.display_name, role: 'owner' },
          companies: companies ? await companies.list() : []
        });
      }
      const { rows } = await pool.query(`SELECT r.id,r.base_token_id,r.mode,r.status,r.created_at,r.reviewed_at,
        u.display_name AS requested_by FROM licence_renewal_requests r JOIN app_users u ON u.id=r.requested_by
        ORDER BY r.created_at DESC LIMIT 50`);
      const licence = await snapshot();
      res.json({ licence, account: { id: req.platformUser.id, username: req.platformUser.username,
        displayName: req.platformUser.displayName, role: req.platformUser.role },
        ownership: { displayName: req.licenceOwner.display_name, role: 'owner' },
        testRenewalEnabled: licence.testRenewalEnabled, requests: rows,
        companies: companies ? await companies.list() : [], companyCode: companies?.current().code || '' });
    }));
    app.put('/api/license/owner/settings', authenticateOwner, route(async (req, res) => {
      if (typeof req.body?.testRenewalEnabled !== 'boolean') throw invalid('Choose whether free test renewal is enabled.');
      await withTransaction(async (client) => {
        await lockSystem(client);
        if (companies) await companies.updateTesting(req.body.testRenewalEnabled);
        else await ownerPool.query('UPDATE licence_owner SET test_renewal_enabled=$1 WHERE id=1', [req.body.testRenewalEnabled]);
      });
      res.json({ testRenewalEnabled: req.body.testRenewalEnabled });
    }));
    app.post('/api/license/owner/companies', authenticateOwner, route(async (req, res) => {
      if (!companies || !initialiseCompany) throw invalid('Company registration is unavailable.', 503);
      const company = await companies.create(req.body || {}, async (options) => {
        await initialiseCompany(options);
        await issue(options.client, await lockSystem(options.client), req.licenceOwner, 'first-activation');
      });
      const billing = platformAccounts ? await platformAccounts.billCompany(company.code) : undefined;
      res.status(201).json({ company, billing });
    }));
    app.post('/api/license/owner/issue', authenticateOwner, route(async (req, res) => {
      if (companies?.current().active === false) throw invalid('This client is inactive. Reactivate it in Account status & dates before renewing.', 409);
      const token = await withTransaction(async (client) => {
        const system = await lockSystem(client);
        return issue(client, system, req.licenceOwner, req.body?.baseTokenId, req.body?.requestId || null);
      });
      res.json({ token, licence: await snapshot() });
    }));
    app.put('/api/license/owner/client-access', authenticateOwner, route(async (req, res) => {
      const { companyCode, active, startsAt, expiresAt, baseTokenId, reason } = req.body || {};
      if (!companies || companyCode !== companies.current().code) throw invalid('Open the client account first.');
      const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
      if (typeof active !== 'boolean' || !iso(startsAt) || !iso(expiresAt) || expiresAt <= startsAt
          || typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) {
        throw invalid('Choose active status, valid start/end dates (end after start), and a reason of up to 500 characters.');
      }
      await withTransaction(async (client) => {
        const system = await lockSystem(client);
        requireBase(system, req.licenceOwner, baseTokenId);
        const token = issueToken(crypto.createPrivateKey(decrypt(req.licenceOwner.private_key_encrypted, req.licenceOwner.key_version)),
          system.system_id, system.token, new Date(), { startsAt, expiresAt, active });
        await client.query('UPDATE system_licence SET token=$1,last_seen=GREATEST(last_seen,NOW()) WHERE id=1', [token]);
        await client.query('UPDATE public.companies SET active=$1 WHERE code=$2', [active, companyCode]);
        await client.query('INSERT INTO licence_adjustments(id,changed_by,previous_token,token,reason) VALUES($1,$2,$3,$4,$5)',
          [crypto.randomUUID(), req.platformUser.username, system.token, token, reason.trim()]);
        await client.query(`UPDATE licence_renewal_requests SET status='declined',reviewed_at=NOW()
          WHERE base_token_id=$1 AND status='pending'`, [baseTokenId]);
      });
      res.json({ success: true });
    }));
    app.post('/api/license/owner/decline', authenticateOwner, route(async (req, res) => {
      if (!/^[0-9a-f-]{36}$/i.test(req.body?.requestId || '')) throw invalid('Choose a pending renewal request.');
      const { rowCount } = await pool.query(`UPDATE licence_renewal_requests SET status='declined',reviewed_at=NOW()
        WHERE id=$1 AND status='pending'`, [req.body.requestId]);
      if (!rowCount) throw invalid('Request already reviewed. Refresh.', 409);
      res.json({ success: true });
    }));
    app.post('/api/license/renew', rateLimit, route(async (req, res) => {
      if (companies?.current().active === false) throw invalid('This client account is inactive. Contact PrimeOps.', 423);
      const { mode, username: email, password, baseTokenId } = req.body || {};
      if (!['request', 'test'].includes(mode)) throw invalid('Choose request renewal or free test renewal.');
      const userId = await manager(email, password);
      const result = await withTransaction(async (client) => {
        const system = await lockSystem(client);
        const { rows } = await ownerPool.query('SELECT * FROM licence_owner WHERE id=1');
        const owner = rows[0];
        if (!owner) throw invalid('The owner must register the system first.', 409);
        requireBase(system, owner, baseTokenId);
        const testing = companies ? await companies.testingEnabled() : owner.test_renewal_enabled;
        if (mode === 'test' && !testing) throw invalid('Free test renewal is disabled. Request owner approval.', 403);
        const { rows: existing } = await client.query('SELECT * FROM licence_renewal_requests WHERE base_token_id=$1 FOR UPDATE', [baseTokenId]);
        let request = existing[0];
        if (request?.status === 'declined') {
          if (mode !== 'test') throw invalid('The owner declined this renewal. Contact the owner.', 409);
          await client.query("UPDATE licence_renewal_requests SET status='pending',mode='test',reviewed_at=NULL WHERE id=$1", [request.id]);
        } else if (!request) {
          const { rows: created } = await client.query(`INSERT INTO licence_renewal_requests(id,base_token_id,requested_by,mode)
            VALUES($1,$2,$3,$4) RETURNING *`, [crypto.randomUUID(), baseTokenId, userId, mode]);
          request = created[0];
        }
        if (mode === 'test') {
          await issue(client, system, owner, baseTokenId);
          return { status: 'approved', requestId: request.id };
        }
        return { status: request.status, requestId: request.id };
      });
      res.json({ ...result, licence: await snapshot() });
    }));
  }
  return { mount };
}
module.exports = { schema, renewalSchema, createOwnerService };
