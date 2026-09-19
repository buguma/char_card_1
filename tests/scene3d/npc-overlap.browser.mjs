import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { artifact, launchBrowser, sha256, workspace } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';

/**
 * P3-T05 independent runtime/WebGL overlap branch (NOT full game integration).
 * Import contract: await npcOverlap({ browser, server, directory, buildId? }).
 * browser/server are caller-owned test-support/test-server instances; this helper
 * creates/closes its own BrowserContext, never changes shared server asset rules,
 * and writes evidence only beneath a caller-supplied .scene3d-work directory.
 * Returns serializable PASS evidence or throws (after saving failure evidence).
 * No top-level browser/server work on import. Direct invocation runs only this branch.
 * Source runtime + real Three/GLTFLoader/default PNG decoder/picker/input are used.
 * Fixture seams: synthetic legal floor GLB, two static PNGs, normalized host snapshot,
 * camera projection before ticks, and a real opaque mesh. No placement/pick override,
 * no business roster/RNG change, fabricated intent, DOM dispatch or postMessage.
 */
export const NPC_OVERLAP_CONTRACT = Object.freeze({
  version: 1, scope: 'runtime-browser-controlled-fixture', inputs: ['browser', 'server', 'directory', 'buildId?'],
  cases: ['transparent-front-to-back', 'opaque-front-to-front', 'both-transparent-miss', 'solid-occlusion-miss'],
  inputModes: ['mouse', 'touch'], realAndroid: false, fullGameIntegration: false,
});

function chunk(type, data) {
  const name = Buffer.from(type); let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  const head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, name, data, tail]);
}
// Independent CPU oracle, specified in PNG top-left pixel coordinates. All borders
// are opaque, so production alphaBounds must retain the full 128x128 image.
function alpha(id, x, y) {
  return id === 'A' ? (x >= 32 && x < 96 && y >= 32 && y < 96 ? 0 : 255)
    : (x >= 76 && x < 108 && y >= 44 && y < 84 ? 0 : 255);
}
function portrait(id) {
  const raw = Buffer.alloc(128 * 513);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const p = y * 513 + 1 + x * 4;
    raw[p] = id === 'A' ? 255 : 0; raw[p + 1] = id === 'D' ? 255 : 0; raw[p + 2] = id === 'A' ? 255 : 0; raw[p + 3] = alpha(id, x, y);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(128); ihdr.writeUInt32BE(128, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function pixels(png) {
  const parts = []; let width, height, channels;
  for (let p = 8; p < png.length;) {
    const n = png.readUInt32BE(p), type = png.toString('ascii', p + 4, p + 8), data = png.subarray(p + 8, p + 8 + n);
    if (type === 'IHDR') { width = data.readUInt32BE(); height = data.readUInt32BE(4); assert.equal(data[8], 8); assert.ok([2, 6].includes(data[9])); assert.equal(data[12], 0); channels = data[9] === 6 ? 4 : 3; }
    if (type === 'IDAT') parts.push(data); p += 12 + n;
  }
  const raw = inflateSync(Buffer.concat(parts)), stride = width * channels, out = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => { const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c); return da <= db && da <= dc ? a : db <= dc ? b : c; };
  for (let y = 0; y < height; y++) for (let x = 0; x < stride; x++) {
    const i = y * stride + x, a = x >= channels ? out[i - channels] : 0, b = y ? out[i - stride] : 0, c = y && x >= channels ? out[i - stride - channels] : 0;
    const f = raw[y * (stride + 1)]; assert.ok(f <= 4); out[i] = (raw[y * (stride + 1) + x + 1] + [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][f]) & 255;
  }
  return { width, height, rgba(x, y) { const i = (y * width + x) * channels; return [...out.subarray(i, i + 3), channels === 4 ? out[i + 3] : 255]; } };
}
function floorGlb() {
  // Two explicitly upward CCW triangles, 20m square, y=0; no custom sampler.
  const positions = [-10, 0, -10, -10, 0, 10, 10, 0, -10, 10, 0, -10, -10, 0, 10, 10, 0, 10];
  const bin = Buffer.alloc(positions.length * 4); positions.forEach((v, i) => bin.writeFloatLE(v, i * 4));
  const doc = { asset: { version: '2.0', generator: 'npc-overlap controlled legal fixture' }, extensionsUsed: ['KHR_materials_unlit'], scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'floor', mesh: 0, extras: { npcSpawn: { authored: true } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ extensions: { KHR_materials_unlit: {} }, pbrMetallicRoughness: { baseColorFactor: [0.3, 0.3, 0.3, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length, target: 34962 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 6, type: 'VEC3', min: [-10, 0, -10], max: [10, 0, 10] }] };
  const text = Buffer.from(JSON.stringify(doc)), data = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 32)]);
  const head = Buffer.alloc(12), jhead = Buffer.alloc(8), bhead = Buffer.alloc(8);
  head.write('glTF'); head.writeUInt32LE(2, 4); head.writeUInt32LE(28 + data.length + bin.length, 8);
  jhead.writeUInt32LE(data.length); jhead.write('JSON', 4); bhead.writeUInt32LE(bin.length); bhead.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jhead, data, bhead, bin]);
}
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

export async function npcOverlap({ browser, server, directory, buildId }) {
  assert.ok(browser && server?.origin && directory, 'browser, test server and diagnostic directory required');
  directory = path.resolve(directory);
  const relative = path.relative(path.join(workspace, '.scene3d-work'), directory);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Evidence must be in an independent .scene3d-work subdirectory');
  await mkdir(directory, { recursive: true });
  const pointerPath = path.join(server.root, 'assets/sect3d/current.json'), pointerBefore = await readFile(pointerPath);
  const release = JSON.parse(pointerBefore);
  assert.equal(release.schemaVersion, 1, 'Unsupported current pointer schema');
  assert.ok(typeof release.buildId === 'string' && release.buildId.length > 0, 'Current build ID required');
  if (buildId !== undefined) assert.equal(release.buildId, buildId, 'Expected build must match current pointer');
  buildId = release.buildId; // Reference only: this branch executes source plus controlled fixtures, not this release.
  const context = await browser.createBrowserContext(), page = await context.newPage();
  const network = [], pageerrors = [], violations = [], consoleErrors = [], evidence = [], sourceHashes = {};
  const pngs = { A: portrait('A'), D: portrait('D') }, glb = floorGlb();
  for (const id of ['A', 'D']) { const decoded = pixels(pngs[id]); for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) assert.equal(decoded.rgba(x, y)[3], alpha(id, x, y), 'Encoded PNG and independent CPU alpha contract agree'); }
  let result, failure, cdp;
  page.on('pageerror', e => pageerrors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') consoleErrors.push(e.text()); });
  page.on('response', response => network.push({ event: 'response', url: response.url(), status: response.status() }));
  page.on('requestfailed', request => network.push({ event: 'failed', url: request.url(), failure: request.failure() }));
  await page.setViewport({ width: 800, height: 640, deviceScaleFactor: 1, hasTouch: true });
  await page.setRequestInterception(true);
  page.on('request', async request => {
    try {
      const url = new URL(request.url());
      if (url.origin !== server.origin || request.method() !== 'GET') { violations.push(request.url()); await request.abort('blockedbyclient'); return; }
      const pathname = decodeURIComponent(url.pathname); let body, contentType, source;
      if (pathname === '/npc-overlap.html') {
        contentType = 'text/html'; body = '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/assets/overlap-source/scene3d.css"><style>body{margin:0;background:#eee}#host{position:relative;width:640px;height:480px;margin:40px}</style><div id="host"></div><script type="importmap">{"imports":{"three":"/assets/overlap-three/build/three.module.js","three/addons/":"/assets/overlap-three/examples/jsm/"}}</script>';
      } else if (['/assets/overlap-fixture/sect_diorama.glb', '/assets/overlap-fixture/sub_scene/library_interior.glb'].includes(pathname)) { body = glb; contentType = 'model/gltf-binary'; }
      else if (/^\/assets\/overlap-fixture\/[AD]\.png$/.test(pathname)) { body = pngs[path.basename(pathname, '.png')]; contentType = 'image/png'; }
      else if (pathname.startsWith('/assets/overlap-source/')) source = path.join(workspace, 'scene3d/src', pathname.slice('/assets/overlap-source/'.length));
      else if (pathname.startsWith('/assets/overlap-three/')) source = path.join(workspace, 'scene3d/node_modules/three', pathname.slice('/assets/overlap-three/'.length));
      else { violations.push(`Unexpected fixture request: ${pathname}`); await request.abort('blockedbyclient'); return; }
      if (source) { body = await readFile(source); sourceHashes[path.relative(workspace, source)] = sha256(body); contentType = source.endsWith('.css') ? 'text/css' : 'text/javascript'; }
      network.push({ event: 'request', method: request.method(), url: url.href, action: source ? 'unmodified-source' : 'controlled-fixture', sha256: sha256(body) });
      await request.respond({ status: 200, contentType, body });
    } catch (error) { violations.push(error.stack); if (!request.isInterceptResolutionHandled()) await request.abort(); }
  });
  try {
    await page.goto(`${server.origin}/npc-overlap.html`);
    const setup = await page.evaluate(async () => {
      // Observe real browser timer/RAF ownership. No time or rendering API is stubbed.
      const timers = new Set(), rafs = new Set(), nativeTimeout = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window), nativeRaf = window.requestAnimationFrame.bind(window), nativeCancel = window.cancelAnimationFrame.bind(window);
      window.setTimeout = (fn, ms, ...args) => { let id; id = nativeTimeout(() => { timers.delete(id); typeof fn === 'function' ? fn(...args) : (0, eval)(fn); }, ms); timers.add(id); return id; };
      window.clearTimeout = id => { timers.delete(id); nativeClear(id); };
      window.requestAnimationFrame = fn => { let id; id = nativeRaf(now => { rafs.delete(id); fn(now); }); rafs.add(id); return id; };
      window.cancelAnimationFrame = id => { rafs.delete(id); nativeCancel(id); };
      const THREE = await import('three'), { mount } = await import('/assets/overlap-source/runtime.js'), { createNpcController } = await import('/assets/overlap-source/npcs.js');
      let ctx, npc, cameraFixture; const events = [], input = [], disposed = { geometry: 0, material: 0, texture: 0 };
      const view = mount(document.querySelector('#host'), { assetBaseUrl: new URL('/assets/overlap-fixture/', location.href).href, quality: 'low', reducedMotion: true,
        onEvent: event => events.push(event), npcFactory(value) {
          ctx = value; npc = createNpcController(value);
          // Runtime controls constrain the normal gameplay camera; reset ONLY fixture
          // projection just before the real tick. bind/placement/pick remain original.
          return { ...npc, tick(...args) { cameraFixture?.(); return npc.tick(...args); } };
        } });
      window.__overlap = { view }; // Permit cleanup even if fixture setup fails.
      const applied = await view.applyState({ protocol: 1, sessionEpoch: 5, revision: 1, mode: 0, logicalPage: 'cangjingge', gameLocationId: 'cangjingge', sceneId: 'library', layoutKey: 'p3t05-overlap-fixed-layout',
        residents: ['A', 'D'].map(gameNpcId => ({ gameNpcId, displayName: `Fixture ${gameNpcId}` })),
        renderedNpcs: ['A', 'D'].map(gameNpcId => ({ gameNpcId, visualKind: 'static', visualKey: `overlap-${gameNpcId}`, portraitUrl: new URL(`/assets/overlap-fixture/${gameNpcId}.png`, location.href).href, heightMeters: 1.5 })),
        environment: { season: 'winter', hour: 12 }, visible: true, interactive: true, renderEnabled: true, blockReasons: [] });
      if (npc.getStats().cards !== 2) throw Error(`Expected two production cards: ${JSON.stringify({ applied, stats: npc.getStats(), events })}`);
      const cards = ['A', 'D'].map(id => ctx.scene.getObjectByName(`Scene3D_NPC_${id}`)), feetBefore = npc.getStats().residents.map(n => n.foot);
      const a = new THREE.Vector3(...feetBefore[0]), d = new THREE.Vector3(...feetBefore[1]), direction = a.clone().sub(d).normalize(), target = a.clone().add(d).multiplyScalar(.5).add(new THREE.Vector3(0, .75, 0));
      cameraFixture = () => { const c = ctx.camera; c.position.copy(target).addScaledVector(direction, 30); c.lookAt(target); c.zoom = 1; c.left = -2; c.right = 2; c.top = 1.5; c.bottom = -1.5; c.updateProjectionMatrix(); c.updateMatrixWorld(true); };
      cameraFixture(); npc.tick(0, 0);
      for (const card of cards) {
        card.geometry.addEventListener('dispose', () => disposed.geometry++); card.material.addEventListener('dispose', () => disposed.material++); card.material.map.addEventListener('dispose', () => disposed.texture++);
      }
      const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 2, .2), new THREE.MeshBasicMaterial({ color: '#0000ff' }));
      wall.name = 'FixtureSolidOccluder'; wall.position.copy(a).add(new THREE.Vector3(0, .75, 0)).addScaledVector(direction, .7); wall.quaternion.copy(cards[0].quaternion); wall.visible = false;
      cards[0].parent.parent.add(wall); // Owning GLB root discovers this mesh during release; do not double-register.
      for (const type of ['pointerdown', 'pointerup']) ctx.renderer.domElement.addEventListener(type, event => input.push({ type, pointerType: event.pointerType, isTrusted: event.isTrusted, x: event.clientX, y: event.clientY, timeStamp: event.timeStamp }));
      // Analytic ray-plane intersection, NOT Mesh.raycast/npc.pick and never reads
      // the production alpha mask. Node independently evaluates the PNG formula.
      function oracleAt(x, y) {
        const rect = ctx.renderer.domElement.getBoundingClientRect(), c = ctx.camera;
        const origin = new THREE.Vector3((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2, -1).unproject(c);
        const ray = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion);
        return cards.map(card => {
          const planePoint = card.getWorldPosition(new THREE.Vector3()), normal = new THREE.Vector3(0, 0, 1).transformDirection(card.matrixWorld);
          const distance = planePoint.clone().sub(origin).dot(normal) / ray.dot(normal), world = origin.clone().addScaledVector(ray, distance), local = card.worldToLocal(world.clone());
          return { id: card.userData.gameNpcId, distance, local: local.toArray(), pixel: [Math.floor((local.x + .5) * 128), Math.floor((1 - local.y) * 128)], inside: local.x > -.5 && local.x < .5 && local.y > 0 && local.y < 1 };
        }).sort((a, b) => a.distance - b.distance);
      }
      function wallOracle(x, y) {
        if (!wall.visible) return null;
        const r = ctx.renderer.domElement.getBoundingClientRect(), origin = new THREE.Vector3((x-r.left)/r.width*2-1, 1-(y-r.top)/r.height*2, -1).unproject(ctx.camera), direction = new THREE.Vector3(0,0,-1).applyQuaternion(ctx.camera.quaternion);
        const ray = new THREE.Ray(origin.clone(), direction.clone()).applyMatrix4(wall.matrixWorld.clone().invert());
        const local = ray.intersectBox(new THREE.Box3(new THREE.Vector3(-1,-1,-.1), new THREE.Vector3(1,1,.1)), new THREE.Vector3());
        return local ? local.applyMatrix4(wall.matrixWorld).distanceTo(origin) : null;
      }
      function point(pixelX, pixelY) {
        const p = new THREE.Vector3((pixelX + .5) / 128 - .5, 1 - (pixelY + .5) / 128, 0).applyMatrix4(cards[0].matrixWorld).project(ctx.camera), r = ctx.renderer.domElement.getBoundingClientRect();
        const x = Math.round(r.left + (p.x + 1) * r.width / 2), y = Math.round(r.top + (1 - p.y) * r.height / 2);
        return { x, y, intersections: oracleAt(x, y), canvasOnTop: document.elementFromPoint(x, y) === ctx.renderer.domElement };
      }
      const gl = ctx.renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
      window.__overlap = { view, ctx, npc, wall, cards, events, input, disposed, timers, rafs, oracleAt, wallOracle,
        timerStats: () => ({ timers: timers.size, rafs: rafs.size }),
        destroy: async () => { await view.destroy(); return { runtime: view.getDiagnostics(), gpu: { ...ctx.renderer.info.memory }, disposed, timers: timers.size, rafs: rafs.size, canvases: document.querySelectorAll('canvas').length }; } };
      return { applied, feetBefore, feetAfter: npc.getStats().residents.map(n => n.foot), direction: direction.toArray(), camera: { position: ctx.camera.position.toArray(), target: target.toArray(), matrixWorld: ctx.camera.matrixWorld.toArray(), projection: ctx.camera.projectionMatrix.toArray() },
        cards: cards.map(card => ({ id: card.userData.gameNpcId, matrixWorld: card.matrixWorld.toArray(), scale: card.scale.toArray(), frameRect: { x: card.userData.frameRect.x, y: card.userData.frameRect.y, width: card.userData.frameRect.width, height: card.userData.frameRect.height } })),
        wall: { name: wall.name, dimensions: [2, 2, .2], matrixWorld: (wall.updateMatrixWorld(true), wall.matrixWorld.toArray()), depthWrite: wall.material.depthWrite, opacity: wall.material.opacity },
        points: { through: point(48, 64), front: point(16, 64), neither: point(88, 64) }, gpu: { webgl2: gl instanceof WebGL2RenderingContext, renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) }, diagnostics: view.getDiagnostics() };
    });
    await artifact(directory, 'setup.json', setup);
    assert.equal(setup.applied.status, 'applied'); assert.equal(setup.gpu.webgl2, true); assert.deepEqual(setup.feetAfter, setup.feetBefore);
    assert.equal(setup.diagnostics.npc.cards, 2); assert.deepEqual(setup.diagnostics.npc.fallbacks, []);
    for (const p of Object.values(setup.points)) { assert.equal(p.canvasOnTop, true); assert.deepEqual(p.intersections.map(n => n.id), ['A', 'D']); assert.ok(p.intersections.every(n => n.inside)); assert.ok(p.intersections[1].distance - p.intersections[0].distance > .1); }
    for (const card of setup.cards) assert.deepEqual(card.frameRect, { x: 0, y: 0, width: 128, height: 128 });
    cdp = await page.createCDPSession();
    const cases = [
      { name: 'transparent-front-to-back', point: setup.points.through, expected: 'D', expectedAlpha: [0, 255] },
      { name: 'opaque-front-to-front', point: setup.points.front, expected: 'A', expectedAlpha: [255, 255] },
      { name: 'both-transparent-miss', point: setup.points.neither, expected: null, expectedAlpha: [0, 0] },
      { name: 'solid-occlusion-miss', point: setup.points.through, expected: null, expectedAlpha: [0, 255], wall: true },
    ];
    for (const mode of ['mouse', 'touch']) for (const test of cases) {
      const expectedAlpha = test.point.intersections.map(hit => alpha(hit.id, ...hit.pixel)); assert.deepEqual(expectedAlpha, test.expectedAlpha);
      await page.evaluate(wall => { window.__overlap.wall.visible = wall; window.__overlap.wall.updateMatrixWorld(true); }, Boolean(test.wall));
      await frames(page);
      const before = await page.evaluate(() => ({ events: __overlap.events.length, input: __overlap.input.length, diagnostics: __overlap.view.getDiagnostics(), gpu: { ...__overlap.ctx.renderer.info.memory } }));
      assert.equal(before.diagnostics.interactionEnabled, true); assert.ok(before.gpu.textures >= 2 && before.gpu.geometries >= 3);
      const { x, y } = test.point;
      if (mode === 'mouse') await page.mouse.click(x, y);
      else { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
      await frames(page);
      const after = await page.evaluate(({ events, input, x, y }) => ({ events: __overlap.events.slice(events), input: __overlap.input.slice(input), intersections: __overlap.oracleAt(x, y), wallDistance: __overlap.wallOracle(x, y), feet: __overlap.npc.getStats().residents.map(n => n.foot) }), { ...before, x, y });
      const actual = after.events.filter(e => e.type === 'npcIntent');
      const screenshot = `${mode}-${test.name}.png`, png = Buffer.from(await page.screenshot({ path: path.join(directory, screenshot) })), color = pixels(png).rgba(x, y);
      const record = { mode, case: test.name, expected: test.expected, selectedIds: actual.map(e => e.gameNpcId), point: test.point, expectedAlpha, actualEvents: actual, input: after.input, screenshot, screenshotSha256: sha256(png), rgba: color, wallDistance: after.wallDistance, intersectionsAfterInput: after.intersections };
      evidence.push(record); await artifact(directory, 'cases.json', evidence);
      assert.deepEqual(actual.map(e => e.gameNpcId), test.expected ? [test.expected] : [], `${mode}/${test.name}`);
      assert.deepEqual(after.feet, setup.feetBefore, 'Fixture projection/input must not reroll or move cards');
      assert.deepEqual(after.input.map(e => e.type), ['pointerdown', 'pointerup']); assert.ok(after.input.every(e => e.isTrusted && e.pointerType === mode));
      assert.deepEqual(after.intersections.map(h => alpha(h.id, ...h.pixel)), expectedAlpha, 'Projection must remain stable through native input');
      if (test.expected === 'A') assert.ok(color[0] > color[1] * 1.3 && color[2] > color[1] * 1.3, `Expected actual magenta front pixel: ${color}`);
      if (test.expected === 'D') assert.ok(color[1] > color[0] * 1.3 && color[1] > color[2] * 1.3, `Expected actual green rear pixel: ${color}`);
      if (test.name === 'both-transparent-miss') assert.deepEqual(color, pixels(png).rgba(100, 450), 'Both holes must reveal the actual empty background');
      if (test.wall) { assert.ok(color[2] > color[0] * 1.3 && color[2] > color[1] * 1.3, `Expected actual solid blue occluder pixel: ${color}`); assert.ok(after.wallDistance > 0 && after.wallDistance < after.intersections[0].distance - .02, 'CPU ray-box oracle proves solid mesh in front of both cards'); assert.ok(Math.abs(after.intersections[0].distance - after.wallDistance - .8) < 1e-6, 'Solid front face is exactly .7 + .1 meters ahead of front card'); }
      for (const event of actual) { assert.equal(event.epoch, 5); assert.equal(event.revision, 1); assert.equal(event.anchor.space, 'client-css-px'); assert.ok(event.anchor.width > 0 && event.anchor.height > 0); }
    }
    // Causal control: remove only the wall, same coordinate and same two cards.
    await page.evaluate(() => { __overlap.wall.visible = false; }); await frames(page);
    const count = await page.evaluate(() => __overlap.events.length);
    await page.mouse.click(setup.points.through.x, setup.points.through.y); await frames(page);
    const restored = await page.evaluate(n => __overlap.events.slice(n).filter(e => e.type === 'npcIntent').map(e => e.gameNpcId), count); assert.deepEqual(restored, ['D']);
    const cleanup = await page.evaluate(() => __overlap.destroy());
    await frames(page);
    const settled = await page.evaluate(() => ({ timers: __overlap.timerStats(), frames: __overlap.view.getDiagnostics().frames, contextLost: __overlap.ctx.renderer.getContext().isContextLost() }));
    await artifact(directory, 'cleanup.json', { cleanup, settled });
    const d = cleanup.runtime;
    for (const key of ['raf', 'listeners', 'controls', 'observers', 'renderers', 'canvases', 'decoders', 'fetches', 'pendingLoads', 'resources', 'roots', 'geometries', 'materials', 'textures', 'pending', 'cachedRooms']) assert.equal(d[key], 0, `Clean runtime ${key}`);
    assert.equal(d.destroyed, true); assert.equal(d.rendererCreated, d.rendererDisposed); assert.equal(d.registered, d.disposed); assert.equal(d.errors, 0); assert.equal(d.npcErrors, 0);
    for (const key of ['cards', 'cachedAssets', 'pinnedAssets', 'pendingLoads', 'alphaBytes', 'fallbackListeners']) assert.equal(d.npc[key], 0, `Clean NPC ${key}`);
    assert.equal(d.npc.texturesCreated, 2); assert.equal(d.npc.texturesDisposed, 2); assert.equal(d.npc.imagesDisposed, 2);
    assert.deepEqual(cleanup.disposed, { geometry: 2, material: 2, texture: 2 }); assert.deepEqual(cleanup.gpu, { geometries: 0, textures: 0 });
    assert.equal(d.compilation.pending, 0); assert.equal(d.compilation.timers, 0); assert.equal(d.compilation.materialListeners, 0); assert.equal(d.compilation.disposed, true);
    assert.equal(cleanup.timers, 0); assert.equal(cleanup.rafs, 0); assert.equal(cleanup.canvases, 0); assert.deepEqual(settled.timers, { timers: 0, rafs: 0 }); assert.equal(settled.frames, d.frames); assert.equal(settled.contextLost, true, 'Real GPU context released');
    assert.deepEqual(pageerrors, []); assert.deepEqual(violations, []); assert.deepEqual(consoleErrors, []);
    assert.ok(network.filter(n => n.event === 'response').every(n => n.status === 200)); assert.equal(network.filter(n => n.event === 'failed').length, 0);
    for (const suffix of ['runtime.js', 'npcs.js', 'library_interior.glb', '/A.png', '/D.png']) assert.ok(network.some(n => n.event === 'response' && n.url.endsWith(suffix) && n.status === 200), `HTTP200 ${suffix}`);
    result = { status: 'PASS', contract: NPC_OVERLAP_CONTRACT, buildIdReference: buildId, sourceHashes, fixtureHashes: { floor: sha256(glb), A: sha256(pngs.A), D: sha256(pngs.D) }, cases: evidence, solidRemovalControl: restored, cleanup, pageerrors, violations,
      scope: 'Unmodified source runtime and createNpcController, real Three/WebGL/GLTFLoader/PNG decode; controlled legal floor + PNG + camera projection, fixed valid snapshot. Not bundled full game menu/battle integration, not physical Android. Existing 37jfr9 asset and current pointer are untouched.' };
  } catch (error) { failure = error; await artifact(directory, 'failure.json', { message: error.message, stack: error.stack, evidence, pageerrors, violations, consoleErrors }); try { await page.screenshot({ path: path.join(directory, 'failure.png') }); } catch {} }
  finally {
    try { if (!page.isClosed()) await page.evaluate(async () => { if (window.__overlap) await window.__overlap.view.destroy(); }); } catch {}
    await artifact(directory, 'network.json', { network, pageerrors, violations, consoleErrors });
    await artifact(directory, 'source-hashes.json', sourceHashes);
    await cdp?.detach(); await context.close();
    assert.equal(sha256(await readFile(pointerPath)), sha256(pointerBefore), 'Never switch current');
  }
  if (failure) throw failure;
  await artifact(directory, 'result.json', result); return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let browser, server;
  const directory = path.join(workspace, '.scene3d-work', `npc-overlap-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  try {
    server = await startTestServer({ gameRoot: workspace }); browser = await launchBrowser();
    const result = await npcOverlap({ browser, server, directory });
    console.log(JSON.stringify({ status: result.status, cases: result.cases.length, inputs: NPC_OVERLAP_CONTRACT.inputModes, directory }));
  } catch (error) { console.error(error.stack); console.error(`Evidence: ${directory}`); process.exitCode = 1; }
  finally { await browser?.close(); await server?.close(); }
}
