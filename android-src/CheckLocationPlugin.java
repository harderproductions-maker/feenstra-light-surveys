package app.primeops.mobile;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "CheckLocation", permissions = {
    @Permission(alias = "location", strings = {
        Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION
    })
})
public class CheckLocationPlugin extends Plugin {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private PluginCall pending;
    private LocationManager manager;
    private LocationListener listener;
    private Runnable timeout;

    @PluginMethod
    public void capture(PluginCall call) {
        if (!hasLocationPermission()) {
            requestPermissionForAlias("location", call, "locationPermission");
            return;
        }
        getActivity().runOnUiThread(() -> startCapture(call));
    }

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @PermissionCallback
    private void locationPermission(PluginCall call) {
        if (!hasLocationPermission()) {
            call.reject("Location permission is required to start and complete an appliance check.");
            return;
        }
        capture(call);
    }

    private void startCapture(PluginCall call) {
        if (pending != null) {
            call.reject("A location capture is already in progress.");
            return;
        }
        manager = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) {
            call.reject("Location services are unavailable on this device.");
            return;
        }
        pending = call;
        listener = new LocationListener() {
            @Override
            public void onLocationChanged(Location location) {
                if (pending == null || !location.hasAccuracy()
                    || SystemClock.elapsedRealtimeNanos() - location.getElapsedRealtimeNanos() > 15000000000L) return;
                PluginCall result = pending;
                boolean mocked = location.isFromMockProvider();
                JSObject reading = new JSObject();
                reading.put("latitude", location.getLatitude());
                reading.put("longitude", location.getLongitude());
                reading.put("accuracy", location.getAccuracy());
                reading.put("timestamp", location.getTime());
                reading.put("mocked", mocked);
                cleanup();
                if (mocked) result.reject("Mock location detected. Turn off mock locations and try again.");
                else result.resolve(reading);
            }

            @Override
            public void onProviderDisabled(String provider) {}

            @Override
            public void onProviderEnabled(String provider) {}

            @Override
            public void onStatusChanged(String provider, int status, Bundle extras) {}
        };
        timeout = () -> fail("Could not obtain a fresh location. Enable location services and try again outside or near a window.");
        handler.postDelayed(timeout, 30000);
        try {
            boolean requested = false;
            if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                && manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 0, 0, listener, Looper.getMainLooper());
                requested = true;
            }
            if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                manager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 0, 0, listener, Looper.getMainLooper());
                requested = true;
            }
            if (!requested) fail("Enable location services before starting or completing the check.");
        } catch (SecurityException error) {
            fail("Location permission was revoked. Allow location access and try again.");
        } catch (IllegalArgumentException error) {
            fail("The location provider is unavailable. Enable location services and try again.");
        }
    }

    private void fail(String message) {
        PluginCall result = pending;
        cleanup();
        if (result != null) result.reject(message);
    }

    private void cleanup() {
        if (timeout != null) handler.removeCallbacks(timeout);
        if (manager != null && listener != null) manager.removeUpdates(listener);
        pending = null;
        listener = null;
        timeout = null;
    }

    @Override
    protected void handleOnDestroy() {
        handler.post(() -> fail("Location capture stopped because the app closed."));
        super.handleOnDestroy();
    }
}
