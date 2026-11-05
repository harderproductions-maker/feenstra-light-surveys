const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const port = Number(process.env.PORT || 3000);
const adminPort = Number(process.env.ADMIN_PORT || 3001);
const adminHost = process.env.ADMIN_HOST || '127.0.0.1';
const jwtSecret = process.env.JWT_SECRET;
const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD || '';
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const buildingCatalog = require('./building-catalog.json');
const allowedOrigins = new Set(
  String(process.env.CORS_ORIGINS || 'capacitor://localhost,http://localhost,https://localhost,primeops://app')
    .split(',').map((origin) => origin.trim()).filter(Boolean)
);
const reportsRoot = path.resolve(process.env.REPORTS_ROOT || path.join(__dirname, '..', 'reports'));
const controlPool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
const companies = require('./companies.cjs').createCompanies({ controlPool, databaseUrl, reportsRoot });
const platformAccounts = require('./platform-accounts.cjs').createPlatformAccounts({ pool: controlPool, companies });
const payfast = require('./payfast.cjs').createPayfast({ pool: controlPool, companies, platformAccounts });
const offlineTransactions = require('./offline.cjs').createOfflineTransactions(companies.pool);
const pool = offlineTransactions.pool;
const subscriptions = require('./subscriptions.cjs');
const companyFeatures = require('./company-features.cjs');
const managerRoles = require('../www/manager-roles.json');
const isManagerRole = (role) => managerRoles.includes(role);
const isManagementRole = (role) => role === 'admin' || isManagerRole(role);
const app = express();
const privateAdministration = express();
const adminRequests = new WeakSet();
const isAdministrationPath = (value) => /^\/(?:admin(?:\/|$)|api\/license\/owner(?:\/|$))/i.test(value);
const loginAttempts = new Map();
const accountAccess = import('../www/account-access.mjs');
const legacy = require('../www/legacy-identifiers.json');
allowedOrigins.add('primeops://app');
allowedOrigins.add(`${legacy.desktopScheme}://app`);

if (!jwtSecret || Buffer.byteLength(jwtSecret) < 32) {
  throw new Error('JWT_SECRET must contain at least 32 characters.');
}
if (!adminEmail || adminPassword.length < 4) {
  throw new Error('Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 4 characters.');
}
if (!databaseUrl) {
  throw new Error('Set DATABASE_URL to the PostgreSQL connection string.');
}
if (!Number.isInteger(adminPort) || adminPort < 0 || adminPort > 65535 || adminPort === port) {
  throw new Error('ADMIN_PORT must be a valid port different from PORT (0 selects an available private port).');
}
if (!['127.0.0.1', '::1', '0.0.0.0'].includes(adminHost)) {
  throw new Error('ADMIN_HOST must be a loopback address, or 0.0.0.0 inside an isolated container.');
}
privateAdministration.disable('x-powered-by');
privateAdministration.use((req, res) => {
  if (req.path === '/') return res.redirect('/admin/');
  if (!isAdministrationPath(req.path)) return res.status(404).json({ error: 'Not found.' });
  adminRequests.add(req);
  return app(req, res);
});

function requireTicketManager(req, res, next) {
  if (!isManagementRole(req.user.role)) {
    return apiError(res, 403, 'A maintenance manager or administrator must manage ticket assignments.');
  }
  return next();
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use((req, res, next) => {
  if (isAdministrationPath(req.path) && !adminRequests.has(req)) {
    return res.status(404).json({ error: 'Not found.' });
  }
  return next();
});
app.use((req, res, next) => cors({
  origin(origin, callback) {
    const requestOrigin = `${req.protocol}://${req.get('host')}`;
    if (!origin || allowedOrigins.has(origin) || origin === requestOrigin) return callback(null, true);
    return callback(new Error('This app origin is not allowed by CORS.'));
  },
  methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'If-Match', 'X-Operation-ID'],
  maxAge: 600
})(req, res, next));
app.use(express.json({ limit: '64mb' }));
app.get(/^\/admin$/, (_req, res) => res.redirect('/admin/'));
app.get(['/admin/', '/admin/index.html', '/admin/renderer.js', '/admin/styles.css', '/admin/icon.png'], (req, res) => {
  const file = req.path.endsWith('/') ? 'index.html' : path.basename(req.path);
  res.set('Cache-Control', 'no-store');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  return res.sendFile(path.join(__dirname, '..', 'owner-app', file));
});
app.use('/admin', (_req, res) => res.status(404).send('Not found.'));
payfast.mountNotify(app);
app.post('/api/auth/company', async (req, res) => {
  const bucket = getLoginBucket(req.ip);
  if (bucket.count >= 10) return apiError(res, 429, 'Too many sign-in attempts. Wait a minute and try again.');
  bucket.count += 1;
  res.set('Cache-Control', 'no-store');
  try {
    return res.json(await companies.resolve(req.body?.identifier));
  } catch (error) {
    if (!error.status) console.error('Client lookup failed:', error.message);
    return apiError(res, error.status || 503, error.status ? error.message : 'Could not find your client. Try again when the server is available.');
  }
});
app.use(companies.middleware);
const licence = require('./license.cjs').createLicence({ pool, withTransaction, ownerPool: controlPool, companies, initialiseCompany: initialiseDatabase, platformAccounts,
  clientAccounts: { validateUserInput, updateAccount: updateClientAccount, createAccount: createClientAccount } });
licence.mount(app);
platformAccounts.mountClient(app, { authenticate });
payfast.mountClient(app, { authenticate });
app.use(offlineTransactions.middleware(authenticate, apiError));
subscriptions.mount(app, { pool, withTransaction, authenticate, apiError });
companyFeatures.mount(app, { pool, withTransaction, authenticate, apiError });
require('./operations.cjs').mount(app, { pool, withTransaction, authenticate, accessibleProperties, apiError, isValidJpeg });
require('./leasing.cjs').mount(app, { pool, withTransaction, authenticate, accessibleProperties, companies });
require('./check-templates.cjs').mount(app, { pool, authenticate, accessibleProperties, apiError });
require('./android-updates.cjs').registerAndroidUpdates(app,
  process.env.ANDROID_UPDATES_ROOT || path.join(__dirname, '..', 'android-updates'));

function apiError(res, status, message) {
  return res.status(status).json({ error: message });
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function signInToken(user) {
  return jwt.sign(
    { sub: user.id, company: companies.current().code, authVersion: user.auth_version },
    jwtSecret,
    { expiresIn: '12h', issuer: 'primeops' }
  );
}

async function authenticate(req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return apiError(res, 401, 'Sign in to continue.');
  let claims;
  try {
    claims = jwt.verify(token, jwtSecret, { issuer: ['primeops', legacy.sessionIssuer] });
    if ((claims.company || companies.primaryCode) !== companies.current().code) return apiError(res, 401, 'Sign in to this company.');
  } catch {
    return apiError(res, 401, 'Your sign-in has expired. Sign in again.');
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, email, display_name, role, unit_number, resident_type, sections, admin_rights AS "adminRights",auth_version FROM app_users WHERE id = $1 AND active = TRUE',
      [claims.sub]
    );
    if (!rows[0]) return apiError(res, 401, 'This account is no longer active.');
    if ((claims.authVersion ?? 0) !== rows[0].auth_version) return apiError(res, 401, 'Your password changed. Sign in again.');
    req.user = rows[0];
    req.user.billingBlocked = (await platformAccounts.access(companies.current().code)).blocked;
    if (req.user.billingBlocked && req.path !== '/api/auth/me' && !/^\/api\/platform-account(?:\/|$)/.test(req.path)) {
      return res.status(423).json({ error: 'This client account is blocked for overdue PrimeOps invoices. Contact PrimeOps; the main administrator can still view the account statement.', code: 'ACCOUNT_ARREARS' });
    }
    req.user.companyFeatures = (await companyFeatures.state(pool)).enabled;
    req.user.companySettings = await require('./operations.cjs').settings(pool);
    const { canUseSection, sectionForPath } = await accountAccess;
    const section = sectionForPath(req.path === '/api/properties' && req.method === 'POST' ? '/api/properties:create' : req.path);
    if (section && !canUseSection(req.user, section)) return apiError(res, 403, 'Your account does not have access to this section.');
  } catch (error) {
    console.error('Account verification failed:', error.message);
    return apiError(res, 503, 'Could not verify your sign-in with the backend.');
  }
  return next();
}

function hasOpsAccess(user) {
  return isManagementRole(user.role) || user.role === 'maintenance_assistant';
}

function hasFullAccess(user) {
  return isManagementRole(user.role);
}

function requireAdmin(req, res, next) {
  if (!hasFullAccess(req.user)) return apiError(res, 403, 'Manager or administrator access is required.');
  return next();
}

async function accessibleProperties(user, database = pool) {
  const global = user.role === 'admin';
  const query = global
    ? 'SELECT id, name, city FROM app_properties WHERE active = TRUE ORDER BY name'
    : `SELECT p.id, p.name, p.city FROM app_properties p
       JOIN user_properties up ON up.property_id = p.id
       WHERE up.user_id = $1 AND p.active = TRUE ORDER BY p.name`;
  const { rows } = await database.query(query, global ? [] : [user.id]);
  return rows;
}

function propertyIdFor(record, propertiesByName) {
  if (record?.propertyId) return String(record.propertyId);
  const name = String(record?.buildingName || '').trim().toLocaleLowerCase();
  return propertiesByName.get(name) || null;
}

function validateRecordScope(records, allowedIds, propertiesByName, kind) {
  if (!Array.isArray(records)) throw Object.assign(new Error(`Workspace ${kind} must be a list.`), { status: 400 });
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw Object.assign(new Error(`Workspace ${kind} contains an invalid record.`), { status: 400 });
    }
    const propertyId = propertyIdFor(record, propertiesByName);
    if (!propertyId) {
      throw Object.assign(new Error(`Every ${kind === 'surveys' ? 'survey' : 'building check'} must belong to a known building.`), { status: 400 });
    }
    if (!allowedIds.has(propertyId)) {
      throw Object.assign(new Error('You do not have access to one or more buildings in this request.'), { status: 403 });
    }
  }
}

function mergeScopedRecords(currentRecords, submittedRecords, allowedIds, propertiesByName) {
  const retained = (Array.isArray(currentRecords) ? currentRecords : []).filter((record) => {
    const propertyId = propertyIdFor(record, propertiesByName);
    return !propertyId || !allowedIds.has(propertyId);
  });
  return [...retained, ...submittedRecords.map((record) => ({
    ...record,
    propertyId: propertyIdFor(record, propertiesByName)
  }))];
}

async function withTransaction(callback) {
  const current = offlineTransactions.current();
  if (current) return callback(current);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function getLoginBucket(ip) {
  const now = Date.now();
  const bucket = loginAttempts.get(ip);
  if (!bucket || now - bucket.startedAt > 60_000) {
    const next = { startedAt: now, count: 0 };
    loginAttempts.set(ip, next);
    return next;
  }
  return bucket;
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({ status: 'ok' });
  } catch (error) {
    console.error('Health check failed:', error.message);
    return apiError(res, 503, 'The database is unavailable.');
  }
});

app.post('/api/auth/login', async (req, res) => {
  const bucket = getLoginBucket(req.ip);
  if (bucket.count >= 10) return apiError(res, 429, 'Too many sign-in attempts. Wait a minute and try again.');
  bucket.count += 1;
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!email || !password) return apiError(res, 400, 'Enter your email and password.');
  try {
    const { rows } = await pool.query(
      'SELECT id, email, display_name, password_hash, role,auth_version FROM app_users WHERE email = $1 AND active = TRUE',
      [email]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return apiError(res, 401, 'Email or password is incorrect.');
    }
    loginAttempts.delete(req.ip);
    return res.json({
      token: signInToken(user),
      user: { id: user.id, email: user.email, name: user.display_name, role: user.role }
    });
  } catch (error) {
    console.error('Sign-in failed:', error.message);
    return apiError(res, 503, 'Could not sign in because the backend is unavailable.');
  }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    const properties = await accessibleProperties(req.user);
    return res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.display_name,
        role: req.user.role,
        unitNumber: req.user.unit_number, residentType: req.user.resident_type, companySettings: req.user.companySettings,
        propertyIds: properties.map((property) => property.id), billingBlocked: req.user.billingBlocked,
        sections: req.user.sections, adminRights: req.user.adminRights, companyFeatures: req.user.companyFeatures
      }
    });
  } catch (error) {
    console.error('Account lookup failed:', error.message);
    return apiError(res, 503, 'Could not verify the account with the backend.');
  }
});

app.get('/api/properties', authenticate, async (req, res) => {
  try {
    return res.json({ properties: await accessibleProperties(req.user) });
  } catch (error) {
    console.error('Property list failed:', error.message);
    return apiError(res, 503, 'Could not load your buildings.');
  }
});

app.post('/api/properties', authenticate, requireAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const city = String(req.body?.city || '').trim();
  if (!name || name.length > 120) return apiError(res, 400, 'Enter a building name of up to 120 characters.');
  if (city.length > 120) return apiError(res, 400, 'Enter a city of up to 120 characters.');
  try {
    const id = crypto.randomUUID();
    const property = await withTransaction(async (client) => {
      const { rows } = await client.query(
        'INSERT INTO app_properties (id, name, city) VALUES ($1, $2, $3) RETURNING id, name, city', [id, name, city]
      );
      if (req.user.role !== 'admin') await client.query('INSERT INTO user_properties (user_id, property_id) VALUES ($1, $2)', [req.user.id, id]);
      return rows[0];
    });
    return res.status(201).json({ property });
  } catch (error) {
    if (error.code === '23505') return apiError(res, 409, 'A building with this name already exists.');
    console.error('Building creation failed:', error.message);
    return apiError(res, 503, 'Could not add the building.');
  }
});

function managedAccountScope(alias, globalParameter, managerParameter) {
  return `(${globalParameter} OR (${alias}.role <> 'admin' AND ${alias}.id <> ${managerParameter}
    AND (${alias}.role NOT IN (${managerRoles.map((role) => `'${role}'`).join(',')}) OR (NOT ${alias}.admin_rights AND EXISTS (
      SELECT 1 FROM app_users delegator WHERE delegator.id=${managerParameter} AND delegator.admin_rights=TRUE)))
    AND EXISTS (SELECT 1 FROM user_properties target WHERE target.user_id = ${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM user_properties target WHERE target.user_id = ${alias}.id
      AND NOT EXISTS (SELECT 1 FROM user_properties own JOIN app_properties p ON p.id = own.property_id
        WHERE own.user_id = ${managerParameter} AND own.property_id = target.property_id AND p.active = TRUE))))`;
}

async function requireManagedAccount(user, userId, database = pool, checkPermissions = false) {
  const { rows } = await database.query(
    `SELECT u.id FROM app_users u WHERE u.id = $1 AND ${managedAccountScope('u', '$2', '$3')}`,
    [userId, user.role === 'admin', user.id]
  );
  if (!rows[0]) throw Object.assign(new Error('This account is not available in your assigned buildings.'), { status: 404 });
  if (checkPermissions) {
    const { rows: accounts } = await database.query('SELECT id,role,sections,admin_rights FROM app_users WHERE id=$1', [userId]);
    if (!(await accountAccess).canManageAccountPermissions(user, accounts[0])) {
      throw Object.assign(new Error('You cannot manage an account with permissions outside your own access.'), { status: 403 });
    }
  }
}

async function validateManagedUser(user, input, database = pool) {
  if (user.role === 'admin') return;
  const allowed = new Set((await accessibleProperties(user, database)).map((property) => property.id));
  const { canDelegateAccounts, sectionsFor, canUseSection } = await accountAccess;
  if ((isManagerRole(input.role) && !canDelegateAccounts(user)) || input.propertyIds.some((id) => !allowed.has(id))
      || input.adminRights || sectionsFor({ ...input, companyFeatures: isManagerRole(input.role) ? undefined : user.companyFeatures })
        .some((section) => !canUseSection(user, section))) {
    throw Object.assign(new Error('Manage accounts only within your own buildings and sections. Scoped admin rights are required to manage MMs; only full administrators grant those rights.'), { status: 403 });
  }
}

app.get('/api/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.display_name AS name, u.role, u.unit_number, u.resident_type, u.active, u.created_at,u.sections,u.admin_rights,
              COALESCE(array_agg(up.property_id) FILTER (WHERE up.property_id IS NOT NULL), ARRAY[]::TEXT[]) AS property_ids
       FROM app_users u LEFT JOIN user_properties up ON up.user_id = u.id
       WHERE ${managedAccountScope('u', '$1', '$2')}
       GROUP BY u.id ORDER BY u.created_at`, [req.user.role === 'admin', req.user.id]
    );
    const { canManageAccountPermissions } = await accountAccess;
    return res.json({ users: rows.filter((account) => canManageAccountPermissions(req.user, account)) });
  } catch (error) {
    console.error('User list failed:', error.message);
    return apiError(res, 503, 'Could not load user accounts.');
  }
});

async function validateUserInput(req, res, requirePassword) {
  const email = normalizeEmail(req.body?.email);
  const name = String(req.body?.name || '').trim();
  const password = String(req.body?.password || '');
  if (!/^[^\s]{2,100}$/.test(email)) {
    apiError(res, 400, 'Enter a username of 2 or more characters without spaces.');
    return null;
  }
  if (!name || name.length > 100) {
    apiError(res, 400, 'Enter a name of up to 100 characters.');
    return null;
  }
  if ((requirePassword || password) && (password.length < 4 || password.length > 200)) {
    apiError(res, 400, 'Use a password between 4 and 200 characters.');
    return null;
  }
  const role = String(req.body?.role || 'user');
  if (!['user', ...managerRoles, 'maintenance_assistant', 'technician'].includes(role)) {
    apiError(res, 400, 'Choose a valid account role.');
    return null;
  }
  let propertyIds;
  try { propertyIds = (await accountAccess).accountBuildingIds(role, req.body?.propertyIds); }
  catch (error) {
    apiError(res, 400, error.message);
    return null;
  }
  const unitNumber = role === 'user' ? String(req.body?.unitNumber || '').trim() : '';
  if (unitNumber.length > 80 || (role === 'user' && !unitNumber)) {
    apiError(res, 400, 'Enter the resident apartment/unit number (up to 80 characters).');
    return null;
  }
  const sections = req.body?.sections;
  const adminRights = req.body?.adminRights;
  const allowedSections = (await accountAccess).accountSections.map(([id]) => id);
  if (sections !== undefined && sections !== null && (!Array.isArray(sections)
      || sections.some((section) => !allowedSections.includes(section)))) {
    apiError(res, 400, 'Choose valid account sections.');
    return null;
  }
  if ((adminRights !== undefined && typeof adminRights !== 'boolean')
      || (!isManagerRole(role) && (adminRights === true || Array.isArray(sections)))) {
    apiError(res, 400, 'Custom sections and scoped admin rights apply only to manager profiles.');
    return null;
  }
  if (adminRights && Array.isArray(sections) && !sections.includes('users')) {
    apiError(res, 400, 'Scoped admin rights require the User management section.');
    return null;
  }
  const residentType = role === 'user' ? req.body?.residentType : undefined;
  if (residentType !== undefined && !['student', 'tenant'].includes(residentType)) {
    apiError(res, 400, 'Choose Student or Tenant for this resident.');
    return null;
  }
  return { email, name, password, role, unitNumber, residentType, propertyIds: [...new Set(propertyIds)],
    sections: Array.isArray(sections) ? [...new Set(sections)] : null, adminRights: adminRights === true,
    sectionsProvided: sections !== undefined, adminRightsProvided: adminRights !== undefined };
}

async function residentTypeFor(input, client, previous = 'student') {
  const { residentMode } = await require('./operations.cjs').settings(client);
  return residentMode === 'both' ? input.residentType || previous : residentMode === 'tenants' ? 'tenant' : 'student';
}

async function replaceUserProperties(client, userId, propertyIds) {
  const { rows } = await client.query(
    'SELECT id FROM app_properties WHERE active = TRUE AND id = ANY($1::TEXT[])',
    [propertyIds]
  );
  if (rows.length !== propertyIds.length) {
    throw Object.assign(new Error('One or more selected buildings do not exist.'), { status: 400 });
  }
  await client.query('DELETE FROM user_properties WHERE user_id = $1', [userId]);
  for (const propertyId of propertyIds) {
    await client.query('INSERT INTO user_properties (user_id, property_id) VALUES ($1, $2)', [userId, propertyId]);
  }
}

async function createClientAccount(client, input, passwordHash) {
  await subscriptions.requireUserCapacity(client);
  const id = crypto.randomUUID();
  const residentType = await residentTypeFor(input, client);
  const { rows } = await client.query(
    `INSERT INTO app_users (id, email, display_name, password_hash, role, unit_number,sections,admin_rights,resident_type)
     VALUES ($1, $2, $3, $4, $5, $6,$7,$8,$9)
     RETURNING id, email, display_name AS name, role, unit_number, resident_type, active, created_at,sections,admin_rights`,
    [id, input.email, input.name, passwordHash, input.role, input.unitNumber,input.sections,input.adminRights,residentType]
  );
  await replaceUserProperties(client, id, input.propertyIds);
  return { ...rows[0], property_ids: input.propertyIds };
}

app.post('/api/users', authenticate, requireAdmin, async (req, res) => {
  const input = await validateUserInput(req, res, true);
  if (!input) return;
  try {
    await validateManagedUser(req.user, input);
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await withTransaction(async (client) => {
      await validateManagedUser(req.user, input, client);
      return createClientAccount(client, input, passwordHash);
    });
    return res.status(201).json({ user });
  } catch (error) {
    if (error.code === '23505') return apiError(res, 409, 'An account with this email already exists.');
    if (error.status) return apiError(res, error.status, error.message);
    console.error('User creation failed:', error.message);
    return apiError(res, 503, 'Could not create the account.');
  }
});

async function updateClientAccount(client, userId, input, active, validateInput) {
  const { rows: previous } = await client.query('SELECT role, unit_number, resident_type, active,sections,admin_rights,password_hash FROM app_users WHERE id = $1 FOR UPDATE', [userId]);
  if (!previous[0] || previous[0].role === 'admin') throw Object.assign(new Error('The main client administrator is protected. Choose a client worker or resident account.'), { status: 404 });
  if (active && previous[0].active === false) await subscriptions.requireUserCapacity(client);
  if (isManagerRole(input.role) && previous[0].role === input.role) {
    if (!input.sectionsProvided) input.sections = previous[0].sections;
    if (!input.adminRightsProvided) input.adminRights = previous[0].admin_rights;
  }
  if (input.adminRights && Array.isArray(input.sections) && !input.sections.includes('users')) {
    throw Object.assign(new Error('Scoped admin rights require the User management section.'), { status: 400 });
  }
  if (validateInput) await validateInput();
  const residentType = await residentTypeFor(input, client, previous[0].resident_type);
  const { rows } = await client.query(
    `UPDATE app_users SET email = $1, display_name = $2, active = $3, role = $4, unit_number = $6,sections=$7,admin_rights=$8,resident_type=$9
     WHERE id = $5 AND role <> 'admin'
     RETURNING id, email, display_name AS name, role, unit_number, resident_type, active, created_at,sections,admin_rights`,
    [input.email, input.name, active, input.role, userId, input.unitNumber, input.sections, input.adminRights, residentType]
  );
  if (!rows[0]) throw Object.assign(new Error('The user account was not found.'), { status: 404 });
  const { rows: assignedRows } = await client.query(
    `SELECT id FROM maintenance_tickets
     WHERE assigned_to = $1 AND status <> 'completed'
       AND ($2 <> 'maintenance_assistant' OR NOT $4 OR NOT (property_id = ANY($3::TEXT[])))
     LIMIT 1`,
    [userId, input.role, input.propertyIds, active]
  );
  if (assignedRows[0]) {
    throw Object.assign(new Error('Reassign this assistant’s open tickets before changing their role or building access.'), { status: 409 });
  }
  await replaceUserProperties(client, userId, input.propertyIds);
  if (previous[0].role === 'user') {
    await client.query(
      `UPDATE maintenance_tickets SET access_granted = FALSE, access_granted_at = NULL, access_note = '', updated_at = NOW()
       WHERE created_by = $1 AND access_granted = TRUE
         AND ($2 <> 'user' OR NOT $3 OR unit_number <> $4 OR NOT (property_id = ANY($5::TEXT[])))`,
      [userId, input.role, active, input.unitNumber, input.propertyIds]
    );
  }
  if (input.password && !await bcrypt.compare(input.password, previous[0].password_hash)) {
    const passwordHash = await bcrypt.hash(input.password, 12);
    await client.query('UPDATE app_users SET password_hash = $1,auth_version=auth_version+1,password_managed_in_app=TRUE WHERE id = $2', [passwordHash, userId]);
  }
  return { ...rows[0], property_ids: input.propertyIds };
}

app.put('/api/users/:id', authenticate, requireAdmin, async (req, res) => {
  const input = await validateUserInput(req, res, false);
  if (!input) return;
  const active = req.body?.active !== false;
  if (!active && req.params.id === req.user.id) return apiError(res, 400, 'You cannot deactivate your own account.');
  try {
    const user = await withTransaction(async (client) => {
      await requireManagedAccount(req.user, req.params.id, client, true);
      return updateClientAccount(client, req.params.id, input, active, () => validateManagedUser(req.user, input, client));
    });
    return res.json({ user });
  } catch (error) {
    if (error.code === '23505') return apiError(res, 409, 'An account with this email already exists.');
    if (error.status) return apiError(res, error.status, error.message);
    console.error('User update failed:', error.message);
    return apiError(res, 503, 'Could not update the account.');
  }
});

function validateTicketText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isValidJpeg(image) {
  if (image.length < 12 || image[0] !== 0xff || image[1] !== 0xd8
      || image[image.length - 2] !== 0xff || image[image.length - 1] !== 0xd9) return false;
  let offset = 2;
  let hasFrame = false;
  let hasScan = false;
  while (offset < image.length) {
    if (image[offset] !== 0xff) return false;
    while (image[offset] === 0xff) offset += 1;
    const marker = image[offset++];
    if (marker === 0xd9) return hasFrame && hasScan && offset === image.length;
    if (marker === 0x00 || marker === 0xd8) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > image.length) return false;
    const segmentLength = image.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > image.length) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (segmentLength < 8) return false;
      const height = image.readUInt16BE(offset + 3);
      const width = image.readUInt16BE(offset + 5);
      if (!width || !height) return false;
      hasFrame = true;
    }
    offset += segmentLength;
    if (marker === 0xda) {
      const scanStart = offset;
      while (offset < image.length - 2) {
        if (image[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const next = image[offset + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2;
          continue;
        }
        break;
      }
      if (offset === scanStart) return false;
      hasScan = true;
    }
  }
  return false;
}

async function ticketScopeCondition(user, alias = 't', firstParameter = 1) {
  if (user.role === 'admin') return { sql: 'TRUE', values: [] };
  if (user.role === 'technician') return { sql: 'FALSE', values: [] };
  const userParameter = `$${firstParameter}`;
  if (isManagerRole(user.role)) {
    return {
      sql: `EXISTS (
        SELECT 1 FROM user_properties up
        WHERE up.user_id = ${userParameter} AND up.property_id = ${alias}.property_id
      )`,
      values: [user.id]
    };
  }
  if (user.role === 'maintenance_assistant') {
    return {
      sql: `${alias}.assigned_to = ${userParameter} AND EXISTS (
        SELECT 1 FROM user_properties up
        WHERE up.user_id = ${userParameter} AND up.property_id = ${alias}.property_id
      )`,
      values: [user.id]
    };
  }
  return {
    sql: `${alias}.created_by = ${userParameter} AND EXISTS (
      SELECT 1 FROM user_properties up
      WHERE up.user_id = ${userParameter} AND up.property_id = ${alias}.property_id
    )`,
    values: [user.id]
  };
}

async function logTicketEvent(ticketId, actorName, event, detail = '', database = pool) {
  await database.query('INSERT INTO ticket_events (ticket_id, actor_name, event, detail) VALUES ($1, $2, $3, $4)', [ticketId, actorName, event, detail]);
}

app.get('/api/tickets', authenticate, async (req, res) => {
  if (req.user.role === 'technician') return apiError(res, 403, 'Technicians only have access to appliance reports.');
  try {
    const scope = await ticketScopeCondition(req.user);
    const { rows } = await pool.query(
      `SELECT t.id, t.property_id, p.name AS building_name, t.subject, t.description,
              t.status, t.unit_number, t.tags, t.source_asset_id, t.source_asset_activity_id, t.asset_snapshot, t.created_by, creator.display_name AS created_by_name,
              t.assigned_to, assistant.display_name AS assigned_to_name,
              t.created_at, t.updated_at, t.completed_at,
              t.scheduled_for, t.access_granted, t.access_granted_at, t.access_note, t.contractor_name,
              (SELECT COALESCE(json_agg(json_build_object('event', e.event, 'detail', e.detail, 'actor', e.actor_name, 'at', e.created_at) ORDER BY e.created_at, e.id), '[]'::json)
                 FROM ticket_events e WHERE e.ticket_id = t.id) AS events,
              (t.completion_photo IS NOT NULL) AS has_completion_photo
       FROM maintenance_tickets t
       JOIN app_properties p ON p.id = t.property_id
       JOIN app_users creator ON creator.id = t.created_by
       LEFT JOIN app_users assistant ON assistant.id = t.assigned_to
       WHERE ${scope.sql}
       ORDER BY t.created_at DESC`,
      scope.values
    );
    return res.json({ tickets: rows });
  } catch (error) {
    console.error('Ticket list failed:', error.message);
    return apiError(res, 503, 'Could not load tickets.');
  }
});

app.post('/api/tickets', authenticate, async (req, res) => {
  if (req.user.role === 'technician') return apiError(res, 403, 'Technicians only have access to appliance reports.');
  if (req.user.role === 'maintenance_assistant') {
    return apiError(res, 403, 'Maintenance assistants can only update tickets assigned to them.');
  }
  if (req.user.role === 'user') {
    const blocked = await pool.query(`SELECT 1 FROM billing_accounts WHERE user_id = $1 AND status = 'blocked'`, [req.user.id])
      .then((result) => result.rows, () => null);
    if (!blocked) return apiError(res, 503, 'Could not check your account status.');
    if (blocked.length) return apiError(res, 403, 'Your account is blocked. Please contact the office about your account before logging a ticket.');
  }
  const subject = validateTicketText(req.body?.subject);
  const description = validateTicketText(req.body?.description);
  const propertyId = String(req.body?.propertyId || '');
  const unitNumber = req.user.role === 'user' ? req.user.unit_number : String(req.body?.unitNumber || '').trim();
  if (req.user.role === 'user' && req.body?.unitNumber && req.body.unitNumber !== unitNumber) {
    return apiError(res, 409, 'Your apartment/unit has changed. Check the ticket location before submitting again.');
  }
  const tags = req.body?.tags;
  if (!unitNumber || unitNumber.length > 80) return apiError(res, 400, 'An apartment/unit number is required. Ask the office to update your account if it is missing.');
  if (!Array.isArray(tags) || !tags.length || tags.length > 10 || tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 60)) {
    return apiError(res, 400, 'Select at least one valid ticket tag.');
  }
  if (!subject || subject.length > 160) return apiError(res, 400, 'Enter a ticket title of up to 160 characters.');
  if (!description || description.length > 4000) return apiError(res, 400, 'Describe the issue in up to 4,000 characters.');
  if (!propertyId) return apiError(res, 400, 'Choose a building for this ticket.');
  let scheduledFor = null;
  if (req.body?.scheduledFor) {
    const when = new Date(String(req.body.scheduledFor));
    if (Number.isNaN(when.getTime())) return apiError(res, 400, 'Choose a valid date and time.');
    if (when.getTime() < Date.now() - 5 * 60_000) return apiError(res, 400, 'The scheduled date and time must be in the future.');
    if (when.getTime() > Date.now() + 365 * 86_400_000) return apiError(res, 400, 'Choose a date within the next year.');
    scheduledFor = when.toISOString();
  }
  const accessGranted = req.body?.accessGranted === true;
  const accessNote = String(req.body?.accessNote || '').trim().slice(0, 500);
  const assetId = req.body?.assetId || null, activityId = req.body?.assetActivityId || null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if ((assetId && (typeof assetId !== 'string' || !uuid.test(assetId))) || (activityId && (typeof activityId !== 'string' || !uuid.test(activityId) || !assetId))) {
    return apiError(res, 400, 'Choose a valid source asset and inspection/fault record.');
  }
  try {
    const properties = await accessibleProperties(req.user);
    if (!properties.some((property) => property.id === propertyId)) {
      return apiError(res, 403, 'You do not have access to the selected building.');
    }
    const ticket = await withTransaction(async (client) => {
      let snapshot = null;
      if (assetId) {
        const { canUseSection } = await accountAccess;
        if (!isManagementRole(req.user.role) || !canUseSection(req.user, 'assets')) {
          throw Object.assign(new Error('Asset and maintenance-ticket management access is required.'), { status: 403 });
        }
        const { rows: assets } = await client.query("SELECT data,status FROM operation_records WHERE id=$1 AND property_id=$2 AND kind='assets' FOR UPDATE", [assetId, propertyId]);
        if (!assets[0]) throw Object.assign(new Error('Asset not found in the selected building. Refresh after an asset transfer.'), { status: 404 });
        if (assets[0].status === 'retired') throw Object.assign(new Error('Reactivate the retired asset before requesting work.'), { status: 409 });
        if (activityId) {
          const activity = await client.query("SELECT id FROM asset_activity WHERE id=$1 AND asset_id=$2 AND kind IN ('inspection','fault')", [activityId, assetId]);
          if (!activity.rows[0]) throw Object.assign(new Error('Source inspection/fault does not belong to this asset.'), { status: 404 });
        }
        snapshot = { ...assets[0].data, propertyId };
      }
      const { rows } = await client.query(
        `INSERT INTO maintenance_tickets (id, property_id, subject, description, created_by, scheduled_for, access_granted, access_granted_at, access_note, unit_number, tags,source_asset_id,source_asset_activity_id,asset_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 THEN NOW() END, $8, $9, $10,$11,$12,$13)
         RETURNING id, property_id, subject, description, status, created_at, scheduled_for, access_granted`,
        [crypto.randomUUID(), propertyId, subject, description, req.user.id, scheduledFor, accessGranted, accessNote, unitNumber, [...new Set(tags.map((tag) => tag.trim()))],assetId,activityId,snapshot]
      );
      const when = scheduledFor ? `Requested visit: ${new Date(scheduledFor).toISOString()}` : 'Standard response: within 48 hours';
      await logTicketEvent(rows[0].id, req.user.display_name || req.user.email, 'Ticket logged', when, client);
      if (snapshot) await logTicketEvent(rows[0].id, req.user.display_name || req.user.email, 'Linked to asset', `${snapshot.assetTag} / ${snapshot.name}${activityId ? ` / Inspection or fault ${activityId}` : ''}`, client);
      if (accessGranted) await logTicketEvent(rows[0].id, req.user.display_name || req.user.email, 'Access granted', accessNote || 'Permission given to enter the apartment when the resident is not home.', client);
      return rows[0];
    });
    return res.status(201).json({ ticket });
  } catch (error) {
    console.error('Ticket creation failed:', error.message);
    return apiError(res, error.code === '23505' ? 409 : error.status || 503, error.code === '23505'
      ? 'A maintenance ticket already exists for this inspection/fault. Open the asset history to view it.'
      : error.status ? error.message : 'Could not submit the ticket.');
  }
});

app.get('/api/ticket-assignees', authenticate, requireTicketManager, async (req, res) => {
  const propertyId = String(req.query.propertyId || '');
  if (!propertyId) return apiError(res, 400, 'Choose a building to find maintenance assistants.');
  try {
    const { rows: propertyRows } = await pool.query(
      'SELECT id FROM app_properties WHERE id = $1 AND active = TRUE',
      [propertyId]
    );
    if (!propertyRows[0]) return apiError(res, 404, 'The selected building was not found.');
    const allowedProperties = await accessibleProperties(req.user);
    if (!allowedProperties.some((property) => property.id === propertyId)) {
      return apiError(res, 403, 'You do not manage this building.');
    }
    const { rows } = await pool.query(
      `SELECT u.id, u.display_name AS name
       FROM app_users u JOIN user_properties up ON up.user_id = u.id
       WHERE u.role = 'maintenance_assistant' AND u.active = TRUE AND up.property_id = $1
       ORDER BY u.display_name`,
      [propertyId]
    );
    return res.json({ assistants: rows });
  } catch (error) {
    console.error('Ticket assistant lookup failed:', error.message);
    return apiError(res, 503, 'Could not load maintenance assistants for this building.');
  }
});

app.put('/api/tickets/:id/assignment', authenticate, requireTicketManager, async (req, res) => {
  const assistantId = String(req.body?.assistantId || '');
  if (!assistantId) return apiError(res, 400, 'Select a maintenance assistant to assign this ticket.');
  try {
    await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE maintenance_tickets t
         SET assigned_to = u.id, status = 'assigned', contractor_name = '', updated_at = NOW()
         FROM app_users u, user_properties up
         WHERE t.id = $1 AND u.id = $2 AND u.role = 'maintenance_assistant' AND u.active = TRUE
           AND up.user_id = u.id AND up.property_id = t.property_id
           AND ($3 = 'admin' OR EXISTS (
             SELECT 1 FROM user_properties manager_property
             WHERE manager_property.user_id = $4 AND manager_property.property_id = t.property_id
           ))
           AND t.status <> 'completed'
         RETURNING t.id`,
        [req.params.id, assistantId, req.user.role, req.user.id]
      );
      if (!rows[0]) {
        const { rows: ticketRows } = await client.query('SELECT status FROM maintenance_tickets WHERE id = $1', [req.params.id]);
        if (!ticketRows[0]) throw Object.assign(new Error('The ticket was not found.'), { status: 404 });
        if (ticketRows[0].status === 'completed') throw Object.assign(new Error('Completed tickets cannot be reassigned.'), { status: 409 });
        throw Object.assign(new Error('The assistant must be active and assigned to this ticket’s building.'), { status: 400 });
      }
      const { rows: nameRows } = await client.query('SELECT display_name FROM app_users WHERE id = $1', [assistantId]);
      await logTicketEvent(req.params.id, req.user.display_name || req.user.email, 'Assigned to maintenance assistant', nameRows[0]?.display_name || '', client);
    });
    return res.json({ success: true });
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    console.error('Ticket assignment failed:', error.message);
    return apiError(res, 503, 'Could not assign the ticket.');
  }
});

app.post('/api/tickets/:id/complete', authenticate, async (req, res) => {
  const isAssistant = req.user.role === 'maintenance_assistant';
  if (!isAssistant && !isManagementRole(req.user.role)) {
    return apiError(res, 403, 'Only the assigned maintenance assistant or a maintenance manager can complete this ticket.');
  }
  const dataUrl = String(req.body?.photo || '');
  const match = dataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+=*)$/);
  if (!match) return apiError(res, 400, 'Capture a new photo with the camera before completing this ticket.');
  const photo = Buffer.from(match[1], 'base64');
  if (photo.length > 5 * 1024 * 1024 || !isValidJpeg(photo)) {
    return apiError(res, 400, 'The camera photo must be a complete JPEG no larger than 5 MB.');
  }
  try {
    const ticket = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE maintenance_tickets t
         SET status = 'completed', completion_photo = $3, completion_photo_type = 'image/jpeg',
             completed_at = NOW(), updated_at = NOW()
         WHERE t.id = $1 AND t.status IN ('assigned', 'in_progress', 'contractor', 'awaiting_stock', 'awaiting_access', 'out_of_stock')
           AND (($4 AND t.assigned_to = $2) OR (NOT $4 AND ($5 = 'admin' OR t.property_id IN (SELECT property_id FROM user_properties WHERE user_id = $2))))
           AND ($5 = 'admin' OR EXISTS (
             SELECT 1 FROM user_properties up
             WHERE up.user_id = $2 AND up.property_id = t.property_id
           ))
         RETURNING t.id, t.status, t.completed_at`,
        [req.params.id, req.user.id, photo, isAssistant, req.user.role]
      );
      if (!rows[0]) throw Object.assign(new Error('This ticket is not assigned to you, is outside your buildings, or is already complete.'), { status: 404 });
      await logTicketEvent(req.params.id, req.user.display_name || req.user.email, 'Completed', 'Completion photo uploaded.', client);
      return rows[0];
    });
    return res.json({ ticket });
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    console.error('Ticket completion failed:', error.message);
    return apiError(res, 503, 'Could not complete the ticket.');
  }
});

const managerStatuses = { in_progress: 'In progress', awaiting_stock: 'Awaiting stock', awaiting_access: 'Awaiting access', contractor: 'Sent to contractor' };

app.put('/api/tickets/:id/status', authenticate, async (req, res) => {
  const status = String(req.body?.status || '');
  const note = String(req.body?.note || '').trim().slice(0, 500);
  const isManager = isManagementRole(req.user.role);
  const isAssistant = req.user.role === 'maintenance_assistant';
  if (!isManager && !isAssistant) return apiError(res, 403, 'You cannot change the status of this ticket.');
  if (isAssistant && status !== 'out_of_stock') {
    return apiError(res, 403, 'Maintenance assistants can only mark a ticket out of stock, or complete it with a photo.');
  }
  if (isManager && !managerStatuses[status]) {
    return apiError(res, 400, 'Choose in progress, awaiting stock, awaiting access or contractor. Use assignment for assistants.');
  }
  const contractorName = String(req.body?.contractorName || '').trim().slice(0, 120);
  if (status === 'contractor' && !contractorName) return apiError(res, 400, 'Enter the contractor’s name.');
  try {
    const ticket = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE maintenance_tickets t
         SET status = $2,
             assigned_to = CASE WHEN $2 = 'contractor' THEN NULL ELSE t.assigned_to END,
             contractor_name = CASE WHEN $2 = 'contractor' THEN $3 ELSE t.contractor_name END,
             updated_at = NOW()
         WHERE t.id = $1 AND t.status <> 'completed'
           AND ($6 = 'admin' OR t.property_id IN (SELECT property_id FROM user_properties WHERE user_id = $5))
           AND (($4 AND t.assigned_to = $5)
             OR (NOT $4 AND ($6 = 'admin' OR t.property_id IN (SELECT property_id FROM user_properties WHERE user_id = $5))))
         RETURNING t.id, t.status`,
        [req.params.id, status, contractorName, isAssistant, req.user.id, req.user.role]
      );
      if (!rows[0]) throw Object.assign(new Error('This ticket is not available to you, or is already complete.'), { status: 404 });
      const label = status === 'out_of_stock' ? 'Out of stock' : managerStatuses[status];
      await logTicketEvent(req.params.id, req.user.display_name || req.user.email, label, status === 'contractor' ? [contractorName, note].filter(Boolean).join(' – ') : note, client);
      return rows[0];
    });
    return res.json({ ticket });
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    console.error('Ticket status failed:', error.message);
    return apiError(res, 503, 'Could not update the ticket status.');
  }
});

app.put('/api/tickets/:id/access', authenticate, async (req, res) => {
  if (req.user.role !== 'user') return apiError(res, 403, 'Only the resident who logged the ticket can change access permission.');
  const granted = req.body?.granted === true;
  const note = String(req.body?.note || '').trim().slice(0, 500);
  try {
    await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE maintenance_tickets
         SET access_granted = $3, access_granted_at = CASE WHEN $3 THEN NOW() END, access_note = CASE WHEN $3 THEN $4 ELSE '' END, updated_at = NOW()
         WHERE id = $1 AND created_by = $2 AND status <> 'completed'
           AND unit_number = $5
           AND property_id IN (SELECT up.property_id FROM user_properties up JOIN app_properties p ON p.id = up.property_id
             WHERE up.user_id = $2 AND p.active = TRUE) RETURNING id`,
        [req.params.id, req.user.id, granted, note, req.user.unit_number]
      );
      if (!rows[0]) throw Object.assign(new Error('This ticket is not available, or is already complete.'), { status: 404 });
      await logTicketEvent(req.params.id, req.user.display_name || req.user.email, granted ? 'Access granted' : 'Access withdrawn',
        granted ? note || 'Permission given to enter the apartment when the resident is not home.' : '', client);
    });
    return res.json({ success: true });
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    console.error('Ticket access failed:', error.message);
    return apiError(res, 503, 'Could not update access permission.');
  }
});

app.get('/api/tickets/:id/photo', authenticate, async (req, res) => {
  try {
    const scope = await ticketScopeCondition(req.user, 't', 2);
    const { rows } = await pool.query(
      `SELECT t.completion_photo, t.completion_photo_type
       FROM maintenance_tickets t WHERE t.id = $1 AND ${scope.sql}`,
      [req.params.id, ...scope.values]
    );
    if (!rows[0] || !rows[0].completion_photo) return apiError(res, 404, 'The ticket photo is unavailable.');
    res.set('Content-Type', rows[0].completion_photo_type);
    res.set('Cache-Control', 'private, no-store');
    return res.send(rows[0].completion_photo);
  } catch (error) {
    console.error('Ticket photo lookup failed:', error.message);
    return apiError(res, 503, 'Could not load the ticket photo.');
  }
});

app.post('/api/tickets/:id/replies', authenticate, async (req, res) => {
  if (req.user.role === 'technician') return apiError(res, 403, 'Technicians cannot access tickets.');
  const message = String(req.body?.message || '').trim();
  if (!message || message.length > 4000) return apiError(res, 400, 'Enter a reply of up to 4,000 characters.');
  try {
    const scope = await ticketScopeCondition(req.user, 't', 2);
    await withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT t.id FROM maintenance_tickets t WHERE t.id = $1 AND ${scope.sql} FOR UPDATE`, [req.params.id, ...scope.values]);
      if (!rows[0]) throw Object.assign(new Error('Ticket not found.'), { status: 404 });
      await client.query('INSERT INTO ticket_events (ticket_id, actor_name, event, detail) VALUES ($1, $2, $3, $4)', [req.params.id, req.user.display_name, 'Reply', message]);
      await client.query('UPDATE maintenance_tickets SET updated_at = NOW() WHERE id = $1', [req.params.id]);
    });
    return res.status(201).json({ success: true });
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    console.error('Ticket reply failed:', error.message);
    return apiError(res, 503, 'Could not post your reply.');
  }
});

app.put('/api/tickets/:id/tags', authenticate, requireTicketManager, async (req, res) => {
  const tags = req.body?.tags;
  if (!Array.isArray(tags) || !tags.length || tags.length > 10 || tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 60)) {
    return apiError(res, 400, 'Enter between 1 and 10 tags of up to 60 characters.');
  }
  try {
    await withTransaction(async (client) => {
      const scope = await ticketScopeCondition(req.user, 'maintenance_tickets', 3);
      const { rows } = await client.query(`UPDATE maintenance_tickets SET tags = $2, updated_at = NOW()
        WHERE id = $1 AND ${scope.sql} RETURNING id`, [req.params.id, [...new Set(tags.map((tag) => tag.trim()))], ...scope.values]);
      if (!rows[0]) throw Object.assign(new Error('Ticket not found.'), { status: 404 });
      await client.query('INSERT INTO ticket_events (ticket_id, actor_name, event, detail) VALUES ($1, $2, $3, $4)', [req.params.id, req.user.display_name, 'Tags updated', tags.join(', ')]);
    });
    return res.json({ success: true });
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    console.error('Ticket tags failed:', error.message);
    return apiError(res, 503, 'Could not update the tags.');
  }
});

app.get('/api/workspace', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT revision, data FROM shared_workspace WHERE id = 1');
    const workspace = rows[0];
    const properties = await accessibleProperties(req.user);
    const allowedIds = new Set(properties.map((property) => property.id));
    const propertiesByName = new Map(buildingCatalog.map((property) => [property.name.trim().toLocaleLowerCase(), property.id]));
    const data = workspace.data || { surveys: [], buildingChecks: [], properties: [], sensorCalibration: null };
    const { canUseSection } = await accountAccess;
    return res.json({
      revision: Number(workspace.revision),
      data: {
        ...data,
        properties,
        surveys: !hasOpsAccess(req.user) || !canUseSection(req.user, 'lighting') ? [] : (data.surveys || []).filter((survey) => allowedIds.has(propertyIdFor(survey, propertiesByName)))
          .map((survey) => ({ ...survey, propertyId: propertyIdFor(survey, propertiesByName) })),
        buildingChecks: !hasOpsAccess(req.user) || !canUseSection(req.user, 'checks') ? [] : (data.buildingChecks || []).filter((project) => allowedIds.has(propertyIdFor(project, propertiesByName)))
      }
    });
  } catch (error) {
    console.error('Workspace load failed:', error.message);
    return apiError(res, 503, 'Could not load the shared workspace.');
  }
});

app.put('/api/workspace', authenticate, async (req, res) => {
  if (!hasOpsAccess(req.user)) {
    return apiError(res, 403, 'Your account cannot modify OHS records.');
  }
  const expectedRevision = Number(req.get('if-match'));
  const data = req.body?.data;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return apiError(res, 428, 'A valid workspace revision is required.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || !Array.isArray(data.surveys) || !Array.isArray(data.buildingChecks)
      || !Array.isArray(data.properties)) {
    return apiError(res, 400, 'The workspace data is incomplete or invalid.');
  }
  try {
    const { canUseSection } = await accountAccess;
    if ((!canUseSection(req.user, 'lighting') && data.surveys.length)
        || (!canUseSection(req.user, 'checks') && data.buildingChecks.length)
        || (!canUseSection(req.user, 'lighting') && !canUseSection(req.user, 'checks'))) {
      return apiError(res, 403, 'Your account cannot modify records in a disabled section.');
    }
    const result = await withTransaction(async (client) => {
      const properties = await accessibleProperties(req.user, client);
      const allowedIds = new Set(properties.map((property) => property.id));
      const propertiesByName = new Map(buildingCatalog.map((property) => [property.name.trim().toLocaleLowerCase(), property.id]));
      validateRecordScope(data.surveys, allowedIds, propertiesByName, 'surveys');
      validateRecordScope(data.buildingChecks, allowedIds, propertiesByName, 'building checks');
      const { rows } = await client.query('SELECT revision, data FROM shared_workspace WHERE id = 1 FOR UPDATE');
      const workspace = rows[0];
      if (Number(workspace.revision) !== expectedRevision) return { conflict: true, revision: Number(workspace.revision) };
      const current = workspace.data || { surveys: [], buildingChecks: [], properties: [] };
      const merged = {
        ...current,
        properties: buildingCatalog,
        surveys: canUseSection(req.user, 'lighting') ? mergeScopedRecords(current.surveys, data.surveys, allowedIds, propertiesByName) : current.surveys,
        buildingChecks: canUseSection(req.user, 'checks') ? mergeScopedRecords(current.buildingChecks, data.buildingChecks, allowedIds, propertiesByName) : current.buildingChecks,
        sensorCalibration: data.sensorCalibration || current.sensorCalibration || null
      };
      const update = await client.query(
        `UPDATE shared_workspace SET data = $1::jsonb, revision = revision + 1,
         updated_at = NOW(), updated_by = $2 WHERE id = 1 RETURNING revision, updated_at`,
        [JSON.stringify(merged), req.user.id]
      );
      return { revision: Number(update.rows[0].revision), updatedAt: update.rows[0].updated_at };
    });
    if (result.conflict) {
      return res.status(409).json({
        error: 'The shared workspace changed on another device. Your local copy remains saved on this device.',
        revision: result.revision
      });
    }
    return res.json(result);
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    console.error('Workspace save failed:', error.message);
    return apiError(res, 503, 'Could not save changes to the shared workspace. Your local copy remains available.');
  }
});

function safeSegment(value, fallback) {
  let name = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) name = `_${name}`;
  return name || fallback;
}

// Resolves a folder relative to the reports root and refuses anything that escapes it.
function resolveReportFolder(relative) {
  const companyRoot = companies.reportsRoot();
  const parts = String(relative || '').split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || /[<>:"|?*\u0000-\u001f]/.test(part))) {
    throw Object.assign(new Error('Use a folder path made of plain folder names.'), { status: 400 });
  }
  const resolved = path.resolve(companyRoot, ...parts);
  if (resolved !== companyRoot && !resolved.startsWith(companyRoot + path.sep)) {
    throw Object.assign(new Error('The folder must be inside the server reports location.'), { status: 400 });
  }
  return { resolved, relative: parts.join('/') };
}

async function currentReportFolder() {
  const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'reports_folder'");
  return resolveReportFolder(rows[0]?.value || '');
}

app.get('/api/settings/reports', authenticate, requireAdmin, async (req, res) => {
  if (req.user.role !== 'admin') return apiError(res, 403, 'Only administrators manage server report storage.');
  try {
    const current = await currentReportFolder();
    const browse = resolveReportFolder(req.query.browse ?? current.relative);
    await fs.promises.mkdir(browse.resolved, { recursive: true });
    const entries = await fs.promises.readdir(browse.resolved, { withFileTypes: true });
    return res.json({
      root: companies.reportsRoot(),
      folder: current.relative,
      absolutePath: current.resolved,
      browsing: browse.relative,
      folders: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    });
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    console.error('Report settings lookup failed:', error.message);
    return apiError(res, 503, 'Could not read the report storage settings.');
  }
});

app.put('/api/settings/reports', authenticate, requireAdmin, async (req, res) => {
  if (req.user.role !== 'admin') return apiError(res, 403, 'Only administrators manage server report storage.');
  try {
    const target = resolveReportFolder(req.body?.folder);
    await fs.promises.mkdir(target.resolved, { recursive: true });
    const probe = path.join(target.resolved, `.write-test-${crypto.randomUUID()}`);
    await fs.promises.writeFile(probe, 'ok');
    await fs.promises.rm(probe, { force: true });
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('reports_folder', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [target.relative]
    );
    return res.json({ folder: target.relative, absolutePath: target.resolved });
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    console.error('Report folder save failed:', error.message);
    return apiError(res, 400, 'The server could not write to that folder. Choose another one.');
  }
});

app.post('/api/reports', authenticate, async (req, res) => {
  if (!hasOpsAccess(req.user)) return apiError(res, 403, 'Your account cannot save reports.');
  const section = req.body?.section || (req.body?.kind === 'Lighting survey' ? 'lighting' : 'checks');
  if (!['lighting', 'checks'].includes(section) || !(await accountAccess).canUseSection(req.user, section)) {
    return apiError(res, 403, 'Your account cannot save reports for this section.');
  }
  const html = req.body?.html;
  if (typeof html !== 'string' || !html || html.length > 60 * 1024 * 1024) {
    return apiError(res, 400, 'The report is empty or too large.');
  }
  const building = String(req.body?.building || '').trim();
  try {
    if (req.user.role !== 'admin') {
      const allowed = await accessibleProperties(req.user);
      if (!allowed.some((property) => property.name.toLocaleLowerCase() === building.toLocaleLowerCase())) {
        return apiError(res, 403, 'You do not have access to this building.');
      }
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.date) ? req.body.date : new Date().toISOString().slice(0, 10);
    const kind = safeSegment(req.body?.kind, 'Report');
    const revision = Number(req.body?.revision) > 1 ? ` (revision ${Math.floor(Number(req.body.revision))})` : '';
    const base = await currentReportFolder();
    const dir = path.join(base.resolved, safeSegment(building, 'Unassigned building'), kind);
    await fs.promises.mkdir(dir, { recursive: true });
    const operation = req.get('X-Operation-ID');
    const stem = `${date} - ${kind}${revision}${operation ? ` (${operation})` : ''}`;
    let file = path.join(dir, `${stem}.html`);
    if (operation && fs.existsSync(file)) {
      if (await fs.promises.readFile(file, 'utf8') !== html) return apiError(res, 409, 'A different report already exists for this offline upload.');
    } else {
      for (let n = 2; fs.existsSync(file); n += 1) file = path.join(dir, `${stem} (${n}).html`);
      await fs.promises.writeFile(file, html, { flag: 'wx' });
    }
    return res.status(201).json({ path: path.relative(companies.reportsRoot(), file).split(path.sep).join('/') });
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    console.error('Report save failed:', error.message);
    return apiError(res, 503, 'The server could not save the report to its storage folder.');
  }
});

const billingStatuses = ['active', 'blocked', 'stopped'];
const billingKinds = ['charge', 'payment', 'credit'];

async function billingSnapshot(userId) {
  const [{ rows: accountRows }, { rows: entries }] = await Promise.all([
    pool.query(`SELECT u.id, u.display_name AS name, u.email, COALESCE(b.status, 'active') AS status, COALESCE(b.note, '') AS note,
                ARRAY(SELECT property_id FROM user_properties WHERE user_id = u.id ORDER BY property_id) AS property_ids
                FROM app_users u LEFT JOIN billing_accounts b ON b.user_id = u.id WHERE u.id = $1 AND u.role = 'user'`, [userId]),
    pool.query(`SELECT id, kind, amount_cents::float8 AS amount_cents, description, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, voided_at, created_at
                FROM billing_entries WHERE user_id = $1 ORDER BY entry_date, created_at`, [userId])
  ]);
  if (!accountRows[0]) return null;
  const balanceCents = entries.filter((entry) => !entry.voided_at).reduce(
    (total, entry) => total + (entry.kind === 'charge' ? entry.amount_cents : -entry.amount_cents), 0
  );
  return { account: accountRows[0], entries, balanceCents };
}

app.get('/api/billing/me', authenticate, async (req, res) => {
  if (req.user.role !== 'user')   return apiError(res, 403, 'Billing accounts are only available to resident accounts.');
  try {
    return res.json(await billingSnapshot(req.user.id));
  } catch (error) {
    console.error('Billing load failed:', error.message);
    return apiError(res, 503, 'Could not load your account.');
  }
});

app.get('/api/billing/accounts', authenticate, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.display_name AS name, u.email, u.active, COALESCE(b.status, 'active') AS status,
              ARRAY(SELECT property_id FROM user_properties WHERE user_id = u.id ORDER BY property_id) AS property_ids,
              COALESCE(SUM(CASE WHEN e.voided_at IS NOT NULL THEN 0 WHEN e.kind = 'charge' THEN e.amount_cents ELSE -e.amount_cents END), 0)::float8 AS balance_cents
       FROM app_users u
       LEFT JOIN billing_accounts b ON b.user_id = u.id
       LEFT JOIN billing_entries e ON e.user_id = u.id
       WHERE u.role = 'user' AND ${managedAccountScope('u', '$1', '$2')}
       GROUP BY u.id, b.status ORDER BY u.display_name`, [req.user.role === 'admin', req.user.id]
    );
    return res.json({ accounts: rows });
  } catch (error) {
    console.error('Billing list failed:', error.message);
    return apiError(res, 503, 'Could not load billing accounts.');
  }
});

app.get('/api/billing/accounts/:userId', authenticate, requireAdmin, async (req, res) => {
  try {
    await requireManagedAccount(req.user, String(req.params.userId));
    const snapshot = await billingSnapshot(String(req.params.userId));
    if (!snapshot) return apiError(res, 404, 'Resident account not found.');
    return res.json(snapshot);
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    console.error('Billing load failed:', error.message);
    return apiError(res, 503, 'Could not load the account.');
  }
});

app.put('/api/billing/accounts/:userId/status', authenticate, requireAdmin, async (req, res) => {
  const status = String(req.body?.status || '');
  const note = String(req.body?.note || '').trim().slice(0, 500);
  if (!billingStatuses.includes(status)) return apiError(res, 400, 'Status must be active, blocked or stopped.');
  try {
    await requireManagedAccount(req.user, String(req.params.userId));
    const snapshot = await billingSnapshot(String(req.params.userId));
    if (!snapshot) return apiError(res, 404, 'Resident account not found.');
    await pool.query(
      `INSERT INTO billing_accounts (user_id, status, note, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, updated_at = now()`,
      [snapshot.account.id, status, note]
    );
    return res.json(await billingSnapshot(snapshot.account.id));
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    console.error('Billing status failed:', error.message);
    return apiError(res, 503, 'Could not update the account status.');
  }
});

app.post('/api/billing/accounts/:userId/entries', authenticate, requireAdmin, async (req, res) => {
  const kind = String(req.body?.kind || '');
  const description = String(req.body?.description || '').trim();
  const amount = Number(req.body?.amount);
  const entryDate = String(req.body?.date || new Date().toISOString().slice(0, 10));
  if (!billingKinds.includes(kind)) return apiError(res, 400, 'Choose charge, payment or credit.');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return apiError(res, 400, 'Enter an amount greater than zero.');
  if (!description || description.length > 200) return apiError(res, 400, 'Enter a description of up to 200 characters.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate) || Number.isNaN(Date.parse(entryDate))) return apiError(res, 400, 'Enter a valid date.');
  try {
    await requireManagedAccount(req.user, String(req.params.userId));
    const snapshot = await billingSnapshot(String(req.params.userId));
    if (!snapshot) return apiError(res, 404, 'Resident account not found.');
    if (kind === 'charge' && snapshot.account.status !== 'active') {
      return apiError(res, 409, `Billing is ${snapshot.account.status} for this account. Set it to active before loading new charges.`);
    }
    const entryId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO billing_entries (id, user_id, kind, amount_cents, description, entry_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [entryId, snapshot.account.id, kind, Math.round(amount * 100), description, entryDate, req.user.id]
    );
    return res.status(201).json({ ...await billingSnapshot(snapshot.account.id), entryId });
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    console.error('Billing entry failed:', error.message);
    return apiError(res, 503, 'Could not save the entry.');
  }
});

app.post('/api/billing/accounts/:userId/entries/:entryId/void', authenticate, requireAdmin, async (req, res) => {
  try {
    await requireManagedAccount(req.user, String(req.params.userId));
    const { rowCount } = await pool.query(
      'UPDATE billing_entries SET voided_at = now() WHERE id = $1 AND user_id = $2 AND voided_at IS NULL',
      [String(req.params.entryId), String(req.params.userId)]
    );
    if (!rowCount) return apiError(res, 404, 'Entry not found or already voided.');
    return res.json(await billingSnapshot(String(req.params.userId)));
  } catch (error) {
    if (error.status) return apiError(res, error.status, error.message);
    console.error('Billing void failed:', error.message);
    return apiError(res, 503, 'Could not void the entry.');
  }
});

require('./appliances.cjs').mount(app, { pool, authenticate, requireAdmin, accessibleProperties, hasFullAccess, withTransaction, apiError, isValidJpeg });
require('./profile-photos.cjs').mount(app, { pool, authenticate, apiError, isValidJpeg });

app.use(express.static(path.join(__dirname, '..', 'www'), { index: false, fallthrough: true }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(__dirname, '..', 'www', 'index.html'));
});
app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && 'body' in error) return apiError(res, 400, 'The request body is not valid JSON.');
  if (error.type === 'entity.too.large') return apiError(res, 413, 'The submitted data is too large.');
  if (error.message?.includes('CORS')) return apiError(res, 403, error.message);
  console.error('Unhandled request error:', error.message);
  return apiError(res, 500, 'The backend could not complete the request.');
});

async function initialiseDatabase({ email = adminEmail, password = adminPassword, catalog = buildingCatalog, client = pool, subscriptionPlan = 'operations', newCompany = false } = {}) {
  const pool = client;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check;
    ALTER TABLE app_users ADD CONSTRAINT app_users_role_check CHECK (role IN ('admin', 'user', 'office_admin', 'maintenance_manager', 'portfolio_manager', 'building_manager', 'operations_manager', 'maintenance_assistant', 'technician'));
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS unit_number TEXT NOT NULL DEFAULT '';
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS resident_type TEXT NOT NULL DEFAULT 'student' CHECK(resident_type IN ('student','tenant'));
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS password_managed_in_app BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS app_properties (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      city TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_properties (
      user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      property_id TEXT NOT NULL REFERENCES app_properties(id),
      PRIMARY KEY (user_id, property_id)
    );
    CREATE TABLE IF NOT EXISTS shared_workspace (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision BIGINT NOT NULL DEFAULT 0,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT REFERENCES app_users(id)
    );
    CREATE TABLE IF NOT EXISTS maintenance_tickets (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL REFERENCES app_properties(id),
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'assigned', 'completed')),
      created_by TEXT NOT NULL REFERENCES app_users(id),
      assigned_to TEXT REFERENCES app_users(id),
      completion_photo BYTEA,
      completion_photo_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      CHECK ((status = 'completed') = (completion_photo IS NOT NULL))
    );
    ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS unit_number TEXT NOT NULL DEFAULT '';
    ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT ARRAY['General']::TEXT[];
    UPDATE maintenance_tickets t SET unit_number = u.unit_number FROM app_users u WHERE t.created_by = u.id AND t.unit_number = '' AND u.unit_number <> '';
    ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;
    ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS access_granted BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS access_granted_at TIMESTAMPTZ;
    ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS access_note TEXT NOT NULL DEFAULT '';
    ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS contractor_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE maintenance_tickets DROP CONSTRAINT IF EXISTS maintenance_tickets_status_check;
    ALTER TABLE maintenance_tickets DROP CONSTRAINT IF EXISTS maintenance_tickets_status_v2;
    ALTER TABLE maintenance_tickets ADD CONSTRAINT maintenance_tickets_status_v2
      CHECK (status IN ('submitted', 'assigned', 'in_progress', 'contractor', 'awaiting_stock', 'awaiting_access', 'out_of_stock', 'completed'));
    CREATE TABLE IF NOT EXISTS ticket_events (
      id BIGSERIAL PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES maintenance_tickets(id) ON DELETE CASCADE,
      actor_name TEXT NOT NULL,
      event TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ticket_events_ticket_idx ON ticket_events (ticket_id, created_at);
    CREATE INDEX IF NOT EXISTS maintenance_tickets_property_created_idx ON maintenance_tickets (property_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS maintenance_tickets_assigned_created_idx ON maintenance_tickets (assigned_to, created_at DESC);
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS billing_accounts (
      user_id TEXT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'stopped')),
      note TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS billing_entries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('charge', 'payment', 'credit')),
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      description TEXT NOT NULL,
      entry_date DATE NOT NULL,
      voided_at TIMESTAMPTZ,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS billing_entries_user_idx ON billing_entries (user_id, entry_date);
    INSERT INTO shared_workspace (id, revision) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
  `);
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS sections TEXT[];
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS admin_rights BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(require('./license.cjs').schema);
  await pool.query(subscriptions.schema);
  await pool.query(companyFeatures.schema);
  await pool.query(require('./operations.cjs').schema);
  await pool.query('INSERT INTO company_features(id,enabled,setup_complete) VALUES(1,$1,$2) ON CONFLICT DO NOTHING',
    [newCompany ? [] : companyFeatures.catalog.map((item) => item.id), !newCompany]);
  await pool.query('INSERT INTO company_subscription(id,plan) VALUES(1,$1) ON CONFLICT DO NOTHING', [subscriptions.planFor(subscriptionPlan).id]);
  await pool.query(require('./check-templates.cjs').schema);
  if (companies.isPrimary()) await require('./check-templates.cjs').seed(pool);
  await pool.query(require('./appliances.cjs').schema);
  await pool.query(require('./profile-photos.cjs').schema);
  if (companies.isPrimary()) await require('./appliances.cjs').seedParts(pool);
  await pool.query(require('./offline.cjs').schema);
  for (const property of catalog) {
    await pool.query(
      `INSERT INTO app_properties (id, name, city) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, city = EXCLUDED.city`,
      [property.id, property.name, property.city || '']
    );
  }
  if (catalog.length) await require('./building-locations.cjs').seedLocations(pool);
  await pool.query(
    `UPDATE shared_workspace SET data = $1::jsonb WHERE id = 1 AND data = '{}'::jsonb`,
    [JSON.stringify({ surveys: [], buildingChecks: [], properties: catalog, sensorCalibration: null })]
  );
  const passwordHash = password === null ? null : await bcrypt.hash(password, 12);
  if (password !== null) await pool.query(
    `INSERT INTO app_users (id, email, display_name, password_hash, role)
     VALUES ($1, $2, 'Administrator', $3, 'admin') ON CONFLICT (email) DO NOTHING`,
    [crypto.randomUUID(), email, passwordHash]
  );
  const { rows: adminRows } = await pool.query('SELECT role, password_hash, active,password_managed_in_app FROM app_users WHERE email = $1', [email]);
  if (adminRows[0]?.role !== 'admin') throw new Error('ADMIN_EMAIL is already in use by a non-administrator account.');
  if (password !== null && !adminRows[0].password_managed_in_app
      && (!adminRows[0].active || !(await bcrypt.compare(password, adminRows[0].password_hash)))) {
    await pool.query('UPDATE app_users SET password_hash = $1, active = TRUE,auth_version=auth_version+1 WHERE email = $2', [passwordHash, email]);
    console.log('Administrator password synchronised from ADMIN_PASSWORD.');
  }
}

async function start() {
  await controlPool.query(require('./companies.cjs').schema);
  await controlPool.query(require('./platform-accounts.cjs').schema);
  await controlPool.query(require('./invoice-documents.cjs').schema);
  await controlPool.query(require('./payfast.cjs').schema);
  await controlPool.query(require('./license-owner.cjs').schema);
  await initialiseDatabase({ client: pool });
  await platformAccounts.initialiseDemoBilling(companies.primaryCode, (await pool.query('SELECT plan FROM company_subscription WHERE id=1')).rows[0].plan);
  for (const company of await companies.list()) {
    if (company.code === companies.primaryCode) continue;
    await companies.run(company.code, async () => {
      // Existing companies keep their own administrator credentials.
      const { rows } = await pool.query("SELECT email FROM app_users WHERE role='admin' ORDER BY created_at LIMIT 1");
      if (!rows[0]) throw new Error(`Company ${company.code} has no administrator.`);
      await initialiseDatabase({ email: rows[0].email, password: null, catalog: [], client: pool });
      await platformAccounts.initialiseDemoBilling(company.code, (await pool.query('SELECT plan FROM company_subscription WHERE id=1')).rows[0].plan);
    });
  }
  platformAccounts.startInvoiceDelivery();
  platformAccounts.startRecurringBilling();
  app.listen(port, '0.0.0.0', () => console.log(`PrimeOps backend listening on port ${port}`));
  const adminListener = privateAdministration.listen(adminPort, adminHost, () => {
    console.log(`PrimeOps private administration listening on ${adminHost}:${adminListener.address().port}`);
  }).on('error', (error) => {
    console.error('Private administration startup failed:', error.message);
    process.exit(1);
  });
}

start().catch((error) => {
  console.error('Backend startup failed:', error.message);
  process.exitCode = 1;
});
