const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { nextYear, issueToken, verifyToken } = require('./license-token.cjs');

const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const systemId = crypto.randomUUID();

test('pre-rebrand tokens remain valid and renew into the PrimeOps format', () => {
  const modern = issueToken(keys.privateKey, systemId);
  const payload = `FG1.${modern.split('.')[1]}`;
  const token = `${payload}.${crypto.sign('sha256', Buffer.from(payload), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  const previous = verifyToken(token, keys.publicKey);
  const renewed = issueToken(keys.privateKey, systemId, token);
  assert(renewed.startsWith('PO1.'));
  assert.equal(verifyToken(renewed, keys.publicKey).previousId, previous.id);
});

test('one calendar year, leap day clamping, early and late renewals', () => {
  assert.equal(nextYear('2024-02-29T12:34:56.000Z'), '2025-02-28T12:34:56.000Z');
  const first = issueToken(keys.privateKey, systemId, null, '2024-02-29T12:34:56.000Z');
  const early = verifyToken(issueToken(keys.privateKey, systemId, first, '2025-02-01T10:00:00.000Z'), keys.publicKey);
  assert.equal(early.termStart, '2025-02-28T12:34:56.000Z');
  assert.equal(early.expiresAt, '2026-02-28T12:34:56.000Z');
  assert.equal(early.previousId, verifyToken(first, keys.publicKey).id);
  const late = verifyToken(issueToken(keys.privateKey, systemId, first, '2025-03-10T10:00:00.000Z'), keys.publicKey);
  assert.equal(late.termStart, late.issuedAt);
  assert.equal(late.expiresAt, '2026-03-10T10:00:00.000Z');
  assert.throws(() => issueToken(keys.privateKey, crypto.randomUUID(), first), /another system/);
});

test('forged, tampered, malformed and wrong-key tokens are rejected', () => {
  const token = issueToken(keys.privateKey, systemId);
  assert.equal(verifyToken(token, keys.publicKey).systemId, systemId);
  const parts = token.split('.');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  claims.expiresAt = '2099-01-01T00:00:00.000Z';
  assert.throws(() => verifyToken(`PO1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${parts[2]}`, keys.publicKey), /signature/);
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.throws(() => verifyToken(token, other.publicKey), /signature/);
  for (const invalid of ['', 'PO1.a.b', token + '.extra', 'x'.repeat(5000)]) assert.throws(() => verifyToken(invalid, keys.publicKey));
});

test('manual periods are signed, support past/future dates and preserve start restrictions on renewal', () => {
  const first = issueToken(keys.privateKey, systemId, null, '2026-01-01T00:00:00.000Z');
  const period = { startsAt: '2026-03-01T00:00:00.000Z', expiresAt: '2026-06-15T12:00:00.000Z', active: true };
  const token = issueToken(keys.privateKey, systemId, first, '2026-01-02T00:00:00.000Z', period);
  const claims = verifyToken(token, keys.publicKey);
  assert.equal(claims.v, 2);
  assert.equal(claims.termStart, period.startsAt);
  assert.equal(claims.expiresAt, period.expiresAt);
  const renewal = verifyToken(issueToken(keys.privateKey, systemId, token, '2026-02-01T00:00:00.000Z'), keys.publicKey);
  assert.equal(renewal.v, 2);
  assert.equal(renewal.termStart, period.startsAt);
  assert.equal(renewal.expiresAt, '2027-06-15T12:00:00.000Z');
  const past = verifyToken(issueToken(keys.privateKey, systemId, token, '2026-02-01T00:00:00.000Z',
    { startsAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-02-01T00:00:00.000Z', active: false }), keys.publicKey);
  assert.equal(past.active, false);
  for (const invalid of [{ ...period, expiresAt: period.startsAt }, { ...period, active: 'false' }, { ...period, startsAt: 'bad-date' }]) {
    assert.throws(() => issueToken(keys.privateKey, systemId, first, '2026-01-02T00:00:00.000Z', invalid));
  }
});

test('standalone generator creates owner keys, issues tokens, and refuses overwrites', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-licence-generator-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'license-token.cjs'), ...args], { encoding: 'utf8' });
  assert.equal(run('init', directory).status, 0);
  assert.equal(run('init', directory).status, 1);
  const privatePath = path.join(directory, 'licence-owner-private.pem');
  const output = path.join(directory, 'first.txt');
  assert.equal(run('issue', privatePath, systemId, output).status, 0);
  const publicKey = await fs.readFile(path.join(directory, 'licence-owner-public.pem'));
  const token = (await fs.readFile(output, 'utf8')).trim();
  assert.equal(verifyToken(token, publicKey).systemId, systemId);
  assert.equal(run('issue', privatePath, systemId, output).status, 1);
  const renewed = path.join(directory, 'renewed.txt');
  assert.equal(run('issue', privatePath, systemId, renewed, output).status, 0);
  assert.equal(verifyToken((await fs.readFile(renewed, 'utf8')).trim(), publicKey).termStart, verifyToken(token, publicKey).expiresAt);
});
