package com.feenstra.lightsurveys;

import android.content.Intent;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.IOException;

@CapacitorPlugin(name = "CameraCapture")
public class CameraCapturePlugin extends Plugin {
    @PluginMethod
    public void capture(PluginCall call) {
        Intent intent = new Intent(getContext(), CameraCaptureActivity.class);
        intent.putExtra("buildingName", call.getString("buildingName", ""));
        intent.putExtra("entryName", call.getString("entryName", ""));
        intent.putExtra("calibrationFactor", call.getDouble("calibrationFactor", 1.0));
        intent.putExtra("recommendedLux", call.getDouble("recommendedLux", 300.0));
        startActivityForResult(call, intent, "cameraResult");
    }

    @ActivityCallback
    private void cameraResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            call.resolve(new JSObject().put("cancelled", true));
            return;
        }

        String path = result.getData().getStringExtra("photoPath");
        if (path == null || path.isEmpty()) {
            call.reject("The camera did not return a photo.");
            return;
        }

        try {
            byte[] image;
            try (FileInputStream input = new FileInputStream(new File(path));
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                image = output.toByteArray();
            }
            JSObject response = new JSObject();
            response.put("cancelled", false);
            response.put("base64", Base64.encodeToString(image, Base64.NO_WRAP));
            double rawLux = result.getData().getDoubleExtra("rawLux", Double.NaN);
            double calibratedLux = result.getData().getDoubleExtra("calibratedLux", Double.NaN);
            if (Double.isFinite(rawLux) && Double.isFinite(calibratedLux)) {
                response.put("rawLux", rawLux);
                response.put("calibratedLux", calibratedLux);
            }
            response.put("capturedAt", result.getData().getLongExtra("capturedAt", System.currentTimeMillis()));
            call.resolve(response);
        } catch (IOException error) {
            call.reject("Could not read the captured photo.", error);
        }
    }
}
