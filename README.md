# Feenstra Light Surveys

Offline-first Android lighting survey app built with Capacitor 6. Survey records and compressed photos are stored on the device. Use the phone's ambient light sensor when available or enter a measured lux value manually. Target lux is assessor-entered; the app does not assume a jurisdiction-specific standard.

## Build the Android debug APK

The GitHub Actions workflow runs on pushes to `main` and can also be started manually from the **Actions** tab. It creates the Android project, installs the native light sensor plugin and manifest configuration, and builds an installable debug APK.

To download it, open the repository's **Actions** tab, select the successful **Build Android Debug APK** run, scroll to **Artifacts**, and click **Feenstra-Light-Surveys-APK**. Download and unzip the artifact to get `app-debug.apk`.

## Local web preview

Install Node.js 20, then run:

```sh
npm install
npm run build
npx --yes http-server www
```

The sensor requires a native Android build. Browser preview supports manual illuminance entry and photo selection where the browser allows it.