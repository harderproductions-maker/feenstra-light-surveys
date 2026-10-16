# Feenstra Light Surveys

Offline-first Android lighting survey app built with Capacitor 6. Each project requires a building name and inspector name and contains separately named inspection entries. Readings, notes, and photos are kept with their entry in on-device storage.

On Android, **Start sensor** reads the phone's ambient light sensor and displays illuminance in lux (lx). The app initially applies the comparison factor 1200 / 82.01 requested for this phone. This is an **unverified adjustment, not certified calibration**: raw sensor values and the applied factor are retained with each reading. Use **Calibrate** with a trusted reference meter to update the adjustment. Choose **Use live reading** to save the current adjusted value, raw value, and factor with the selected entry. If a device has no light sensor, the app reports that the sensor is unavailable; it never fabricates readings. Manually entered measurements are clearly identified as manual.

The recommended lux target defaults to **300 lx**. Each entry can keep its own measurements, notes, and photos. On Android, **Take inspection photo** opens the native camera preview, displays the live phone lux reading, and captures the photograph. When the sensor is available, that photo is saved with the exact raw and adjusted reading captured alongside it. The app creates an annotated copy showing the building, entry, capture time, recommended target, and recorded lux; it retains the original image as well. Without a light sensor, the photo is still saved without inventing a measurement. Photos and readings remain attached to their project and named entry.

Exported PDF reports contain every entry, measurement, observation, and photo in the project. **Saved reports** keeps report revisions in the app, where they can be viewed or exported as PDF later. On Android, the report is rendered locally and Android's print screen lets you save or share the PDF. In a browser, the print dialog lets you save as PDF.

Use **Share project** to export a portable JSON package containing the editable project, entries, measurements, photos, and saved report history. The recipient chooses **Import project** and selects that package; it is added as a separate project, without replacing existing data. Project packages can contain large embedded photos, so share them using a method that supports large files. Project records and photos are otherwise stored in the app's local IndexedDB database and are not synchronized to a server.

## Build the Android debug APK

The GitHub Actions workflow runs on pushes to `main` and can also be started manually from the **Actions** tab. It uses Node.js 20 and Eclipse Temurin Java 17, installs npm dependencies, builds the web app, creates the Android project when it is not present, installs the native light sensor plugin and manifest configuration, syncs Capacitor, and builds an installable debug APK.

To download it, open the repository's **Actions** tab, select the successful **Build Android Debug APK** run, scroll to **Artifacts**, and click **Feenstra-Light-Surveys-APK**. Download and unzip the artifact to get `app-debug.apk`.

On Android, choose **Export PDF report** to open Android's print screen, where the report can be saved as a PDF or shared. In a browser, the print dialog can save the report as PDF.

## Local web preview

Install Node.js 20, then run:

```sh
npm install
npm run build
npx --yes http-server www
```

The sensor requires a native Android build. Browser preview supports manual illuminance entry and camera/photo selection where the browser allows it.