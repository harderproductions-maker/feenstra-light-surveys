package app.primeops.mobile;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "AppUpdates")
public class AppUpdatesPlugin extends Plugin {
    private static final long MAX_SIZE = 250L * 1024 * 1024;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy = new AtomicBoolean(false);

    @PluginMethod
    public void getInfo(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject result = new JSObject();
            result.put("versionCode", versionCode(info));
            result.put("versionName", info.versionName);
            result.put("applicationId", getContext().getPackageName());
            call.resolve(result);
        } catch (PackageManager.NameNotFoundException error) {
            call.reject("Could not read the installed app version.", error);
        }
    }

    @PluginMethod
    public void install(PluginCall call) {
        if (!busy.compareAndSet(false, true)) {
            call.reject("An Android update is already in progress.");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            getActivity().runOnUiThread(() -> {
                try {
                    Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName()));
                    startActivityForResult(call, settings, "installPermissionResult");
                } catch (Exception error) {
                    busy.set(false);
                    call.reject("Could not open Android installation permission settings.", error);
                }
            });
            return;
        }
        download(call);
    }

    @ActivityCallback
    private void installPermissionResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            busy.set(false);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            busy.set(false);
            call.reject("Allow PrimeOps to install app updates in Android settings, then try again.");
            return;
        }
        download(call);
    }

    private void download(PluginCall call) {
        executor.execute(() -> {
            File partial = null;
            HttpURLConnection connection = null;
            try {
                String address = call.getString("url", "");
                String expectedHash = call.getString("sha256", "");
                Integer expectedSize = call.getInt("size");
                Integer expectedVersion = call.getInt("versionCode");
                URL url = new URL(address);
                if ((!url.getProtocol().equals("https") && !url.getProtocol().equals("http"))
                        || url.getHost().isEmpty() || url.getUserInfo() != null
                        || !expectedHash.matches("[a-f0-9]{64}")
                        || expectedSize == null || expectedSize < 1 || expectedSize > MAX_SIZE
                        || expectedVersion == null || expectedVersion < 1 || expectedVersion > 2100000000) {
                    throw new IllegalArgumentException("The update details are invalid. Check for updates again.");
                }
                File directory = new File(getContext().getCacheDir(), "app-updates");
                if (!directory.isDirectory() && !directory.mkdirs()) throw new Exception("Could not create update download storage.");
                partial = new File(directory, "download.part.apk");
                File apk = new File(directory, "PrimeOps-" + expectedVersion + ".apk");
                connection = (HttpURLConnection) url.openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(30000);
                connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
                if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                    throw new Exception("The server could not provide this update (HTTP " + connection.getResponseCode() + "). Check for updates again.");
                }
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long total = 0;
                long deadline = android.os.SystemClock.elapsedRealtime() + 300000;
                try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(partial)) {
                    byte[] buffer = new byte[65536];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (Thread.currentThread().isInterrupted() || android.os.SystemClock.elapsedRealtime() > deadline) {
                            throw new Exception("The update download timed out. Try again on a stable connection.");
                        }
                        total += count;
                        if (total > expectedSize) throw new Exception("The update is larger than advertised. Check for updates again.");
                        digest.update(buffer, 0, count);
                        output.write(buffer, 0, count);
                    }
                }
                if (total != expectedSize || !hex(digest.digest()).equals(expectedHash)) {
                    throw new Exception("The update download is incomplete or its checksum does not match. Try again.");
                }
                verifyApk(partial, expectedVersion);
                if (apk.exists() && !apk.delete()) throw new Exception("Could not replace the previous update download.");
                if (!partial.renameTo(apk)) throw new Exception("Could not save the verified Android update.");
                getActivity().runOnUiThread(() -> openInstaller(call, apk));
            } catch (Exception error) {
                busy.set(false);
                call.reject("Android update failed: " + error.getMessage(), error);
            } finally {
                if (connection != null) connection.disconnect();
                if (partial != null && partial.exists() && !partial.delete()) {
                    android.util.Log.w("AppUpdates", "Could not delete the partial update download.");
                }
            }
        });
    }

    @SuppressWarnings("deprecation")
    private void verifyApk(File apk, long expectedVersion) throws Exception {
        PackageManager manager = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo downloaded = manager.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        PackageInfo installed = manager.getPackageInfo(getContext().getPackageName(), flags);
        if (downloaded == null || !getContext().getPackageName().equals(downloaded.packageName)) {
            throw new Exception("This APK is not an PrimeOps application update.");
        }
        if (versionCode(downloaded) != expectedVersion || versionCode(downloaded) <= versionCode(installed)) {
            throw new Exception("This APK is not a newer version of the installed app.");
        }
        Signature[] wanted = signatures(installed);
        Signature[] actual = signatures(downloaded);
        if (wanted == null || actual == null || wanted.length == 0 || wanted.length != actual.length
                || !Arrays.asList(actual).containsAll(Arrays.asList(wanted))) {
            throw new Exception("The APK signing certificate does not match this app. The update was rejected.");
        }
    }

    @SuppressWarnings("deprecation")
    private Signature[] signatures(PackageInfo info) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners();
        }
        return info.signatures;
    }

    @SuppressWarnings("deprecation")
    private long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
    }

    private String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder();
        for (byte value : bytes) text.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return text.toString();
    }

    private void openInstaller(PluginCall call, File apk) {
        try {
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(intent);
            JSObject result = new JSObject();
            result.put("installerOpened", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not open the Android update installer.", error);
        } finally {
            busy.set(false);
        }
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        super.handleOnDestroy();
    }
}
