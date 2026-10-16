package com.feenstra.lightsurveys;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LightSensorPlugin.class);
        super.onCreate(savedInstanceState);
    }
}