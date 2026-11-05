import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareProfilePhoto } from './profile-photo.mjs';
import { createOfflineStore } from './offline.mjs';

test('profile pictures resize proportionally to 256 px and are re-encoded as JPEG', async () => {
  for (const [width, height, expectedWidth, expectedHeight] of [[1200, 600, 256, 128], [600, 1200, 128, 256], [32, 16, 32, 16]]) {
    let closed = false, drawn = false;
    const canvas = {
      getContext: () => ({ fillRect() {}, drawImage() { drawn = true; } }),
      toDataURL: (type, quality) => {
        assert.equal(type, 'image/jpeg');
        assert.equal(quality, 0.85);
        return 'data:image/jpeg;base64,cGhvdG8=';
      }
    };
    const photo = await prepareProfilePhoto({ type: 'image/png', size: 1024 }, {
      decode: async () => ({ width, height, close() { closed = true; } }), createCanvas: () => canvas
    });
    assert.equal(canvas.width, expectedWidth);
    assert.equal(canvas.height, expectedHeight);
    assert(drawn && closed && photo.startsWith('data:image/jpeg;base64,'));
  }
});

test('invalid file types/sizes and unreadable images are explicitly rejected', async () => {
  for (const file of [null, { type: 'image/svg+xml', size: 100 }, { type: 'image/jpeg', size: 0 },
    { type: 'image/png', size: 10 * 1024 * 1024 + 1 }]) {
    await assert.rejects(prepareProfilePhoto(file), /Choose a JPEG/);
  }
  await assert.rejects(prepareProfilePhoto({ type: 'image/webp', size: 100 }, {
    decode: async () => { throw new Error('Invalid image'); }
  }), /Invalid image/);
});

test('profile picture updates/removal persist offline under the right account and server without queueing', async () => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  let user = { id: 'one', role: 'user', propertyIds: ['p'] }, online = true, release;
  const records = new Map(), storage = {
    get: async (key) => structuredClone(records.get(key)), set: async (key, value) => records.set(key, structuredClone(value))
  };
  const photo = 'data:image/jpeg;base64,cGhvdG8=';
  const store = createOfflineStore({ storage, getUser: () => user, getServer: () => 'server', notify() {},
    send: async (path, options) => {
      if (!online) throw new TypeError('Network unavailable');
      if (options?.body?.delay) return new Promise((resolve) => { release = resolve; });
      return { photo: options?.body?.photo ?? null };
    }
  });
  await store.request('/api/auth/profile-photo', { method: 'PUT', body: { photo } });
  online = false;
  assert.equal((await store.request('/api/auth/profile-photo')).photo, photo);
  await assert.rejects(store.request('/api/auth/profile-photo', { method: 'PUT', body: { photo: null } }), /Network unavailable/);
  online = true;
  await store.request('/api/auth/profile-photo', { method: 'PUT', body: { photo: null } });
  online = false;
  assert.equal((await store.request('/api/auth/profile-photo')).photo, null);
  online = true;
  const delayed = store.request('/api/auth/profile-photo', { method: 'PUT', body: { delay: true } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  user = { ...user, id: 'two' };
  release({ photo });
  await assert.rejects(delayed, /account or building access changed/);
  online = false;
  await assert.rejects(store.request('/api/auth/profile-photo'), /not been downloaded/);
  assert.equal([...records.values()].flatMap((record) => record.jobs).length, 0);
});
