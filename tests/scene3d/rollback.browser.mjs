// Isolated P6 desktop rehearsal. Run: node tests/scene3d/rollback.browser.mjs
// Optional: --older=p6-history-a --newer=p6-current-b --runId=p6-unique-id
// Writes only a new .scene3d-work/<runId>; never activates the workspace pointer.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { configurationHash, loadRunRecord } from '../../scene3d/scripts/run-record.mjs';
import { verifyRelease } from '../../scene3d/scripts/artifact-utils.mjs';
import { artifact, assertSessionSafe, exportJson, fixturesRoot, hashFile, importJsonFile, json, launchBrowser, newGameContext, readState, runReadOnlyValidator, saveSessionEvidence, startGame } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';
import { readBridgeDiagnostics, setEnabled, waitForLatestApplied } from './p1.browser.mjs';
import { businessProjection, enterFromBuildingMenu, studyWithStream } from './p2.browser.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const options = { older: 'p6-history-a', newer: 'p6-current-b', runId: `p6-rollback-${Date.now()}-${randomUUID().slice(0, 8)}` };
const protectedHistoryIds = ['integration-003', 'integration-005'];
const invalidImportedAttempts = ['p6-rollback-1789223026338-c5e08ed8', 'p6-rollback-1789223291513-f9b9a0fe', 'p6-rollback-1789223574325-4e9d83d6'];
const seenOptions = new Set();
for (const argument of process.argv.slice(2)) {
  const match = /^--(older|newer|runId)=([a-zA-Z0-9][a-zA-Z0-9_-]*)$/.exec(argument);
  assert.ok(match, `Unknown/unsafe argument: ${argument}`);
  assert.ok(!seenOptions.has(match[1]), 'Duplicate option'); seenOptions.add(match[1]);
  options[match[1]] = match[2];
}
assert.notEqual(options.older, options.newer);
const directory = path.join(workspace, '.scene3d-work', options.runId);
await fs.mkdir(directory); // Deliberate EEXIST; previous evidence is never reused.
const gameRoot = path.join(directory, 'game'), sourceRoot = path.join(workspace, '.scene3d-work/baseline-original/pro');
const sourceManifest = path.join(workspace, '开发文档/3D整合/P0-资产清单.json');
const report = { schemaVersion: 1, status: 'RUNNING', startedAt: new Date().toISOString(), workspace, directory, gameRoot, options,
  scope: 'Isolated desktop Chromium rehearsal with two normal run-record/import-assets/build/publish CLI builds, synthetic saves and fake API; no production deployment.',
  tooling: { scripts: path.join(workspace, 'scene3d/scripts'), explanation: 'Original tooling explicitly invoked with frozen isolated projectRoot; copied package/lock must match original. Only three is copied into isolated node_modules for source dependency resolution.' },
  supersededAttempts: invalidImportedAttempts.map(runId => ({ report: path.join(workspace, '.scene3d-work', runId, 'report.json'), status: 'INVALID PROVENANCE / SUPERSEDED', reason: 'Runner manually set steps.build succeeded after importing an archive; not a normal build, so previous aggregate PASS is invalid for the requested P6 acceptance.' })),
  relatedTestEvidence: [{ suite: 'tests/scene3d/release-unit.mjs', status: 'PASS', tests: 21, passed: 21, exitCode: 0, source: 'Direct user report in this session, before corrected browser rehearsal', independentlyExecutedByThisRunner: false, scope: 'Separate historical unit-test claim; not included in this runner result count.' }],
  p5T04: { status: 'NOT RUN', serverCacheControl: 'no-store',
    observedOnly: 'Version selection, no mixed release requests, and open-session release retention under no-store transport.',
    missing: ['same URL A/B deployment with cacheable immutable JS and changed valid models', 'reload/reentry proving cache replacement', 'load-failure fallback during the A/B cache scenario'],
    scope: 'This P6 rehearsal does not satisfy P5-T04 cache acceptance.' },
  notRun: ['signed APK upgrade', 'Android devices', 'real user saves', 'real API', 'three natural days of rollout', 'P5-T04 cache acceptance', 'full P6 acceptance'], results: [], errors: [] };
let browser, server, before, isolatedBefore;
const sessions = [];
const historical = [];
async function inventory(root, prefix = '', output = {}) {
  for (const entry of (await fs.readdir(path.join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.ok(!entry.isSymbolicLink(), `Symlink forbidden: ${root}/${name}`);
    if (entry.isDirectory()) await inventory(root, name, output);
    else if (entry.isFile()) output[name] = await hashFile(path.join(root, name));
    else throw Error(`Unsupported file: ${name}`);
  }
  return output;
}
async function protectedInputs() {
  const output = {};
  // All production release bytes and host/runtime/scripts; original APK files are
  // hashed separately, without traversing dependency/build caches as source.
  for (const name of ['index.html', 'module', 'ui', 'assets', 'scene3d/src', 'scene3d/scripts', 'scene3d/package-lock.json', 'scene3d/package.json', 'scene3d/vite.config.js', 'scene3d/node_modules/three']) {
    const filename = path.join(workspace, name);
    output[name] = (await fs.stat(filename)).isDirectory() ? await inventory(filename) : await hashFile(filename);
  }
  async function apkFiles(root, relative = '') {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const name = path.join(relative, entry.name);
      if (entry.isDirectory() && !['node_modules', '.git', '.scene3d-work', '.gradle'].includes(entry.name)) await apkFiles(root, name);
      else if (entry.isFile() && entry.name.endsWith('.apk')) output[`apk:${name}`] = await hashFile(path.join(root, name));
    }
  }
  await apkFiles(workspace);
  output.sourceManifest = await hashFile(sourceManifest);
  output.sourceBaseline = {};
  for (const name of Object.keys((await json(sourceManifest)).files).sort()) output.sourceBaseline[name] = await hashFile(path.join(sourceRoot, name));
  for (const id of protectedHistoryIds) {
    output[`history:${id}`] = await hashFile(path.join(workspace, '.scene3d-work', id, 'run.json'));
    output[`archive:${id}`] = await inventory(path.join(workspace, '.scene3d-work', id, 'release'));
  }
  return output;
}
async function record(runId, buildId) {
  const runDir = path.join(gameRoot, '.scene3d-work', runId), filename = path.join(runDir, 'run.json');
  await cli(`record-${runId}`, 'run-record.mjs', [`--runRecord=${filename}`, `--runId=${runId}`, `--buildId=${buildId}`, `--projectRoot=${gameRoot}`, `--sourceRoot=${sourceRoot}`, `--sourceManifest=${sourceManifest}`,
    `--resourceRoot=${path.join(runDir, 'resources')}`, `--releaseDir=${path.join(runDir, 'release')}`, `--publishRoot=${path.join(gameRoot, 'assets/sect3d')}`]);
  return { filename, value: await loadRunRecord(filename) };
}
async function cli(label, script, args, expectedSuccess = true) {
  const logDir = path.join(directory, 'cli', label); await fs.mkdir(logDir, { recursive: true });
  const result = await runReadOnlyValidator(path.join(workspace, 'scene3d/scripts', script), args, { cwd: gameRoot, directory: logDir });
  await artifact(logDir, 'command.json', result);
  assert.equal(result.timedOut, false, `${label} timed out`);
  assert.equal(result.signal, null, `${label} terminated`);
  if (expectedSuccess) assert.equal(result.code, 0, `${label} failed; see ${result.stderr}`);
  else assert.ok(Number.isInteger(result.code) && result.code !== 0, `${label} should reject`);
  return result;
}
async function step(name, work) {
  console.log('START', name);
  const row = { name, startedAt: new Date().toISOString() }; report.results.push(row);
  try { row.value = await work(); row.status = 'PASS'; }
  catch (error) { row.status = 'FAIL'; row.error = error.stack; throw error; }
  finally { row.endedAt = new Date().toISOString(); await artifact(directory, 'report.json', report); console.log('END', name, row.status); }
}
async function activate(label, target, expected, success = true) {
  const operation = await record(label, target.value.buildId);
  const pointerPath = path.join(gameRoot, 'assets/sect3d/current.json'), prior = await fs.readFile(pointerPath);
  const command = await cli(label, 'activate-release.mjs', [`--runRecord=${operation.filename}`, `--targetRunRecord=${target.filename}`, `--expectedCurrentBuildId=${expected}`], success);
  const transaction = await json(path.join(path.dirname(operation.filename), 'activation/transaction.json'));
  assert.equal(transaction.status, success ? 'committed' : 'failed');
  assert.equal(transaction.pointerCommitted, success);
  if (success) {
    assert.equal((await json(pointerPath)).buildId, target.value.buildId);
    assert.equal(transaction.after.sha256, (await hashFile(pointerPath)).sha256);
    assert.deepEqual(await fs.readFile(path.join(path.dirname(operation.filename), 'activation/before-pointer.json')), prior);
  } else assert.deepEqual(await fs.readFile(pointerPath), prior);
  return { operation: operation.filename, transaction, command };
}
async function openGame(label, buildId, payload) {
  const session = await newGameContext(browser, server, { payload: payload || await json(path.join(fixturesRoot, 'saves/map.json')), channel: label, scene3dPreferences: { enabled: true, quality: 'low' } });
  session.label = label; sessions.push(session);
  await startGame(session, server); await session.page.evaluate(() => closeModal());
  const diagnostics = await waitForLatestApplied(session.page, 'main');
  assert.equal(diagnostics.buildId, buildId); assert.equal(diagnostics.renderer.canvases, 1);
  assert.ok(diagnostics.renderer.geometries > 0); assert.ok(diagnostics.renderer.frames > 0);
  const requests = session.network.filter(item => item.action === 'allow' && item.url.includes('/assets/sect3d/'));
  assert.ok(requests.some(item => item.url.includes(`/${buildId}/`) && /\.m?js$/.test(item.url)));
  assert.ok(requests.some(item => item.url.includes(`/${buildId}/`) && /\.glb$/.test(item.url)));
  assert.ok(requests.every(item => item.url.endsWith('/current.json') || item.url.includes(`/${buildId}/`)), 'Mixed release request');
  assertSessionSafe(session, server, label);
  await artifact(directory, `${label}-diagnostics.json`, diagnostics);
  await saveSessionEvidence(session, directory, label);
  return session;
}
async function assertOriginal2d(page, sceneId, label) {
  const selector = sceneId === 'main' ? '#map-scene' : '#cangjingge-scene';
  const controls = sceneId === 'main' ? ['#map-hit-areas', '#cangjingge'] : ['#cangjingge-scene .back-btn', '#cangjingge-scene .scene-btn'];
  // Host scene buttons animate from opacity zero; wait for their real visible state.
  await page.waitForFunction(selectors => selectors.every(selector => {
    const element = document.querySelector(selector); if (!element) return false;
    const rect = element.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return false;
    for (let node = element; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node); if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
  }), { timeout: 15000 }, controls);
  const visual = await page.evaluate(async (sceneSelector, controlSelectors) => {
    function visible(element) {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let node = element; node instanceof Element; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      }
      return true;
    }
    const scene = document.querySelector(sceneSelector), background = getComputedStyle(scene).backgroundImage;
    const match = /^url\(["']?(.*?)["']?\)$/.exec(background);
    const image = match ? await new Promise(resolve => {
      const img = new Image(), timer = setTimeout(() => resolve({ loaded: false, error: 'background timeout' }), 15000);
      img.onload = async () => { try { await img.decode(); clearTimeout(timer); resolve({ loaded: true, decoded: true, width: img.naturalWidth, height: img.naturalHeight }); } catch (error) { clearTimeout(timer); resolve({ loaded: false, decoded: false, error: error.message }); } };
      img.onerror = () => { clearTimeout(timer); resolve({ loaded: false, error: 'background load failed' }); }; img.src = match[1];
    }) : { loaded: false };
    return { sceneVisible: visible(scene), background, image, ready: document.querySelector('#main-viewport').dataset.scene3dReady,
      controls: controlSelectors.map(selector => ({ selector, visible: visible(document.querySelector(selector)), text: document.querySelector(selector)?.textContent?.trim(), pointerEvents: document.querySelector(selector) ? getComputedStyle(document.querySelector(selector)).pointerEvents : null })) };
  }, selector, controls);
  assert.equal((await readBridgeDiagnostics(page)).renderer, null); assert.notEqual(visual.ready, 'true');
  assert.ok(visual.sceneVisible); assert.ok(visual.image.loaded && visual.image.decoded && visual.image.width > 0 && visual.image.height > 0, 'Original background must load and decode');
  assert.ok(visual.controls.every(item => item.visible), `Original 2D controls hidden: ${JSON.stringify(visual.controls)}`);
  await artifact(directory, `${label}-2d-visual.json`, visual); await page.screenshot({ path: path.join(directory, `${label}-2d.png`) });
  return visual;
}
async function readSyntheticConfig(page, channel) {
  const { runtime, persistedRaw } = await page.evaluate(() => ({ runtime: JSON.parse(JSON.stringify(apiService.getConfig())), persistedRaw: localStorage.getItem('jxz_apiConfig') }));
  assert.equal(typeof persistedRaw, 'string');
  const persisted = JSON.parse(persistedRaw), endpoint = `${server.origin}/__mock/${channel}`;
  assert.equal(runtime.endpoint, endpoint); assert.equal(persisted.endpoint, endpoint);
  // Keep runtime defaults and persisted fields separate; both must retain their
  // exact values. Only the deliberate per-session mock address is normalized.
  return { runtime: { ...runtime, endpoint: '<isolated mock channel>' }, persisted: { ...persisted, endpoint: '<isolated mock channel>' },
    persistedRaw: persistedRaw.replaceAll(JSON.stringify(endpoint), JSON.stringify('<isolated mock channel>')) };
}
async function trajectory(label, buildId, enabled) {
  const payload = await json(path.join(fixturesRoot, 'saves/map.json'));
  const session = await newGameContext(browser, server, { payload, channel: label, scene3dPreferences: { enabled, quality: 'low' } });
  session.label = label; sessions.push(session); const page = session.page;
  await startGame(session, server); await page.evaluate(() => closeModal());
  await page.waitForFunction(() => window.GameSceneBridge?.getDiagnostics().started);
  if (enabled) { const d = await waitForLatestApplied(page, 'main'); assert.equal(d.buildId, buildId); }
  else await assertOriginal2d(page, 'main', `${label}-map`);
  const config = await readSyntheticConfig(page, label), initial = await readState(page);
  if (enabled) {
    await setEnabled(page, false); assert.deepEqual(businessProjection(await readState(page)), businessProjection(initial));
    await assertOriginal2d(page, 'main', `${label}-map-toggle`);
    await setEnabled(page, true); await waitForLatestApplied(page, 'main');
    await enterFromBuildingMenu(page); await waitForLatestApplied(page, 'library');
  } else await page.evaluate(() => goToLocation('cangjingge'));
  const arrived = await readState(page); assert.equal(arrived.userLocation, 'cangjingge');
  if (enabled) {
    const d = await readBridgeDiagnostics(page); assert.equal(d.buildId, buildId); assert.ok(d.renderer.geometries > 0);
    await artifact(directory, `${label}-library-diagnostics.json`, d); await page.screenshot({ path: path.join(directory, `${label}-library.png`) });
    await setEnabled(page, false); assert.deepEqual(businessProjection(await readState(page)), businessProjection(arrived));
    await assertOriginal2d(page, 'library', `${label}-library-toggle`);
    await setEnabled(page, true); await waitForLatestApplied(page, 'library');
  } else await assertOriginal2d(page, 'library', `${label}-library`);
  const { partial, committed, prompt } = await studyWithStream({ directory }, server, page, label);
  if (enabled) await waitForLatestApplied(page, 'library');
  const back = await page.waitForSelector('#cangjingge-scene .back-btn', { visible: true });
  assert.equal(await back.evaluate(element => element.getAttribute('onclick')), 'backToMap()');
  await back.click();
  if (enabled) await waitForLatestApplied(page, 'main');
  else await page.waitForFunction(() => window.__scene3dRead().userLocation === 'tianshanpai');
  const returned = await readState(page); assert.equal(returned.userLocation, 'tianshanpai');
  const exported = await exportJson(page), filename = await artifact(directory, `${label}-export.json`, exported);
  await importJsonFile(page, filename); if (enabled) await waitForLatestApplied(page, 'main');
  const restored = await readState(page);
  assert.deepEqual(await readSyntheticConfig(page, label), config, 'Study/import changed synthetic API config');
  assertSessionSafe(session, server, label);
  const versionRequests = session.network.filter(item => item.action === 'allow' && item.url.includes('/assets/sect3d/'));
  if (enabled) {
    assert.ok(versionRequests.some(item => item.url.includes(`/${buildId}/`) && /library_interior\.glb$/.test(item.url)));
    assert.ok(versionRequests.every(item => item.url.endsWith('/current.json') || item.url.includes(`/${buildId}/`)));
  } else assert.equal(versionRequests.length, 0, 'Cold disabled trajectory must not load 3D assets');
  const value = { initial: businessProjection(initial), arrived: businessProjection(arrived), partial: businessProjection(partial), committed: businessProjection(committed),
    returned: businessProjection(returned), restored: businessProjection(restored), exported, prompt, config };
  await artifact(directory, `${label}-trajectory.json`, value); await saveSessionEvidence(session, directory, label);
  await session.close(); sessions.splice(sessions.indexOf(session), 1);
  return value;
}
async function compareTrajectories(label, buildId) {
  const disabled = await trajectory(`${label}-2d`, buildId, false), enabled = await trajectory(`${label}-3d`, buildId, true);
  assert.deepEqual(enabled, disabled, 'Seeded 2D/3D business/RNG/config/SSE trajectories must match');
  await artifact(directory, `${label}-equivalence.json`, { status: 'PASS', differences: [], includes: ['complete businessProjection including RNG', 'API configuration excluding only isolated channel address', 'mock SSE request and commit', 'actual export/import', 'original back-button click', 'visible loaded map and library 2D backgrounds and controls'] });
  return enabled;
}
async function isolationHashes() {
  const output = { host: {}, releases: {}, records: {}, sentinels: await inventory(path.join(gameRoot, 'sentinels')) };
  for (const name of ['index.html', 'module', 'ui', 'scene3d']) {
    const filename = path.join(gameRoot, name);
    output.host[name] = (await fs.stat(filename)).isDirectory() ? await inventory(filename) : await hashFile(filename);
  }
  for (const item of historical) {
    output.releases[item.value.buildId] = { archive: await inventory(item.value.releaseDir), published: await inventory(path.join(item.value.publishRoot, item.value.buildId)) };
    output.records[item.value.buildId] = await hashFile(item.filename);
  }
  return output;
}
try {
  before = await protectedInputs(); await artifact(directory, 'protected-before.json', before);
  await step('prepare-isolated-normal-builds', async () => {
    await fs.mkdir(gameRoot); await fs.mkdir(path.join(gameRoot, 'scene3d'));
    for (const entry of await fs.readdir(workspace, { withFileTypes: true })) {
      if ((entry.isFile() && (entry.name.endsWith('.html') || entry.name === 'favicon.ico')) || ['module', 'ui', 'img', 'bgm', 'music'].includes(entry.name))
        await fs.cp(path.join(workspace, entry.name), path.join(gameRoot, entry.name), { recursive: true, errorOnExist: true, force: false });
    }
    const sourceAssetEntries = await fs.readdir(path.join(workspace, 'assets'), { withFileTypes: true });
    const copiedAssetEntries = [];
    for (const entry of sourceAssetEntries) {
      if (entry.name === 'sect3d') continue;
      assert.ok(!entry.isSymbolicLink(), `Unexpected static asset symlink: ${entry.name}`);
      await fs.cp(path.join(workspace, 'assets', entry.name), path.join(gameRoot, 'assets', entry.name), { recursive: true, errorOnExist: true, force: false });
      copiedAssetEntries.push(entry.name);
    }
    for (const required of ['fonts', 'image', 'ui']) assert.ok(copiedAssetEntries.includes(required), `Required host asset directory was not copied: assets/${required}`);
    assert.ok(!copiedAssetEntries.includes('sect3d'), 'Mutable production sect3d pointer/releases must never be copied');
    await artifact(directory, 'isolated-assets-copy.json', { sourceEntries: sourceAssetEntries.map(entry => entry.name).sort(), copiedEntries: copiedAssetEntries.sort(), excluded: ['sect3d'], requiredHostAssets: ['fonts', 'image', 'ui'] });
    for (const required of ['fonts', 'image', 'ui']) assert.ok((await inventory(path.join(gameRoot, 'assets', required))).fileCount !== 0 || Object.keys(await inventory(path.join(gameRoot, 'assets', required))).length > 0, `Copied host asset directory is empty: assets/${required}`);
    for (const name of ['src', 'scripts', 'vite.config.js', 'package.json', 'package-lock.json', 'node_modules/three'])
      await fs.cp(path.join(workspace, 'scene3d', name), path.join(gameRoot, 'scene3d', name), { recursive: true, errorOnExist: true, force: false });
    assert.deepEqual(await hashFile(path.join(gameRoot, 'scene3d/package-lock.json')), await hashFile(path.join(workspace, 'scene3d/package-lock.json')));
    assert.deepEqual(await inventory(path.join(gameRoot, 'scene3d/node_modules/three')), before['scene3d/node_modules/three']);
    const builds = [];
    for (const id of [options.older, options.newer]) {
      const built = await record(`build-${id}`, id), commands = [];
      for (const [label, script] of [['import', 'import-assets.mjs'], ['build', 'build.mjs'], ['publish', 'publish-assets.mjs']])
        commands.push(await cli(`${label}-${id}`, script, [`--runRecord=${built.filename}`]));
      built.value = await loadRunRecord(built.filename);
      assert.equal(built.value.configurationSha256, configurationHash(built.value));
      for (const name of ['import-assets', 'build', 'publish:assets']) assert.equal(built.value.steps[name].status, 'succeeded');
      const result = built.value.steps.build.result;
      assert.equal(built.value.steps['publish:assets'].result.manifestSha256, result.manifestSha256);
      assert.equal(result.buildInputsSha256, (await hashFile(result.buildInputs)).sha256);
      const inputs = await json(result.buildInputs);
      assert.equal(inputs.lockSha256, built.value.lockSha256); assert.equal(inputs.sourceManifestSha256, before.sourceManifest.sha256);
      await verifyRelease(built.value.releaseDir, id, result.manifestSha256);
      await verifyRelease(path.join(built.value.publishRoot, id), id, result.manifestSha256);
      historical.push(built);
      builds.push({ run: built.filename, buildId: id, commands, buildInputs: result.buildInputs, buildInputsSha256: result.buildInputsSha256, manifestSha256: result.manifestSha256 });
    }
    await fs.mkdir(path.join(gameRoot, 'sentinels'));
    for (const name of ['dummy-save-generation-1.json', 'dummy-save-generation-2.json', 'dummy-api-config.json', 'dummy-original.apk']) await artifact(path.join(gameRoot, 'sentinels'), name, 'SYNTHETIC sentinel; not real user data or an APK');
    isolatedBefore = await isolationHashes(); await artifact(directory, 'isolated-before.json', isolatedBefore);
    return builds;
  });
  server = await startTestServer({ gameRoot, basePath: '/p6/rehearsal/' }); browser = await launchBrowser();
  report.browser = await browser.version(); report.baseUrl = server.baseUrl;
  let active, backup, rolled, newerTrajectory, activeConfig, rolledConfig;
  await step('newer-business-rng-config-equivalence', async () => {
    newerTrajectory = await compareTrajectories('newer', options.newer);
    return { buildId: options.newer, differences: 0, evidence: 'newer-equivalence.json' };
  });
  await step('newer-browser-and-backup', async () => {
    active = await openGame('newer-initial', options.newer);
    activeConfig = await readSyntheticConfig(active.page, active.label);
    await artifact(directory, 'config-before-rollback.json', activeConfig);
    backup = await exportJson(active.page); await active.page.evaluate(() => closeModal());
    const filename = await artifact(directory, 'synthetic-export-before.json', backup);
    return { buildId: options.newer, backup: filename, hash: await hashFile(filename) };
  });
  await step('cli-rollback', () => activate('rollback-operation', historical[0], options.newer));
  await step('open-session-version-lock', async () => {
    const diagnostics = await waitForLatestApplied(active.page, 'main'); assert.equal(diagnostics.buildId, options.newer);
    assert.deepEqual(await readSyntheticConfig(active.page, active.label), activeConfig, 'Rollback changed runtime or persisted config');
    assert.deepEqual(await exportJson(active.page), backup, 'Pointer operation changed open-session export');
    await active.page.evaluate(() => closeModal());
    const requestStart = active.network.length;
    await active.page.evaluate(() => goToLocation('cangjingge'));
    const library = await waitForLatestApplied(active.page, 'library');
    assert.equal(library.buildId, options.newer);
    assert.equal((await readState(active.page)).userLocation, 'cangjingge');
    const navigationRequests = active.network.slice(requestStart).filter(item => item.action === 'allow' && item.url.includes('/assets/sect3d/'));
    assert.ok(navigationRequests.some(item => item.url.includes(`/${options.newer}/`) && /library_interior\.glb$/.test(item.url)), 'Open session must load the previously unvisited library from its frozen release');
    assert.ok(navigationRequests.every(item => item.url.includes(`/${options.newer}/`)), 'Open session fetched a pointer or another release after rollback');
    await artifact(directory, 'open-session-library-after-rollback.json', { diagnostics: library, navigationRequests });
    await saveSessionEvidence(active, directory, 'open-session-library-after-rollback');
    await active.page.click('#cangjingge-scene .back-btn'); await waitForLatestApplied(active.page, 'main');
    assertSessionSafe(active, server, active.label);
    return { openSessionBuildId: library.buildId, pointerBuildId: (await json(path.join(gameRoot, 'assets/sect3d/current.json'))).buildId, libraryFetchedFromFrozenRelease: true, navigationRequests };
  });
  await step('older-business-rng-config-equivalence', async () => {
    const olderTrajectory = await compareTrajectories('older', options.older);
    assert.deepEqual(olderTrajectory, newerTrajectory, 'Same seeded business/RNG/config/SSE trajectory must survive resource rollback');
    return { buildId: options.older, differencesFrom2d: 0, differencesFromNewer: 0, evidence: 'older-equivalence.json' };
  });
  await step('rollback-browser-import-and-2d', async () => {
    rolled = await openGame('older-fresh', options.older, backup);
    rolledConfig = await readSyntheticConfig(rolled.page, rolled.label);
    assert.deepEqual(rolledConfig, activeConfig, 'Fresh older version differs in runtime/persisted config');
    await importJsonFile(rolled.page, path.join(directory, 'synthetic-export-before.json'));
    const exported = await exportJson(rolled.page); await rolled.page.evaluate(() => closeModal());
    assert.deepEqual(exported.gameData, backup.gameData, 'Actual import/export changed synthetic game data');
    await artifact(directory, 'synthetic-export-rollback.json', exported);
    const prior = await readState(rolled.page); await setEnabled(rolled.page, false);
    const after = await readState(rolled.page); assert.deepEqual(after.gameData, prior.gameData); assert.equal(after.userLocation, prior.userLocation);
    assert.equal((await readBridgeDiagnostics(rolled.page)).renderer, null);
    await saveSessionEvidence(rolled, directory, 'older-disabled');
    await setEnabled(rolled.page, true); await waitForLatestApplied(rolled.page, 'main');
    assertSessionSafe(rolled, server, rolled.label);
    return { buildId: options.older, actualSyntheticImportExport: true, disabledRenderer: null, businessDataUnchanged: true };
  });
  await step('rollback-2d-business-and-second-backup', async () => {
    const beforeDisable = businessProjection(await readState(rolled.page));
    await setEnabled(rolled.page, false);
    assert.deepEqual(businessProjection(await readState(rolled.page)), beforeDisable);
    await rolled.page.evaluate(() => goToLocation('cangjingge'));
    assert.equal((await readState(rolled.page)).userLocation, 'cangjingge');
    const { committed } = await studyWithStream({ directory }, server, rolled.page, rolled.label);
    assert.equal(committed.streaming, false);
    assert.equal((await readBridgeDiagnostics(rolled.page)).renderer, null);
    await rolled.page.click('#cangjingge-scene .back-btn');
    const returned = await readState(rolled.page); assert.equal(returned.userLocation, 'tianshanpai');
    backup = await exportJson(rolled.page);
    const filename = await artifact(directory, 'synthetic-export-after-rollback-action.json', backup);
    await importJsonFile(rolled.page, filename);
    assert.deepEqual((await exportJson(rolled.page)).gameData, backup.gameData);
    await rolled.page.evaluate(() => closeModal());
    await artifact(directory, 'rollback-2d-business.json', { committed: businessProjection(committed), returned: businessProjection(returned) });
    await saveSessionEvidence(rolled, directory, 'older-2d-action');
    await setEnabled(rolled.page, true); await waitForLatestApplied(rolled.page, 'main');
    assertSessionSafe(rolled, server, rolled.label);
    return { actualTravelAndStreamingStudy: true, requests: server.requests.filter(item => item.channel === rolled.label).length,
      secondGenerationBackup: filename, hash: await hashFile(filename), actualSyntheticImportExport: true };
  });
  await step('cli-stale-expected-rejected', () => activate('stale-operation', historical[1], options.newer, false));
  await step('cli-reactivation', () => activate('reactivation-operation', historical[1], options.older));
  await step('reactivated-browser', async () => {
    const session = await openGame('newer-reactivated', options.newer, backup);
    assert.deepEqual((await exportJson(session.page)).gameData, backup.gameData);
    assert.deepEqual(await readSyntheticConfig(session.page, session.label), activeConfig, 'Reactivated version changed runtime/persisted config');
    assert.deepEqual(await readSyntheticConfig(active.page, active.label), activeConfig, 'Original open session config changed');
    assert.deepEqual(await readSyntheticConfig(rolled.page, rolled.label), rolledConfig, 'Older session study/import/reactivation changed config');
    await artifact(directory, 'config-after-reactivation.json', await readSyntheticConfig(session.page, session.label));
    return { buildId: options.newer, syntheticDataRoundTrip: true, runtimeAndPersistedConfigRetained: true };
  });
  report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.errors.push(error.stack || String(error)); console.error(error.stack || error); }
finally {
  for (const session of sessions) {
    try { assertSessionSafe(session, server, session.label); await saveSessionEvidence(session, directory, `${session.label}-final`); }
    catch (error) { report.status = 'FAIL'; report.errors.push(String(error.stack || error)); }
    finally { try { await session.close(); } catch (error) { report.status = 'FAIL'; report.errors.push(String(error)); } }
  }
  try { if (browser) await browser.close(); } catch (error) { report.status = 'FAIL'; report.errors.push(String(error)); }
  try { if (server) { await artifact(directory, 'transport.json', { events: server.events, requests: server.requests }); await server.close(); } } catch (error) { report.status = 'FAIL'; report.errors.push(String(error)); }
  try {
    const after = await protectedInputs(); await artifact(directory, 'protected-after.json', after);
    report.mainInputsUnchanged = !!before && JSON.stringify(before) === JSON.stringify(after); assert.ok(report.mainInputsUnchanged, 'Protected main inputs changed');
    if (isolatedBefore) {
      const isolatedAfter = await isolationHashes(); await artifact(directory, 'isolated-after.json', isolatedAfter);
      report.isolatedImmutableInputsUnchanged = JSON.stringify(isolatedBefore) === JSON.stringify(isolatedAfter);
      assert.ok(report.isolatedImmutableInputsUnchanged, 'Isolated host/releases/history/sentinels changed');
    }
  } catch (error) { report.status = 'FAIL'; report.errors.push(String(error.stack || error)); }
  report.endedAt = new Date().toISOString(); await artifact(directory, 'report.json', report);
  console.log(JSON.stringify({ status: report.status, report: path.join(directory, 'report.json'), errors: report.errors }, null, 2));
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}
