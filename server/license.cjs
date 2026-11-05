const crypto = require('node:crypto');
const fs = require('node:fs');
const { verifyToken } = require('./license-token.cjs');

const schema = `CREATE TABLE IF NOT EXISTS system_licence (
  id INTEGER PRIMARY KEY CHECK(id=1),
  system_id UUID NOT NULL,
  token TEXT,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO system_licence(id,system_id) VALUES(1,gen_random_uuid()) ON CONFLICT(id) DO NOTHING;
${require('./license-owner.cjs').renewalSchema}
CREATE TABLE IF NOT EXISTS licence_adjustments (
  id UUID PRIMARY KEY,
  changed_by TEXT NOT NULL,
  previous_token TEXT,
  token TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;

function createLicence({ pool, withTransaction, ownerPool = pool, companies, initialiseCompany, platformAccounts, clientAccounts, publicKeyFile = process.env.LICENSE_PUBLIC_KEY_FILE }) {
  let publicKey = null;
  if (publicKeyFile) {
    publicKey = crypto.createPublicKey(fs.readFileSync(publicKeyFile));
    if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails.namedCurve !== 'prime256v1') {
      throw new Error('LICENSE_PUBLIC_KEY_FILE must contain the owner P-256 public key.');
    }
  }
  async function registeredKey(database = pool) {
    const { rows } = await ownerPool.query('SELECT public_key,test_renewal_enabled FROM licence_owner WHERE id=1');
    const key = rows[0] ? crypto.createPublicKey(rows[0].public_key) : publicKey;
    return { key, ownerRegistered: !!rows[0], testRenewalEnabled: companies ? companies.current().test_renewal_enabled : rows[0]?.test_renewal_enabled || false };
  }
  const clockError = () => Object.assign(new Error('The server clock moved backwards. Correct the server date/time before using the system.'), { status: 423 });
  async function snapshot(database = pool) {
    const { rows } = await database.query('SELECT system_id,token,last_seen FROM system_licence WHERE id=1');
    const row = rows[0];
    const registration = await registeredKey(database);
    const verificationKey = registration.key;
    if (!row) throw new Error('The system licence has not been initialised.');
    const now = Date.now();
    const lastSeen = new Date(row.last_seen).getTime();
    const serverTime = new Date(Math.max(now, lastSeen)).toISOString();
    let claims = null, state = 'unconfigured', message = 'Register this system in the Windows owner app.';
    if (now + 300000 < lastSeen) { state = 'clock'; message = clockError().message; }
    else if (verificationKey) {
      if (!row.token) { state = 'missing'; message = 'Ask the owner to register this company licence.'; }
      else {
        claims = verifyToken(row.token, verificationKey);
        if (claims.systemId !== row.system_id) throw new Error('The stored licence belongs to another system.');
        state = Date.parse(claims.expiresAt) > Math.max(now, lastSeen) ? 'active' : 'expired';
        if (claims.v === 2 && Date.parse(claims.termStart) > Math.max(now, lastSeen)) state = 'scheduled';
        if (claims.v === 2 && !claims.active) state = 'inactive';
        message = state === 'active' ? 'Annual licence active.' : 'The annual licence has expired. Ask the owner to renew it.';
        if (state === 'scheduled') message = 'The licence period has not started yet.';
        if (state === 'inactive') message = 'This client account is inactive. Contact PrimeOps.';
      }
      if (companies?.current().active === false) { state = 'inactive'; message = 'This client account is inactive. Contact PrimeOps.'; }
    }
    await database.query('UPDATE system_licence SET last_seen=GREATEST(last_seen,$1::timestamptz) WHERE id=1', [new Date(now).toISOString()]);
    return { systemId: row.system_id, token: row.token, publicKey: verificationKey?.export({ format: 'jwk' }) || null,
      serverTime, state, message, ownerRegistered: registration.ownerRegistered, testRenewalEnabled: registration.testRenewalEnabled,
      companyCode: companies?.current().code || '', companyName: companies?.current().name || 'Company' };
  }
  const buckets = new Map();
  function mount(app) {
    require('./license-owner.cjs').createOwnerService({ pool, ownerPool, withTransaction, secret: process.env.JWT_SECRET,
      companies, initialiseCompany, platformAccounts, clientAccounts }).mount(app, snapshot);
    app.get('/api/license', async (_req, res) => {
      res.set('Cache-Control', 'no-store');
      try { return res.json(await snapshot()); }
      catch (error) {
        console.error('Licence status failed:', error.message);
        return res.status(503).json({ error: 'Could not verify the system licence. Reconnect and retry.' });
      }
    });
    app.post('/api/license/activate', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const now = Date.now();
      const bucket = buckets.get(req.ip) || { since: now, count: 0 };
      if (now - bucket.since >= 60000) { bucket.since = now; bucket.count = 0; }
      if (buckets.size > 10000) for (const [ip, value] of buckets) if (now - value.since >= 60000) buckets.delete(ip);
      buckets.set(req.ip, bucket);
      if (++bucket.count > 10) return res.status(429).json({ error: 'Too many activation attempts. Wait a minute and retry.' });
      try {
        const { key: publicKey } = await registeredKey();
        if (!publicKey) throw new Error('Register this system in the Windows owner app first.');
        const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
        const claims = verifyToken(token, publicKey);
        await withTransaction(async (client) => {
          const { rows } = await client.query('SELECT * FROM system_licence WHERE id=1 FOR UPDATE');
          const row = rows[0];
          if (now + 300000 < new Date(row.last_seen).getTime()) throw clockError();
          if (claims.systemId !== row.system_id) throw new Error('This token belongs to another system.');
          if (Date.parse(claims.issuedAt) > now + 300000 || Date.parse(claims.expiresAt) <= now) throw new Error('This token is not currently valid.');
          if (token === row.token) return;
          const previous = row.token ? verifyToken(row.token, publicKey) : null;
          if (claims.previousId !== (previous?.id || null)
              || (claims.v === 1 && claims.termStart !== (previous?.expiresAt > claims.issuedAt ? previous.expiresAt : claims.issuedAt))
              || (previous && claims.issuedAt < previous.issuedAt)) {
            throw new Error('Generate a new renewal using the system current token as the previous-token file. Older tokens cannot renew this system.');
          }
          await client.query('UPDATE system_licence SET token=$1,last_seen=GREATEST(last_seen,NOW()) WHERE id=1', [token]);
        });
        return res.json(await snapshot());
      } catch (error) {
        console.error('Licence activation failed:', error.message);
        return res.status(error.status || (error.code ? 503 : 400)).json({ error: error.code
          ? 'The licence could not be saved. Reconnect and retry.' : error.message });
      }
    });
    app.use('/api', async (req, res, next) => {
      if (req.path === '/health' || /^\/app-updates\/android(?:\/|$)/.test(req.path)) return next();
      res.set('Cache-Control', 'private, no-store');
      try {
        const licence = await snapshot();
        if (licence.state !== 'active') return res.status(423).json({ error: licence.message, code: 'LICENSE_REQUIRED' });
        return next();
      } catch (error) {
        console.error('Licence enforcement failed:', error.message);
        return res.status(503).json({ error: 'Could not verify the system licence. Reconnect and retry.' });
      }
    });
  }
  return { mount, snapshot };
}
module.exports = { schema, createLicence };
