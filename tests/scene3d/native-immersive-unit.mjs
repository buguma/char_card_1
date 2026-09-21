// Static native-source contracts only: not an Android runtime/keyboard test.
// Run without Gradle, freezing assets, cap sync, an emulator or an APK build.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const read = name => fs.readFile(new URL(name, root), 'utf8');
const activity = (await read('apk/android/app/src/main/java/com/jihaitang/jxz/MainActivity.java'))
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const themes = await read('apk/android/app/src/main/res/values/styles.xml');
const manifest = await read('apk/android/app/src/main/AndroidManifest.xml');
const config = JSON.parse(await read('apk/capacitor.config.json'));

function style(name) {
  const blocks = [...themes.matchAll(/<style\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/style>/g)];
  const matches = blocks.filter(([, found]) => found === name);
  assert.equal(matches.length, 1, `unique theme ${name}`);
  return matches[0][2];
}
function method(name) {
  const signature = new RegExp(`\\b(?:public|private|protected)\\s+void\\s+${name}\\s*\\([^)]*\\)\\s*\\{`).exec(activity);
  assert.ok(signature, `method ${name} exists`);
  let depth = 1;
  const start = signature.index + signature[0].length;
  for (let index = start; index < activity.length; index++) {
    if (activity[index] === '{') depth++;
    if (activity[index] === '}' && --depth === 0) return activity.slice(start, index);
  }
  assert.fail(`unclosed method ${name}`);
}

test('fullscreen window flag is launch-only so legacy adjustResize remains available', () => {
  assert.match(style('AppTheme.NoActionBarLaunch'), /name="android:windowFullscreen">true<\/item>/);
  assert.match(style('AppTheme.NoActionBar'), /name="android:windowFullscreen">false<\/item>/);
  assert.match(style('AppTheme.NoActionBarLaunch'), /name="postSplashScreenTheme">@style\/AppTheme.NoActionBar<\/item>/);
  assert.match(manifest, /android:windowSoftInputMode="adjustResize"/);
});

test('every immersive restoration clears the inherited window flag before hiding system bars', () => {
  const apply = method('applyImmersiveMode');
  const clear = apply.indexOf('window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)');
  const edge = apply.indexOf('WindowCompat.setDecorFitsSystemWindows(window, false)');
  const hide = apply.indexOf('controller.hide(WindowInsetsCompat.Type.systemBars())');
  assert.ok(clear >= 0 && clear < edge && edge < hide, 'clear Window flag before edge-to-edge and compat hide');
  assert.match(apply, /BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE/);
  assert.doesNotMatch(activity, /(?:addFlags|setFlags)\s*\([^;]*\bFLAG_FULLSCREEN\b/);
  assert.doesNotMatch(activity, /controller\.hide\([^;]*Type\.ime\(/);
  assert.match(method('restoreImmersiveMode'), /applyImmersiveMode\(\)/);
  assert.match(method('restoreImmersiveMode'), /decor\.post\(restoreImmersive\)/);
  for (const name of ['onCreate', 'onResume', 'onWindowFocusChanged', 'onConfigurationChanged']) {
    assert.match(method(name), /restoreImmersiveMode\(\)/, name);
  }
});

test('IME-only padding and dismissal recovery preserve child cutout insets', () => {
  const configure = method('configureWebViewInsets');
  assert.match(configure, /ViewCompat\.setOnApplyWindowInsetsListener\(container/);
  assert.match(configure, /insets\.isVisible\(WindowInsetsCompat.Type\.ime\(\)\)/);
  assert.match(configure, /keyboardVisible\s*\?\s*insets\.getInsets\(WindowInsetsCompat.Type\.ime\(\)\)\.bottom\s*:\s*0/);
  assert.match(configure, /view\.setPadding\(0, 0, 0, keyboard\)/);
  assert.match(configure, /if \(keyboardWasVisible && !keyboardVisible\)/);
  assert.match(configure, /post\(restoreImmersive\)/);
  assert.match(configure, /return insets;/);
  assert.doesNotMatch(configure, /CONSUMED|consumeDisplayCutout/);
  assert.equal(config.plugins.SystemBars.hidden, true);
  assert.equal(config.plugins.SystemBars.insetsHandling, 'disable');
});

test('IME fix retains cutout and native orientation policies', () => {
  const apply = method('applyImmersiveMode');
  assert.match(apply, /SDK_INT >= Build.VERSION_CODES\.P/);
  assert.match(apply, /SDK_INT >= Build.VERSION_CODES\.R\s*\?\s*WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS\s*:\s*WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES/);
  assert.match(manifest, /android:screenOrientation="sensorPortrait"/);
  assert.match(method('onCreate'), /registerPlugin\(GameOrientationPlugin.class\)/);
  assert.doesNotMatch(activity, /setRequestedOrientation/);
});
