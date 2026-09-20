package com.jihaitang.jxz;

import android.content.pm.ActivityInfo;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Locks the Activity itself; CSS layout and browser orientation APIs cannot do this. */
@CapacitorPlugin(name = "GameOrientation")
public class GameOrientationPlugin extends Plugin {
    @PluginMethod
    public void lock(PluginCall call) {
        String orientation = call.getString("orientation");
        final int requested;
        if ("landscape".equals(orientation)) {
            requested = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE;
        } else if ("portrait".equals(orientation)) {
            requested = ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT;
        } else {
            call.reject("Expected landscape or portrait");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                // Overrides the launch-time portrait preference even with system auto-rotate off.
                getActivity().setRequestedOrientation(requested);
                call.resolve();
            } catch (Exception error) {
                call.reject("Unable to change screen orientation", error);
            }
        });
    }
}
