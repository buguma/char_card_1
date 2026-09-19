// Supplementary real-host label lane; never replaces the renderer or edits game state.
// CLI: node tests/scene3d/location-labels.browser.mjs <new absolute report directory> [expected build ID]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { artifact, assertSessionSafe, fixturesRoot, hashFile, json, launchBrowser, newGameContext, saveSessionEvidence, startGame, workspace } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';
import { safeRelative, verifyRelease } from '../../scene3d/scripts/artifact-utils.mjs';
import { INTERIOR_SCENES } from '../../scene3d/src/interior-scenes.js';

const frames = (page, count = 24) => page.evaluate(count => new Promise(resolve => {
  let remaining = count; const tick = () => --remaining ? requestAnimationFrame(tick) : resolve(); requestAnimationFrame(tick);
}), count);
const expected = Object.fromEntries(Object.entries(INTERIOR_SCENES).filter(([id]) => id !== 'guest_quarters').map(([id, descriptor]) => [id, descriptor.label]));
async function sample(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.scene3d-canvas'), shell = document.querySelector('.scene3d-runtime');
    const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const shellRect = shell && rect(shell), status = document.querySelector('.scene.active .status-display');
    const statusOverlay = status ? { bounds: rect(status), background: getComputedStyle(status).backgroundColor, image: getComputedStyle(status).backgroundImage } : null;
    return { bodyClass: document.body.className, browserViewport: { width: innerWidth, height: innerHeight }, shell: shellRect, statusOverlay,
      diagnostics: GameSceneBridge.getDiagnostics(),
      labels: Array.from(document.querySelectorAll('.scene3d-location-label'), label => {
        const style = getComputedStyle(label), bounds = rect(label), layer = label.parentElement;
        const cx = bounds.left + bounds.width / 2, cy = bounds.top + bounds.height / 2;
        const visible = !label.hidden && !layer.hidden && style.display !== 'none' && bounds.width > 0 && bounds.height > 0;
        return { id: label.dataset.sceneId, text: label.textContent, hidden: label.hidden, layerHidden: layer.hidden, visible,
          bounds, anchor: { left: parseFloat(label.style.left), top: parseFloat(label.style.top) },
          clipped: visible && (bounds.left < shellRect.left || bounds.right > shellRect.right || bounds.top < shellRect.top || bounds.bottom > shellRect.bottom),
          statusOverlap: visible && statusOverlay && statusOverlay.background !== 'rgba(0, 0, 0, 0)' && bounds.left < statusOverlay.bounds.right && bounds.right > statusOverlay.bounds.left && bounds.top < statusOverlay.bounds.bottom && bounds.bottom > statusOverlay.bounds.top,
          inBrowser: visible && cx >= 0 && cx < innerWidth && cy >= 0 && cy < innerHeight,
          hitCanvas: visible && document.elementFromPoint(cx, cy) === canvas,
          style: { color: style.color, strokeColor: style.webkitTextStrokeColor, strokeWidth: style.webkitTextStrokeWidth,
            backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, boxShadow: style.boxShadow,
            borderWidths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
            pointerEvents: style.pointerEvents, layerPointerEvents: getComputedStyle(layer).pointerEvents } };
      }), input: window.__labelInput || [] };
  });
}
function movement(before, after) {
  return before.labels.flatMap(label => {
    const next = after.labels.find(item => item.id === label.id);
    return label.visible && next?.visible ? [{ id: label.id, pixels: Math.hypot(next.anchor.left - label.anchor.left, next.anchor.top - label.anchor.top) }] : [];
  });
}
async function sourceIdentity(root, release, manifest) {
  const files = ['module/scene3d-bridge.js', 'module/scene3d-host.css', 'assets/sect3d/current.json', `assets/sect3d/${release.manifest}`,
    `assets/sect3d/${release.buildId}/${manifest.entry}`, ...manifest.css.map(name => `assets/sect3d/${release.buildId}/${name}`)];
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await hashFile(path.join(root, file))])));
}

export async function verifyLocationLabels({ browser, server, directory, buildId, gameRoot }) {
  const root = gameRoot || server.root || workspace;
  const release = await json(path.join(root, 'assets/sect3d/current.json'));
  assert.equal(release.schemaVersion, 1, 'Unsupported current pointer schema');
  safeRelative(release.buildId); assert.ok(!release.buildId.includes('/'), 'Invalid current build ID');
  assert.deepEqual(release.bridgeProtocol, { min: 1, max: 1 }, 'Unsupported current bridge protocol');
  assert.equal(release.manifest, `${release.buildId}/manifest.json`, 'Current manifest must belong to selected build');
  assert.match(release.manifestSha256, /^[a-f0-9]{64}$/, 'Current manifest hash required');
  if (buildId !== undefined) assert.equal(release.buildId, buildId, 'Expected build must match current pointer');
  buildId = release.buildId;
  const { manifest } = await verifyRelease(path.join(root, 'assets/sect3d', buildId), buildId, release.manifestSha256);
  const beforeSource = await sourceIdentity(root, release, manifest), results = [];
  await artifact(directory, 'source-before.json', beforeSource);
  for (const lane of [
    { name: 'desktop-1280x900-ui0', style: 0, viewport: { width: 1280, height: 900, deviceScaleFactor: 1 } },
    { name: 'mobile-390x844-ui1', style: 1, viewport: { width: 390, height: 844, deviceScaleFactor: 1 } },
  ]) {
    const payload = await json(path.join(fixturesRoot, 'saves/map.json'));
    const channel = `location-labels-${lane.name}`;
    const session = await newGameContext(browser, server, { payload, channel, style: lane.style, viewport: lane.viewport,
      scene3dPreferences: { enabled: true, quality: 'balanced', renderScale: 1.5, msaa: 2 } });
    const { page } = session, checks = [], evidence = {};
    const check = (name, passed, detail) => checks.push({ name, status: passed ? 'PASS' : 'FAIL', detail });
    const capture = async name => {
      const state = await sample(page); evidence[name] = state;
      await artifact(directory, `${lane.name}-${name}.json`, state);
      await page.screenshot({ path: path.join(directory, `${lane.name}-${name}.png`) });
      return state;
    };
    try {
      await startGame(session, server);
      if (await page.$eval('#modal', node => getComputedStyle(node).display !== 'none')) {
        const close = await page.$('#modal-buttons [onclick="closeModal()"]');
        assert.ok(close, 'Original close-modal control must exist'); await close.click();
      }
      await page.waitForFunction(() => { const d = GameSceneBridge.getDiagnostics(); return d.readyScene === 'main' && d.renderer?.interactionEnabled && d.renderer?.frames > 2; }, { timeout: 150000 });
      await page.evaluate(() => {
        window.__labelInput = [];
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel']) document.querySelector('.scene3d-canvas').addEventListener(type, event => {
          __labelInput.push({ type, trusted: event.isTrusted, x: event.clientX, y: event.clientY, deltaY: event.deltaY });
        }, { passive: true });
      });
      await frames(page);
      const initial = await capture('initial');
      check('loaded final current release', initial.diagnostics.buildId === buildId, initial.diagnostics.buildId);
      check('11 authored names, guest-room label suppressed', initial.labels.length === 11 && JSON.stringify(Object.fromEntries(initial.labels.map(l => [l.id, l.text]).sort())) === JSON.stringify(Object.fromEntries(Object.entries(expected).sort())), initial.labels.map(l => ({ id: l.id, text: l.text })));
      const hidden = initial.labels.filter(l => !l.visible), clipped = initial.labels.filter(l => l.clipped);
      // The actual east pavilion roof can leave the frustum in a close view.
      // Never demand a bridge substitute or screen-edge clamp to make it fit.
      check('main names visible; actual pavilion may be frustum-hidden', hidden.every(l => l.id === 'back_mountain'), hidden.map(l => l.id));
      check('central names have unclipped glyph boxes; pavilion remains world-attached', clipped.every(l => l.id === 'back_mountain'), clipped.map(l => ({ id: l.id, bounds: l.bounds })));
      check('no names painted under opaque host status overlay', initial.labels.every(l => !l.statusOverlap), { overlay: initial.statusOverlay, overlaps: initial.labels.filter(l => l.statusOverlap).map(l => ({ id: l.id, bounds: l.bounds })) });
      check('white text, black 2px stroke, no border/background/shadow', initial.labels.every(l => l.style.color === 'rgb(255, 255, 255)' && l.style.strokeColor === 'rgb(0, 0, 0)' && l.style.strokeWidth === '2px' && l.style.backgroundColor === 'rgba(0, 0, 0, 0)' && l.style.backgroundImage === 'none' && l.style.boxShadow === 'none' && l.style.borderWidths.every(width => width === '0px')), initial.labels.map(l => ({ id: l.id, style: l.style })));
      check('labels and layer never intercept pointer events', initial.labels.every(l => l.style.pointerEvents === 'none' && l.style.layerPointerEvents === 'none'));
      const probe = initial.labels.find(l => l.visible && !l.clipped && l.inBrowser && l.hitCanvas);
      check('actual canvas receives hit test beneath a name', Boolean(probe), initial.labels.map(l => ({ id: l.id, hitCanvas: l.hitCanvas })));
      assert.ok(probe, 'Need an unobscured label for a trusted orbit gesture');
      const x = probe.bounds.left + probe.bounds.width / 2, y = probe.bounds.top + probe.bounds.height / 2;
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + Math.min(70, initial.shell.width * .2), y + 8, { steps: 12 }); await page.mouse.up();
      await frames(page, 48);
      const orbit = await capture('orbited'), orbitMovement = movement(initial, orbit);
      check('real orbit changes projected name positions', orbitMovement.some(l => l.pixels > 1), orbitMovement);
      check('orbit changes real camera position', JSON.stringify(initial.diagnostics.renderer.cameraView.position) !== JSON.stringify(orbit.diagnostics.renderer.cameraView.position));
      check('native pointer gesture passes through label into canvas', orbit.input.some(e => e.type === 'pointerdown' && e.trusted) && orbit.input.some(e => e.type === 'pointerup' && e.trusted));
      await page.mouse.move(initial.shell.left + initial.shell.width / 2, initial.shell.top + initial.shell.height / 2);
      await page.mouse.wheel({ deltaY: -160 }); await frames(page, 36);
      const zoomed = await capture('zoomed'), zoomMovement = movement(orbit, zoomed);
      check('real wheel zoom reprojects labels', zoomMovement.some(l => l.pixels > 1) && zoomed.diagnostics.renderer.cameraView.zoom !== orbit.diagnostics.renderer.cameraView.zoom, zoomMovement);
      check('trusted wheel event reached actual canvas', zoomed.input.some(e => e.type === 'wheel' && e.trusted));
      // A diagnostic native zoom-out distinguishes frustum-hidden labels from
      // missing authored text. Never clamp/reposition labels from the test.
      for (let attempt = 0; attempt < 8; attempt++) {
        await page.mouse.wheel({ deltaY: 500 }); await frames(page, 24);
        const state = await sample(page);
        if (state.labels.every(l => l.visible && !l.clipped && !l.statusOverlap) || state.diagnostics.renderer.cameraView.zoom <= .5) break;
      }
      const overview = await capture('zoomed-out');
      check('native overview can reveal all names without clipping or status overlap', overview.labels.every(l => l.visible && !l.clipped && !l.statusOverlap), overview.labels.filter(l => !l.visible || l.clipped || l.statusOverlap).map(l => ({ id: l.id, hidden: l.hidden, clipped: l.clipped, statusOverlap: l.statusOverlap })));
      // Call the existing host navigation action: no direct renderer apply or scene
      // mutation, and no NPC focus/action lane is exercised by this label test.
      await page.evaluate(() => goToLocation('cangjingge'));
      await page.waitForFunction(() => { const d = GameSceneBridge.getDiagnostics(); return d.readyScene === 'library' && d.renderer?.interactionEnabled; }, { timeout: 150000 });
      await frames(page);
      const room = await capture('room');
      check('room navigation removes all main-scene labels', room.labels.length === 0 && room.diagnostics.renderer.locationLabels.count === 0, room.diagnostics.renderer.locationLabels);
      assertSessionSafe(session, server, channel);
      check('isolated host has no page errors or unexpected external traffic', true);
    } catch (error) {
      check('execution', false, error.stack);
      try { await capture('failure'); } catch { /* Always preserve logs below. */ }
    } finally {
      try {
        await artifact(directory, `${lane.name}-checks.json`, checks);
        await saveSessionEvidence(session, directory, lane.name);
      } finally { await session.close(); }
    }
    results.push({ ...lane, checks, failures: checks.filter(c => c.status === 'FAIL'), initialHidden: evidence.initial?.labels.filter(l => !l.visible).map(l => l.id), initialClipped: evidence.initial?.labels.filter(l => l.clipped).map(l => l.id) });
    console.log(JSON.stringify({ lane: lane.name, checks: checks.length, failures: results.at(-1).failures }));
  }
  const afterSource = await sourceIdentity(root, release, manifest);
  await artifact(directory, 'source-after.json', afterSource);
  const sourceStable = JSON.stringify(beforeSource) === JSON.stringify(afterSource);
  const summary = { release, sourceStable, results, scope: 'Synthetic map.json host saves; real current published assets; isolated Chromium contexts; desktop and mobile-size mouse/wheel input, not physical touch hardware. No NPC action/focus tests.' };
  await artifact(directory, 'location-labels-results.json', summary);
  assert.equal(sourceStable, true, 'Production source or release changed during this lane');
  return summary;
}

async function main() {
  const directory = process.argv[2], buildId = process.argv[3];
  assert.ok(directory && path.isAbsolute(directory), 'Provide a new absolute evidence directory');
  await mkdir(directory, { recursive: false });
  const server = await startTestServer({ gameRoot: workspace }); let browser;
  try {
    console.log(JSON.stringify({ directory, url: server.origin, buildId }));
    browser = await launchBrowser();
    const result = await verifyLocationLabels({ browser, server, directory, buildId });
    process.exitCode = result.results.some(lane => lane.failures.length) ? 1 : 0;
    console.log(JSON.stringify({ directory, sourceStable: result.sourceStable, status: process.exitCode ? 'FAIL' : 'PASS' }));
  } finally { try { if (browser) await browser.close(); } finally { await server.close(); } }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
