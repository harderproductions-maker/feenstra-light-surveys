package app.primeops.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LightSensorPlugin.class);
        registerPlugin(CameraCapturePlugin.class);
        registerPlugin(PdfReportPlugin.class);
        registerPlugin(CheckLocationPlugin.class);
        registerPlugin(AppUpdatesPlugin.class);
        registerPlugin(SupplierEmailPlugin.class);
        super.onCreate(savedInstanceState);
    }
}