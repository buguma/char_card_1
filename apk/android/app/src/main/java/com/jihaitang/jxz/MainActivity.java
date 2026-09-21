package com.jihaitang.jxz;

import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private final Runnable restoreImmersive = this::applyImmersiveMode;
    private boolean keyboardWasVisible;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register before BridgeActivity creates the WebView bridge.
        registerPlugin(GameOrientationPlugin.class);
        super.onCreate(savedInstanceState);
        configureWebViewInsets();
        restoreImmersiveMode();
    }

    private void configureWebViewInsets() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        View container = (View) getBridge().getWebView().getParent();
        // SystemBars.insetsHandling is disabled in capacitor.config.json. Never
        // inset the entire game for a cutout or a temporarily revealed system bar.
        // Keep keyboard avoidance: edge-to-edge disables the old automatic resize.
        ViewCompat.setOnApplyWindowInsetsListener(container, (view, insets) -> {
            boolean keyboardVisible = insets.isVisible(WindowInsetsCompat.Type.ime());
            int keyboard = keyboardVisible ? insets.getInsets(WindowInsetsCompat.Type.ime()).bottom : 0;
            view.setPadding(0, 0, 0, keyboard);
            if (keyboardWasVisible && !keyboardVisible) {
                // IME dismissal need not change Activity focus. Restore once, not
                // on every inset event (which would fight swipe-to-reveal bars).
                getWindow().getDecorView().removeCallbacks(restoreImmersive);
                getWindow().getDecorView().post(restoreImmersive);
            }
            keyboardWasVisible = keyboardVisible;
            // Preserve cutout information for WebView's env(safe-area-inset-*).
            // Pages must use viewport-fit=cover; safe-area belongs on controls,
            // not on the full-screen game surface.
            return insets;
        });
        ViewCompat.requestApplyInsets(container);
    }

    @SuppressWarnings("deprecation")
    private void applyImmersiveMode() {
        if (isFinishing() || isDestroyed()) return;
        Window window = getWindow();
        // Clear the launch theme's window flag on every restore. On API 24-29
        // FLAG_FULLSCREEN disables adjustResize and can starve compat IME insets.
        // AndroidX hide(statusBars) uses SYSTEM_UI_FLAG_FULLSCREEN instead; it
        // does not re-add this Window flag. Keep launch-only fullscreen separate.
        window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS
            | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attributes = window.getAttributes();
            // ALWAYS also covers long-edge cutouts after rotating the device.
            // Android 9/10 only support SHORT_EDGES; do not pass a newer enum there.
            attributes.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(attributes);
        }
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
        // AndroidX maps this to immersive-sticky/system UI flags on API 24-29.
        // Do not hide IME or change requested orientation here.
    }

    private void restoreImmersiveMode() {
        applyImmersiveMode();
        View decor = getWindow().getDecorView();
        decor.removeCallbacks(restoreImmersive);
        // Reapply after the platform/bridge's current lifecycle/layout callbacks.
        decor.post(restoreImmersive);
    }

    @Override
    public void onResume() {
        super.onResume();
        restoreImmersiveMode();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) restoreImmersiveMode();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        restoreImmersiveMode();
    }

    @Override
    public void onDestroy() {
        getWindow().getDecorView().removeCallbacks(restoreImmersive);
        super.onDestroy();
    }
}
