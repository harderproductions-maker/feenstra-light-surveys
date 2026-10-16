package com.feenstra.lightsurveys;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "LightSensor")
public class LightSensorPlugin extends Plugin implements SensorEventListener {
    private SensorManager sensorManager;
    private Sensor lightSensor;

    @Override
    public void load() {
        sensorManager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        if (sensorManager != null) {
            lightSensor = sensorManager.getDefaultSensor(Sensor.TYPE_LIGHT);
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (lightSensor == null || sensorManager == null) {
            call.reject("This device does not have an ambient light sensor.");
            return;
        }

        if (!sensorManager.registerListener(this, lightSensor, SensorManager.SENSOR_DELAY_NORMAL)) {
            call.reject("Could not start the ambient light sensor.");
            return;
        }

        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (sensorManager != null) {
            sensorManager.unregisterListener(this);
        }
        call.resolve();
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event.sensor.getType() != Sensor.TYPE_LIGHT || event.values.length == 0) {
            return;
        }

        JSObject reading = new JSObject();
        reading.put("lux", event.values[0]);
        notifyListeners("reading", reading);
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
    }

    @Override
    protected void handleOnStop() {
        if (sensorManager != null) {
            sensorManager.unregisterListener(this);
        }
        super.handleOnStop();
    }
}