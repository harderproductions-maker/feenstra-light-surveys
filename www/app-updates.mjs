const APPLICATION_ID = 'app.primeops.mobile';

export function createAndroidUpdater({ native, request, getServer, notify, now = () => Date.now() }) {
  let latest = null;
  let checkedServer = '';
  let lastCheck = -Infinity;
  let checking = false;
  let installing = false;

  async function check(manual = false) {
    const server = getServer();
    if (checking || installing || (!manual && checkedServer === server && now() - lastCheck < 300000)) return;
    checking = true;
    lastCheck = now();
    checkedServer = server;
    try {
      const info = await native.getInfo();
      if (info.applicationId && info.applicationId !== APPLICATION_ID) {
        latest = null;
        notify({ message: 'Migration app: export Move device data, then install PrimeOps separately. Keep this app until restore is verified.', visible: manual });
        return;
      }
      const release = await request('/api/app-updates/android', { auth: false });
      if (getServer() !== server) return;
      if (release.available === false) {
        latest = null;
        notify({ message: 'No Android update has been published on this server.', visible: manual });
        return;
      }
      if (release.available !== true || release.applicationId !== APPLICATION_ID
          || !Number.isSafeInteger(release.versionCode) || release.versionCode < 1 || release.versionCode > 2100000000
          || typeof release.versionName !== 'string' || !release.versionName.trim() || release.versionName.length > 100
          || !/^[a-f0-9]{64}$/.test(release.sha256)
          || !Number.isSafeInteger(release.size) || release.size < 1 || release.size > 250 * 1024 * 1024) {
        throw new Error('The server returned an invalid Android update. Contact the administrator.');
      }
      if (release.versionCode <= info.versionCode) {
        latest = null;
        notify({ message: `Android app ${info.versionName} is up to date.`, visible: manual });
        return;
      }
      latest = { ...release, server };
      notify({ message: `Android update ${release.versionName} is available. Save any open form before installing.`, visible: true, canInstall: true });
    } catch (error) {
      if (getServer() !== server) return;
      latest = null;
      console.error('Android update check failed:', error);
      notify({ message: `Could not check for Android updates: ${error.message}`, visible: manual });
    } finally {
      checking = false;
    }
  }

  async function install() {
    if (installing) return;
    if (!latest || latest.server !== getServer()) throw new Error('Check for updates on the selected server before installing.');
    const release = latest;
    installing = true;
    notify({ message: 'Downloading and verifying the Android update. Allow installation from PrimeOps if Android asks.', visible: true });
    try {
      await native.install({
        url: `${release.server}/api/app-updates/android/apk/${release.versionCode}`,
        versionCode: release.versionCode, sha256: release.sha256, size: release.size
      });
      notify({ message: 'Android installer opened. Confirm Update to finish. Your saved app data will be kept.', visible: true, canInstall: true });
    } catch (error) {
      notify({ message: `Update not installed: ${error.message}`, visible: true, canInstall: true });
      throw error;
    } finally {
      installing = false;
    }
  }

  return { check, install };
}
