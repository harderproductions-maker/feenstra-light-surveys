const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { registerAndroidUpdates, validateManifest } = require('./android-updates.cjs');
const { publishAndroidUpdate } = require('../scripts/publish_android_update.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-android-update-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const build = path.join(root, 'build');
  const updates = path.join(root, 'updates');
  await fs.mkdir(build);
  await fs.writeFile(path.join(build, 'app-debug.apk'), Buffer.from('Test APK bytes'));
  async function version(versionCode) {
    await fs.writeFile(path.join(build, 'output-metadata.json'), JSON.stringify({
      applicationId: 'app.primeops.mobile',
      elements: [{ type: 'SINGLE', filters: [], versionCode, versionName: `1.6.0.${versionCode}`, outputFile: 'app-debug.apk' }]
    }));
  }
  await version(20);
  return { root, build, updates, version };
}

test('publishes authoritative version, size and digest; rejects version reuse and downgrades', async (t) => {
  const { build, updates, version } = await fixture(t);
  const manifest = await publishAndroidUpdate(build, updates);
  assert.equal(manifest.versionCode, 20);
  const bytes = await fs.readFile(path.join(updates, 'PrimeOps-20.apk'));
  assert.equal(manifest.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(manifest.size, bytes.length);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(updates, 'manifest.json'))), manifest);
  await publishAndroidUpdate(build, updates);
  await fs.writeFile(path.join(build, 'app-debug.apk'), 'Changed build');
  await assert.rejects(() => publishAndroidUpdate(build, updates), /higher Android versionCode/);
  await version(21);
  await publishAndroidUpdate(build, updates);
  await version(20);
  await assert.rejects(() => publishAndroidUpdate(build, updates), /higher Android versionCode/);
});

test('serves updates without login and detects new deployments without a server restart', async (t) => {
  const { build, updates, version } = await fixture(t);
  const app = express();
  registerAndroidUpdates(app, updates);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/app-updates/android`;
  let response = await fetch(base);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { available: false });
  response = await fetch(`${base}/download`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'No Android app has been published on this server yet.' });
  const manifest = await publishAndroidUpdate(build, updates);
  response = await fetch(base);
  assert.deepEqual(await response.json(), { available: true, ...manifest });
  response = await fetch(`${base}/download`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="PrimeOps.apk"');
  assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), manifest.sha256);
  response = await fetch(`${base}/apk/20`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="PrimeOps-20.apk"');
  assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), manifest.sha256);
  await version(21);
  await publishAndroidUpdate(build, updates);
  assert.equal((await (await fetch(base)).json()).versionCode, 21);
  response = await fetch(`${base}/apk/20`);
  assert.equal(response.status, 200);
  assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), manifest.sha256);
  assert.equal((await fetch(`${base}/apk/22`)).status, 404);
  for (const invalid of ['0', '01', '-1', '2100000001', '20.txt']) {
    assert.equal((await fetch(`${base}/apk/${invalid}`)).status, 400, invalid);
  }
  await fs.writeFile(path.join(updates, 'PrimeOps-21.apk'), '');
  assert.equal((await fetch(base)).status, 503);
  assert.equal((await fetch(`${base}/apk/21`)).status, 503);
  await fs.writeFile(path.join(updates, 'manifest.json'), '{broken');
  assert.equal((await fetch(base)).status, 503);
});

test('rejects invalid update metadata rather than exposing arbitrary files', () => {
  const valid = {
    applicationId: 'app.primeops.mobile', versionCode: 20,
    versionName: '1.6.0.20', size: 100, sha256: 'a'.repeat(64)
  };
  for (const changes of [
    { applicationId: 'other' }, { versionCode: '../../secret' }, { versionCode: 2100000001 },
    { versionCode: -1 }, { size: 0 }, { size: 300 * 1024 * 1024 }, { sha256: 'no' }, { versionName: '' }
  ]) assert.throws(() => validateManifest({ ...valid, ...changes }), /invalid/);
});
