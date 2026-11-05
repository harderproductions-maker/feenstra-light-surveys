const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { browserSession } = require('./browser-test-helper.cjs');

test('device backup UI downloads, restores safely and uses the native save bridge', { skip: !process.env.CHROMIUM }, async (t) => {
  const { decryptTransfer, encryptTransfer } = await import('../www/device-transfer.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'primeops-transfer-'));
  const app = express();
  app.use('/www', express.static(path.join(__dirname, '../www')));
  app.get('/', (_req, res) => res.type('html').send(`<!doctype html><button data-device-transfer>Device backup</button>
    <script type="module">
      import { wireDeviceTransfer } from '/www/device-transfer.mjs';
      window.fixtureInstance = Math.random();
      const request = indexedDB.open('primeops-transfer-fixture', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('workspace');
      const ready = new Promise((resolve, reject) => {
        request.onsuccess = () => { window.fixtureDatabase = request.result; resolve(); };
        request.onerror = () => reject(request.error);
      });
      wireDeviceTransfer({
        getDatabase: () => window.fixtureDatabase, getCompany: () => 'SAMPLE',
        getUser: () => window.transferUser, ready: () => ready,
        saveNativeBackup: location.search ? async (data, filename) => {
          if (window.nativeError) throw new Error(window.nativeError);
          window.nativeBackup = { data, filename };
        } : null
      });
      await ready;
      window.fixtureReady = true;
    </script>`));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { cdp, evaluate, waitFor, errors } = await browserSession(t, process.env.CHROMIUM, ['--headless']);
  await cdp('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: directory });
  await cdp('Page.navigate', { url: base });
  await waitFor('window.fixtureReady');
  const jobs = { jobs: [{ id: 'preserved-job', state: 'pending', body: { note: 'Offline inspection' } }] };
  await evaluate(`(async () => {
    const { writeDatabaseEntries } = await import('/www/product-migration.mjs');
    await writeDatabaseEntries(window.fixtureDatabase, [['offline-v1:fixture', ${JSON.stringify(jobs)}]]);
    localStorage.setItem('primeops-token-SAMPLE', 'private-session');
    document.querySelector('[data-device-transfer]').click();
    const form = document.querySelector('#device-transfer-dialog form');
    form.elements.password.value = 'backup-password-123';
    form.requestSubmit(form.querySelector('[value=export]'));
  })()`);
  await waitFor('document.querySelector("[data-transfer-status]").textContent.includes("Backup ready")');
  const file = path.join(directory, 'PrimeOps-device-backup.json');
  let contents;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { contents = await fs.readFile(file, 'utf8'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert(contents, 'Browser must actually save the encrypted backup');
  assert(!contents.includes('private-session') && !contents.includes('Offline inspection'));
  const data = await decryptTransfer(JSON.parse(contents), 'backup-password-123');
  assert.deepEqual(data.entries, [['offline-v1:fixture', jobs]]);
  assert.equal(data.settings['primeops-token-SAMPLE'], 'private-session');
  const restore = async (text, password = 'backup-password-123') => {
    await evaluate(`(() => {
      const form = document.querySelector('#device-transfer-dialog form');
      const transfer = new DataTransfer();
      transfer.items.add(new File([${JSON.stringify(text)}], 'backup.json', { type: 'application/json' }));
      form.elements.backup.files = transfer.files;
      form.elements.password.value = ${JSON.stringify(password)};
      form.requestSubmit(form.querySelector('[value=import]'));
    })()`);
  };
  await evaluate('window.transferUser = { id: 1 }');
  await restore(contents);
  await waitFor('document.querySelector("[data-transfer-status]").textContent.includes("Sign out")');
  await evaluate('window.transferUser = null');
  await restore(contents, 'incorrect-password');
  await waitFor('document.querySelector("[data-transfer-status]").textContent.includes("incorrect")');
  await restore(contents);
  await waitFor('document.querySelector("[data-transfer-status]").textContent.includes("already has local work")');
  await evaluate(`new Promise((resolve, reject) => {
    const transaction = window.fixtureDatabase.transaction('workspace', 'readwrite');
    transaction.objectStore('workspace').clear();
    transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
    localStorage.removeItem('primeops-token-SAMPLE');
  })`);
  const otherCompany = await encryptTransfer({ ...data, company: 'OTHER' }, 'backup-password-123');
  await restore(JSON.stringify(otherCompany));
  await waitFor('document.querySelector("[data-transfer-status]").textContent.includes("does not match")');
  const instance = await evaluate('window.fixtureInstance');
  await restore(contents);
  await waitFor(`window.fixtureReady && window.fixtureInstance !== ${instance}`);
  assert.equal(await evaluate('localStorage.getItem("primeops-token-SAMPLE")'), 'private-session');
  assert.deepEqual(await evaluate(`(async () => {
    const { readDatabaseEntries } = await import('/www/product-migration.mjs');
    return readDatabaseEntries(window.fixtureDatabase);
  })()`), data.entries);
  await cdp('Page.navigate', { url: `${base}/?native=1` });
  await waitFor('window.fixtureReady');
  await evaluate(`document.querySelector('[data-device-transfer]').click();
    const form = document.querySelector('#device-transfer-dialog form');
    form.elements.password.value = 'backup-password-123';
    form.requestSubmit(form.querySelector('[value=export]'));`);
  await waitFor('!!window.nativeBackup && document.querySelector("[data-transfer-status]").textContent.includes("Backup ready")');
  const native = await evaluate('window.nativeBackup');
  assert.equal(native.filename, 'PrimeOps-device-backup.json');
  assert.deepEqual(await decryptTransfer(JSON.parse(native.data), 'backup-password-123'), data);
  await evaluate(`window.nativeError = 'Could not save device backup';
    document.querySelector('#device-transfer-dialog form').requestSubmit(document.querySelector('[value=export]'));`);
  await waitFor('document.querySelector("[data-transfer-status]").textContent === "Could not save device backup"');
  assert.deepEqual(errors, []);
});
