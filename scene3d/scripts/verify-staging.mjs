import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, readJson, fileInfo, verifyFiles, atomicJson, sha256, noSymlinks } from './artifact-utils.mjs';
import { withRun, isMain, runCli } from './run-record.mjs';
import { loadWwwExpected, validateNativeConfig, validatePlugins, parseGradleIdentity, canonical, EMPTY_FILE_INFO } from './prepare-apk.mjs';

export async function verifyCapacitorContract(paths, native) {
  const cliRoot = path.join(paths.apkRoot, 'node_modules/@capacitor/cli');
  const cli = await readJson(path.join(cliRoot, 'package.json'));
  assert(cli.version === native.capacitorCliVersion && cli.version === '8.4.0', 'Installed Capacitor CLI differs from reviewed lock');
  const cordovaSourcePath = path.join(cliRoot, 'dist/cordova.js');
  await noSymlinks(cordovaSourcePath);
  const source = await fs.readFile(cordovaSourcePath, 'utf8');
  assert(/async function createEmptyCordovaJS\(config, platform\)\s*\{[\s\S]*?writeFile\)\(\(0, path_1\.join\)\(webDir, 'cordova\.js'\), ''\);\s*await \(0, fs_extra_1\.writeFile\)\(\(0, path_1\.join\)\(webDir, 'cordova_plugins\.js'\), ''\);\s*\}/.test(source), 'Cap8 empty Cordova file contract changed');
  for (const [name, version] of Object.entries(native.dependencyVersions)) {
    const metadata = await readJson(path.join(paths.apkRoot, 'node_modules', name, 'package.json'));
    assert(metadata.name === name && metadata.version === version, `Installed native dependency differs from lock: ${name}`);
  }
  for (const plugin of native.plugins) {
    const metadata = await readJson(path.join(paths.apkRoot, 'node_modules', plugin.pkg, 'package.json'));
    assert(metadata.name === plugin.pkg && metadata.capacitor?.android?.src === 'android', `Installed native plugin metadata mismatch: ${plugin.pkg}`);
  }
  return { version: cli.version, cordovaSourceSha256: sha256(source), allowedPublicGenerated: { 'cordova.js': EMPTY_FILE_INFO, 'cordova_plugins.js': EMPTY_FILE_INFO } };
}
export async function verifyNativeGradle(paths, native) {
  const root = paths.androidRoot;
  const appBuildPath = path.join(root, 'app/build.gradle'), settingsPath = path.join(root, 'capacitor.settings.gradle'), pluginsBuildPath = path.join(root, 'app/capacitor.build.gradle');
  for (const filename of [appBuildPath, settingsPath, pluginsBuildPath]) await noSymlinks(filename);
  const appBuild = await fs.readFile(appBuildPath, 'utf8');
  assert(canonical(parseGradleIdentity(appBuild)) === canonical(native.identity), 'Native Gradle identity differs from frozen input');
  assert(/apply\s+from:\s*['"]capacitor\.build\.gradle['"]/.test(appBuild), 'Native Capacitor plugin build inclusion missing');
  const settings = await fs.readFile(settingsPath, 'utf8'), pluginBuild = await fs.readFile(pluginsBuildPath, 'utf8');
  const includes = [...settings.matchAll(/include\s+['"]:([^'"]+)['"]/g)].map(match => match[1]).sort();
  assert(canonical(includes) === canonical(['capacitor-android', 'capacitor-filesystem', 'capacitor-share']), 'Native Gradle settings plugin set mismatch');
  for (const short of ['filesystem', 'share']) {
    assert(new RegExp(`project\\(':capacitor-${short}'\\)\\.projectDir\\s*=\\s*new File\\('\\.\\./node_modules/@capacitor/${short}/android'\\)`).test(settings), `Native plugin source mapping mismatch: ${short}`);
    assert(new RegExp(`implementation\\s+project\\(['"]:capacitor-${short}['"]\\)`).test(pluginBuild), `Native implementation missing: ${short}`);
  }
  const implementation = [...pluginBuild.matchAll(/implementation\s+project\(['"]:([^'"]+)['"]\)/g)].map(match => match[1]).sort();
  assert(canonical(implementation) === canonical(['capacitor-filesystem', 'capacitor-share']), 'Unexpected native plugin implementation');
  return { appBuild: await fileInfo(appBuildPath), settings: await fileInfo(settingsPath), pluginBuild: await fileInfo(pluginsBuildPath) };
}
export async function verifyStaging(record, { runDir }) {
  const { paths, input, expected, built } = await loadWwwExpected(record, runDir);
  // Capacitor may regenerate only these known source-side files. Every other
  // copied native/build configuration input must still match the frozen copy.
  const regenerated = new Set(['apk/android/capacitor.settings.gradle', 'apk/android/app/capacitor.build.gradle', 'apk/android/app/src/main/res/xml/config.xml']);
  for (const [name, info] of Object.entries(input.files)) {
    if (!name.startsWith('apk/') || regenerated.has(name) || name.startsWith('apk/android/capacitor-cordova-android-plugins/')) continue;
    const actual = await fileInfo(path.join(paths.isolatedRoot, name));
    assert(actual.bytes === info.bytes && actual.sha256 === info.sha256, `Frozen native/build input changed: ${name}`);
  }
  // The upstream expectation comes from copying/mapping, never from scanning synchronized output.
  await verifyFiles(paths.wwwRoot, expected.files);
  const contract = await verifyCapacitorContract(paths, expected.native);
  for (const name of Object.keys(contract.allowedPublicGenerated)) assert(!Object.hasOwn(expected.files, name), `Upstream file collides with controlled generated file: ${name}`);
  const publicFiles = { ...expected.files, ...contract.allowedPublicGenerated };
  await verifyFiles(path.join(paths.assetsRoot, 'public'), publicFiles);
  const configPath = path.join(paths.assetsRoot, 'capacitor.config.json'), pluginsPath = path.join(paths.assetsRoot, 'capacitor.plugins.json');
  validateNativeConfig(await readJson(configPath), expected.native.config);
  validatePlugins(await readJson(pluginsPath));
  const nativeFiles = { 'capacitor.config.json': await fileInfo(configPath), 'capacitor.plugins.json': await fileInfo(pluginsPath) };
  const assetFiles = { ...nativeFiles, ...Object.fromEntries(Object.entries(publicFiles).map(([name, info]) => [`public/${name}`, info])) };
  await verifyFiles(paths.assetsRoot, assetFiles);
  const gradleEvidence = await verifyNativeGradle(paths, expected.native);
  const report = { schemaVersion: 1, runId: record.runId, buildId: record.buildId, status: 'passed', upstreamManifestSha256: built.wwwExpectedManifestSha256, androidRoot: paths.androidRoot, apkPath: paths.apkPath, assetFiles, native: expected.native, contract, gradleEvidence, verifiedAt: new Date().toISOString() };
  const manifestPath = path.join(runDir, 'android-staging-manifest.json');
  // This is written only AFTER all comparisons pass. withRun marks any later failure explicitly.
  await atomicJson(manifestPath, report);
  return { stagingManifest: manifestPath, stagingManifestSha256: (await fileInfo(manifestPath)).sha256, apkPath: paths.apkPath, fileCount: Object.keys(assetFiles).length };
}
if (isMain(import.meta.url)) runCli(() => withRun('verify:staging', verifyStaging));
