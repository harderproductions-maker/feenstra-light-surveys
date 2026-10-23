# Feenstra Building And OHS

Offline-first Android lighting survey app built with Capacitor 6. Each project requires a building name and inspector name and contains separately named inspection entries. Readings, notes, and photos are kept with their entry in on-device storage.

On Android, **Start sensor** reads the phone's ambient light sensor and displays illuminance in lux (lx). The app initially applies the comparison factor 1200 / 82.01 requested for this phone. This is an **unverified adjustment, not certified calibration**: raw sensor values and the applied factor are retained with each reading. Use **Calibrate** with a trusted reference meter to update the adjustment. Choose **Use live reading** to save the current adjusted value, raw value, and factor with the selected entry. If a device has no light sensor, the app reports that the sensor is unavailable; it never fabricates readings. Manually entered measurements are clearly identified as manual.

The recommended lux target defaults to **300 lx**. Each entry can keep its own measurements, notes, and photos. On Android, **Take inspection photo** opens the native camera preview, displays the live phone lux reading, and captures the photograph. When the sensor is available, that photo is saved with the exact raw and adjusted reading captured alongside it. The app creates an annotated copy showing the building, entry, capture time, recommended target, and recorded lux; it retains the original image as well. Without a light sensor, the photo is still saved without inventing a measurement. Photos and readings remain attached to their project and named entry.

Exported PDF reports contain every entry, measurement, observation, and photo in the project. **Saved reports** keeps report revisions in the app, where they can be viewed or exported as PDF later. On Android, the report is rendered locally and Android's print screen lets you save or share the PDF. In a browser, the print dialog lets you save as PDF.

In a saved report preview, use **Copy photo** under the preview to copy an embedded report photo for pasting into another document. This requires browser clipboard image support; the exported PDF itself remains a static document.

Use **Share project** to export a portable JSON package containing the editable project, entries, measurements, photos, and saved report history. The recipient chooses **Import project** and selects that package; it is added as a separate project, without replacing existing data. Project packages can contain large embedded photos, so share them using a method that supports large files. The app saves records in local IndexedDB for offline use and synchronizes signed-in users' accessible buildings to the shared backend.

## Security and data handling

The app restricts executable scripts to its own origin, blocks embedded objects, and limits loaded images and connections. Imported checklist files are limited to 25 MB; survey and repair photos are limited to 12 MB each. Keep the Android device protected with its screen lock and treat exported reports and project packages as sensitive: local records are not encrypted by the app, and anyone with access to the unlocked device can open them. The backend stores workspace records and password hashes in PostgreSQL; put it behind HTTPS before allowing connections over an untrusted network.

MyBuildings integration is reserved in `www/config.js` and disabled by default. The flag alone does not enable a connection; no MyBuildings requests are made until a vendor-supported connector and authentication flow are implemented. Do not put credentials in browser configuration.

## Install and update the Android app

The GitHub Actions workflow builds and publishes an installable APK whenever changes reach `main`; it can also be started manually from the **Actions** tab. To get the newest build, open the repository's [latest release](https://github.com/harderproductions-maker/feenstra-light-surveys/releases/latest) on the Android device, download `Feenstra-Building-And-OHS.apk`, then open the downloaded file and confirm **Update**. Leave the existing app installed; Android keeps its locally saved projects when an update installs successfully. The same APK is available as an artifact on each successful Actions run.

Android accepts an update only when the APK uses the same signing certificate and has a higher version code. This project uses a persistent Android debug signing key (alias `androiddebugkey`, passwords `android`) and refuses to publish if the key is missing or does not match the certificate already used by the APK. Keep a secure backup of the keystore; if it is lost, Android cannot install future builds over the existing app.

Before the first automated build, configure the repository Actions secret `ANDROID_KEYSTORE_BASE64` (**Settings → Secrets and variables → Actions**) with the base64-encoded keystore used to sign the current APK. In the build workspace, `base64 -w 0 ~/.android/debug.keystore` prints the value to save as that secret. Do not commit or publish the keystore. If the installed app was signed with a different key, Android will require a one-time uninstall before the persistent-key builds can be installed; after that migration, future updates install over the app and retain its local data.

On Android, choose **Export PDF report** to open Android's print screen, where the report can be saved as a PDF or shared. In a browser, the print dialog can save the report as PDF.

## Install the Windows desktop app

The **Build Windows desktop app** workflow publishes a Windows x64 portable ZIP to [GitHub Releases](https://github.com/harderproductions-maker/feenstra-light-surveys/releases) on pushes to `main`; it can also be started manually from the **Actions** tab. Download the ZIP from the newest release whose tag starts with `desktop-v`, extract it, and run `Feenstra Building and OHS.exe` from the extracted folder. This is a portable app, not an installer.

## Building checks and repairs

From the **Home** dashboard, open **Building checks**, select a property, and choose one of the 21 supplied monthly forms. The question labels and field types are extracted from the completed PDFs in `Docs/`, but their historical answers are not copied into new runs. Use `npm run forms:extract` to regenerate `www/building-check-templates.json` after updating those source forms. Fill in the answers, add photos where prompted, and submit. Each property/form/month has one saved run and submitted PDF revisions; the previous months remain unchanged. Draft answers and photos are saved locally.

Use **Import completed checklist** only for an existing CSV, Excel, or PDF inspection record. Select its inspection date and target property; the app does not retain the imported PDF itself. Spreadsheet imports must include a **Check**, **Item**, **Name**, or **Inspection Item** column.

Use **Next month** on a run to create a blank copy of that form for the next month. The current run is never overwritten. Each answer or photo change records the entered editor name and timestamp; old history without actor data is shown as **Not recorded**. Editor names are manually entered and are not verified against the signed-in account. Submitted reports remain available from the monthly run. Older free-form/imported checklists remain under **Existing checklists** for their property. Records for buildings assigned to the signed-in user sync to the shared workspace and remain available offline on this device.

## Local web preview

Install Node.js 20, then run:

```sh
npm install
npm run build
npx --yes http-server www
```

The sensor requires a native Android build. Browser preview supports manual illuminance entry and camera/photo selection where the browser allows it.

## Install and test the shared backend

The shared backend serves both the web app and its JSON API. Install Docker with the Compose plugin, then from the repository root:

```sh
cp .env.example .env
```

Edit `.env` and set unique, long values for `POSTGRES_PASSWORD`, `JWT_SECRET`, and `ADMIN_PASSWORD`. For example, generate `POSTGRES_PASSWORD` and `JWT_SECRET` with `openssl rand -hex 32`; choose a unique administrator email and password. Keep `.env` private; it is ignored by Git. When publishing behind a TLS-terminating reverse proxy, add the public origin (for example, `https://surveys.example.com`) to `CORS_ORIGINS`.

Start the database and app:

```sh
docker compose up --build -d
docker compose ps
curl http://localhost:3000/api/health
```

The health endpoint should return `{"status":"ok"}`. Open [http://localhost:3000](http://localhost:3000) and sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`. The first startup creates the administrator and building catalog. From **Account**, an administrator can add accounts and assign buildings. Use `docker compose logs -f app` to inspect startup and server errors. `docker compose down` stops the services while preserving PostgreSQL data; `docker compose down -v` also deletes that database volume.

To use the installed Android app with this backend, make the backend reachable over HTTPS and set the repository Actions variable `VITE_API_BASE_URL` to that HTTPS origin (**Settings → Secrets and variables → Actions → Variables**) before running the Android build workflow. The workflow embeds this URL in the APK. If building locally instead:

```sh
VITE_API_BASE_URL=https://surveys.example.com npm run build
npx cap sync android
```

Install the resulting APK from the workflow artifact or release. Leave `VITE_API_BASE_URL` unset for a same-origin web deployment, where the backend also serves the web app. The default APK does not contain a public server address; its API requests use the app's current origin.