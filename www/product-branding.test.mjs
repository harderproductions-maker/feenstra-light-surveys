import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import legacy from './legacy-identifiers.json' with { type: 'json' };

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('public product surfaces use PrimeOps rather than the original client brand', async () => {
  const surfaces = [
    '../README.md', '../owner-app/README.txt', '../owner-app/index.html',
    '../owner-app/renderer.js', '../desktop/settings.html',
    '../desktop/package.json', '../owner-app/package.json', '../capacitor.config.json',
    '../desktop-download/JOIN-DESKTOP-APP.bat', '../.github/workflows/build-apk.yml',
    '../.github/workflows/build-desktop.yml', './index.html', './report-layout.mjs'
  ];
  await Promise.all(surfaces.map(async (path) => {
    const source = await read(path);
    assert.equal(source.toLowerCase().includes(legacy.defaultClientCode.toLowerCase()), false, path);
    assert(source.toLowerCase().includes('primeops'), `${path} must identify the product as PrimeOps`);
  }));
});

test('new native packages use independent PrimeOps identities and filenames', async () => {
  const android = JSON.parse(await read('../capacitor.config.json'));
  const desktop = JSON.parse(await read('../desktop/package.json')).build;
  const owner = JSON.parse(await read('../owner-app/package.json')).build;
  assert.equal(android.appName, 'PrimeOps');
  assert.equal(android.appId, 'app.primeops.mobile');
  assert.equal(desktop.productName, 'PrimeOps');
  assert.equal(desktop.artifactName, 'PrimeOps-Windows-${version}.${ext}');
  assert.equal(owner.productName, 'PrimeOps Owner');
  assert.equal(owner.artifactName, 'PrimeOps-Owner-Windows-${version}.${ext}');
  assert.notEqual(android.appId, legacy.androidApplicationId);
  const join = await read('../desktop-download/JOIN-DESKTOP-APP.bat');
  assert(join.includes('PrimeOps-Desktop.part* PrimeOps-Windows.zip'));
  assert(join.includes('"PrimeOps.exe"'));
});
