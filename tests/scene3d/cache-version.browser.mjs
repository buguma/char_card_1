// P5-T04 only. Run: node tests/scene3d/cache-version.browser.mjs
// Every execution owns a fresh work root; no production pointer/source/archive writes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { configurationHash, loadRunRecord } from '../../scene3d/scripts/run-record.mjs';
import { fileInfo, readJson, safeRelative, verifyRelease } from '../../scene3d/scripts/artifact-utils.mjs';
import { artifact, assertSessionSafe, diff, exportJson, fixturesRoot, hashFile, importJsonFile, json, launchBrowser, newGameContext, readState, runReadOnlyValidator, saveSessionEvidence, sha256, startGame } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';
import { readBridgeDiagnostics, waitForLatestApplied } from './p1.browser.mjs';
import { businessProjection, enterFromBuildingMenu, studyWithStream } from './p2.browser.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
assert.equal(process.argv.length, 2, 'No options: each execution must create fresh evidence');
const directory = path.join(workspace, '.scene3d-work', `p5-cache-${Date.now()}-${randomUUID().slice(0, 8)}`);
await fs.mkdir(directory);
const gameRoot = path.join(directory, 'game');
const sourceManifest = path.join(workspace, '开发文档/3D整合/P0-资产清单.json');
const report = { schemaVersion: 1, testId: 'P5-T04', status: 'RUNNING', directory, startedAt: new Date().toISOString(),
  scope: 'Desktop Chromium; synthetic saves and mock API in new BrowserContexts; normal independent CLI A/B builds; no unit/batch/APK runs.',
  cachePolicy: { resources: 'public, max-age=31536000, immutable', pointer: 'no-store', manifest: 'no-cache (always revalidate; complete 200 response)' },
  tooling: 'Original scene3d/scripts explicitly invoked; isolated source/package/lock; only same-lock three copied into isolated node_modules; no symlinks or manual run steps.', results: [], commands: [], errors: [] };
let browser, server, before, parallelBefore, activeVersion, faultPath;
async function parallelObservations() {
  const output = {};
  for (const name of ['开发文档/3D整合', 'tests/scene3d']) output[name] = await inventory(path.join(workspace, name));
  return output;
}
const sessions = [], transport = [], builds = {};
async function inventory(root, prefix = '', out = {}) {
  for (const entry of (await fs.readdir(path.join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.ok(!entry.isSymbolicLink(), `Symlink forbidden: ${root}/${name}`);
    if (entry.isDirectory()) await inventory(root, name, out);
    else if (entry.isFile()) out[name] = await hashFile(path.join(root, name));
    else throw Error(`Unsupported file: ${name}`);
  }
  return out;
}
// Protect the actual publication, not archived integration runs. The separate
// P0 sourceRoot (currently .scene3d-work/baseline-original/pro) is still required
// for genuine isolated builds; no obsolete published release is a fixture.
async function currentPublication(publishRoot = path.join(workspace, 'assets/sect3d')) {
  const pointerPath = path.join(publishRoot, 'current.json');
  const pointerInfo = await fileInfo(pointerPath), pointer = await readJson(pointerPath);
  assert.equal(pointer.schemaVersion, 1, 'Current pointer schema mismatch');
  safeRelative(pointer.buildId);
  assert.ok(!pointer.buildId.includes('/'), 'Current buildId must be a single directory');
  assert.deepEqual(pointer.bridgeProtocol, { min: 1, max: 1 });
  assert.equal(pointer.manifest, `${pointer.buildId}/manifest.json`);
  assert.match(pointer.manifestSha256, /^[a-f0-9]{64}$/);
  const releaseRoot = path.join(publishRoot, pointer.buildId);
  const { manifest, manifestSha256 } = await verifyRelease(releaseRoot, pointer.buildId, pointer.manifestSha256);
  const release = await inventory(releaseRoot);
  assert.equal(release['manifest.json'].sha256, manifestSha256);
  for (const [name, info] of Object.entries(manifest.files)) assert.deepEqual(release[name], { bytes: info.bytes, sha256: info.sha256 });
  assert.deepEqual(await fileInfo(pointerPath), pointerInfo, 'Current pointer changed during capture');
  return { pointer, pointerInfo, release };
}
async function protectedInputs() {
  const out = {};
  for (const name of ['index.html', 'module', 'ui', 'assets', 'scene3d/src', 'scene3d/scripts', 'scene3d/package.json', 'scene3d/package-lock.json', 'scene3d/vite.config.js', 'scene3d/node_modules/three']) {
    const filename = path.join(workspace, name);
    out[name] = (await fs.stat(filename)).isDirectory() ? await inventory(filename) : await hashFile(filename);
  }
  out.currentPublication = await currentPublication();
  out.baseline = {};
  out.sourceManifest = await hashFile(sourceManifest); // Frozen build input remains protected even though general docs may change.
  const manifest = await json(sourceManifest);
  for (const name of Object.keys(manifest.files).sort()) out.baseline[name] = await hashFile(path.join(manifest.sourceRoot, name));
  // Include APKs in historical work roots too, excluding only this newly owned run.
  async function apks(root, prefix = '') {
    for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(root, entry.name), name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || filename === directory) continue;
      if (entry.isDirectory() && !['.git', 'node_modules', '.gradle'].includes(entry.name)) await apks(filename, name);
      else if (entry.isFile() && entry.name.endsWith('.apk')) out[`apk:${name}`] = await hashFile(filename);
    }
  }
  await apks(workspace);
  return out;
}
async function step(name, work) {
  console.log('START', name);
  const row = { name, status: 'RUNNING', startedAt: new Date().toISOString() }; report.results.push(row);
  try { row.value = await work(); row.status = 'PASS'; return row.value; }
  catch (error) { row.status = 'FAIL'; row.error = error.stack; throw error; }
  finally { row.endedAt = new Date().toISOString(); await artifact(directory, 'report.json', report); console.log('END', name, row.status); }
}
async function cli(label, script, args) {
  const logDir = path.join(directory, 'cli', label); await fs.mkdir(logDir, { recursive: true });
  const result = await runReadOnlyValidator(path.join(workspace, 'scene3d/scripts', script), args, { cwd: gameRoot, directory: logDir });
  report.commands.push({ label, ...result }); await artifact(logDir, 'command.json', result);
  assert.equal(result.timedOut, false); assert.equal(result.signal, null);
  assert.equal(result.code, 0, `${label} failed: ${result.stderr}`);
  return result;
}
function markGlb(bytes, version) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67); assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length); assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  const oldLength = bytes.readUInt32LE(12), originalText = bytes.subarray(20, 20 + oldLength).toString('utf8').trimEnd();
  const original = JSON.parse(originalText);
  assert.ok(original.asset && !Object.hasOwn(original.asset, 'extras'), 'Fixture must have asset without existing extras');
  const assetTokens = [...originalText.matchAll(/"asset"\s*:\s*\{/g)];
  assert.equal(assetTokens.length, 1, 'Require an unambiguous asset object insertion point');
  const insertAt = assetTokens[0].index + assetTokens[0][0].length;
  // Insert inside asset without reserializing any existing token (including -0).
  const marker = `"extras":{"scene3dCacheTestVersion":${JSON.stringify(version)}},`;
  const text = Buffer.from(originalText.slice(0, insertAt) + marker + originalText.slice(insertAt));
  const padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20); text.copy(padded);
  const tail = bytes.subarray(20 + oldLength), header = Buffer.from(bytes.subarray(0, 20));
  header.writeUInt32LE(20 + padded.length + tail.length, 8); header.writeUInt32LE(padded.length, 12);
  const result = Buffer.concat([header, padded, tail]);
  const decoded = JSON.parse(result.subarray(20, 20 + padded.length).toString('utf8'));
  assert.deepEqual(decoded.asset.extras, { scene3dCacheTestVersion: version });
  delete decoded.asset.extras.scene3dCacheTestVersion;
  if (!Object.hasOwn(original.asset, 'extras')) delete decoded.asset.extras;
  assert.deepEqual(decoded, original, 'Only diagnostic extras may differ');
  assert.deepEqual(result.subarray(20 + padded.length), tail, 'Binary/other chunks unchanged');
  return result;
}
function glbSemanticProof(bytes, version) {
  const jsonLength = bytes.readUInt32LE(12);
  const normalized = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  if (version) {
    assert.deepEqual(normalized.asset.extras, { scene3dCacheTestVersion: version });
    delete normalized.asset.extras; // This container was absent in the original, asserted by markGlb.
  }
  const chunks = [];
  for (let offset = 20 + jsonLength; offset < bytes.length;) {
    assert.ok(offset + 8 <= bytes.length);
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    assert.equal(length % 4, 0); assert.ok(offset + 8 + length <= bytes.length);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, bytes: length, sha256: sha256(payload) }); offset += 8 + length;
  }
  assert.ok(chunks.some(chunk => chunk.type === 0x004e4942), 'Expected GLB BIN chunk');
  return { normalized, evidence: { normalizedJsonSha256: sha256(JSON.stringify(normalized)),
    binaryChunks: chunks.filter(chunk => chunk.type === 0x004e4942), allNonJsonChunks: chunks,
    nonJsonChunkBytesSha256: sha256(bytes.subarray(20 + jsonLength)) } };
}
async function prepare() {
  await fs.mkdir(gameRoot);
  for (const entry of await fs.readdir(workspace, { withFileTypes: true })) {
    if ((entry.isFile() && (entry.name.endsWith('.html') || entry.name === 'favicon.ico')) || ['module', 'ui', 'img', 'bgm', 'music'].includes(entry.name))
      await fs.cp(path.join(workspace, entry.name), path.join(gameRoot, entry.name), { recursive: true, errorOnExist: true, force: false });
  }
  for (const entry of await fs.readdir(path.join(workspace, 'assets'), { withFileTypes: true })) {
    if (entry.name !== 'sect3d') await fs.cp(path.join(workspace, 'assets', entry.name), path.join(gameRoot, 'assets', entry.name), { recursive: true, errorOnExist: true, force: false });
  }
  const original = await json(sourceManifest);
  for (const version of ['a', 'b']) {
    const projectRoot = path.join(directory, `project-${version}`), sourceRoot = path.join(directory, `source-${version}`);
    await fs.mkdir(path.join(projectRoot, 'scene3d'), { recursive: true }); await fs.mkdir(sourceRoot);
    for (const name of ['src', 'scripts', 'vite.config.js', 'package.json', 'package-lock.json', 'node_modules/three'])
      await fs.cp(path.join(workspace, 'scene3d', name), path.join(projectRoot, 'scene3d', name), { recursive: true, errorOnExist: true, force: false });
    assert.deepEqual(await hashFile(path.join(projectRoot, 'scene3d/package-lock.json')), before['scene3d/package-lock.json']);
    assert.deepEqual(await inventory(path.join(projectRoot, 'scene3d/node_modules/three')), before['scene3d/node_modules/three']);
    assert.deepEqual(await fs.readdir(path.join(projectRoot, 'scene3d/node_modules')), ['three']);
    const entry = path.join(projectRoot, 'scene3d/src/index.js');
    await fs.writeFile(entry, (await fs.readFile(entry, 'utf8')) + `\n// Isolated cache-test diagnostic; no business or RNG effects.\nexport const SCENE3D_CACHE_TEST_VERSION = '${version}';\n`);
    const manifest = { ...structuredClone(original), capturedAt: new Date().toISOString(), sourceRoot };
    for (const name of Object.keys(manifest.files)) {
      const target = path.join(sourceRoot, name); await fs.mkdir(path.dirname(target), { recursive: true });
      const bytes = await fs.readFile(path.join(original.sourceRoot, name));
      await fs.writeFile(target, name.endsWith('.glb') ? markGlb(bytes, version) : bytes);
      Object.assign(manifest.files[name], await hashFile(target));
    }
    const manifestPath = await artifact(directory, `source-${version}-manifest.json`, manifest);
    const id = `p5-cache-${version}`, runDir = path.join(projectRoot, '.scene3d-work', id), filename = path.join(runDir, 'run.json');
    await cli(`record-${version}`, 'run-record.mjs', [`--runRecord=${filename}`, `--runId=${id}`, `--buildId=${id}`, `--projectRoot=${projectRoot}`, `--sourceRoot=${sourceRoot}`, `--sourceManifest=${manifestPath}`, `--resourceRoot=${path.join(runDir, 'resources')}`, `--releaseDir=${path.join(runDir, 'release')}`, `--publishRoot=${path.join(projectRoot, 'assets/sect3d')}`]);
    for (const [label, script] of [['import', 'import-assets.mjs'], ['build', 'build.mjs']]) await cli(`${label}-${version}`, script, [`--runRecord=${filename}`]);
    const record = await loadRunRecord(filename);
    assert.equal(record.configurationSha256, configurationHash(record));
    for (const name of ['import-assets', 'build']) assert.equal(record.steps[name].status, 'succeeded');
    const inputs = await json(record.steps.build.result.buildInputs);
    assert.equal(inputs.sourceManifestSha256, (await hashFile(manifestPath)).sha256);
    assert.equal(inputs.lockSha256, before['scene3d/package-lock.json'].sha256);
    assert.equal(record.steps.build.result.buildInputsSha256, (await hashFile(record.steps.build.result.buildInputs)).sha256);
    await verifyRelease(record.releaseDir, id, record.steps.build.result.manifestSha256);
    builds[version] = { id, filename, record, manifest: await json(path.join(record.releaseDir, 'manifest.json')), immutable: await inventory(projectRoot) };
  }
  const semanticProof = {};
  for (const name of Object.keys(original.files).filter(name => name.endsWith('.glb'))) {
    const proofs = {};
    for (const [label, root] of [['original', original.sourceRoot], ['a', path.join(directory, 'source-a')], ['b', path.join(directory, 'source-b')]])
      proofs[label] = glbSemanticProof(await fs.readFile(path.join(root, name)), label === 'original' ? undefined : label);
    assert.deepEqual(proofs.a.normalized, proofs.original.normalized, `${name}: A changes GLB semantics`);
    assert.deepEqual(proofs.b.normalized, proofs.original.normalized, `${name}: B changes GLB semantics`);
    assert.deepEqual(proofs.a.normalized, proofs.b.normalized, `${name}: A/B normalized JSON differs`);
    assert.deepEqual(proofs.a.evidence, proofs.original.evidence); assert.deepEqual(proofs.b.evidence, proofs.original.evidence);
    semanticProof[name] = { original: proofs.original.evidence, a: proofs.a.evidence, b: proofs.b.evidence, normalizedJsonDeepEqual: true, binaryChunksByteIdentical: true };
  }
  await artifact(directory, 'glb-semantic-proof.json', { marker: 'asset.extras.scene3dCacheTestVersion', files: semanticProof });
  const differences = {};
  for (const name of ['entry.mjs', 'sect_diorama.glb', 'sub_scene/library_interior.glb']) {
    differences[name] = { a: builds.a.manifest.files[name], b: builds.b.manifest.files[name] };
    assert.notEqual(differences[name].a.sha256, differences[name].b.sha256, `${name} must change bytes`);
  }
  await artifact(directory, 'version-hashes.json', differences);
  await inventory(gameRoot); // Reject any symlinks in the copied host too.
  return differences;
}
async function publish(version) {
  const built = builds[version];
  await cli(`publish-${version}`, 'publish-assets.mjs', [`--runRecord=${built.filename}`]);
  const record = await loadRunRecord(built.filename); assert.equal(record.steps['publish:assets'].status, 'succeeded');
  assert.equal(record.steps['publish:assets'].result.manifestSha256, record.steps.build.result.manifestSha256);
  await verifyRelease(path.join(record.publishRoot, built.id), built.id, record.steps.build.result.manifestSha256);
  assert.equal((await json(path.join(record.publishRoot, 'current.json'))).buildId, built.id);
  activeVersion = version; // Route the same public pointer URL to this CLI-produced pointer.
  built.immutable = await inventory(record.projectRoot);
  return { buildId: built.id, runRecord: built.filename, manifestSha256: record.steps.build.result.manifestSha256 };
}
async function cacheServer() {
  // Temporarily decorate the factory only during this owned server's creation.
  // Preserve test-server's path/host/mock checks, streaming, fault rules and cleanup.
  const createServer = http.createServer;
  http.createServer = function(listener) {
    return createServer.call(http, (req, res) => {
      const writeHead = res.writeHead;
      res.writeHead = function(status, headers) {
        const url = new URL(req.url, 'http://localhost'), versioned = /\/assets\/sect3d\/p5-cache-[ab]\//.test(url.pathname);
        const cacheControl = status === 200 && versioned ? (url.pathname.endsWith('/manifest.json') ? 'no-cache' : 'public, max-age=31536000, immutable') : 'no-store';
        transport.push({ path: url.pathname, method: req.method, status, cacheControl, at: Date.now() });
        return writeHead.call(this, status, { ...headers, 'Cache-Control': cacheControl });
      };
      const prefix = '/p5/cache/assets/sect3d/';
      if (req.url.startsWith(prefix)) {
        // One public deployment URL, two independently CLI-published physical roots.
        // No proxy, copied release, rewritten pointer, or handmade publication step.
        void (async () => {
          const parsed = new URL(req.url, 'http://localhost'), relative = decodeURIComponent(parsed.pathname.slice(prefix.length));
          if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(server.origin).host || req.method !== 'GET' || relative.includes('\\') || relative.split('/').some(p => !p || p.startsWith('.'))) {
            res.writeHead(403).end(); return;
          }
          if (parsed.pathname === faultPath) { res.writeHead(404).end(); return; }
          const version = relative === 'current.json' ? activeVersion : /^p5-cache-([ab])\//.exec(relative)?.[1];
          if (!version) { res.writeHead(404).end(); return; }
          const filename = path.join(builds[version].record.publishRoot, relative);
          const bytes = await fs.readFile(filename);
          const types = { '.json': 'application/json', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.png': 'image/png', '.wasm': 'application/wasm' };
          res.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Content-Length': bytes.length, 'X-Content-Type-Options': 'nosniff' }).end(bytes);
        })().catch(error => { transport.push({ error: error.message, path: req.url }); if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(); });
        return;
      }
      return listener(req, res);
    });
  };
  try { return await startTestServer({ gameRoot, basePath: '/p5/cache/' }); }
  finally { http.createServer = createServer; }
}
async function session(label, enabled = true) {
  const value = await newGameContext(browser, server, { payload: await json(path.join(fixturesRoot, 'saves/map.json')), channel: label, scene3dPreferences: { enabled, quality: 'low' } });
  value.label = label; value.cache = []; value.bodies = []; value.pendingBodies = []; value.cdpEvents = [];
  sessions.push(value);
  const cdp = await value.page.createCDPSession(); await cdp.send('Network.enable');
  // Puppeteer interception otherwise disables HTTP cache. Keep request isolation,
  // explicitly re-enable Chromium's cache and demand observed hits below.
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
  const urls = new Map();
  cdp.on('Network.requestWillBeSent', event => urls.set(event.requestId, event.request.url));
  cdp.on('Network.requestServedFromCache', event => value.cdpEvents.push({ requestId: event.requestId, url: urls.get(event.requestId) }));
  value.page.on('response', response => {
    if (!response.url().includes('/assets/sect3d/')) return;
    value.cache.push({ url: response.url(), status: response.status(), fromCache: response.fromCache(), headers: response.headers() });
    if (response.status() === 200 && /\/(?:entry\.mjs|sect_diorama\.glb|library_interior\.glb)$/.test(response.url()))
      value.pendingBodies.push(response.buffer().then(bytes => value.bodies.push({ url: response.url(), sha256: sha256(bytes), bytes: bytes.length })).catch(error => value.bodies.push({ url: response.url(), error: error.message })));
  });
  return value;
}
async function open(value, version) {
  await startGame(value, server); await value.page.evaluate(() => closeModal());
  if (version) {
    const diagnostics = await waitForLatestApplied(value.page, 'main');
    assert.equal(diagnostics.buildId, builds[version].id); assert.ok(diagnostics.renderer.geometries > 0 && diagnostics.renderer.frames > 0);
    await artifact(directory, `${value.label}-${version}-diagnostics.json`, diagnostics);
  } else await value.page.waitForFunction(() => window.GameSceneBridge?.getDiagnostics().started);
}
async function resources(value, version, start = 0) {
  await Promise.all(value.pendingBodies);
  const rows = value.cache.slice(start), id = builds[version].id;
  assert.ok(rows.every(row => row.url.endsWith('/current.json') || row.url.includes(`/${id}/`)), 'Mixed release responses');
  for (const name of ['entry.mjs', 'sect_diorama.glb']) {
    const url = `${server.baseUrl}assets/sect3d/${id}/${name}`;
    assert.ok(rows.some(row => row.url === url && row.status === 200), `Missing ${name} load`);
    const bodies = value.bodies.filter(row => row.url === url); assert.ok(bodies.length);
    assert.ok(bodies.every(row => row.sha256 === builds[version].manifest.files[name].sha256), `Browser bytes differ: ${name}`);
  }
  const marker = await value.page.evaluate(async url => (await import(url)).SCENE3D_CACHE_TEST_VERSION, `${server.baseUrl}assets/sect3d/${id}/entry.mjs`);
  assert.equal(marker, version);
  return rows;
}
async function config(page) {
  return page.evaluate(() => {
    const runtime = structuredClone(apiService.getConfig()), persisted = JSON.parse(localStorage.getItem('jxz_apiConfig'));
    if (runtime.endpoint !== persisted.endpoint || !runtime.endpoint.startsWith(location.origin + '/__mock/')) throw Error('Synthetic config changed');
    runtime.endpoint = persisted.endpoint = '<isolated mock channel>';
    return { runtime, persisted };
  });
}
async function original2d(value) {
  const page = value.page;
  await page.waitForFunction(() => ['#map-scene', '#map-hit-areas', '#cangjingge'].every(selector => {
    const element = document.querySelector(selector); if (!element || !element.getClientRects().length) return false;
    for (let node = element; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node); if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
  }), { timeout: 15000 });
  const visual = await page.evaluate(async () => {
    const background = getComputedStyle(document.querySelector('#map-scene')).backgroundImage;
    const match = /^url\(["']?(.*?)["']?\)$/.exec(background); if (!match) throw Error('No original background');
    const img = new Image(); img.src = match[1]; await img.decode();
    return { background, width: img.naturalWidth, height: img.naturalHeight, ready: document.querySelector('#main-viewport').dataset.scene3dReady,
      controls: ['#map-hit-areas polygon[data-location="cangjingge"]'].map(selector => ({ selector, pointerEvents: getComputedStyle(document.querySelector(selector)).pointerEvents })) };
  });
  assert.ok(visual.width > 0 && visual.height > 0); assert.notEqual(visual.ready, 'true');
  assert.ok(visual.controls.every(row => row.pointerEvents !== 'none'));
  const diagnostics = await readBridgeDiagnostics(page);
  assert.equal(diagnostics.readyScene, null);
  if (diagnostics.renderer) {
    assert.equal(diagnostics.renderer.phase, 'degraded'); assert.equal(diagnostics.renderer.ready, false); assert.equal(diagnostics.renderer.interactionEnabled, false);
    assert.equal(await page.$eval('#sect-3d-root', element => element.hidden), true);
  }
  await artifact(directory, `${value.label}-2d-visual.json`, visual); await page.screenshot({ path: path.join(directory, `${value.label}-2d.png`) });
  return visual;
}
async function trajectory(label, version) {
  const value = await session(label, !!version); await open(value, version);
  const page = value.page, initialConfig = await config(page), initial = businessProjection(await readState(page));
  if (version) { await resources(value, version); await enterFromBuildingMenu(page); await waitForLatestApplied(page, 'library'); }
  else { await original2d(value); await page.evaluate(() => goToLocation('cangjingge')); }
  const arrived = businessProjection(await readState(page));
  const { partial, committed, prompt } = await studyWithStream({ directory }, server, page, label);
  if (version) await waitForLatestApplied(page, 'library');
  await page.waitForSelector('#cangjingge-scene .back-btn', { visible: true }); await page.click('#cangjingge-scene .back-btn');
  if (version) await waitForLatestApplied(page, 'main');
  else await page.waitForFunction(() => window.__scene3dRead().userLocation === 'tianshanpai');
  const returned = businessProjection(await readState(page)), exported = await exportJson(page);
  await importJsonFile(page, await artifact(directory, `${label}-export.json`, exported));
  if (version) await waitForLatestApplied(page, 'main');
  const restored = businessProjection(await readState(page)); assert.deepEqual(await config(page), initialConfig);
  const result = { initial, arrived, partial: businessProjection(partial), committed: businessProjection(committed), returned, restored, exported, prompt, config: initialConfig };
  await artifact(directory, `${label}-trajectory.json`, result);
  assertSessionSafe(value, server, label); return result;
}
try {
  before = await protectedInputs(); await artifact(directory, 'protected-before.json', before);
  parallelBefore = await parallelObservations(); await artifact(directory, 'parallel-before.json', parallelBefore);
  report.mainPointerBefore = before.currentPublication.pointer;
  report.mainPointerHashBefore = before.currentPublication.pointerInfo.sha256;
  await step('independent-normal-cli-builds', prepare);
  await step('publish-a', () => publish('a'));
  server = await cacheServer(); browser = await launchBrowser(); report.browser = await browser.version(); report.baseUrl = server.baseUrl;
  const baseline = await step('baseline-2d-trajectory', () => trajectory('baseline-2d'));
  await step('a-business-rng-config-equivalence', async () => {
    const differences = diff(await trajectory('trajectory-a', 'a'), baseline);
    await artifact(directory, 'a-business-differences.json', differences); assert.equal(differences.length, 0, 'A trajectory differs; see a-business-differences.json');
    return { differences, includes: 'businessProjection/RNG, SSE prompt/commit, travel, export/import, config' };
  });
  const retained = await session('retained-a'), refreshed = await session('refresh-a');
  let retainedConfig, refreshConfig;
  await step('populate-and-prove-a-http-cache', async () => {
    await open(retained, 'a'); await resources(retained, 'a'); retainedConfig = await config(retained.page);
    await open(refreshed, 'a'); await resources(refreshed, 'a'); refreshConfig = await config(refreshed.page);
    const start = refreshed.cache.length, cdpStart = refreshed.cdpEvents.length;
    // Same URL document navigation, same BrowserContext, no cache clearing/bypass.
    await open(refreshed, 'a'); const rows = await resources(refreshed, 'a', start);
    const hits = rows.filter(row => row.fromCache), cdpHits = refreshed.cdpEvents.slice(cdpStart);
    for (const name of ['entry.mjs', 'sect_diorama.glb']) assert.ok(hits.some(row => row.url.endsWith('/' + name)) || cdpHits.some(row => row.url?.endsWith('/' + name)), `No actual HTTP cache hit for ${name}`);
    assert.ok(rows.filter(row => row.url.endsWith('/current.json')).every(row => !row.fromCache && row.headers['cache-control'] === 'no-store'));
    assert.deepEqual(await config(refreshed.page), refreshConfig);
    await artifact(directory, 'a-repeat-cache-hits.json', { rows, hits, cdpHits });
    return { sameUrl: refreshed.page.url(), hits, cdpHits };
  });
  await step('publish-b', () => publish('b'));
  await step('same-url-refresh-and-new-session-b', async () => {
    const url = refreshed.page.url(), start = refreshed.cache.length;
    await open(refreshed, 'b'); assert.equal(refreshed.page.url(), url);
    const rows = await resources(refreshed, 'b', start); assert.deepEqual(await config(refreshed.page), refreshConfig);
    const fresh = await session('fresh-b'); await open(fresh, 'b'); const freshRows = await resources(fresh, 'b');
    assert.deepEqual(businessProjection(await readState(fresh.page)), baseline.initial);
    assert.deepEqual(businessProjection(await readState(refreshed.page)), baseline.initial);
    return { sameUrl: url, refresh: rows, fresh: freshRows };
  });
  await step('retained-a-loads-previously-uncached-library-a', async () => {
    const library = `/assets/sect3d/${builds.a.id}/sub_scene/library_interior.glb`;
    assert.ok(!retained.cache.some(row => row.url.endsWith(library)), 'Library already visited');
    const beforeState = businessProjection(await readState(retained.page)); assert.deepEqual(beforeState, baseline.initial);
    assert.equal((await readBridgeDiagnostics(retained.page)).buildId, builds.a.id);
    const start = retained.cache.length, requestStart = retained.network.length, serverStart = transport.length;
    await enterFromBuildingMenu(retained.page); const diagnostics = await waitForLatestApplied(retained.page, 'library');
    assert.equal(diagnostics.buildId, builds.a.id);
    await Promise.all(retained.pendingBodies);
    const rows = retained.cache.slice(start), requests = retained.network.slice(requestStart).filter(row => row.action === 'allow' && row.url.includes('/assets/sect3d/'));
    assert.ok(requests.every(row => row.url.includes(`/${builds.a.id}/`)), 'Retained page fetched pointer/B');
    assert.ok(rows.some(row => row.url.endsWith(library) && !row.fromCache && row.status === 200));
    assert.ok(transport.slice(serverStart).some(row => row.path.endsWith(library) && row.status === 200));
    assert.ok(retained.bodies.some(row => row.url.endsWith(library) && row.sha256 === builds.a.manifest.files['sub_scene/library_interior.glb'].sha256));
    assert.deepEqual(businessProjection(await readState(retained.page)), baseline.arrived); assert.deepEqual(await config(retained.page), retainedConfig);
    return { diagnostics, rows, requests, uncachedLibraryReachedServer: true };
  });
  await step('b-business-rng-config-equivalence', async () => {
    const differences = diff(await trajectory('trajectory-b', 'b'), baseline);
    await artifact(directory, 'b-business-differences.json', differences); assert.equal(differences.length, 0, 'B trajectory differs; see b-business-differences.json');
    return { differences, matches: ['baseline-2d', 'trajectory-a'] };
  });
  await step('b-exact-model-404-restores-original-2d', async () => {
    // New BrowserContext has an empty cache; never clear another context's cache.
    const failed = await session('failure-b');
    const target = `assets/sect3d/${builds.b.id}/sect_diorama.glb`;
    faultPath = `/p5/cache/${target}`;
    try {
      await open(failed);
      await failed.page.waitForFunction(() => { const d = window.GameSceneBridge.getDiagnostics(); return d.errors.length > 0 && d.renderer?.phase === 'degraded' && !d.renderer.ready && !d.renderer.interactionEnabled && d.readyScene === null; }, { timeout: 90000 });
      assert.ok(failed.cache.some(row => row.url.endsWith('/' + target) && row.status === 404 && !row.fromCache));
      const diagnostics = await readBridgeDiagnostics(failed.page); assert.equal(diagnostics.buildId, builds.b.id);
      const visual = await original2d(failed);
      assert.deepEqual(businessProjection(await readState(failed.page)), baseline.initial);
      assert.deepEqual(await config(failed.page), baseline.config);
      // Use the restored original building control, not a fabricated state update.
      await failed.page.click('#map-hit-areas polygon[data-location="cangjingge"]'); await failed.page.waitForSelector('#location-info-popup.show', { visible: true });
      assert.equal(await failed.page.$eval('#location-info-popup .location-go-btn', element => element.getAttribute('onclick')), "goToLocation('cangjingge')");
      assert.deepEqual(businessProjection(await readState(failed.page)), baseline.initial);
      return { diagnostics, visual, emptyCache: 'new BrowserContext; no global clear', businessAndRngUnchanged: true, originalControlClicked: true };
    } finally { faultPath = undefined; }
  });
  await step('isolated-build-inputs-and-releases-immutable', async () => {
    for (const version of ['a', 'b']) {
      assert.deepEqual(await inventory(builds[version].record.projectRoot), builds[version].immutable);
      await verifyRelease(path.join(builds[version].record.publishRoot, builds[version].id), builds[version].id, builds[version].record.steps.build.result.manifestSha256);
    }
    return { unchanged: true };
  });
  report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.errors.push(error.stack || String(error)); console.error(error); }
finally {
  for (const value of sessions) {
    try {
      await Promise.all(value.pendingBodies); assertSessionSafe(value, server, value.label);
      await artifact(directory, `${value.label}-cache.json`, { responses: value.cache, cdpCacheEvents: value.cdpEvents, bodyHashes: value.bodies });
      await saveSessionEvidence(value, directory, value.label);
    } catch (error) { report.status = 'FAIL'; report.errors.push(error.stack || String(error)); }
    finally { try { await value.close(); } catch (error) { report.status = 'FAIL'; report.errors.push(String(error)); } }
  }
  try { if (browser) await browser.close(); } catch (error) { report.status = 'FAIL'; report.errors.push(String(error)); }
  try { if (server) { await artifact(directory, 'transport.json', { static: transport, events: server.events, requests: server.requests }); await server.close(); } } catch (error) { report.status = 'FAIL'; report.errors.push(String(error)); }
  try {
    const after = await protectedInputs(); await artifact(directory, 'protected-after.json', after);
    report.mainPointerAfter = after.currentPublication.pointer;
    report.mainPointerHashAfter = after.currentPublication.pointerInfo.sha256;
    assert.equal(report.mainPointerAfter.buildId, report.mainPointerBefore.buildId, 'Production build changed');
    assert.equal(report.mainPointerHashAfter, report.mainPointerHashBefore, 'Production pointer bytes changed');
    report.protectedDifferences = diff(after, before).map(row => row.path);
    report.mainInputsUnchanged = !!before && report.protectedDifferences.length === 0;
    assert.ok(report.mainInputsUnchanged, `Protected workspace inputs changed: ${report.protectedDifferences.join(', ')}`);
  } catch (error) { report.status = 'FAIL'; report.errors.push(error.stack || String(error)); }
  try {
    const parallelAfter = await parallelObservations(); await artifact(directory, 'parallel-after.json', parallelAfter);
    report.parallelObservations = {
      policy: 'General development docs/tests are observed separately, not production integrity gates; frozen P0 source manifest remains protected.',
      docs: { differences: parallelBefore ? diff(parallelAfter['开发文档/3D整合'], parallelBefore['开发文档/3D整合']) : null,
        attribution: 'Parent-agent parallel documentation updates authorized by direct user; this runner never writes the docs tree. Attribution comes from session authorization, not hash data.' },
      tests: { differences: parallelBefore ? diff(parallelAfter['tests/scene3d'], parallelBefore['tests/scene3d']) : null,
        attribution: 'Observed parallel test changes; not classified as production source changes or automatically attributed to a writer.' },
      wholeWorkspaceUnchangedClaimed: false
    };
    await artifact(directory, 'parallel-differences.json', report.parallelObservations);
  } catch (error) { report.parallelObservationError = String(error.stack || error); }
  report.endedAt = new Date().toISOString(); await artifact(directory, 'report.json', report);
  console.log(JSON.stringify({ status: report.status, report: path.join(directory, 'report.json'), errors: report.errors }, null, 2));
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}
