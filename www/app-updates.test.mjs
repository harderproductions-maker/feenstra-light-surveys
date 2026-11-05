import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAndroidUpdater } from './app-updates.mjs';

const release = {
  available: true, applicationId: 'app.primeops.mobile', versionCode: 20,
  versionName: '1.6.0.20', size: 1024, sha256: 'a'.repeat(64)
};

function setup() {
  let server = 'https://server.example';
  let response = { ...release };
  let error;
  let time = 0;
  let calls = 0;
  let failure;
  const statuses = [];
  const installations = [];
  const updater = createAndroidUpdater({
    native: {
      getInfo: async () => ({ versionCode: 10, versionName: '1.6.0.10' }),
      install: async (options) => {
        installations.push(options);
        if (failure) throw failure;
        return { installerOpened: true };
      }
    },
    request: async () => {
      calls++;
      if (error) throw error;
      return response;
    },
    getServer: () => server,
    notify: (status) => statuses.push(status),
    now: () => time
  });
  return {
    updater, statuses, installations, calls: () => calls,
    response: (value) => { response = value; }, fail: (value) => { error = value; },
    failInstall: (value) => { failure = value; },
    server: (value) => { server = value; }, time: (value) => { time = value; }
  };
}

test('discovers a newer server-hosted release and passes exact verification details to Android', async () => {
  const app = setup();
  await app.updater.check();
  assert.equal(app.statuses.at(-1).canInstall, true);
  assert(app.statuses.at(-1).message.includes(release.versionName));
  await app.updater.install();
  assert.deepEqual(app.installations, [{
    url: 'https://server.example/api/app-updates/android/apk/20',
    versionCode: 20, size: 1024, sha256: release.sha256
  }]);
  assert.match(app.statuses.at(-1).message, /installer opened/);
});

test('never offers an older, equal, unconfigured or invalid update', async () => {
  for (const response of [
    { available: false }, { ...release, versionCode: 9 }, { ...release, versionCode: 10 },
    { ...release, applicationId: 'another.app' }, { ...release, sha256: 'incorrect' },
    { ...release, versionCode: 20.5 }, { ...release, versionCode: 2100000001 },
    { ...release, size: 0 }, { ...release, size: 300 * 1024 * 1024 }
  ]) {
    const app = setup();
    app.response(response);
    await app.updater.check(true);
    assert(!app.statuses.at(-1).canInstall);
    assert.equal(app.statuses.at(-1).visible, true);
    await assert.rejects(() => app.updater.install(), /Check for updates/);
  }
});

test('automatic checks are throttled, while manual and changed-server checks are immediate', async () => {
  const app = setup();
  await app.updater.check();
  await app.updater.check();
  assert.equal(app.calls(), 1);
  await app.updater.check(true);
  assert.equal(app.calls(), 2);
  app.time(300000);
  await app.updater.check();
  assert.equal(app.calls(), 3);
  app.server('https://different.example');
  await assert.rejects(() => app.updater.install(), /selected server/);
  await app.updater.check();
  assert.equal(app.calls(), 4);
});

test('failed checks clear stale updates, show errors on request and do not interrupt offline work', async () => {
  const app = setup();
  await app.updater.check();
  app.fail(new TypeError('Server down'));
  await app.updater.check(true);
  assert.match(app.statuses.at(-1).message, /Server down/);
  assert.equal(app.statuses.at(-1).visible, true);
  await assert.rejects(() => app.updater.install(), /Check for updates/);
  app.time(300000);
  await app.updater.check();
  assert.equal(app.statuses.at(-1).visible, false);
});

test('failed or denied installations are visible and can be retried', async () => {
  const app = setup();
  await app.updater.check();
  app.failInstall(new Error('Permission denied'));
  await assert.rejects(() => app.updater.install(), /Permission denied/);
  assert.match(app.statuses.at(-1).message, /Update not installed: Permission denied/);
  assert.equal(app.statuses.at(-1).canInstall, true);
  app.failInstall(null);
  await app.updater.install();
  assert.equal(app.installations.length, 2);
});
