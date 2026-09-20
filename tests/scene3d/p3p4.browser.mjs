import path from 'node:path';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateSync, inflateSync } from 'node:zlib';
import { artifact, assertSessionSafe, diff, exportJson, fixturesRoot, importJsonFile, json, loadKnownAssets, newGameContext, readState, requestPolicy, saveSessionEvidence, sha256, startGame } from '../../scene3d/scripts/test-support.mjs';
import { exitIframeThroughRealControl, assertRendererPausedDuringHostOverlay } from './iframe-business.browser.mjs';
import { npcOverlap } from './npc-overlap.browser.mjs';
import { hostUi } from './host-ui.browser.mjs';
import { iframeSettlement } from './iframe-settlement.browser.mjs';

// This module is an implementation registry, not a runner. It never launches a
// browser/server or reads a real profile. Missing required branches FAIL loudly.
const IDS = 'ABCDEFGHIJKLMNO'.split('');
const ROUTES = Object.freeze({ yanwuchang: ['training', 'sub_scene/training.glb'], cangjingge: ['library', 'sub_scene/library_interior.glb'], huofang: ['kitchen', 'sub_scene/kitchen_room.glb'], houshan: ['back_mountain', 'sub_scene/back_mountain.glb'], yishiting: ['council', 'sub_scene/council_hall.glb'], tiejiangpu: ['forge', 'sub_scene/blacksmith.glb'], nandizi: ['male_quarters', 'sub_scene/male_quarters.glb'], nvdizi: ['female_quarters', 'sub_scene/female_quarters.glb'], shanmen: ['gate', 'sub_scene/gate.glb'], gongtian: ['fields', 'sub_scene/fields.glb'], danfang: ['alchemy', 'sub_scene/alchemy_room.glb'] });
const DIAGNOSTICS = () => window.GameSceneBridge.getDiagnostics();
const pixelBaselines = new WeakMap(), pickEvidence = new WeakMap();
const channelName = (ctx, name) => `${ctx.runId || 'p3p4'}-${name}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(-110);
const requests = (ctx, channel) => ctx.server.requests.filter(item => item.channel === channel);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function deadline(promise, ms, message) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), ms); })]); } finally { clearTimeout(timer); } }

function pngChunk(type, data) {
  const name = Buffer.from(type), crcInput = Buffer.concat([name, data]); let crc = 0xffffffff;
  for (const byte of crcInput) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const header = Buffer.alloc(4), tail = Buffer.alloc(4); header.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, name, data, tail]);
}
function alphaRingPng(solid = false) {
  const width = 128, height = 96, raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (1 + width * 4) + 1 + x * 4;
    const opaque = x >= 8 && x < 120 && y >= 8 && y < 88 && (solid || !(x >= 32 && x < 96 && y >= 32 && y < 64));
    raw[offset] = solid ? 0 : 255; raw[offset+1] = solid ? 255 : 0; raw[offset + 2] = 255; raw[offset + 3] = opaque ? 255 : 0;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
function screenshotPixels(png) {
  const chunks = []; let width, height, channels;
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + size);
    if (type === 'IHDR') { width = data.readUInt32BE(); height = data.readUInt32BE(4); assert.equal(data[8], 8); assert.ok([2, 6].includes(data[9])); channels = data[9] === 6 ? 4 : 3; assert.equal(data[12], 0, 'No interlaced screenshots'); }
    if (type === 'IDAT') chunks.push(data); offset += 12 + size;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels, pixels = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => { const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c); return da <= db && da <= dc ? a : db <= dc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0, up = y ? pixels[(y - 1) * stride + x] : 0, corner = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const prediction = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, corner)][filter];
      pixels[y * stride + x] = (raw[y * (stride + 1) + x + 1] + prediction) & 255;
    }
  }
  return { width, height, rgba(x, y) { const offset = (y * width + x) * channels; return [pixels[offset], pixels[offset + 1], pixels[offset + 2], channels === 4 ? pixels[offset + 3] : 255]; } };
}
async function releaseIdentity(ctx) {
  const root = ctx.gameRoot || ctx.server.root;
  assert.ok(root, 'The runner must supply the isolated gameRoot');
  const pointer = await json(path.join(root, 'assets/sect3d/current.json'));
  if (ctx.buildId) assert.equal(pointer.buildId, ctx.buildId, 'Requested buildId and published pointer must agree; never mix releases in one diagnostic');
  assert.notEqual(pointer.buildId, 'integration-002', 'integration-002 failed publication and is not a valid P3/P4 result');
  assert.notEqual(pointer.buildId, 'integration-001', 'Use the notified integration-003 or newer release');
  const bytes = await readFile(path.join(root, 'assets/sect3d', pointer.manifest));
  assert.equal(sha256(bytes), pointer.manifestSha256, 'Published manifest hash mismatch');
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.buildId, pointer.buildId);
  const identity = { buildId: pointer.buildId, manifestDirectory: path.posix.dirname(pointer.manifest), manifestSha256: pointer.manifestSha256, runId: ctx.runId, gameRoot: root, scope: 'Desktop Chromium real WebGL; fake API only; no Android certification' };
  await artifact(ctx.directory, 'p3p4-release.json', identity);
  return identity;
}
// A/D use the published animated-atlas path, not the host's /img/NPC portraits.
// Substitute only resource bytes/metadata in this test profile. Production loading,
// texture decoding, UVs, alpha raycasting and real pointer dispatch stay untouched.
async function alphaAtlasFixture(ctx, release, images) {
  const manifestPath = `/assets/sect3d/${release.manifestDirectory}/npc/generated/manifest.json`;
  const manifest = await json(path.join(ctx.gameRoot || ctx.server.root, manifestPath.slice(1)));
  const responses = new Map(), served = new Map();
  for (const [id, body] of Object.entries(images)) {
    const entry = manifest.npcs.find(npc => npc.id === id);
    assert.ok(entry, `Published NPC atlas identity missing: ${id}`);
    const image = screenshotPixels(body); assert.equal(image.width, 128); assert.equal(image.height, 96);
    const file = `npc/generated/${id}-alpha-fixture.png`;
    // The 8px transparent gutter is atlas padding. The frame is the 112x80 opaque
    // bounding box; the ring's central transparent hole remains inside that frame.
    Object.assign(entry, { sourceSize: [128, 96], bounds: [8, 8, 120, 88],
      width: 112, heightPixels: 80, cellWidth: 128, cellHeight: 96, columns: 1,
      padding: 8, anchor: [.5, 0], animated: true, frameCount: 1,
      durationMs: 1000, delays: [1000],
      sheets: [{ file, first: 0, count: 1, width: 128, height: 96 }] });
    responses.set(`/assets/sect3d/${release.manifestDirectory}/${file}`, { status: 200, contentType: 'image/png', body });
  }
  responses.set(manifestPath, { status: 200, contentType: 'application/json', body: JSON.stringify(manifest) });
  return {
    control(url) {
      if (url.origin !== ctx.server.origin) return null;
      const response = responses.get(url.pathname);
      if (response) served.set(url.pathname, (served.get(url.pathname) || 0) + 1);
      return response || null;
    },
    evidence() {
      for (const pathname of responses.keys()) assert.ok(served.get(pathname) > 0, `Production renderer did not request alpha fixture: ${pathname}`);
      return [...responses].map(([pathname, response]) => ({ pathname, requests: served.get(pathname), sha256: sha256(response.body) }));
    }
  };
}
async function payloadFor(ids = [], patch = {}, fixture = 'library') {
  const payload = await json(path.join(fixturesRoot, `saves/${fixture}.json`));
  const location = patch.userLocation || payload.gameData.userLocation;
  Object.assign(payload.gameData, { npcLocations: Object.fromEntries(IDS.map(id => [id, ids.includes(id) ? location : 'none'])), npcVisibility: Object.fromEntries(IDS.map(id => [id, true])), npcFavorability: Object.fromEntries(IDS.map(id => [id, 0])), npcGiftGiven: Object.fromEntries(IDS.map(id => [id, false])), npcSparred: Object.fromEntries(IDS.map(id => [id, false])), inputEnable: 1, currentSpecialEvent: '', ...patch });
  payload.saveName = `合成P3P4-${fixture}-${ids.join('') || 'empty'}`;
  return payload;
}
function withoutNpcFloor(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF'); assert.equal(bytes.readUInt32LE(4), 2);
  const length = bytes.readUInt32LE(12); assert.equal(bytes.toString('ascii', 16, 20), 'JSON');
  const document = JSON.parse(bytes.subarray(20, 20 + length).toString('utf8')); let removed = 0;
  for (const node of document.nodes || []) if (node.name === 'floor' || node.extras?.npcSpawn) { node.name = `fixture_no_npc_floor_${removed++}`; if (node.extras) delete node.extras.npcSpawn; }
  assert.ok(removed, 'Expected real source GLB authored NPC floor metadata');
  const text = Buffer.from(JSON.stringify(document)), padding = (4 - text.length % 4) % 4;
  const chunk = Buffer.alloc(8); chunk.writeUInt32LE(text.length + padding, 0); chunk.write('JSON', 4);
  const header = Buffer.from(bytes.subarray(0, 12)), rest = bytes.subarray(20 + length);
  const output = Buffer.concat([header, chunk, text, Buffer.alloc(padding, 32), rest]); output.writeUInt32LE(output.length, 8);
  return { output, removed, sourceSha256: sha256(bytes), fixtureSha256: sha256(output) };
}
async function installNetworkControls(session, ctx, control) {
  if (!control) return;
  const known = await loadKnownAssets();
  // Replace only this fresh session's request hook; retain its response/error logs
  // and exactly the same external-request denylist. No production hook is changed.
  session.page.removeAllListeners('request');
  session.page.on('request', async request => {
    try {
      const url = new URL(request.url());
      const policy = requestPolicy({ url: request.url(), method: request.method(), resourceType: request.resourceType() }, ctx.server.origin, known.substitutions);
      session.network.push({ method: request.method(), url: url.origin === ctx.server.origin ? url.pathname : `${url.protocol}//${url.host}${url.pathname}`, action: policy.action, controlled: true });
      if (policy.action === 'deny') { session.violations.push(request.url().split('?')[0]); await request.abort('blockedbyclient'); return; }
      if (policy.action === 'substitute') { await request.respond({ status: 200, contentType: policy.fixture.contentType, body: policy.fixture.body }); return; }
      const action = control(url, request);
      if (action?.gate) { action.seen?.resolve(url.pathname); await action.gate.promise; }
      if (action?.status) { await request.respond({ status: action.status, contentType: action.contentType || 'text/plain', body: action.body || 'intentional P3/P4 fixture response' }); return; }
      await request.continue();
    } catch (error) {
      if (/Invalid [Ii]nterceptionId|No resource with given identifier|Target closed|Session closed|Request is already handled/.test(error.message)) session.network.push({ event: 'controlled-request-cancelled', message: error.message });
      else if (!session.page.isClosed()) session.violations.push(`Test request hook: ${error.message}`);
    }
  });
}
async function withGame(ctx, label, options, work) {
  const channel = channelName(ctx, label);
  const payload = options.payload || await payloadFor();
  const session = await newGameContext(ctx.browser, ctx.server, { payload, channel, style: options.style ?? 0 });
  session.channel = channel; session.apiChannels = [channel];
  if (options.baseline) pixelBaselines.set(session.page, options.baseline);
  pickEvidence.set(session.page, []);
  await installNetworkControls(session, ctx, options.control);
  await session.page.evaluateOnNewDocument(({ origin, enabled }) => {
    if (location.origin === origin && window.top === window) localStorage.setItem('jxz_scene3d_preferences_v1', JSON.stringify({ schema: 2, enabled, quality: 'low' }));
  }, { origin: ctx.server.origin, enabled: options.enabled !== false });
  try {
    await startGame(session, ctx.server);
    await session.page.evaluate(() => closeModal());
    await session.page.waitForFunction(() => window.GameSceneBridge?.getDiagnostics().started);
    if (ctx.buildId) {
      const published=await json(path.join(ctx.gameRoot || ctx.server.root,'assets/sect3d/current.json'));
      assert.equal(published.buildId,ctx.buildId,'Every profile must keep the requested published release');
      // Cold Gal/disabled 3D must not fetch runtime just to satisfy the test.
      const initial=await readState(session.page);
      if(options.enabled!==false && initial.GameMode===0 && initial.inputEnable!==0) {
        await session.page.waitForFunction(()=>!!GameSceneBridge.getDiagnostics().buildId,{timeout:30000});
        assert.equal((await diag(session.page)).buildId,ctx.buildId,'Mounted renderer must match requested release');
      }
    }
    if (options.causal) await installNpcCausalObserver(session.page);
    const result = await work(session);
    for (const usedChannel of session.apiChannels) assertSessionSafe(session, ctx.server, usedChannel);
    return result;
  } finally {
    if (!session.page.isClosed()) { try { await artifact(ctx.directory, `${label}-diagnostics.json`, await diag(session.page)); } catch (error) { await artifact(ctx.directory, `${label}-diagnostics-error.txt`, error.message); } }
    if(options.causal && !session.page.isClosed()) {
      const events=await session.page.evaluate(()=>{const p=window.__npcCausalProbe;if(!p)return [];p.cleanup();delete window.__npcCausalProbe;return p.events;});
      await artifact(ctx.directory, `${label}-causal-events.json`, events);
    }
    await artifact(ctx.directory, `${label}-pick-search.json`, pickEvidence.get(session.page) || []);
    await saveSessionEvidence(session, ctx.directory, label); await session.close();
  }
}
async function diag(page) { return page.evaluate(DIAGNOSTICS); }
async function waitReady(page, location, npcs = true) {
  const sceneId = location === 'tianshanpai' || location === 'map' ? 'main' : ROUTES[location]?.[0];
  assert.ok(sceneId, `Unknown test route ${location}`);
  await page.waitForFunction((target, checkNpcs) => {
    const d = window.GameSceneBridge?.getDiagnostics(), r = d?.renderer;
    return d?.readyScene === target && r?.ready && r.activeSceneId === target && r.frames > 0 && r.width > 0 && r.height > 0 &&
      (!checkNpcs || !r.npc?.pendingLoads) && document.querySelector('#main-viewport')?.dataset.scene3dReady === 'true';
  }, { timeout: 120000 }, sceneId, npcs);
  const d = await diag(page), state = await readState(page);
  assert.equal(state.userLocation, location === 'map' ? 'tianshanpai' : location);
  assert.equal(d.snapshot.sceneId, sceneId); assert.equal(d.renderer.renderers, 1); assert.equal(d.renderer.canvases, 1);
  assert.ok(d.renderer.geometries > 0, 'Ready must own real GLB geometries');
  assert.equal(d.renderer.quality, 'low'); assert.equal(d.renderer.dpr, 1); assert.equal(d.renderer.postprocessing, 0);
  assert.ok(d.renderer.cachedRooms <= 1);
  if (npcs && sceneId !== 'main') {
    const selected = d.snapshot.renderedNpcs.map(n => n.gameNpcId);
    assert.equal(d.renderer.npc.cards + d.renderer.npc.fallbacks.length, selected.length);
    assert.deepEqual([...d.renderer.npc.residents.map(n => n.gameNpcId), ...d.renderer.npc.fallbacks.map(n => n.gameNpcId)].sort(), [...selected].sort());
  }
  return d;
}
async function capture(ctx, page, name) {
  const state = await readState(page), diagnostics = await diag(page);
  const bytes = await page.screenshot({ path: path.join(ctx.directory, `${name}.png`) });
  await artifact(ctx.directory, `${name}.json`, { state, diagnostics, screenshotSha256: sha256(bytes) });
  return { state, diagnostics, screenshotSha256: sha256(bytes) };
}
async function importPayload(ctx, page, name, payload) {
  const filename = await artifact(ctx.directory, `${name}-fixture.json`, payload);
  await importJsonFile(page, filename);
  // Shared chooser helper closes importSave's toggled history menu. Conditional
  // fallback keeps this wrapper safe with older helpers without toggling twice.
  if (await page.$('#history-dropdown.show')) await stableClick(await page.$('.dropdown-toggle[onclick*="history-dropdown"]'));
  await page.waitForFunction(() => !document.querySelector('.dropdown-menu.show'));
  const state=await readState(page),diagnostics=await diag(page);
  if(diagnostics.preferences.enabled && state.GameMode===0 && state.inputEnable!==0) await waitReady(page,state.userLocation);
  return readState(page);
}
async function advanceBusinessClock(page) {
  // The shared bootstrap freezes business time. Advance explicitly between
  // transactions, not by render time, so original Date.now() IDs remain unique.
  await page.evaluate(() => { const next = Date.now() + 1000; Date.now = () => next; });
}
async function waitSurfaceStable(page) {
  await page.$eval('.scene3d-canvas', async canvas => {
    const animations = []; for (let node = canvas; node; node = node.parentElement) animations.push(...node.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity));
    await Promise.all(animations.map(a => a.finished.catch(() => {})));
  });
  await quietFrames(page, 2);
}
async function quietFrames(page, count = 12) {
  await page.evaluate(n => new Promise(resolve => { let i = 0; const frame = () => ++i >= n ? resolve() : requestAnimationFrame(frame); requestAnimationFrame(frame); }), count);
}
async function assertPaused(page) {
  await page.waitForFunction(() => { const r = window.GameSceneBridge.getDiagnostics().renderer; return !r || (r.raf === 0 && !r.interactionEnabled); }, { timeout: 10000 });
  const before = await diag(page); await quietFrames(page, 18); const after = await diag(page);
  assert.equal(after.renderer?.frames ?? 0, before.renderer?.frames ?? 0, 'Renderer must really stop drawing beneath host UI');
  return { before, after };
}
async function menuText(page) { return page.$eval('.scene3d-menu', element => element.textContent); }
async function closeMenu(page) {
  // 关闭按钮已移除：点弹窗外自然关闭（与游戏交互一致）。
  if (await page.$('.scene3d-menu')) await page.evaluate(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  await page.waitForFunction(() => !document.querySelector('.scene3d-menu'));
}
async function stableClick(element) {
  assert.ok(element, 'Expected a real clickable element');
  await element.scrollIntoView();
  await element.evaluate(async node => {
    await document.fonts?.ready;
    const root = node.closest('.modal-content') || node;
    await Promise.all(root.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
  });
  const target = await element.evaluate(node => { const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { reachable: hit === node || node.contains(hit), target: hit?.outerHTML?.slice(0, 250) }; });
  assert.ok(target.reachable, `Original UI button center is obstructed: ${target.target}`);
  await element.click(); // real CDP mouse, after the existing .3s entrance animation, never HTMLElement.click()
}
async function clickText(pageOrFrame, selector, text) {
  const elements = await pageOrFrame.$$(selector);
  for (const element of elements) if ((await element.evaluate(node => node.textContent)).includes(text)) { await stableClick(element); return; }
  throw Error(`Missing actual clickable ${selector}: ${text}`);
}
async function canvasRect(page) { return page.$eval('.scene3d-canvas', node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; }); }
async function npcPixelBaseline(ctx, style = 0) {
  return withGame(ctx, `p3-pixel-baseline-${style}`, { style, payload: await payloadFor([], { uiStyle: style }) }, async session => {
    await waitReady(session.page, 'cangjingge'); const rect = await canvasRect(session.page);
    const png = Buffer.from(await session.page.screenshot({ path: path.join(ctx.directory, `p3-empty-baseline-${style}.png`) }));
    return { rect, image: screenshotPixels(png), sha256: sha256(png) };
  });
}
async function openNpc(page, id, coordinates = null) {
  await page.waitForFunction(() => window.GameSceneBridge.getDiagnostics().renderer?.interactionEnabled, { timeout: 30000 });
  const d = await diag(page), expected = d.snapshot.residents.find(n => n.gameNpcId === id)?.displayName;
  assert.ok(expected, `NPC ${id} must really be resident`);
  const fallback = await page.$(`.scene3d-npc-fallback-button[data-game-npc-id="${id}"]`);
  if (fallback) { await fallback.click(); await page.waitForSelector('.scene3d-menu'); assert.match(await menuText(page), new RegExp(expected)); return { kind: 'fallback', id }; }
  await waitSurfaceStable(page);
  const anchor = (await diag(page)).renderer?.npc?.residents.find(n => n.gameNpcId === id)?.anchor;
  assert.ok(anchor && anchor.width > 0 && anchor.height > 0, `NPC ${id} requires a pure diagnostic anchor; no viewport raster fallback`);
  const points = [], faultCoordinates = { C: { x: 245, y: 159 }, A: { x: 231, y: 147 } };
  for (let y = Math.ceil(anchor.top + 1); y < anchor.top + anchor.height - 1; y += 2) for (let x = Math.ceil(anchor.left + 1); x < anchor.left + anchor.width - 1; x += 2) points.push({x,y});
  points.sort((a,b) => Math.hypot(a.x-anchor.left-anchor.width/2,a.y-anchor.top-anchor.height*.55)-Math.hypot(b.x-anchor.left-anchor.width/2,b.y-anchor.top-anchor.height*.55));
  const search = { id, epoch:d.epoch, anchor, source:'real pointer input bounded to pure diagnostic anchor',hit:null };
  if (coordinates && coordinates.x >= anchor.left && coordinates.x <= anchor.left+anchor.width && coordinates.y >= anchor.top && coordinates.y <= anchor.top+anchor.height) points.unshift(coordinates);
  search.candidates = points.length; pickEvidence.get(page)?.push(search);
  const canvasPoints = await page.evaluate(candidates => candidates.filter(point => document.elementFromPoint(point.x, point.y)?.matches('.scene3d-canvas')), points);
  search.canvasCandidates = canvasPoints.length;
  search.actualPointerClicks = 0;
  search.blockedAtDispatch = 0;
  for (const point of canvasPoints) {
    if (!await page.evaluate(p => document.elementFromPoint(p.x,p.y)?.matches('.scene3d-canvas'),point)) { search.blockedAtDispatch++; continue; }
    await page.mouse.click(point.x, point.y);
    search.actualPointerClicks++;
    const title = await page.evaluate(() => document.querySelector('.scene3d-menu .location-info-name, .scene3d-menu .npc-info-name')?.textContent || null);
    if (title === expected) { search.hit = { ...point }; return { kind: 'canvas', id, ...point }; }
    if (title) { await closeMenu(page); await page.waitForFunction(() => window.GameSceneBridge.getDiagnostics().renderer?.interactionEnabled); }
  }
  const probe = faultCoordinates[id] ? await page.evaluate(({ x, y }) => {
    const describe = node => { if (!node) return null; const style = getComputedStyle(node); const box = node.getBoundingClientRect(); return { tag: node.tagName, id: node.id, className: node.className, pointerEvents: style.pointerEvents, zIndex: style.zIndex, display: style.display, visibility: style.visibility, opacity: style.opacity, rect: { x: box.x, y: box.y, width: box.width, height: box.height }, text: node.textContent?.slice(0, 120) }; };
    return {
      point: { x, y },
      elements: document.elementsFromPoint(x, y).map(describe),
      masks: [...document.querySelectorAll('.slg-interaction-mask')].map(describe),
      canvas: describe(document.querySelector('.scene3d-canvas')),
      activeScene: document.querySelector('.scene.active')?.id || null
    };
  }, faultCoordinates[id]) : null;
  if (probe) { search.probe = probe; pickEvidence.get(page)?.push({ id, type: 'targeted-overlay-probe', ...probe }); }
  throw Error(`NPC ${id} exists in diagnostics but no opaque canvas/fallback click could open its menu (${points.length} candidates, ${canvasPoints.length} initially on canvas, ${search.actualPointerClicks} actual pointer clicks, ${search.blockedAtDispatch} blocked before dispatch)${probe ? `; targeted overlay probe captured at ${probe.point.x},${probe.point.y}` : ''}`);
}
async function fullResponse(sideNote = {}, text = '合成P3P4受控回复') {
  const content = `<MAIN_TEXT>${text}。|none|藏经阁|none|none</MAIN_TEXT><SUMMARY>第2周，完成合成测试。</SUMMARY><SIDE_NOTE>${JSON.stringify({ 时间: '09:30', 用户: { 位置变动: 'none' }, ...sideNote })}</SIDE_NOTE>`;
  return { status: 200, headers: { 'Content-Type': 'text/event-stream' }, steps: [{ body: `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n` }], terminal: 'end' };
}
async function runTurn(ctx, session, fixture, { message = '合成P3P4测试行动', failure = false, abort = false, checkpoint = null, expectedRequests = 1, hostEntry = false } = {}) {
  const before = await readState(session.page), epochBefore = (await diag(session.page)).epoch, count = requests(ctx, session.channel).length;
  const autoSavesBefore = await session.page.evaluate(() => storageService.listSaves().filter(slot => slot.saveName?.startsWith('[自动]')));
  for (let n = 0; n < expectedRequests; n++) ctx.server.enqueue(session.channel, fixture);
  await session.page.evaluate(({text,hostEntry}) => { window.__scene3dTest.turnDone = false; window.__scene3dTest.turnError = null; (hostEntry ? handleMessageOutput(text) : pipeline.runTurn(text)).then(() => { window.__scene3dTest.turnDone = true; }, error => { window.__scene3dTest.turnError = error.message; window.__scene3dTest.turnDone = true; }); }, {text:message,hostEntry});
  const requestIndex = ctx.server.requests.length;
  if (abort) {
    await ctx.server.waitFor(event => event.channel === session.channel && event.type === 'await-abort' && event.index >= requestIndex - 1);
    await session.page.waitForFunction(() => window.__scene3dRead().streaming);
    await session.page.evaluate(() => pipeline.abortCurrentTurn());
    await ctx.server.waitFor(event => event.channel === session.channel && event.type === 'abort');
  }
  if (checkpoint) {
    await ctx.server.waitFor(event => event.channel === session.channel && event.type === 'waiting');
    await session.page.waitForFunction(() => window.__scene3dRead().currentStoryText.includes('合成流式第一段'));
    await assertPaused(session.page);
    await artifact(ctx.directory, `${session.channel}-${count}-partial.json`, await readState(session.page));
    await ctx.server.release(session.channel, checkpoint);
  }
  await session.page.waitForFunction(() => window.__scene3dTest.turnDone, { timeout: 60000 });
  const error = await session.page.evaluate(() => window.__scene3dTest.turnError);
  if (!failure) assert.equal(error, null, `Unexpected pipeline failure: ${error}`); else assert.ok(error, 'Injected HTTP failure must surface');
  assert.equal(requests(ctx, session.channel).length, count + expectedRequests, 'Controlled transaction must match the original HTTP request/fallback count');
  const after = await readState(session.page);
  await session.page.evaluate(() => closeModal());
  return { before, after, epochBefore, epochAfter: (await diag(session.page)).epoch, autoSavesBefore, autoSavesAfter: await session.page.evaluate(() => storageService.listSaves().filter(slot => slot.saveName?.startsWith('[自动]'))), error, prompt: requests(ctx, session.channel).at(-1).body };
}
async function compareTrajectories(ctx, name, two, three) {
  const differences = diff(three, two);
  await artifact(ctx.directory, `${name}-2d-vs-3d.json`, { two, three, differences, ignoredPaths: [] });
  assert.deepEqual(differences, [], `${name}: business state/prompt/RNG differs between 2D and 3D`);
}
async function incomplete(ctx, id, missing, evidence) {
  await artifact(ctx.directory, `${id}-coverage.json`, { status: 'INCOMPLETE', implementedEvidence: evidence, missing, manual: id === 'P3-T05' ? ['Actual Android touch/body/transparent-edge recording is not desktop emulation'] : [] });
  throw Error(`${id} INCOMPLETE (not PASS/skip): ${missing.join('; ')}`);
}

export async function locations(ctx) {
  await releaseIdentity(ctx); const traces = [], coverage = [];
  for (const enabled of [false, true]) {
    traces.push(await withGame(ctx, `p3t01-${enabled}`, { enabled, payload: await payloadFor([], {}, 'map') }, async session => {
      const trace = [];
      if (enabled) await waitReady(session.page, 'tianshanpai');
      for (const location of Object.keys(ROUTES)) {
        await session.page.evaluate(id => goToLocation(id), location);
        if (enabled) { const d = await waitReady(session.page, location); coverage.push({ location, sceneId: d.renderer.activeSceneId, sourceGlb: ROUTES[location][1] }); await capture(ctx, session.page, `p3t01-${location}`); }
        const state = await readState(session.page); assert.equal(state.logicalPage, location); trace.push(state);
        await session.page.evaluate(() => backToMap());
        if (enabled) await waitReady(session.page, 'tianshanpai');
        assert.equal((await readState(session.page)).logicalPage, 'map'); trace.push(await readState(session.page));
      }
      for (const location of Object.keys(ROUTES)) { await session.page.evaluate(id => goToLocation(id), location); if (enabled) await waitReady(session.page, location); trace.push(await readState(session.page)); }
      if (enabled) {
        const before = await readState(session.page);
        await session.page.evaluate(() => GameSceneBridge.showLocationInfoAtAnchor('guest_quarters', { space: 'client-css-px', left: 100, top: 100, width: 0, height: 0 }));
        assert.equal(await session.page.$('.scene3d-menu'), null); assert.deepEqual(await readState(session.page), before);
        for (const [, file] of Object.values(ROUTES)) assert.ok(session.network.some(item => item.event === 'response' && item.status === 200 && item.url.endsWith(file)), `Missing real GLB HTTP200 ${file}`);
      }
      assert.equal(requests(ctx, session.channel).length, 0); return trace;
    }));
  }
  await compareTrajectories(ctx, 'p3t01', traces[0], traces[1]); await artifact(ctx.directory, 'p3t01-coverage.json', coverage);
  assert.equal(new Set(coverage.map(item => item.sceneId)).size, 11);
  return { destinations: 11, mapDistinctFromGate: true, directAToB: 11, guestBusinessIntentRejected: true };
}

export async function identities(ctx) {
  await releaseIdentity(ctx); const coverage = [], failures = [];
  for (const style of [0, 1]) {
    const baseline = await npcPixelBaseline(ctx, style);
    try { await withGame(ctx, `p3t02-style${style}`, { style, baseline, causal: true, payload: await payloadFor(['A']) }, async session => {
    for (const id of IDS) { try {
      session.channel = channelName(ctx, `p3t02-${style}-${id}`); session.apiChannels.push(session.channel);
      await session.page.evaluate(endpoint => apiService.updateConfig({ endpoint }), `${ctx.server.origin}/__mock/${session.channel}`);
      await importPayload(ctx, session.page, `p3t02-${style}-${id}`, await payloadFor([id], { uiStyle: style, playerStats: { 武学: 20, 学识: 20, 声望: 20, 金钱: 2000 } }));
      const d = await waitReady(session.page, 'cangjingge');
      assert.deepEqual(d.snapshot.renderedNpcs.map(n => n.gameNpcId), [id]);
      const animated = ['B', 'C', 'I'].includes(id);
      if (animated) {
        assert.equal(d.renderer.npc.cards, 1, `${id} must use its real packaged atlas, not a fallback`);
        const frames = new Set(); for (let n = 0; n < 10; n++) { await quietFrames(session.page, 5); frames.add((await diag(session.page)).renderer.npc.residents[0].frame); }
        assert.ok(frames.size > 1, `${id} animation frame must advance`);
        assert.ok(session.network.some(item => item.event === 'response' && item.status === 200 && /npc\/generated\/.*\.png$/.test(item.url)), 'Actual atlas PNG must load');
      }
      const before = await readState(session.page), hit = await openNpc(session.page, id), text = await menuText(session.page);
      assert.ok(text.includes('切磋') && text.includes('互动')); assert.equal(text.includes('送礼'), style === 0);
      assert.deepEqual(await readState(session.page), before, 'Opening NPC info must not change business or RNG');
      await capture(ctx, session.page, `p3t02-${style}-${id}-menu`);
      if (style === 0) {
        await clickText(session.page, '.scene3d-menu button', '送礼');
        await session.page.waitForFunction(npcId => npcGiftGiven[npcId] === true, {}, id);
        const gift = await readState(session.page); assert.equal(gift.playerStats.金钱, before.playerStats.金钱 - 500); assert.equal(gift.npcFavorability[id], before.npcFavorability[id] + 5);
        await session.page.evaluate(() => closeModal()); await waitReady(session.page, 'cangjingge'); await openNpc(session.page, id, hit.kind === 'canvas' ? hit : null);
        const giftButton = await session.page.$('.scene3d-menu button:disabled'); assert.ok(giftButton, 'Gift must be disabled after one settlement');
        assert.ok((await menuText(session.page)).includes('已送礼')); await closeMenu(session.page);
      } else await closeMenu(session.page);
      await waitReady(session.page, 'cangjingge'); await openNpc(session.page, id, hit.kind === 'canvas' ? hit : null);
      await clickText(session.page, '.scene3d-menu button', '互动');
      await session.page.waitForSelector('#interaction-input', { visible: true });
      const name = d.snapshot.residents[0].displayName;
      assert.ok((await session.page.$eval('#modal-text', element => element.textContent)).includes(name));
      // Sending uses the original host interaction entry and the controlled HTTP server.
      const count = requests(ctx, session.channel).length; ctx.server.enqueue(session.channel, await fullResponse({}, `与${name}完成合成互动`));
      await session.page.type('#interaction-input', `合成测试：向${name}问好`);
      await stableClick(await session.page.$('#modal-buttons button[onclick="sendInteraction()"]'));
      await session.page.waitForFunction(() => !window.__scene3dRead().streaming && window.__scene3dRead().uiConversation.at(-1)?.content.includes('完成合成互动'), { timeout: 60000 });
      assert.equal(requests(ctx, session.channel).length, count + 1); const prompt = requests(ctx, session.channel).at(-1).body;
      assert.ok(JSON.stringify(prompt.messages).includes(name), 'Original Chinese game identity must reach the prompt');
      assert.ok(!JSON.stringify(prompt.messages).includes(`npc:${({ B: 'dongting', C: 'qiantang', I: 'anmu' })[id] || 'undefined'}`));
      await session.page.evaluate(() => closeModal()); await waitReady(session.page, 'cangjingge'); await openNpc(session.page, id, hit.kind === 'canvas' ? hit : null);
      const sparCount = requests(ctx, session.channel).length; ctx.server.enqueue(session.channel, await fullResponse({}, `与${name}完成合成切磋退出`));
      await clickText(session.page, '.scene3d-menu button', '切磋');
      await session.page.waitForFunction(() => document.querySelector('#battle-iframe')?.contentDocument?.readyState === 'complete' && document.querySelector('#battle-iframe')?.getAttribute('src'), { timeout: 30000 });
      const battle = await (await session.page.$('#battle-iframe')).contentFrame(); assert.ok(battle);
      await battle.waitForFunction(() => typeof confirmExitBattle === 'function');
      await assertPaused(session.page);
      // Exercise the real iframe confirmation and its own postMessage, never
      // fabricate a parent message or inject a battle result/gameData mutation.
      await battle.evaluate(() => confirmExitBattle());
      await battle.click('[onclick="exitBattle(\'quit\')"]');
      await session.page.waitForFunction(npcId => npcSparred[npcId] === true && !window.__scene3dRead().streaming && window.__scene3dRead().uiConversation.at(-1)?.content.includes('完成合成切磋退出'), { timeout: 60000 }, id);
      assert.equal(requests(ctx, session.channel).length, sparCount + 1);
      assert.ok(JSON.stringify(requests(ctx, session.channel).at(-1).body.messages).includes(name));
      await session.page.evaluate(() => closeModal()); await waitReady(session.page, 'cangjingge'); await openNpc(session.page, id, hit.kind === 'canvas' ? hit : null);
      const settled = await readState(session.page), sparButton = await session.page.$('.scene3d-menu button:disabled'); assert.ok(sparButton);
      assert.ok((await menuText(session.page)).includes('已切磋'));
      await clickText(session.page, '.scene3d-menu button', '已切磋');
      assert.deepEqual(await readState(session.page), settled); assert.equal(requests(ctx, session.channel).length, sparCount + 1);
      await closeMenu(session.page);
      coverage.push({ id, style, hit, animated, interactionRequest: count, sparRequest: sparCount, sparOutcome: 'real-iframe-quit', ChineseName: name, giftChecked: style === 0 });
    } catch (error) {
      failures.push({ id, style, error: error.stack }); await capture(ctx, session.page, `p3t02-${style}-${id}-failure`);
      // Continue all identities rather than treating the first blocked sprite as
      // coverage of the other fourteen; every failure remains fatal at the end.
      await session.page.evaluate(() => { closeModal(); closeAllSpecialModals(); });
      if (await session.page.$('.scene3d-menu')) await closeMenu(session.page);
    } }
  }); } catch (error) { failures.push({ scope: 'session', style, error: error.stack }); }
  }
  await artifact(ctx.directory, 'p3t02-identities.json', { coverage, failures });
  assert.deepEqual(failures, [], 'Every identity/theme branch must pass; failed branches are recorded, not skipped');
  assert.equal(coverage.length, 30);
  return { identities: 15, themes: 2, ChinesePromptChecks: 60, sparringOutcome: 'Actual iframe quit (marks weekly sparring exactly once); not a victory-reward test', coverage };
}

export async function refreshRules(ctx) {
  await releaseIdentity(ctx); const traces = [];
  const payload = await payloadFor(['B', 'C', 'D', 'F']);
  payload.gameData.npcVisibility.O = false; payload.gameData.npcLocations.O = 'none';
  for (const enabled of [false, true]) traces.push(await withGame(ctx, `p3t03-${enabled}`, { enabled, payload }, async session => {
    if (enabled) await waitReady(session.page, 'cangjingge'); const states = [];
    for (let i = 0; i < 5; i++) {
      const before = await readState(session.page); await session.page.evaluate(() => refreshNpcLocations());
      if (enabled) { await waitReady(session.page, 'cangjingge'); await quietFrames(session.page); }
      const after = await readState(session.page); assert.equal(after.userLocation, 'cangjingge');
      for (const id of IDS.filter(id => before.currentNpcLocations[id] === 'cangjingge')) assert.equal(after.currentNpcLocations[id], 'cangjingge', `Current-place NPC ${id} must be retained`);
      assert.equal(after.currentNpcLocations.O, 'none'); states.push(after);
    }
    return { states, nextBusinessRandom: await session.page.evaluate(() => Math.random()) };
  }));
  await compareTrajectories(ctx, 'p3t03', traces[0], traces[1]);
  await withGame(ctx, 'p3t03-conflict', { payload: await payloadFor(['A']) }, async session => {
    await waitReady(session.page, 'cangjingge');
    for (const conflict of ['hidden', 'unknown']) {
      const invalid = await payloadFor(conflict === 'hidden' ? ['A'] : []);
      if (conflict === 'hidden') invalid.gameData.npcVisibility.A = false;
      else invalid.gameData.npcLocations.Z = 'cangjingge';
      await importPayload(ctx, session.page, `p3t03-${conflict}-resident`, invalid);
      await waitReady(session.page, 'cangjingge');
      const state = await readState(session.page);
      if (conflict === 'hidden') { assert.equal(state.currentNpcLocations.A, 'cangjingge'); assert.equal(state.npcVisibility.A, false); }
      else assert.equal(state.currentNpcLocations.Z, 'cangjingge', 'Adapter must not silently repair the unknown business identity');
      const filtered=await diag(session.page);
      assert.equal(filtered.readyScene, 'library'); assert.equal(filtered.snapshot.rosterError, false);
      assert.deepEqual(filtered.snapshot.residents, []); assert.deepEqual(filtered.snapshot.renderedNpcs, []);
      assert.equal(filtered.renderer.npc.cards, 0);
      await capture(ctx, session.page, `p3t03-filtered-${conflict}`);
    }
  });
  return { refreshesPerLane: 5, fullStateAndRngDiff: 0, hiddenResidentExcludedWithoutBusinessMutation: true };
}

export async function crowdingAndFailure(ctx) {
  const release = await releaseIdentity(ctx); const coverage = [];
  for (const count of [0, 1, 2, 3, 4, 15]) await withGame(ctx, `p3t04-count${count}`, { payload: await payloadFor(IDS.slice(0, count)) }, async session => {
    const d = await waitReady(session.page, 'cangjingge');
    assert.equal(d.snapshot.residents.length, count); assert.equal(d.snapshot.renderedNpcs.length, count);
    assert.deepEqual(d.snapshot.renderedNpcs.map(n => n.gameNpcId).sort(), IDS.slice(0,count).sort());
    const original2d=(await readState(session.page)).visibleNpcIds;
    assert.equal(original2d.length, Math.min(3,count), 'Original 2D portrait cap remains unchanged');
    assert.ok(original2d.every(id=>d.snapshot.renderedNpcs.some(n=>n.gameNpcId===id)));
    assert.equal(d.renderer.npc.cards,count); assert.deepEqual(d.renderer.npc.fallbacks,[]);
    const before = await readState(session.page), layout = d.renderer.npc.residents.map(({ gameNpcId, foot }) => ({ gameNpcId, foot })), loads = d.renderer.npc.loads;
    for (let i = 0; i < 4; i++) { await session.page.evaluate(() => GameSceneBridge.notify('test-same-state', true)); await quietFrames(session.page); }
    const after = await diag(session.page); assert.equal(after.renderer.npc.loads, loads); assert.deepEqual(after.renderer.npc.residents.map(({ gameNpcId, foot }) => ({ gameNpcId, foot })), layout); assert.deepEqual(await readState(session.page), before);
    coverage.push({ count, selected: d.snapshot.renderedNpcs.map(n => n.gameNpcId), rendered: after.renderer.npc }); await capture(ctx, session.page, `p3t04-count${count}`);
  });
  let failAtlas = true;
  await withGame(ctx, 'p3t04-atlas404', { payload: await payloadFor(['B']), control: url => failAtlas && /\/npc\/generated\/.*\.png$/.test(url.pathname) ? { status: 404 } : null }, async session => {
    const d = await waitReady(session.page, 'cangjingge'); assert.equal(d.renderer.npc.cards, 0); assert.deepEqual(d.renderer.npc.fallbacks.map(n => n.gameNpcId), ['B']);
    const before = await readState(session.page); const hit = await openNpc(session.page, 'B'); assert.equal(hit.kind, 'fallback'); await closeMenu(session.page);
    assert.deepEqual(await readState(session.page), before); assert.equal(requests(ctx, session.channel).length, 0);
    await capture(ctx, session.page, 'p3t04-atlas-fallback'); failAtlas = false;
    await session.page.evaluate(() => GameSceneBridge.retry()); await waitReady(session.page, 'cangjingge');
    assert.equal((await diag(session.page)).renderer.npc.cards, 1); assert.deepEqual(await readState(session.page), before, 'Atlas retry must not redraw the business roster');
  });
  const floorless = withoutNpcFloor(await readFile(path.join(ctx.gameRoot || ctx.server.root, 'assets/sect3d', release.manifestDirectory, 'sub_scene/library_interior.glb')));
  await artifact(ctx.directory, 'p3t04-floorless-fixture.json', { removedFloorMetadata: floorless.removed, sourceSha256: floorless.sourceSha256, fixtureSha256: floorless.fixtureSha256, mutation: 'Only node floor name/npcSpawn metadata; original real geometry/material/BIN bytes retained' });
  await withGame(ctx, 'p3t04-placement-failure', { payload: await payloadFor(['A', 'B', 'C']), control: url => url.pathname.endsWith('/sub_scene/library_interior.glb') ? { status: 200, contentType: 'model/gltf-binary', body: floorless.output } : null }, async session => {
    const d = await waitReady(session.page, 'cangjingge'); assert.equal(d.renderer.npc.cards, 0);
    assert.deepEqual(d.renderer.npc.fallbacks.map(n => n.gameNpcId), d.snapshot.renderedNpcs.map(n => n.gameNpcId));
    assert.ok(d.renderer.npc.fallbacks.every(n => n.reason === 'NPC_FLOOR_MISSING'));
    const before = await readState(session.page);
    for (const id of ['A', 'B', 'C']) { assert.equal((await openNpc(session.page, id)).kind, 'fallback'); await closeMenu(session.page); }
    assert.deepEqual(await readState(session.page), before); assert.equal(requests(ctx, session.channel).length, 0);
    await capture(ctx, session.page, 'p3t04-placement-failure');
  });
  await artifact(ctx.directory, 'p3t04-crowding.json', coverage);
  return { counts: [0, 1, 2, 3, 4, 15], atlas404SameIdentityFallbackAndRetry: true, realGlbMissingFloorSameSubsetFallback: true, duplicateProjectionNoRngOrLayoutMutation: true };
}

export async function npcOverlapDiagnostic(ctx) {
  const release=await releaseIdentity(ctx);
  const ring=alphaRingPng(),solid=alphaRingPng(true);
  const atlas=await alphaAtlasFixture(ctx,release,{pozhenzi:ring,xiaobaihu:solid});
  return withGame(ctx,'p3-overlap',{payload:await payloadFor(['A','D']),control:atlas.control},async session=>{
    const page=session.page;await waitReady(page,'cangjingge');await waitSurfaceStable(page);
    await artifact(ctx.directory,'p3-overlap-atlas-fixture.json',atlas.evidence());
    const attempts=[];
    for(let step=0;step<320;step++) {
      if(step>0 && step%40===0) {
        await importPayload(ctx,page,`overlap-normal-save-${step/40}`,await payloadFor(['A','D']));
        await waitReady(page,'cangjingge');await waitSurfaceStable(page);
      }
      const d=await diag(page),a=d.renderer.npc.residents.find(n=>n.gameNpcId==='A'),b=d.renderer.npc.residents.find(n=>n.gameNpcId==='D');
      assert.ok(a?.anchor&&b?.anchor,'Both real cards must expose nonempty projected anchors');
      const ar=a.anchor,br=b.anchor,scale=ar.height/(a.height*Math.SQRT1_2);
      // Locked 45-degree interior pitch: camera depth differs by sqrt(2)*worldY
      // minus projected-up. This uses pure foot/anchor diagnostics only.
      const depth=n=>Math.SQRT2*n.foot[1]+(n.anchor.top+n.anchor.height)/scale;
      const front=depth(a)>depth(b)+.02;
      const image=screenshotPixels(Buffer.from(await page.screenshot()));let hole=null,body=null;
      for(let y=Math.ceil(Math.max(ar.top,br.top)+2);y<Math.min(ar.top+ar.height,br.top+br.height)-2;y++)for(let x=Math.ceil(Math.max(ar.left,br.left)+2);x<Math.min(ar.left+ar.width,br.left+br.width)-2;x++) {
        const u=(x-ar.left)/ar.width,v=(y-ar.top)/ar.height,p=image.rgba(x,y);
        const inHole=u>(32-8)/112+.04&&u<(96-8)/112-.04&&v>(32-8)/80+.04&&v<(64-8)/80-.04;
        if(inHole&&p[0]<60&&p[1]>170&&p[2]>170)hole={x,y};
        if(!inHole&&p[0]>170&&p[1]<60&&p[2]>170)body={x,y};
      }
      attempts.push({step,front,a,b,hole,body});
      if(front&&hole&&body) {
        const clickBefore=await readState(page);
        await page.screenshot({path:path.join(ctx.directory,'p3-overlap-oracle.png')});
        for(const [point,name] of [[hole,'萧白瑚'],[body,'破阵子']]) {
          assert.equal(await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.classList.contains('scene3d-canvas'),point),true);
          await page.mouse.click(point.x,point.y);await page.waitForSelector('.scene3d-menu');assert.equal(await page.$eval('.scene3d-menu .location-info-name, .scene3d-menu .npc-info-name',n=>n.textContent),name);await closeMenu(page);await waitReady(page,'cangjingge');
        }
        assert.deepEqual(await readState(page),clickBefore);assert.equal(requests(ctx,session.channel).length,0);
        await artifact(ctx.directory,'p3-overlap-oracle.json',{attempts,ringSha256:sha256(ring),solidSha256:sha256(solid),hole,body,foreground:'A',background:'D'});
        return {foregroundTransparentHitsBackground:true,foregroundOpaqueHitsForeground:true,realPointer:true};
      }
      const r=await canvasRect(page);await page.mouse.move(r.left+r.width*.5,r.top+r.height*.4);await page.mouse.down();await page.mouse.move(r.left+r.width*.5+16,r.top+r.height*.4,{steps:4});await page.mouse.up();await quietFrames(page,8);
    }
    await artifact(ctx.directory,'p3-overlap-attempts.json',attempts);
    throw Error('INCOMPLETE: camera orbit did not expose a verifiable two-card foreground-hole/background-body overlap');
  });
}

export async function pickingAndLocks(ctx) {
  const release = await releaseIdentity(ctx); const evidence = [];
  const ring = alphaRingPng(); assert.equal(screenshotPixels(ring).rgba(64, 48)[3], 0);
  const atlas = await alphaAtlasFixture(ctx, release, { pozhenzi: ring });
  await withGame(ctx, 'p3t05-alpha-pixels', { payload: await payloadFor(['A']), control: atlas.control }, async session => {
    const d = await waitReady(session.page, 'cangjingge'); assert.equal(d.renderer.npc.cards, 1); assert.equal(d.renderer.npc.fallbacks.length, 0);
    const atlasResources = atlas.evidence();
    await artifact(ctx.directory, 'p3t05-alpha-atlas-fixture.json', atlasResources);
    await waitSurfaceStable(session.page);
    const rect = await canvasRect(session.page); assert.equal(await session.page.evaluate(() => devicePixelRatio), 1);
    const png = Buffer.from(await session.page.screenshot({ path: path.join(ctx.directory, 'p3t05-alpha-ring.png') })), image = screenshotPixels(png), mask = [];
    for (let y = Math.max(0, Math.ceil(rect.top)); y < Math.min(image.height, Math.floor(rect.top + rect.height)); y++) for (let x = Math.max(0, Math.ceil(rect.left)); x < Math.min(image.width, Math.floor(rect.left + rect.width)); x++) {
      const [r, g, b] = image.rgba(x, y); if (r > 100 && b > 100 && r > g * 1.5 && b > g * 1.5) mask.push({ x, y });
    }
    assert.ok(mask.length > 12, 'Production WebGL pixels must contain the known synthetic magenta alpha-ring card');
    const bounds = { left: Math.min(...mask.map(p => p.x)), right: Math.max(...mask.map(p => p.x)), top: Math.min(...mask.map(p => p.y)), bottom: Math.max(...mask.map(p => p.y)) };
    const hole = { x: Math.round((bounds.left + bounds.right) / 2), y: Math.round((bounds.top + bounds.bottom) / 2) };
    const middleX = hole.x, upper = mask.filter(p => p.y < bounds.top + (bounds.bottom - bounds.top) * .25).sort((a, b) => Math.abs(a.x - middleX) - Math.abs(b.x - middleX)); assert.ok(upper.length);
    const body = upper[Math.floor(upper.length / 4)], before = await readState(session.page);
    await session.page.mouse.click(body.x, body.y); await session.page.waitForSelector('.scene3d-menu'); assert.ok((await menuText(session.page)).includes(d.snapshot.residents[0].displayName));
    await closeMenu(session.page); await waitReady(session.page, 'cangjingge');
    await session.page.mouse.click(hole.x, hole.y); assert.equal(await session.page.$('.scene3d-menu'), null, 'Transparent center of the actual rendered card must not intercept picking');
    assert.deepEqual(await readState(session.page), before);
    const cdp = await session.page.createCDPSession();
    try {
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 15, y: cy, id: 1 }, { x: cx + 15, y: cy, id: 2 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 30, y: cy, id: 1 }, { x: cx + 30, y: cy, id: 2 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await cdp.detach(); }
    assert.equal(await session.page.$('.scene3d-menu'), null, 'Two-pointer release must not produce an NPC intent'); assert.deepEqual(await readState(session.page), before);
    evidence.push({ alphaAtlasFixtureSha256: sha256(ring), atlasResources, screenshotSha256: sha256(png), body, transparentHole: hole, bounds, twoPointerCdp: true, realAndroid: false });
    await artifact(ctx.directory, 'p3t05-pixel-coordinates.json', evidence.at(-1));
  });
  const baseline = await npcPixelBaseline(ctx, 0);
  await withGame(ctx, 'p3t05-locks', { baseline, payload: await payloadFor(['A']) }, async session => {
    await waitReady(session.page, 'cangjingge'); const hit = await openNpc(session.page, 'A'); assert.equal(hit.kind, 'canvas', 'Opaque-body case requires a real static card, not fallback');
    const before = await readState(session.page); await closeMenu(session.page); await waitReady(session.page, 'cangjingge');
    await session.page.mouse.move(hit.x, hit.y); await session.page.mouse.down(); await session.page.mouse.move(hit.x + 32, hit.y + 4, { steps: 6 }); await session.page.mouse.up();
    assert.equal(await session.page.$('.scene3d-menu'), null, 'Drag release must not click NPC'); assert.deepEqual(await readState(session.page), before);
    await session.page.click('.scene3d-reset'); await quietFrames(session.page); await openNpc(session.page, 'A');
    const menuBounds = await session.page.$eval('.scene3d-menu', element => { const m = element.getBoundingClientRect(), v = document.querySelector('#main-viewport').getBoundingClientRect(); return { left: m.left, right: m.right, top: m.top, bottom: m.bottom, viewport: { left: v.left, right: v.right, top: v.top, bottom: v.bottom } }; });
    assert.ok(menuBounds.left >= menuBounds.viewport.left && menuBounds.right <= menuBounds.viewport.right + 1); await assertPaused(session.page); await closeMenu(session.page);
    // Deliberate host negative-test mutation of live variables only. No gameData
    // mutation, displayNpcs, synchronization, reroll or state repair is performed.
    await session.page.evaluate(() => { inputEnable = 0; updateFreeActionInputState(); GameSceneBridge.notify('test-inputEnable-zero'); });
    await assertPaused(session.page); const locked = await readState(session.page), requestCount = requests(ctx, session.channel).length;
    await session.page.mouse.click(hit.x, hit.y); assert.equal(await session.page.$('.scene3d-menu'), null);
    assert.deepEqual(await readState(session.page), locked); assert.equal(requests(ctx, session.channel).length, requestCount);
    evidence.push({ inputEnableWithoutModal: true, state: locked, hit, menuBounds });
    await capture(ctx, session.page, 'p3t05-negative-locks');
  });
  for (const mutation of ['location', 'visibility']) await withGame(ctx, `p3t05-live-${mutation}`, { baseline, payload: await payloadFor(['A']) }, async session => {
      // Each adversarial guard starts from an independent normal save so an
      // unrelated bad placement at epoch3 cannot mask the visibility guard.
      await waitReady(session.page, 'cangjingge'); await openNpc(session.page, 'A');
      const requestCount = requests(ctx, session.channel).length;
      const stale = await session.page.$('.scene3d-menu button:not(.scene3d-menu-close)'); assert.ok(stale);
      // Mutation and retained card callback run in one browser task, before any
      // microtask reconciliation could make this test vacuously pass by removal.
      const observation = await session.page.evaluate(kind => {
        const read = () => ({ actionPoints, money: playerStats.金钱, favor: npcFavorability.A, rng: window.__scene3dTest.rng(), history: storageService.loadUIConversation(), displayed: GameSceneBridge.getDiagnostics().snapshot.renderedNpcs.map(n => n.gameNpcId) });
        if (kind === 'location') currentNpcLocations.A = 'huofang'; else npcVisibility.A = false;
        const before = read(); const buttons = [...document.querySelectorAll('.scene3d-menu button')].filter(b => !b.classList.contains('scene3d-menu-close'));
        for (const button of buttons) button.click(); return { before, after: read(), clicked: buttons.length };
      }, mutation);
      assert.ok(observation.clicked >= 2); assert.deepEqual(observation.after, observation.before); assert.equal(requests(ctx, session.channel).length, requestCount); evidence.push({ mutation, ...observation });
      await capture(ctx, session.page, `p3t05-live-${mutation}`);
  });
  const overlap = await npcOverlap({ browser:ctx.browser, server:ctx.server, directory:path.join(ctx.directory,'npc-overlap'), buildId:ctx.buildId });
  assert.equal(overlap.status, 'PASS'); evidence.push({overlap});
  const result = { automatedStatus:'PASS', evidence, scope:'Desktop production renderer in full host plus controlled source-runtime overlap oracle; CDP touch is emulated', manual:[{name:'Physical Android touch/body/transparent edge',status:'NOT RUN'}] };
  await artifact(ctx.directory, 'P3-T05-coverage.json', result);
  return result;
}

export async function environmentProjection(ctx) {
  await releaseIdentity(ctx); const states = [], screenshots = new Map();
  await withGame(ctx, 'p3t06-environment', { payload: await payloadFor([], {}, 'map') }, async session => {
    for (const [season, week] of Object.entries({ winter: 2, spring: 10, summer: 22, autumn: 34 })) for (const dayNightStatus of ['daytime', 'night']) {
      await importPayload(ctx, session.page, `p3t06-${season}-${dayNightStatus}`, await payloadFor([], { currentWeek: week, seasonStatus: season, dayNightStatus }, 'map'));
      const d = await waitReady(session.page, 'tianshanpai'); assert.equal(d.snapshot.environment.season, season); assert.equal(d.snapshot.environment.hour, dayNightStatus === 'night' ? 22 : 14);
      const before = await readState(session.page); await quietFrames(session.page, 30); assert.deepEqual(await readState(session.page), before, 'Renderer clock may not advance game week or RNG');
      const captureResult = await capture(ctx, session.page, `p3t06-${season}-${dayNightStatus}`); screenshots.set(`${season}-${dayNightStatus}`, captureResult.screenshotSha256); states.push(d.snapshot.environment);
    }
    for (const season of ['winter', 'spring', 'summer', 'autumn']) assert.notEqual(screenshots.get(`${season}-daytime`), screenshots.get(`${season}-night`), 'Day/night must actually change displayed pixels');
    await runTurn(ctx, session, await fullResponse({ 时间: '07:45' })); await waitReady(session.page, 'tianshanpai');
    const precise = await diag(session.page); assert.equal(precise.snapshot.environment.hour, 7.75); assert.equal(precise.snapshot.environment.timeSource, 'parsed');
    await importPayload(ctx, session.page, 'p3t06-old-time', await payloadFor([], { dayNightStatus: 'night' }, 'map'));
    const fallback = await waitReady(session.page, 'tianshanpai'); assert.ok(fallback.epoch > precise.epoch); assert.equal(fallback.snapshot.environment.hour, 22); assert.equal(fallback.snapshot.environment.timeSource, 'dayNightFallback');
    states.push({ precise: precise.snapshot.environment, restored: fallback.snapshot.environment });
  });
  const eventSource = await readFile(path.join(ctx.gameRoot || ctx.server.root, 'module/special-event.js'), 'utf8');
  const alreadyTriggered = [...eventSource.matchAll(/^\s*id:\s*["']([^"']+)["']/gm)].map(match => match[1]);
  assert.ok(alreadyTriggered.length > 0, 'Use declared story identities in the normal-week fixture, never stub checkSpecialEvents');
  const weekTraces = [];
  for (const enabled of [false, true]) weekTraces.push(await withGame(ctx, `p3t06-week-${enabled}`, { enabled, payload: await payloadFor([], { currentWeek: 8, triggeredEvents: alreadyTriggered }, 'map') }, async session => {
    if (enabled) await waitReady(session.page, 'tianshanpai');
    const before = await readState(session.page); ctx.server.enqueue(session.channel, await fullResponse({}, '合成新周完成'));
    await session.page.evaluate(() => skipWeek());
    await session.page.waitForSelector('#modal-buttons button:not(.cancel)', { visible: true });
    await stableClick(await session.page.$('#modal-buttons button:not(.cancel)'));
    await session.page.waitForFunction(() => !window.__scene3dRead().streaming && window.__scene3dRead().uiConversation.at(-1)?.content.includes('合成新周完成'), { timeout: 60000 });
    await session.page.evaluate(() => closeModal());
    if (enabled) { const d = await waitReady(session.page, 'tianshanpai'); assert.equal(d.snapshot.environment.season, 'spring'); }
    const after = await readState(session.page); assert.equal(after.currentWeek, before.currentWeek + 1); assert.equal(after.actionPoints, 3); assert.equal(requests(ctx, session.channel).length, 1);
    await capture(ctx, session.page, `p3t06-week-${enabled}`);
    return { before, after, prompt: requests(ctx, session.channel)[0].body, nextRandom: await session.page.evaluate(() => Math.random()) };
  }));
  await compareTrajectories(ctx, 'p3t06-week', weekTraces[0], weekTraces[1]);
  await artifact(ctx.directory, 'p3t06-environment-matrix.json', states);
  return { seasonDayNightCombinations: 8, preciseTime: '07:45', newEpochFallback: '22:00', actualWeekBoundaryPaired: true };
}

export async function modeMatrix(ctx) {
  await releaseIdentity(ctx); const coverage = [];
  for (const fixture of ['map', 'gal']) await withGame(ctx, `p4t01-cold-${fixture}`, { payload: await payloadFor([], {}, fixture) }, async session => {
    const state = await readState(session.page); assert.equal(state.GameMode, fixture === 'gal' ? 1 : 0);
    if (fixture === 'gal') {
      await quietFrames(session.page, 30); const d = await diag(session.page); assert.equal(d.preferences.enabled, true); assert.equal(d.renderer, null);
      assert.equal(session.network.filter(item => /\/assets\/sect3d\//.test(item.url)).length, 0, 'Cold Gal with 3D preference ON must request no 3D entry/model/decoder'); await assertPaused(session.page);
    } else await waitReady(session.page, 'tianshanpai');
    coverage.push(await capture(ctx, session.page, `p4t01-cold-${fixture}`));
  });
  const gate = deferred(), seen = deferred();
  await withGame(ctx, 'p4t01-late-room', { payload: await payloadFor([], {}, 'map'), control: url => url.pathname.endsWith('/sub_scene/library_interior.glb') ? { gate, seen } : null }, async session => {
    await waitReady(session.page, 'tianshanpai'); await session.page.evaluate(() => goToLocation('cangjingge'));
    try {
      await deadline(seen.promise, 20000, 'No pending real room GLB request');
      await importPayload(ctx, session.page, 'p4t01-gal-import', await payloadFor([], {}, 'gal')); gate.resolve(); await quietFrames(session.page, 30);
      assert.equal((await readState(session.page)).GameMode, 1); assert.equal((await diag(session.page)).readyScene, null); await assertPaused(session.page);
      await importPayload(ctx, session.page, 'p4t01-mode0-import', await payloadFor([], {}, 'map')); await waitReady(session.page, 'tianshanpai');
    } finally { gate.resolve(); }
  });
  for (const branch of ['ordinary', 'bounty']) {
    const traces = [];
    for (const enabled of [false, true]) {
      const payload = await payloadFor([], {}, 'map'); payload.gameData.npcFavorability.F = 40;
      if (branch === 'bounty') { payload.gameData.activeBounty = { enemyName: '合成悬赏目标', description: '仅供隔离测试', locationName: '天山派外堡', level: 1, reputationReward: 8, goldReward: 1000 }; payload.gameData.lastBountyAcceptWeek = payload.gameData.currentWeek; }
      traces.push(await withGame(ctx, `p4t01-${branch}-${enabled}`, { enabled, payload }, async session => {
        if (enabled) await waitReady(session.page, 'tianshanpai'); const before = await readState(session.page);
        await session.page.evaluate(() => showWorldMap());
        await session.page.waitForFunction(() => document.querySelector('#worldmap-iframe')?.contentDocument?.querySelector('.map-marker'), { timeout: 30000 });
        if (enabled) await assertPaused(session.page);
        const frame = await (await session.page.$('#worldmap-iframe')).contentFrame();
        await stableClick(await frame.$('.map-marker[data-location="天山派外堡"]'));
        await stableClick(await frame.$('#modalFooter button[onclick="showNPCList()"]'));
        await stableClick(await frame.$('label[for="npc-施延年"]'));
        assert.equal(await frame.$eval('input[value="施延年"]', node => node.checked), true);
        await stableClick(await frame.$('#travelBtn'));
        const departureResponse=await fullResponse({}, `合成${branch}下山完成`); departureResponse.steps[0].waitFor='departure-mode-observed';
        ctx.server.enqueue(session.channel, departureResponse);
        await stableClick(await frame.$('#modalFooter button[onclick="confirmTravel()"]'));
        await ctx.server.waitFor(event=>event.channel===session.channel && event.type==='waiting' && event.key===`${session.channel}:departure-mode-observed`);
        const departing=await readState(session.page); assert.equal(departing.GameMode,1);
        if(branch==='bounty') { assert.equal(departing.gameData.battleEvent,1); assert.equal(await session.page.evaluate(()=>currentBattleType),'bounty'); }
        await ctx.server.release(session.channel,'departure-mode-observed');
        await session.page.waitForFunction(marker => !window.__scene3dRead().streaming && window.__scene3dRead().uiConversation.at(-1)?.content.includes(marker), { timeout: 60000 }, `合成${branch}下山完成`);
        const departed = await readState(session.page); assert.equal(departed.GameMode, 1); assert.equal(departed.gameData.mapLocation, '天山派外堡');
        assert.deepEqual(await session.page.evaluate(() => companionNPC), ['施延年']);
        await assertPaused(session.page); assert.equal((await diag(session.page)).readyScene, null);
        assert.ok(JSON.stringify(requests(ctx, session.channel)[0].body.messages).includes(branch === 'bounty' ? '悬赏缉拿' : '下山游历'));
        await capture(ctx, session.page, `p4t01-${branch}-${enabled}-gal`);
        await stableClick(await session.page.$('#modal-buttons button[onclick="closeModal()"]'));
        if(branch==='bounty') {
          assert.equal(departed.inputEnable,0,'Active bounty battle correctly locks return until resolved');
          assert.ok(departed.currentRandomEvent?.事件类型==='战斗事件' || departed.currentBattleEvent,'Original bounty battle must exist');
          return {before,departing,departed,prompts:requests(ctx,session.channel).map(request=>request.body),nextRandom:await session.page.evaluate(()=>Math.random()),scope:'Bounty departure and locked battle; returnFromSLG exercised by ordinary departure pair'};
        }
        await advanceBusinessClock(session.page);
        ctx.server.enqueue(session.channel, await fullResponse({}, '合成返回天山派完成'));
        // 「返回门派」现已收进视窗右下角齿轮展开的面板，需先展开再点击
        await stableClick(await session.page.$('#viewport-dock-gear'));
        await session.page.waitForFunction(() => document.getElementById('viewport-dock').classList.contains('open'));
        await stableClick(await session.page.$('#slg-return-btn'));
        await session.page.waitForFunction(() => !window.__scene3dRead().streaming && window.__scene3dRead().uiConversation.at(-1)?.content.includes('合成返回天山派完成'), { timeout: 60000 });
        await stableClick(await session.page.$('#modal-buttons button[onclick="closeModal()"]'));
        const returned = await readState(session.page); assert.equal(returned.GameMode, 0); assert.equal(returned.userLocation, 'tianshanpai'); assert.deepEqual(await session.page.evaluate(() => companionNPC), []);
        if (enabled) await waitReady(session.page, 'tianshanpai'); assert.equal(requests(ctx, session.channel).length, 2);
        return { before, departing, departed, returned, prompts: requests(ctx, session.channel).map(request => request.body), nextRandom: await session.page.evaluate(() => Math.random()) };
      }));
    }
    await compareTrajectories(ctx, `p4t01-${branch}`, traces[0], traces[1]); coverage.push({ branch, paired: true });
  }
  const storyTraces = [];
  for (const enabled of [false, true]) storyTraces.push(await withGame(ctx, `p4t01-fixed-story-${enabled}`, { enabled, payload: await payloadFor([], { currentWeek: 3, triggeredEvents: [], currentSpecialEvent: '' }, 'map') }, async session => {
    if (enabled) await waitReady(session.page, 'tianshanpai'); const trace = [await readState(session.page)], length = trace[0].uiConversation.length;
    await session.page.evaluate(() => skipWeek()); await stableClick(await session.page.$('#modal-buttons button:not(.cancel)'));
    for (let chapter = 1; chapter <= 6; chapter++) {
      await session.page.waitForFunction((part, size) => window.__scene3dRead().uiConversation.length >= size + part * 2 && (part === 6 ? currentSpecialEvent === '' && GameMode === 0 : currentSpecialEvent === `Apprenticeship_Storyline_${part}` && GameMode === 1), { timeout: 60000 }, chapter, length);
      const state = await readState(session.page); trace.push(state);
      if (chapter < 6) {
        assert.equal(state.inputEnable, 0); await assertPaused(session.page);
        await session.page.evaluate(() => goToPage(storyPages.length - 1));
        await session.page.waitForSelector('#event-options .event-option-btn', { visible: true });
        await clickText(session.page, '#event-options .event-option-btn', '特殊剧情:');
      }
    }
    const final = await readState(session.page); assert.equal(final.inputEnable, 1); assert.equal(final.userLocation, 'nvdizi'); assert.equal(final.currentWeek, 4);
    if (enabled) await waitReady(session.page, 'nvdizi'); assert.equal(requests(ctx, session.channel).length, 0, 'Fixed plot must use original presets, not a fake AI substitute');
    await capture(ctx, session.page, `p4t01-fixed-story-${enabled}-complete`); return { trace, nextRandom: await session.page.evaluate(() => Math.random()) };
  }));
  await compareTrajectories(ctx, 'p4t01-fixed-story', storyTraces[0], storyTraces[1]);
  return { coldGalPreferenceOnZeroAssets: true, lateRoomResultRejectedInGal: true, departureBranches: ['ordinary', 'bounty'], originalReturnFromSlg: true, fixedStoryChapters: 6, pairedBusinessAndRng: true };
}

export async function saveEntryMatrix(ctx) {
  await releaseIdentity(ctx); const coverage = [], failures = [];
  for (const fixture of ['map', 'library', 'gal', 'special-event', 'crowded']) { try { await withGame(ctx, `p4t02-${fixture}`, { payload: await json(path.join(fixturesRoot, `saves/${fixture}.json`)) }, async session => {
    const initial = await readState(session.page); await capture(ctx, session.page, `p4t02-${fixture}-cold`);
    if (initial.GameMode === 0) await waitReady(session.page, initial.userLocation); else await assertPaused(session.page);
    const payload = await json(path.join(fixturesRoot, `saves/${fixture}.json`));
    const imported = await importPayload(ctx, session.page, `p4t02-${fixture}-json`, payload);
    for (const key of ['GameMode', 'userLocation', 'actionPoints', 'currentWeek', 'inputEnable', 'currentSpecialEvent', 'currentNpcLocations', 'npcVisibility', 'uiConversation', 'summaryHistory']) assert.deepEqual(imported[key], initial[key], `${fixture} JSON import ${key}`);
    if (imported.GameMode === 0 && imported.inputEnable !== 0) await waitReady(session.page, imported.userLocation); else await assertPaused(session.page);
    const epoch = (await diag(session.page)).epoch;
    await session.page.evaluate(value => { const id = storageService.importSavePayload(value); loadSaveSlot(id); closeModal(); }, payload);
    await quietFrames(session.page); assert.ok((await diag(session.page)).epoch > epoch, 'Slot load must start a new bridge epoch');
    const slotState = await readState(session.page);
    for (const key of ['GameMode', 'userLocation', 'actionPoints', 'currentWeek', 'inputEnable', 'currentSpecialEvent', 'uiConversation', 'summaryHistory']) assert.deepEqual(slotState[key], initial[key], `${fixture} slot load ${key}`);
    if (slotState.GameMode === 0 && slotState.inputEnable !== 0) await waitReady(session.page, slotState.userLocation); else await assertPaused(session.page);
    const saved = await exportJson(session.page); await artifact(ctx.directory, `p4t02-${fixture}-export.json`, saved);
    // Real ST JSONL import, through its own file chooser and converter, not a call
    // to the JSON importer pretending to exercise ST.
    const stText = [JSON.stringify({ chat_metadata: { variables: { gameData: JSON.stringify(payload.gameData) } } }), JSON.stringify({ is_user: false, send_date: '2026-01-01T00:00:00Z', extra: { api: 'synthetic' }, mes: '<SLG_MODE><MAIN_TEXT>合成ST导入。|none|藏经阁|none|none</MAIN_TEXT><SUMMARY>第2周合成ST摘要。</SUMMARY></SLG_MODE>' })].join('\n');
    const filename = await artifact(ctx.directory, `p4t02-${fixture}.jsonl`, stText), beforeST = (await diag(session.page)).epoch;
    const chooser = session.page.waitForFileChooser(); await session.page.evaluate(() => { closeModal(); importSTSaveFromLoadModal(); }); await (await chooser).accept([filename]);
    await session.page.waitForFunction(() => document.querySelector('#modal-text')?.textContent.includes('ST 存档导入成功'), { timeout: 30000 }); await session.page.evaluate(() => closeModal()); await quietFrames(session.page);
    const afterST = await readState(session.page);
    await artifact(ctx.directory, `p4t02-${fixture}-st-comparison.json`, { initial, imported, afterST, beforeST, afterSTDiagnostics: await diag(session.page) });
    assert.equal(afterST.GameMode, payload.gameData.GameMode); assert.equal(afterST.userLocation, payload.gameData.userLocation);
    // Same three-state contract as st-import-lock.browser.mjs: preserve an
    // active event lock; recover a transient no-event lock; keep unlocked events open.
    const expectedSTInput = imported.inputEnable === 0 && imported.currentSpecialEvent ? 0 : 1;
    assert.equal(afterST.inputEnable, expectedSTInput, `${fixture} ST import must enforce the special-event input-lock contract`);
    if (fixture === 'special-event') assert.equal(afterST.inputEnable, imported.inputEnable, 'Special-event fixture ST/JSON input locks must agree');
    if (expectedSTInput === 0) {
      assert.equal(afterST.inputEnable, 0, 'ST special-event lock must remain locked after import');
      await assertPaused(session.page);
      const locked = await diag(session.page);
      assert.equal(locked.snapshot.interactive, false, 'ST special-event snapshot must prohibit interaction');
      assert.notEqual(locked.renderer?.interactionEnabled, true, 'ST special-event renderer must prohibit interaction');
    }
    assert.ok(afterST.uiConversation.some(message => message.content.includes('合成ST导入')), 'ST converter must restore actual fixture history');
    assert.ok(afterST.summaryHistory.length > 0, 'ST converter must restore the fixture SUMMARY');
    const stDiag=await diag(session.page);
    assert.equal(afterST.currentSpecialEvent, imported.currentSpecialEvent, 'ST converter must preserve currentSpecialEvent identity');
    const jsonVsSt={inputEnable:{json:imported.inputEnable,st:afterST.inputEnable},gameMode:{json:imported.GameMode,st:afterST.GameMode},currentSpecialEvent:{json:imported.currentSpecialEvent,st:afterST.currentSpecialEvent}};
    await artifact(ctx.directory, `p4t02-${fixture}-json-vs-st-difference.json`, jsonVsSt);
    assert.ok(stDiag.epoch > beforeST, 'ST import must publish a new epoch');
    if (afterST.GameMode === 0 && afterST.inputEnable !== 0) await waitReady(session.page, afterST.userLocation); else await assertPaused(session.page);
    coverage.push({ fixture, initial, imported, afterST });
  });
  } catch(error) { failures.push({fixture,error:error.stack}); } }
  await artifact(ctx.directory, 'p4t02-entry-matrix.json', {coverage,failures});
  assert.deepEqual(failures, [], 'Every save-entry fixture must pass; failures do not suppress later fixtures');
  return { fixtures: 5, entries: ['cold-slot', 'JSON-filechooser', 'slot-load', 'ST-filechooser'], exportCaptured: true };
}

export async function rollbackAndFailure(ctx) {
  await releaseIdentity(ctx); const all = [];
  for (const scenario of ['normal', 'stream', 'abort', 'error', 'truncated', 'commit-failure', 'regenerate']) {
    const traces = [];
    for (const enabled of [false, true]) traces.push(await withGame(ctx, `p4t03-${scenario}-${enabled}`, { enabled, payload: await payloadFor([]) }, async session => {
      if (enabled) await waitReady(session.page, 'cangjingge');
      if (scenario === 'normal') await session.page.evaluate(() => apiService.updateConfig({ streamMode: 'non-stream' }));
      const fixture = scenario === 'normal' ? await json(path.join(fixturesRoot, 'responses/action-json.json')) : scenario === 'stream' ? await json(path.join(fixturesRoot, 'responses/action-stream.json')) : ['abort', 'error', 'truncated'].includes(scenario) ? await json(path.join(fixturesRoot, `responses/action-${scenario}.json`)) : await fullResponse({ 用户: { 位置变动: scenario === 'regenerate' ? '伙房' : 'none' } });
      if (scenario === 'commit-failure') await session.page.evaluate(async () => { syncGameDataFromVariables(); await storageService.saveFullSnapshot(); });
      if (scenario === 'commit-failure') await session.page.evaluate(() => {
        const original = storageService.appendUIConversation;
        storageService.appendUIConversation = function(...args) { storageService.appendUIConversation = original; throw Error('P4 controlled commit storage exception'); };
      });
      const result = await runTurn(ctx, session, fixture, { abort: scenario === 'abort', failure: scenario === 'error', checkpoint: scenario === 'stream' ? 'paragraph-consumed' : null, expectedRequests: scenario === 'error' ? 2 : 1, hostEntry: scenario === 'regenerate' });
      if (['abort', 'error'].includes(scenario)) assert.equal(result.epochAfter, result.epochBefore, 'Abort/API failure must not fabricate a snapshot rollback');
      if (scenario === 'commit-failure') assert.ok(result.epochAfter > result.epochBefore, 'Actual commit exception must restore through a new data epoch');
      if (['abort', 'error', 'commit-failure'].includes(scenario)) {
        assert.deepEqual(result.after.uiConversation, result.before.uiConversation, `${scenario} must not append a completed conversation`);
        assert.deepEqual(result.after.summaryHistory, result.before.summaryHistory); assert.equal(result.after.userLocation, result.before.userLocation); assert.equal(result.after.currentWeek, result.before.currentWeek);
      } else if (scenario !== 'truncated') assert.equal(result.after.uiConversation.length, result.before.uiConversation.length + 2);
      else { // Complete MAIN_TEXT may append the assistant; missing SIDE_NOTE must not auto-save.
        assert.equal(result.after.uiConversation.filter(n => n.role === 'assistant').length, result.before.uiConversation.filter(n => n.role === 'assistant').length + 1);
        assert.deepEqual(result.after.summaryHistory.slice(0, result.before.summaryHistory.length), result.before.summaryHistory);
        for (const field of ['actionPoints', 'currentWeek', 'playerStats', 'npcFavorability', 'currentNpcLocations']) assert.deepEqual(result.after[field], result.before[field], `Truncation must not advance ${field}`);
        result.legacyTruncationObservation = { appendedSummary: result.after.summaryHistory.slice(result.before.summaryHistory.length) };
      }
      if (['abort', 'error', 'commit-failure', 'truncated'].includes(scenario)) assert.deepEqual(result.autoSavesAfter, result.autoSavesBefore, `${scenario}: no automatic save slot may be created`);
      else assert.equal(result.autoSavesAfter.length, result.autoSavesBefore.length + 1);
      if (scenario === 'regenerate') {
        assert.equal(result.after.userLocation, 'huofang');
        const oldEpoch = (await diag(session.page)).epoch;
        ctx.server.enqueue(session.channel, await fullResponse({}, '合成重生成完成'));
        await session.page.evaluate(() => handleRegenerate()); await session.page.waitForSelector('#regen-msg-input', { visible: true });
        await stableClick(await session.page.$('#modal-buttons button[onclick="_confirmRegenerate()"]'));
        await session.page.waitForFunction(() => window.__scene3dRead().uiConversation.at(-1)?.content.includes('合成重生成完成') && !window.__scene3dRead().streaming, { timeout: 60000 });
        const regenerated = await readState(session.page); assert.equal(regenerated.userLocation, 'cangjingge'); assert.equal(regenerated.logicalPage, 'cangjingge'); assert.ok((await diag(session.page)).epoch > oldEpoch);
        result.regenerated = regenerated; assert.equal(requests(ctx, session.channel).length, 2);
      }
      if (enabled) { const state = await readState(session.page); await waitReady(session.page, state.userLocation); }
      result.saved = await exportJson(session.page); result.nextRandom = await session.page.evaluate(() => Math.random());
      await capture(ctx, session.page, `p4t03-${scenario}-${enabled}`); return result;
    }));
    await compareTrajectories(ctx, `p4t03-${scenario}`, traces[0], traces[1]); all.push({ scenario, paired: true });
  }
  return { scenarios: all, abortUsesActualAbortControllerTransport: true, noBusinessDiffIgnores: true };
}

export async function specialPages(ctx) {
  await releaseIdentity(ctx); const coverage = [];
  for (const style of [0, 1]) for (const fixture of ['library', 'gal']) {
    const traces = [];
    for (const enabled of [false, true]) traces.push(await withGame(ctx, `p4t04-${style}-${fixture}-${enabled}`, { enabled, style, payload: await payloadFor([], { uiStyle: style }, fixture) }, async session => {
      const trajectory = [], original = await readState(session.page);
      if (enabled && fixture !== 'gal') await waitReady(session.page, 'cangjingge');
      for (const method of ['showPlayerStats', 'showRelationships']) {
        if (fixture !== 'gal') { await session.page.evaluate(() => goToLocation('cangjingge')); if (enabled) await waitReady(session.page, 'cangjingge'); }
        await session.page.evaluate(name => window[name](), method); const expected = method === 'showPlayerStats' ? 'player-stats' : 'relationships';
        assert.equal((await readState(session.page)).logicalPage, expected); if (enabled) await assertPaused(session.page);
        const result = await runTurn(ctx, session, await fullResponse({ 用户: { 位置变动: '伙房' } }));
        assert.equal(result.after.userLocation, fixture === 'gal' ? original.userLocation : 'huofang');
        assert.equal(result.after.logicalPage, expected, 'Location changes must not dismiss a utility page');
        trajectory.push(result); await capture(ctx, session.page, `p4t04-${style}-${fixture}-${enabled}-${expected}`);
        await session.page.evaluate(() => backToMap());
        const returned = await readState(session.page); assert.equal(returned.GameMode, original.GameMode); assert.equal(returned.logicalPage, 'map');
        if (fixture !== 'gal') assert.equal(returned.userLocation, 'tianshanpai'); trajectory.push(returned);
      }
      if (fixture === 'gal') {
        const reply = await fullResponse({}, '合成Gal分页一|none|藏经阁|none|none\n合成Gal分页二|none|藏经阁|none|none\n合成Gal分页三');
        trajectory.push(await runTurn(ctx, session, reply));
        const pages = await session.page.evaluate(() => storyPages.length); assert.ok(pages >= 3, 'Actual Gal reply must create multiple pages');
        await session.page.evaluate(() => goToPage(0));
        await session.page.evaluate(() => nextPage()); assert.equal(await session.page.evaluate(() => currentPage), 1);
        await session.page.evaluate(() => prevPage()); assert.equal(await session.page.evaluate(() => currentPage), 0);
        await session.page.evaluate(() => toggleStoryExpand()); assert.equal(await session.page.evaluate(() => isStoryExpanded), true);
        await capture(ctx, session.page, `p4t04-${style}-${enabled}-expanded`);
        await session.page.evaluate(() => toggleStoryExpand()); assert.equal(await session.page.evaluate(() => isStoryExpanded), false);
        const cg = await session.page.evaluate(() => cgContentEnabled);
        await session.page.evaluate(() => toggleCgContent()); assert.equal(await session.page.evaluate(() => cgContentEnabled), !cg);
        await session.page.evaluate(() => toggleCgContent()); assert.equal(await session.page.evaluate(() => cgContentEnabled), cg);
        if (enabled) await assertPaused(session.page);
        assert.equal(await session.page.$eval('#main-viewport', node => node.hasAttribute('data-scene3d-ready')), false);
        trajectory.push({ pages, cg, final: await readState(session.page) });
      }
      return trajectory;
    }));
    await compareTrajectories(ctx, `p4t04-${style}-${fixture}`, traces[0], traces[1]); coverage.push({ style, fixture, paired: true });
  }
  return { coverage, utilityPages: ['player-stats', 'relationships'], galPaginationExpandedNewReplyAndCg: true };
}

export async function hostOverlays(ctx) {
  await releaseIdentity(ctx); const coverage = [];
  await withGame(ctx, 'p4t05-overlays', { payload: await payloadFor([]) }, async session => {
    await waitReady(session.page, 'cangjingge'); const initial = await readState(session.page);
    await session.page.evaluate(() => showModal('合成模态：3D不得关闭此业务UI'));
    await assertPaused(session.page); assert.ok((await session.page.$eval('#modal-text', node => node.textContent)).includes('不得关闭')); assert.deepEqual(await readState(session.page), initial);
    await capture(ctx, session.page, 'p4t05-modal'); await session.page.evaluate(() => closeModal()); await waitReady(session.page, 'cangjingge');
    for (const [method, modal, iframe] of [['showFarmGame', '#farm-modal', '#farm-iframe'], ['showAlchemyGame', '#alchemy-modal', '#alchemy-iframe'], ['showBlackjackGame', '#blackjack-modal', '#blackjack-iframe'], ['showWorldMap', '#worldmap-modal', '#worldmap-iframe'], ['showBattleGame', '#battle-modal', '#battle-iframe']]) {
      await session.page.evaluate(name => { if (name === 'showBattleGame') showBattleGame({ player: { name: '合成测试弟子', attack: 20, health: 100 }, enemy: { name: '合成对手', maxHealth: '中', basicDamage: '中', category: '未知' } }); else window[name](); }, method);
      const node = await session.page.$(iframe); assert.ok(node, `Missing expected original iframe ${iframe}`);
      await session.page.waitForFunction(selector => { const node = document.querySelector(selector); return node?.getAttribute('src') && node.contentDocument?.readyState === 'complete'; }, { timeout: 30000 }, iframe);
      await assertRendererPausedDuringHostOverlay(session.page); assert.ok(await session.page.$eval(modal, element => getComputedStyle(element).display !== 'none'), 'Runtime must not hide original modal');
      await capture(ctx, session.page, `p4t05-${method}`); coverage.push({ method, iframe, modal });
      const helperName = method === 'showFarmGame' ? 'farm' : method === 'showAlchemyGame' ? 'alchemy' : method === 'showBlackjackGame' ? 'blackjack' : method === 'showWorldMap' ? 'worldmap' : 'battle';
      const exit = await exitIframeThroughRealControl(session.page, helperName);
      coverage.at(-1).exit = exit;
      await session.page.evaluate(() => closeModal()); await waitReady(session.page, 'cangjingge');
    }
  });
  const ui = await hostUi({...ctx, directory:path.join(ctx.directory,'host-ui')});
  assert.ok(ui.results.length > 0 && ui.comparisons.length === 2);
  assert.ok([...ui.results,...ui.comparisons].every(row => row.status === 'PASS'), 'Every host UI check and 2D/3D comparison must PASS');
  assert.equal(ui.sourceStable, true);
  const settlement = await iframeSettlement({...ctx,directory:path.join(ctx.directory,'iframe-settlement')});
  const result = {automatedStatus:'PASS',coverage,ui,settlement,manual:[{name:'Physical Android soft keyboard',status:'NOT RUN'},{name:'Android SystemBack',status:'NOT RUN'}],scope:'Desktop host UI, actual iframe controls and nonzero settlements; normal repeat operation is not malicious postMessage replay testing'};
  await artifact(ctx.directory,'P4-T05-coverage.json',result);
  return result;
}

export async function configurationIsolation(ctx) {
  await releaseIdentity(ctx);
  return withGame(ctx, 'p4t06-isolation', { payload: await payloadFor([]) }, async session => {
    await waitReady(session.page, 'cangjingge');
    const savedBefore = await exportJson(session.page), before = await readState(session.page); // export itself invokes the original RNG-consuming synchronization
    const config = await session.page.evaluate(() => {
      storageService.savePromptOverride('scene3d-synthetic-global', '仅合成测试，不含用户提示词');
      storageService.saveCustomWorldbook(1, [{ id: 'scene3d-synthetic-world', name: '合成世界书', content: '测试文本', enabled: true }]);
      apiService.updateConfig({ temperature: .25, model: 'scene3d-fake-only' });
      GameSceneBridge.setPreference({ enabled: false, quality: 'balanced' });
      const api = apiService.getConfig();
      return { prompts: storageService.loadPromptOverrides(), worldbook: storageService.loadCustomWorldbook(1), api: { endpoint: api.endpoint, model: api.model, temperature: api.temperature }, preference: GameSceneBridge.getDiagnostics().preferences };
    });
    assert.deepEqual((await readState(session.page)).gameData, before.gameData, 'Presentation/global configuration must not contaminate business gameData');
    assert.deepEqual((await readState(session.page)).rng, before.rng, 'Configuration changes must not consume game RNG');
    const savedAfter = await exportJson(session.page); assert.deepEqual(savedAfter, savedBefore, 'Serialized game payload must not acquire global prompt/API/3D preferences');
    const forbidden = [];
    const scan = (value, prefix = '') => { if (!value || typeof value !== 'object') return; for (const [key, child] of Object.entries(value)) { const current = prefix ? `${prefix}.${key}` : key; if (/^(renderer|three|scene3d|assetBaseUrl|jxz_scene3d_preferences_v1|isObject3D|isWebGLRenderer|isTexture|isBufferGeometry|domElement)$/i.test(key)) forbidden.push(current); scan(child, current); } };
    scan(savedAfter); assert.deepEqual(forbidden, []);
    await importPayload(ctx, session.page, 'p4t06-gal', await payloadFor([], {}, 'gal'));
    const retained = await session.page.evaluate(() => { const api = apiService.getConfig(); return { prompts: storageService.loadPromptOverrides(), worldbook: storageService.loadCustomWorldbook(1), api: { endpoint: api.endpoint, model: api.model, temperature: api.temperature }, preference: GameSceneBridge.getDiagnostics().preferences }; });
    assert.deepEqual(retained, config, 'Global configuration scopes must survive changing business save');
    await importPayload(ctx, session.page, 'p4t06-export-reimport', savedAfter);
    assert.equal((await readState(session.page)).userLocation, 'cangjingge'); assert.equal((await diag(session.page)).preferences.enabled, false); assert.equal(requests(ctx, session.channel).length, 0);
    await artifact(ctx.directory, 'p4t06-config-redacted.json', config); await artifact(ctx.directory, 'p4t06-export.json', savedAfter);
    return { globalConfigurationRetained: true, gameDataUntouched: true, rngUntouched: true, serializedForbiddenPaths: forbidden, apiTransport: 'fake-localhost-only; credentials deliberately not sampled' };
  });
}

// Narrow diagnostic for the reported stair occlusion; deliberately not a new
// registry PASS. It still requires real physical canvas hits, not bridge injection.
export async function npcClickDiagnostic(ctx) {
  await releaseIdentity(ctx); const evidence = [];
  for (const variant of ['original-library', 'single-F']) await withGame(ctx, `p3-target-${variant}`, { payload: variant === 'original-library' ? await json(path.join(fixturesRoot, 'saves/library.json')) : await payloadFor(['F']) }, async session => {
    const d = await waitReady(session.page, 'cangjingge');
    assert.ok(d.snapshot.renderedNpcs.some(n => n.gameNpcId === 'F'), 'Original displayed subset must include F for this diagnostic');
    await capture(ctx, session.page, `p3-target-${variant}-before`);
    const before = await readState(session.page), hit = await openNpc(session.page, 'F');
    assert.equal(hit.kind, 'canvas', 'A fallback label is not evidence that an occluded 3D card can be clicked');
    assert.deepEqual(await readState(session.page), before); assert.equal(requests(ctx, session.channel).length, 0);
    evidence.push({ variant, selected: d.snapshot.renderedNpcs.map(n => n.gameNpcId), foot: d.renderer.npc.residents.find(n => n.gameNpcId === 'F')?.foot, hit });
    await capture(ctx, session.page, `p3-target-${variant}-menu`);
  });
  await artifact(ctx.directory, 'npc-F-click-diagnostic.json', evidence); return evidence;
}

async function installNpcCausalObserver(page) {
  await page.evaluate(() => {
    const events = [], describe = node => node ? { tag: node.tagName || node.nodeName, id: node.id || '', className: String(node.className || '') } : null;
    const live = () => {
      const d = GameSceneBridge.getDiagnostics();
      return { GameMode, userLocation, currentNpcLocations: Object.fromEntries(['A','B','C'].map(id => [id,currentNpcLocations[id]])), npcVisibility: Object.fromEntries(['A','B','C'].map(id => [id,npcVisibility[id]])), activeSceneIds: [...document.querySelectorAll('#main-viewport>.scene.active')].map(n => n.id), renderedNpcs: d.snapshot?.renderedNpcs, visible: d.snapshot?.visible, interactive: d.snapshot?.interactive, inputEnable, epoch: d.epoch, rejectedIntents: d.counters?.rejectedIntents };
    };
    const record = (type, data = {}) => { if(events.length < 1000) events.push({sequence:events.length,time:performance.now(),type,...data,live:live()}); };
    const pointer = event => record(event.type, {target:describe(event.target), onCanvas:event.composedPath().some(n => n.classList?.contains('scene3d-canvas')), x:event.clientX,y:event.clientY,pointerId:event.pointerId,isTrusted:event.isTrusted,defaultPrevented:event.defaultPrevented});
    const scroll = event => record('scroll', {target:describe(event.target),scrollX,scrollY});
    const menus = node => node.nodeType === 1 ? [...(node.matches('.scene3d-menu') ? [node] : []),...node.querySelectorAll('.scene3d-menu')] : [];
    const observer = new MutationObserver(records => {
      for(const mutation of records) {
        for(const node of mutation.addedNodes) for(const menu of menus(node)) record('menu-added',{menu:describe(menu),strong:menu.querySelector('strong')?.textContent,connected:menu.isConnected});
        for(const node of mutation.removedNodes) for(const menu of menus(node)) record('menu-removed',{menu:describe(menu),strong:menu.querySelector('strong')?.textContent,connected:menu.isConnected});
        const element=mutation.target.nodeType===1?mutation.target:mutation.target.parentElement;
        if(element?.closest('.scene3d-menu')) record('menu-mutated',{strong:element.closest('.scene3d-menu').querySelector('.scene3d-menu .location-info-name, .scene3d-menu .npc-info-name')?.textContent,mutation:mutation.type});
      }
    });
    document.addEventListener('pointerdown',pointer,true); document.addEventListener('pointerup',pointer,true); window.addEventListener('scroll',scroll,true);
    observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true});
    window.__npcCausalProbe={events,live,record,cleanup(){observer.disconnect();document.removeEventListener('pointerdown',pointer,true);document.removeEventListener('pointerup',pointer,true);window.removeEventListener('scroll',scroll,true);}};
    record('observer-installed');
  });
}

export async function npcOverlayDiagnostic(ctx) {
  await releaseIdentity(ctx);
  return withGame(ctx, 'npc-overlay-probe', { payload: await payloadFor(['A']) }, async session => {
    const observations = [];
    await installNpcCausalObserver(session.page);
    try {
    const probe = async label => {
      const value = await session.page.evaluate(label => {
        const describe = node => { const s = getComputedStyle(node), r = node.getBoundingClientRect(); return { tag: node.tagName, id: node.id, className: String(node.className), pointerEvents: s.pointerEvents, zIndex: s.zIndex, display: s.display, visibility: s.visibility, opacity: s.opacity, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, outerHTML: node.outerHTML.slice(0, 1500) }; };
        window.__npcCausalProbe.record('checkpoint',{label});
        return { label, live: window.__npcCausalProbe.live(), diagnostics: GameSceneBridge.getDiagnostics(), points: [{x:245,y:159},{x:231,y:147}].map(p => ({...p,elements:document.elementsFromPoint(p.x,p.y).map(describe)})), masks:[...document.querySelectorAll('.slg-interaction-mask')].map(describe) };
      }, label);
      observations.push(value); await artifact(ctx.directory, 'npc-overlay-observations.json', observations);
    };
    await waitReady(session.page, 'cangjingge'); await probe('cold-A-epoch1');
    for (const id of ['A','B','C']) {
      await importPayload(ctx, session.page, `overlay-import-${id}`, await payloadFor([id]));
      await waitReady(session.page, 'cangjingge'); await quietFrames(session.page, 24); await probe(`import-${id}`);
      if (id !== 'C') { await runTurn(ctx, session, await fullResponse({}, `合成与${id}互动后检查遮罩`)); await waitReady(session.page, 'cangjingge'); await probe(`after-original-pipeline-${id}`); }
    }
    await capture(ctx, session.page, 'npc-overlay-C-live');
    await session.page.mouse.click(245, 159);
    await probe('C-after-one-real-click');
    await quietFrames(session.page, 24); await probe('C-after-24-frames');
    await artifact(ctx.directory, 'npc-overlay-click.json', { title: await session.page.evaluate(() => document.querySelector('.scene3d-menu .location-info-name, .scene3d-menu .npc-info-name')?.textContent || null) });
    return { observations: observations.length, scope: 'Read-only DOM/permission/event probes with one physical click; no raster scan or mask changes' };
    } finally {
      const events = await session.page.evaluate(() => { const probe=window.__npcCausalProbe; if(!probe)return []; probe.record('observer-cleanup');probe.cleanup();const events=probe.events;delete window.__npcCausalProbe;return events; });
      await artifact(ctx.directory, 'npc-causal-events.json', events);
    }
  });
}

export const implementations = {
  'P3-T01': locations, 'P3-T02': identities, 'P3-T03': refreshRules,
  'P3-T04': crowdingAndFailure, 'P3-T05': pickingAndLocks, 'P3-T06': environmentProjection,
  'P4-T01': modeMatrix, 'P4-T02': saveEntryMatrix, 'P4-T03': rollbackAndFailure,
  'P4-T04': specialPages, 'P4-T05': hostOverlays, 'P4-T06': configurationIsolation,
};
// P4-T07 intentionally has no implementation: real Android OS sharing is manual.
