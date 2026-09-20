package com.jihaitang.jxz;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register before BridgeActivity creates the WebView bridge.
        registerPlugin(GameOrientationPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
