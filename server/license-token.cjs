const crypto = require('node:crypto');

function nextYear(value) {
  const date = new Date(value);
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return date.toISOString();
}

function validateClaims(claims) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!claims || ![1, 2].includes(claims.v) || !uuid.test(claims.systemId) || !uuid.test(claims.id)
      || (claims.previousId !== null && !uuid.test(claims.previousId))
      || !['issuedAt', 'termStart', 'expiresAt'].every((key) => typeof claims[key] === 'string'
        && Number.isFinite(Date.parse(claims[key])) && new Date(claims[key]).toISOString() === claims[key])
      || (claims.v === 1 && (claims.termStart < claims.issuedAt || claims.expiresAt !== nextYear(claims.termStart)))
      || (claims.v === 2 && (typeof claims.active !== 'boolean' || claims.expiresAt <= claims.termStart))) {
    throw new Error('Invalid annual licence contents.');
  }
  return claims;
}

function verifyToken(token, publicKey) {
  if (typeof token !== 'string' || token.length > 4096) throw new Error('Enter a valid signed licence token.');
  const parts = token.split('.');
  if (parts.length !== 3 || !['PO1', 'FG1'].includes(parts[0]) || !parts.slice(1).every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error('Enter a valid signed licence token.');
  }
  if (!crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'))) {
    throw new Error('The licence signature is invalid. Only the owner can generate renewal tokens.');
  }
  return validateClaims(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
}

function issueToken(privateKey, systemId, previousToken = null, now = new Date(), period = null) {
  const issuedAt = new Date(now).toISOString();
  const publicKey = crypto.createPublicKey(privateKey);
  const previous = previousToken ? verifyToken(previousToken.trim(), publicKey) : null;
  if (previous && previous.systemId !== systemId) throw new Error('The previous token belongs to another system.');
  if (previous && previous.issuedAt > issuedAt) throw new Error('The PC clock is earlier than the previous token. Correct the date/time first.');
  const termStart = previous?.expiresAt > issuedAt ? previous.expiresAt : issuedAt;
  const customPeriod = period || (previous?.v === 2 ? {
    startsAt: previous.expiresAt > issuedAt ? previous.termStart : issuedAt,
    expiresAt: nextYear(termStart), active: previous.active
  } : null);
  const claims = validateClaims({ v: customPeriod ? 2 : 1, systemId, id: crypto.randomUUID(), previousId: previous?.id || null,
    issuedAt, termStart: customPeriod ? customPeriod.startsAt : termStart,
    expiresAt: customPeriod ? customPeriod.expiresAt : nextYear(termStart), ...(customPeriod ? { active: customPeriod.active } : {}) });
  const payload = `PO1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  const signature = crypto.sign('sha256', Buffer.from(payload), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${payload}.${signature.toString('base64url')}`;
}

module.exports = { nextYear, validateClaims, verifyToken, issueToken };

if (require.main === module) {
  const fs = require('node:fs');
  const path = require('node:path');
  async function wizard() {
    const readline = require('node:readline/promises').createInterface({ input: process.stdin, output: process.stdout });
    const askPath = async (label) => (await readline.question(label)).trim().replace(/^"(.*)"$/, '$1');
    try {
      console.log('PrimeOps - private annual licence generator\nKeep this tool and ALL private keys on your own PC. Never send the private key to the app server.');
      const action = (await readline.question('1 = Create owner keys (once), 2 = Generate first token or renewal: ')).trim();
      if (action === '1') {
        const directory = await askPath('Folder for owner keys (e.g. C:\\PrimeOps-Owner): ');
        if (!directory) throw new Error('A private folder is required.');
        return [process.execPath, __filename, 'init', directory];
      }
      if (action !== '2') throw new Error('Choose 1 or 2.');
      const privatePath = await askPath('Path to licence-owner-private.pem: ');
      const id = (await readline.question('System ID shown on the app activation screen: ')).trim();
      const output = await askPath('Save NEW token file as (e.g. C:\\PrimeOps-Owner\\token-2027.txt): ');
      const previous = await askPath('Current token file for RENEWAL (leave blank for FIRST activation only): ');
      return [process.execPath, __filename, 'issue', privatePath, id, output, ...(previous ? [previous] : [])];
    } finally { readline.close(); }
  }
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'wizard' && args.length === 0) {
      void wizard().then(([executable, ...arguments]) => {
        const result = require('node:child_process').spawnSync(executable, arguments, { stdio: 'inherit' });
        if (result.error) throw result.error;
        process.exitCode = result.status ?? 1;
      }).catch((error) => { console.error(error.message); process.exitCode = 1; });
    } else if (command === 'init' && args.length === 1) {
      const directory = path.resolve(args[0]);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const privatePath = path.join(directory, 'licence-owner-private.pem');
      const publicPath = path.join(directory, 'licence-owner-public.pem');
      if (fs.existsSync(privatePath) || fs.existsSync(publicPath)) throw new Error('Keys already exist. Never overwrite your owner key.');
      const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
      fs.writeFileSync(privatePath, keys.privateKey, { flag: 'wx', mode: 0o600 });
      fs.writeFileSync(publicPath, keys.publicKey, { flag: 'wx' });
      console.log('Owner keys created. Keep the PRIVATE file offline and backed up. Copy only licence-owner-public.pem to the server.');
    } else if (command === 'issue' && (args.length === 3 || args.length === 4)) {
      const [privatePath, systemId, outputPath, previousPath] = args;
      const privateKey = crypto.createPrivateKey(fs.readFileSync(privatePath));
      const token = issueToken(privateKey, systemId, previousPath ? fs.readFileSync(previousPath, 'utf8') : null);
      fs.writeFileSync(outputPath, `${token}\n`, { flag: 'wx', mode: 0o600 });
      console.log(`Annual token saved. Expires ${verifyToken(token, crypto.createPublicKey(privateKey)).expiresAt}. Keep this file for the next renewal.`);
    } else {
      throw new Error('Usage:\n  node PrimeOps-Licence-Generator.cjs init <private-folder>\n  node PrimeOps-Licence-Generator.cjs issue <private.pem> <system-id> <new-token.txt> [previous-token.txt]');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
