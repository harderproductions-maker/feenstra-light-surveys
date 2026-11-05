const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateManifest } = require('../server/android-updates.cjs');

async function publishAndroidUpdate(buildDirectory, destination) {
  const metadata = JSON.parse(await fs.readFile(path.join(buildDirectory, 'output-metadata.json'), 'utf8'));
  const artifact = metadata.elements?.find((item) => item.type === 'SINGLE' && !item.filters?.length);
  if (!artifact || path.basename(artifact.outputFile) !== artifact.outputFile) throw new Error('Expected a single universal APK build.');
  const apk = await fs.readFile(path.join(buildDirectory, artifact.outputFile));
  const manifest = validateManifest({
    applicationId: metadata.applicationId, versionCode: artifact.versionCode, versionName: artifact.versionName,
    size: apk.length, sha256: crypto.createHash('sha256').update(apk).digest('hex')
  });
  await fs.mkdir(destination, { recursive: true });
  const target = path.join(destination, `PrimeOps-${manifest.versionCode}.apk`);
  const manifestPath = path.join(destination, 'manifest.json');
  let previous;
  try {
    previous = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (previous && (previous.versionCode > manifest.versionCode
      || (previous.versionCode === manifest.versionCode && previous.sha256 !== manifest.sha256))) {
    throw new Error('Build with a higher Android versionCode before publishing a changed APK.');
  }
  const temporary = `${manifestPath}.${crypto.randomUUID()}.tmp`;
  try {
    try {
      await fs.writeFile(target, apk, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await fs.readFile(target);
      if (crypto.createHash('sha256').update(existing).digest('hex') !== manifest.sha256) {
        throw new Error('An APK with this versionCode already exists. Build with a higher versionCode.');
      }
    }
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.rename(temporary, manifestPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return manifest;
}

if (require.main === module) {
  const buildDirectory = path.resolve(__dirname, '../android/app/build/outputs/apk/debug');
  const destination = path.resolve(process.argv[2] || path.join(__dirname, '..', 'android-updates'));
  publishAndroidUpdate(buildDirectory, destination)
    .then((manifest) => console.log(`Published Android ${manifest.versionName} (${manifest.versionCode}) to ${destination}`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { publishAndroidUpdate };
