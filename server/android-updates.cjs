const fs = require('node:fs/promises');
const path = require('node:path');

const APPLICATION_ID = 'app.primeops.mobile';
const MAX_APK_SIZE = 250 * 1024 * 1024;

function validateManifest(manifest) {
  if (manifest.applicationId !== APPLICATION_ID
      || !Number.isSafeInteger(manifest.versionCode) || manifest.versionCode < 1
      || manifest.versionCode > 2100000000
      || typeof manifest.versionName !== 'string' || !manifest.versionName.trim() || manifest.versionName.length > 100
      || !/^[a-f0-9]{64}$/.test(manifest.sha256)
      || !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > MAX_APK_SIZE) {
    throw new Error('The Android update manifest is invalid.');
  }
  return {
    applicationId: APPLICATION_ID, versionCode: manifest.versionCode,
    versionName: manifest.versionName, sha256: manifest.sha256, size: manifest.size
  };
}

function registerAndroidUpdates(app, directory) {
  const root = path.resolve(directory);
  async function latest() {
    let contents;
    try {
      contents = await fs.readFile(path.join(root, 'manifest.json'), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const manifest = validateManifest(JSON.parse(contents));
    const file = path.join(root, `PrimeOps-${manifest.versionCode}.apk`);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size !== manifest.size) throw new Error('The published Android APK is missing or incomplete.');
    return { manifest, file };
  }

  app.get('/api/app-updates/android', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const release = await latest();
      return res.json(release ? { available: true, ...release.manifest } : { available: false });
    } catch (error) {
      console.error('Android update lookup failed:', error);
      return res.status(503).json({ error: 'The Android update is not ready. Ask the administrator to publish the APK and manifest together.' });
    }
  });

  app.get('/api/app-updates/android/download', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const release = await latest();
      if (!release) return res.status(404).json({ error: 'No Android app has been published on this server yet.' });
      return res.download(release.file, 'PrimeOps.apk', (error) => {
        if (!error) return;
        console.error('Android app download failed:', error);
        if (!res.headersSent) res.status(503).json({ error: 'Could not download the Android app. Try again.' });
        else res.destroy();
      });
    } catch (error) {
      console.error('Android app download failed:', error);
      return res.status(503).json({ error: 'The Android app is unavailable. Ask the administrator to publish it.' });
    }
  });

  app.get('/api/app-updates/android/apk/:versionCode', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const version = req.params.versionCode;
      if (!/^[1-9]\d{0,9}$/.test(version) || Number(version) > 2100000000) {
        return res.status(400).json({ error: 'The Android update version is invalid.' });
      }
      const file = path.join(root, `PrimeOps-${version}.apk`);
      let stat;
      try {
        stat = await fs.stat(file);
      } catch (error) {
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'This update is no longer available. Check for updates again.' });
        throw error;
      }
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_APK_SIZE) {
        throw new Error('The requested Android APK is incomplete or invalid.');
      }
      return res.download(file, path.basename(file), (error) => {
        if (!error) return;
        console.error('Android update download failed:', error);
        if (!res.headersSent) res.status(503).json({ error: 'Could not download the Android update. Try again.' });
        else res.destroy();
      });
    } catch (error) {
      console.error('Android update download failed:', error);
      return res.status(503).json({ error: 'The Android update is unavailable. Try checking for updates again.' });
    }
  });
}

module.exports = { registerAndroidUpdates, validateManifest, APPLICATION_ID, MAX_APK_SIZE };
