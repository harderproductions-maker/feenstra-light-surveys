package com.feenstra.lightsurveys;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;

import java.io.File;
import java.text.NumberFormat;
import java.util.Locale;
import java.util.concurrent.Executor;

public class CameraCaptureActivity extends AppCompatActivity implements SensorEventListener {
    private static final int CAMERA_PERMISSION_REQUEST = 7412;

    private PreviewView previewView;
    private TextView readingView;
    private TextView rawView;
    private Button captureButton;
    private ImageCapture imageCapture;
    private SensorManager sensorManager;
    private Sensor lightSensor;
    private double rawLux = Double.NaN;
    private double calibrationFactor = 1.0;
    private double recommendedLux = 300.0;
    private String buildingName = "";
    private String entryName = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        calibrationFactor = getIntent().getDoubleExtra("calibrationFactor", 1.0);
        recommendedLux = getIntent().getDoubleExtra("recommendedLux", 300.0);
        buildingName = getIntent().getStringExtra("buildingName");
        entryName = getIntent().getStringExtra("entryName");
        if (buildingName == null) buildingName = "";
        if (entryName == null) entryName = "";
        buildCameraUi();

        sensorManager = (SensorManager) getSystemService(SENSOR_SERVICE);
        if (sensorManager != null) lightSensor = sensorManager.getDefaultSensor(Sensor.TYPE_LIGHT);
        if (lightSensor == null) {
            readingView.setText("Ambient light sensor unavailable");
            rawView.setText("Photo will not include a lux measurement");
        }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera();
        } else {
            ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.CAMERA }, CAMERA_PERMISSION_REQUEST);
        }
    }

    private void buildCameraUi() {
        FrameLayout root = new FrameLayout(this);
        previewView = new PreviewView(this);
        previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        root.addView(previewView, new FrameLayout.LayoutParams(-1, -1));

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.VERTICAL);
        header.setPadding(dp(18), dp(20), dp(18), dp(18));
        header.setBackgroundColor(0xCC0D1A17);
        TextView projectView = new TextView(this);
        projectView.setText(buildingName + "  ·  " + entryName + "  ·  Recommended " + format(recommendedLux) + " lx");
        projectView.setTextColor(Color.WHITE);
        projectView.setTextSize(15);
        readingView = new TextView(this);
        readingView.setText("Waiting for live light reading…");
        readingView.setTextColor(0xFFCBF067);
        readingView.setTextSize(30);
        rawView = new TextView(this);
        rawView.setTextColor(Color.WHITE);
        rawView.setTextSize(14);
        header.addView(projectView);
        header.addView(readingView);
        header.addView(rawView);
        root.addView(header, new FrameLayout.LayoutParams(-1, -2, Gravity.TOP));

        LinearLayout controls = new LinearLayout(this);
        controls.setGravity(Gravity.CENTER);
        controls.setPadding(dp(16), dp(14), dp(16), dp(24));
        controls.setBackgroundColor(0xCC0D1A17);
        Button cancelButton = new Button(this);
        cancelButton.setText("Cancel");
        cancelButton.setOnClickListener(view -> {
            setResult(RESULT_CANCELED);
            finish();
        });
        captureButton = new Button(this);
        captureButton.setText("Take photo");
        captureButton.setEnabled(false);
        captureButton.setOnClickListener(this::capturePhoto);
        controls.addView(cancelButton, new LinearLayout.LayoutParams(0, -2, 1));
        controls.addView(captureButton, new LinearLayout.LayoutParams(0, -2, 1));
        root.addView(controls, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
        setContentView(root);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> providerFuture = ProcessCameraProvider.getInstance(this);
        Executor executor = ContextCompat.getMainExecutor(this);
        providerFuture.addListener(() -> {
            try {
                ProcessCameraProvider provider = providerFuture.get();
                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());
                imageCapture = new ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                    .setJpegQuality(88)
                    .build();
                provider.unbindAll();
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, imageCapture);
                captureButton.setEnabled(true);
            } catch (Exception error) {
                Toast.makeText(this, "Could not start the camera: " + error.getMessage(), Toast.LENGTH_LONG).show();
                setResult(RESULT_CANCELED);
                finish();
            }
        }, executor);
    }

    private void capturePhoto(View ignored) {
        if (imageCapture == null) return;
        captureButton.setEnabled(false);
        File destination = new File(getCacheDir(), "survey-photo-" + System.currentTimeMillis() + ".jpg");
        ImageCapture.OutputFileOptions options = new ImageCapture.OutputFileOptions.Builder(destination).build();
        imageCapture.takePicture(options, ContextCompat.getMainExecutor(this), new ImageCapture.OnImageSavedCallback() {
            @Override
            public void onImageSaved(@NonNull ImageCapture.OutputFileResults output) {
                if (!destination.isFile() || destination.length() == 0) {
                    captureButton.setEnabled(true);
                    Toast.makeText(CameraCaptureActivity.this, "The camera returned an empty photo.", Toast.LENGTH_LONG).show();
                    return;
                }
                android.content.Intent result = new android.content.Intent();
                result.putExtra("photoPath", destination.getAbsolutePath());
                result.putExtra("rawLux", rawLux);
                result.putExtra("calibratedLux", Double.isFinite(rawLux) ? rawLux * calibrationFactor : Double.NaN);
                result.putExtra("capturedAt", System.currentTimeMillis());
                setResult(RESULT_OK, result);
                finish();
            }

            @Override
            public void onError(@NonNull ImageCaptureException error) {
                captureButton.setEnabled(true);
                Toast.makeText(CameraCaptureActivity.this, "Could not take photo: " + error.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (sensorManager != null && lightSensor != null) {
            sensorManager.registerListener(this, lightSensor, SensorManager.SENSOR_DELAY_NORMAL);
        }
    }

    @Override
    protected void onPause() {
        if (sensorManager != null) sensorManager.unregisterListener(this);
        super.onPause();
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event.sensor.getType() != Sensor.TYPE_LIGHT || event.values.length == 0) return;
        rawLux = event.values[0];
        readingView.setText(format(rawLux * calibrationFactor) + " lx  ·  live (×" + String.format(Locale.US, "%.2f", calibrationFactor) + ")");
        rawView.setText("Raw phone sensor: " + format(rawLux) + " lx");
    }

    private String format(double lux) {
        if (!Double.isFinite(lux)) return "Unavailable";
        NumberFormat format = NumberFormat.getNumberInstance();
        format.setMaximumFractionDigits(2);
        return format.format(lux);
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_PERMISSION_REQUEST) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startCamera();
            } else {
                Toast.makeText(this, "Camera permission is required to take inspection photos.", Toast.LENGTH_LONG).show();
                setResult(RESULT_CANCELED);
                finish();
            }
        }
    }
}
