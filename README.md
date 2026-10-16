# Feenstra Light Surveys

Offline-first Android lighting survey app built with Capacitor 6. Each project requires a building name and inspector name and contains separately named inspection entries. Readings, notes, and photos are kept with their entry in on-device storage.

On Android, **Start sensor** reads the phone's ambient light sensor and displays actual illuminance in lux (lx). Choose **Use live reading** to save that exact sensor reading with an inspection entry. If a device has no light sensor, the app reports that the sensor is unavailable; manually entered measurements are clearly identified as manual and are never presented as sensor readings. Target lux is assessor-entered; the app does not assume a jurisdiction-specific standard.

Photos are captured using the device camera or selected from the device. Before capture, select a saved phone-sensor reading from the current entry to include that exact recorded lux value, entry, building, and capture time on the annotated image. Manually entered values are never used as sensor overlays. The original photograph is retained, and both versions are available in the project report. Reports include every named entry, saved reading, observation, and photo for that project.

Project records and photos are stored in the app's local IndexedDB database. Keep a copy of each exported report; local records are not synchronized to a server.

## Build the Android debug APK

The GitHub Actions workflow runs on pushes to `main` and can also be started manually from the **Actions** tab. It uses Node.js 20 and Eclipse Temurin Java 17, installs npm dependencies, builds the web app, creates the Android project when it is not present, installs the native light sensor plugin and manifest configuration, syncs Capacitor, and builds an installable debug APK.

To download it, open the repository's **Actions** tab, select the successful **Build Android Debug APK** run, scroll to **Artifacts**, and click **Feenstra-Light-Surveys-APK**. Download and unzip the artifact to get `app-debug.apk`.

On Android, choose **Export OHS report** to save the complete HTML report in Documents and open the Android share sheet to download or share it. In a browser, the report downloads directly as an HTML file; it can also be printed or saved as PDF.

## Local web preview

Install Node.js 20, then run:

```sh
npm install
npm run build
npx --yes http-server www
```

The sensor requires a native Android build. Browser preview supports manual illuminance entry and camera/photo selection where the browser allows it.