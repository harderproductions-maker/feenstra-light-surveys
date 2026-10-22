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
const jwtSecret = process.env.JWT_SECRET;
const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD || '';
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const buildingCatalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'www', 'building-check-templates.json'), 'utf8')).properties;
const allowedOrigins = new Set(
  String(process.env.CORS_ORIGINS || 'capacitor://localhost,http://localhost,https://localhost')
    .split(',').map((origin) => origin.trim()).filter(Boolean)
);
const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
const app = express();
const loginAttempts = new Map();

if (!jwtSecret || Buffer.byteLength(jwtSecret) < 32) {
  throw new Error('JWT_SECRET must contain at least 32 characters.');
}
if (!adminEmail || adminPassword.length < 12) {
  throw new Error('Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters.');
}
if (!databaseUrl) {
  throw new Error('Set DATABASE_URL to the PostgreSQL connection string.');
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use((req, res, next) => cors({
  origin(origin, callback) {
    const requestOrigin = `${req.protocol}://${req.get('host')}`;
    if (!origin || allowedOrigins.has(origin) || origin === requestOrigin) return callback(null, true);
    return callback(new Error('This app origin is not allowed by CORS.'));
  },
  methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'If-Match'],
  maxAge: 600
})(req, res, next));
app.use(express.json({ limit: '64mb' }));

function apiError(res, status, message) {
  return res.status(status).json({ error: message });
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function signInToken(user) {
  return jwt.sign(
    { sub: user.id },
    jwtSecret,
    { expiresIn: '12h', issuer: 'feenstra-building-ohs' }
  );
}

async function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return apiError(res, 401, 'Sign in to continue.');
  let claims;
  try {
    claims = jwt.verify(token, jwtSecret, { issuer: 'feenstra-building-ohs' });
  } catch {
    return apiError(res, 401, 'Your sign-in has expired. Sign in again.');
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, email, display_name, role FROM app_users WHERE id = $1 AND active = TRUE',
      [claims.sub]
    );
    if (!rows[0]) return apiError(res, 401, 'This account is no longer active.');
    req.user = rows[0];
  } catch {
    return apiError(res, 503, 'Could not verify your sign-in with the backend.');
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return apiError(res, 403, 'Administrator access is required.');
  return next();
}

async function accessibleProperties(user, database = pool) {
  const query = user.role === 'admin'
    ? 'SELECT id, name, city FROM app_properties WHERE active = TRUE ORDER BY name'
    : `SELECT p.id, p.name, p.city FROM app_properties p
       JOIN user_properties up ON up.property_id = p.id
       WHERE up.user_id = $1 AND p.active = TRUE ORDER BY p.name`;
  const { rows } = await database.query(query, user.role === 'admin' ? [] : [user.id]);
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
      'SELECT id, email, display_name, password_hash, role FROM app_users WHERE email = $1 AND active = TRUE',
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
        propertyIds: properties.map((property) => property.id)
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
    const { rows } = await pool.query(
      'INSERT INTO app_properties (id, name, city) VALUES ($1, $2, $3) RETURNING id, name, city',
      [id, name, city]
    );
    return res.status(201).json({ property: rows[0] });
  } catch (error) {
    if (error.code === '23505') return apiError(res, 409, 'A building with this name already exists.');
    console.error('Building creation failed:', error.message);
    return apiError(res, 503, 'Could not add the building.');
  }
});

app.get('/api/users', authenticate, requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.display_name AS name, u.role, u.active, u.created_at,
              COALESCE(array_agg(up.property_id) FILTER (WHERE up.property_id IS NOT NULL), ARRAY[]::TEXT[]) AS property_ids
       FROM app_users u LEFT JOIN user_properties up ON up.user_id = u.id
       GROUP BY u.id ORDER BY u.created_at`
    );
    return res.json({ users: rows });
  } catch (error) {
    console.error('User list failed:', error.message);
    return apiError(res, 503, 'Could not load user accounts.');
  }
});

function validateUserInput(req, res, requirePassword) {
  const email = normalizeEmail(req.body?.email);
  const name = String(req.body?.name || '').trim();
  const password = String(req.body?.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    apiError(res, 400, 'Enter a valid email address.');
    return null;
  }
  if (!name || name.length > 100) {
    apiError(res, 400, 'Enter a name of up to 100 characters.');
    return null;
  }
  if ((requirePassword || password) && (password.length < 12 || password.length > 200)) {
    apiError(res, 400, 'Use a password between 12 and 200 characters.');
    return null;
  }
  const propertyIds = req.body?.propertyIds;
  if (!Array.isArray(propertyIds) || propertyIds.length === 0 || propertyIds.some((id) => typeof id !== 'string')) {
    apiError(res, 400, 'Assign at least one building to this account.');
    return null;
  }
  return { email, name, password, propertyIds: [...new Set(propertyIds)] };
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

app.post('/api/users', authenticate, requireAdmin, async (req, res) => {
  const input = validateUserInput(req, res, true);
  if (!input) return;
  try {
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await withTransaction(async (client) => {
      const id = crypto.randomUUID();
      const { rows } = await client.query(
        `INSERT INTO app_users (id, email, display_name, password_hash, role)
         VALUES ($1, $2, $3, $4, 'user')
         RETURNING id, email, display_name AS name, role, active, created_at`,
        [id, input.email, input.name, passwordHash]
      );
      await replaceUserProperties(client, id, input.propertyIds);
      return { ...rows[0], property_ids: input.propertyIds };
    });
    return res.status(201).json({ user });
  } catch (error) {
    if (error.code === '23505') return apiError(res, 409, 'An account with this email already exists.');
    if (error.status) return apiError(res, error.status, error.message);
    console.error('User creation failed:', error.message);
    return apiError(res, 503, 'Could not create the account.');
  }
});

app.put('/api/users/:id', authenticate, requireAdmin, async (req, res) => {
  const input = validateUserInput(req, res, false);
  if (!input) return;
  const active = req.body?.active !== false;
  if (!active && req.params.id === req.user.id) return apiError(res, 400, 'You cannot deactivate your own account.');
  try {
    const user = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE app_users SET email = $1, display_name = $2, active = $3
         WHERE id = $4 AND role = 'user'
         RETURNING id, email, display_name AS name, role, active, created_at`,
        [input.email, input.name, active, req.params.id]
      );
      if (!rows[0]) throw Object.assign(new Error('The user account was not found.'), { status: 404 });
      await replaceUserProperties(client, req.params.id, input.propertyIds);
      if (input.password) {
        const passwordHash = await bcrypt.hash(input.password, 12);
        await client.query('UPDATE app_users SET password_hash = $1 WHERE id = $2', [passwordHash, req.params.id]);
      }
      return { ...rows[0], property_ids: input.propertyIds };
    });
    return res.json({ user });
  } catch (error) {
    if (error.code === '23505') return apiError(res, 409, 'An account with this email already exists.');
    if (error.status) return apiError(res, error.status, error.message);
    console.error('User update failed:', error.message);
    return apiError(res, 503, 'Could not update the account.');
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
    return res.json({
      revision: Number(workspace.revision),
      data: {
        ...data,
        properties,
        surveys: (data.surveys || []).filter((survey) => allowedIds.has(propertyIdFor(survey, propertiesByName)))
          .map((survey) => ({ ...survey, propertyId: propertyIdFor(survey, propertiesByName) })),
        buildingChecks: (data.buildingChecks || []).filter((project) => allowedIds.has(propertyIdFor(project, propertiesByName)))
      }
    });
  } catch (error) {
    console.error('Workspace load failed:', error.message);
    return apiError(res, 503, 'Could not load the shared workspace.');
  }
});

app.put('/api/workspace', authenticate, async (req, res) => {
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
        surveys: mergeScopedRecords(current.surveys, data.surveys, allowedIds, propertiesByName),
        buildingChecks: mergeScopedRecords(current.buildingChecks, data.buildingChecks, allowedIds, propertiesByName),
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

async function start() {
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
    INSERT INTO shared_workspace (id, revision) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
  `);
  for (const property of buildingCatalog) {
    await pool.query(
      `INSERT INTO app_properties (id, name, city) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, city = EXCLUDED.city`,
      [property.id, property.name, property.city || '']
    );
  }
  await pool.query(
    `UPDATE shared_workspace SET data = $1::jsonb WHERE id = 1 AND data = '{}'::jsonb`,
    [JSON.stringify({ surveys: [], buildingChecks: [], properties: buildingCatalog, sensorCalibration: null })]
  );
  const passwordHash = await bcrypt.hash(adminPassword, 12);
  await pool.query(
    `INSERT INTO app_users (id, email, display_name, password_hash, role)
     VALUES ($1, $2, 'Administrator', $3, 'admin') ON CONFLICT (email) DO NOTHING`,
    [crypto.randomUUID(), adminEmail, passwordHash]
  );
  const { rows: adminRows } = await pool.query('SELECT role FROM app_users WHERE email = $1', [adminEmail]);
  if (adminRows[0]?.role !== 'admin') throw new Error('ADMIN_EMAIL is already in use by a non-administrator account.');
  app.listen(port, '0.0.0.0', () => console.log(`Feenstra backend listening on port ${port}`));
}

start().catch((error) => {
  console.error('Backend startup failed:', error.message);
  process.exitCode = 1;
});
