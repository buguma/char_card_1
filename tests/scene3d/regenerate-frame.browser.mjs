// Run: node tests/scene3d/regenerate-frame.browser.mjs
// Real host + published WebGL renderer, isolated synthetic saves, owned mock SSE only.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifact, assertSessionSafe, fixturesRoot, json, launchBrowser, newGameContext, saveSessionEvidence, startGame, workspace } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';
import { inspectPublishedBuild, waitForLatestApplied } from './p1.browser.mjs';
import { studyWithStream } from './p2.browser.mjs';

async function observe(page) {
  await page.evaluate(() => {
    const root = document.querySelector('#sect-3d-root');
    const viewport = document.querySelector('#main-viewport');
    const initial = GameSceneBridge.getDiagnostics().renderer;
    const trace = window.__regenFrame = { samples: 0, mutations: 0, violations: [], stopped: false, hold: true, turnSeen: false };
    const initialTop = root.style.top;
    const canvas = root.querySelector('canvas');
    const sample = source => {
      trace.samples++;
      const rect = root.getBoundingClientRect(), css = getComputedStyle(root);
      const renderer = GameSceneBridge.getDiagnostics().renderer;
      const cover = document.querySelector('.scene3d-page-turn');
      const covered = !!cover && !cover.hidden && getComputedStyle(cover).display !== 'none';
      if (covered) trace.turnSeen = true;
      if (trace.hold) {
        if (!renderer?.ready || renderer.activeSceneId !== initial.activeSceneId || renderer.instanceId !== initial.instanceId || renderer.pending !== 0 || root.querySelector('canvas') !== canvas)
          trace.violations.push({ source, reason: 'renderer-scene-lost', renderer });
        if (covered || root.style.top !== initialTop)
          trace.violations.push({ source, reason: 'premature-turn-or-root-move', covered, top: root.style.top, initialTop });
      }
      // Cross-scene unlock may clear readiness beneath its visible covering sheet.
      // Never permit this during generation or after the recovery cover is gone.
      if (!(covered && !trace.hold) && (root.hidden || viewport.dataset.scene3dReady !== 'true' || css.display === 'none' || css.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0))
        trace.violations.push({ source, hidden: root.hidden, ready: viewport.dataset.scene3dReady, display: css.display });
    };
    const observer = new MutationObserver(records => {
      trace.mutations += records.length;
      // Old values catch a clear-and-restore in one task, even if delivery sees ready again.
      const cover = document.querySelector('.scene3d-page-turn');
      const coveredRecovery = !trace.hold && cover && !cover.hidden && getComputedStyle(cover).display !== 'none';
      for (const r of records) {
        if (coveredRecovery) continue;
        if (r.target === viewport && r.attributeName === 'data-scene3d-ready' && r.oldValue !== 'true')
          trace.violations.push({ source: 'ready-mutation', oldValue: r.oldValue });
        if (r.target === root && r.attributeName === 'hidden' && r.oldValue !== null)
          trace.violations.push({ source: 'hidden-mutation', oldValue: r.oldValue });
      }
      sample('mutation');
    });
    observer.observe(viewport, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['hidden', 'data-scene3d-ready', 'style', 'class'] });
    const frame = () => { if (!trace.stopped) { sample('raf'); requestAnimationFrame(frame); } };
    requestAnimationFrame(frame);
    trace.stop = () => { sample('final'); trace.stopped = true; observer.disconnect(); };
    sample('initial');
  });
}

async function canvasEvidence(page, directory, label) {
  const canvas = await page.$('#sect-3d-root canvas');
  assert.ok(canvas, 'Real renderer canvas must exist');
  // Browser compositor screenshots work even with preserveDrawingBuffer=false;
  // readPixels/toDataURL outside the renderer frame may instead return zeros.
  const png = await canvas.screenshot({ path: path.join(directory, `${label}-canvas.png`) });
  return Buffer.from(png).toString('base64');
}

async function compareCanvasPixels(page, first, second) {
  return page.evaluate(async (a, b) => {
    // Element screenshots include composited host UI. The legacy NPC portrait
    // breathes and the restored scene title fades via CSS above the WebGL
    // canvas even while renderer frames freeze. Mask those host overlays.
    const canvasRect = document.querySelector('#sect-3d-root canvas').getBoundingClientRect();
    const masks = [...document.querySelectorAll('.npc-portrait, .scene-title')].filter(e => e.getClientRects().length).map(e => {
      const r = e.getBoundingClientRect(), pad = e.matches('.npc-portrait') ? 20 : 4;
      return { left: r.left - canvasRect.left - pad, top: r.top - canvasRect.top - pad, right: r.right - canvasRect.left + pad, bottom: r.bottom - canvasRect.top + pad };
    });
    async function decode(data) {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
      const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0);
      return { width: c.width, height: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
    }
    const x = await decode(a), y = await decode(b);
    if (x.width !== y.width || x.height !== y.height) return { sameDimensions: false };
    let changed = 0, comparedPixels = 0;
    for (let i = 0; i < x.data.length; i += 4) {
      const px = (i / 4) % x.width, py = Math.floor(i / 4 / x.width);
      if (masks.some(r => px >= r.left && px <= r.right && py >= r.top && py <= r.bottom)) continue;
      comparedPixels++;
      if (Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]) > 12) changed++;
    }
    return { sameDimensions: true, width: x.width, height: x.height, masks, comparedPixels, changedPixels: changed, changedFraction: changed / comparedPixels };
  }, first, second);
}

async function runCase(browser, server, directory, outcome, returnedToMap = false) {
  const label = `${returnedToMap ? 'map-to-library-' : ''}${outcome}`;
  const channel = `regenerate-${label}`;
  const session = await newGameContext(browser, server, {
    payload: await json(path.join(fixturesRoot, 'saves/library.json')), channel,
    scene3dPreferences: { enabled: true, quality: 'low' }
  });
  const { page } = session;
  try {
    await startGame(session, server);
    await page.evaluate(() => closeModal());
    await waitForLatestApplied(page, 'library');
    // Actual successful action creates the full production snapshot, not a fabricated one.
    await studyWithStream({ directory }, server, page, channel);
    await waitForLatestApplied(page, 'library');
    assert.equal(await page.evaluate(() => storageService.hasSnapshot()), true);
    if (returnedToMap) {
      // Real backToMap changes userLocation + active DOM scene but does not replace
      // the action snapshot: regenerate must restore library while retaining main.
      await page.evaluate(() => backToMap());
      await waitForLatestApplied(page, 'main');
      assert.equal(await page.evaluate(() => userLocation), 'tianshanpai');
    }
    await page.waitForFunction(() => GameSceneBridge.getDiagnostics().renderer?.interactionEnabled === true && !document.querySelector('.scene3d-page-turn:not([hidden])'));
    await page.screenshot({ path: path.join(directory, `${label}-before.png`) });
    await canvasEvidence(page, directory, `${label}-before`);
    await observe(page);
    const before = await page.evaluate(() => GameSceneBridge.getDiagnostics());
    const fixture = await json(path.join(fixturesRoot, 'responses/action-stream.json'));
    fixture.steps[1].waitFor = 'regenerate-release';
    if (outcome === 'failed') {
      fixture.steps[1].body = '';
      fixture.terminal = 'disconnect';
    }
    server.enqueue(channel, fixture);
    if (outcome === 'failed') {
      // The real pipeline retries a failed stream once through its non-stream path.
      // Explicitly fail that request too, rather than relying on an unmatched API.
      server.enqueue(channel, {
        status: 500, headers: { 'Content-Type': 'application/json' },
        steps: [{ body: JSON.stringify({ error: { message: 'Synthetic regenerate fallback failure' } }) }],
        terminal: 'end'
      });
    }
    // Both original entry functions execute, including snapshot restore, host repaint,
    // and pipeline.runTurn({isRegenerate:true}); only the network is mocked.
    await page.evaluate(() => handleRegenerate());
    await page.waitForSelector('#regen-msg-input', { visible: true });
    await page.waitForFunction(() => GameSceneBridge.getDiagnostics().renderer?.renderEnabled === false);
    const preconfirm = await page.evaluate(() => GameSceneBridge.getDiagnostics());
    assert.equal(preconfirm.renderer.ready, true);
    const preconfirmCanvas = await canvasEvidence(page, directory, `${label}-preconfirm`);
    await page.evaluate(() => _confirmRegenerate());
    await server.waitFor(e => e.channel === channel && e.key === `${channel}:regenerate-release` && e.type === 'waiting');
    await page.waitForFunction(() => pipeline.isStreaming() && GameSceneBridge.getDiagnostics().renderer?.interactionEnabled === false);
    const busy = await page.evaluate(() => {
      const d = GameSceneBridge.getDiagnostics();
      return { diagnostics: d, hidden: document.querySelector('#sect-3d-root').hidden, ready: document.querySelector('#main-viewport').dataset.scene3dReady };
    });
    await artifact(directory, `${label}-busy.json`, busy);
    assert.equal(busy.hidden, false, 'Snapshot restore must retain the existing 3D root while generation waits');
    assert.equal(busy.ready, 'true', 'Generation must not reveal the 2D fallback');
    await page.screenshot({ path: path.join(directory, `${label}-busy.png`) });
    assert.equal(busy.diagnostics.renderer.ready, true, 'Real WebGL renderer must remain ready, not only DOM ready flags');
    assert.equal(busy.diagnostics.renderer.activeSceneId, returnedToMap ? 'main' : 'library', 'Keep the actually rendered scene until unlock, even when snapshot restores another room');
    assert.equal(busy.diagnostics.renderer.instanceId, before.renderer.instanceId);
    assert.equal(busy.diagnostics.renderer.pending, 0, 'No navigation starts while generation is frozen');
    assert.equal(busy.diagnostics.snapshot.sceneId, 'library', 'The real action snapshot restores the prior room');
    assert.equal(await page.evaluate(() => userLocation), 'cangjingge');
    assert.equal(await page.evaluate(() => !!document.querySelector('.scene3d-page-turn:not([hidden])')), false, 'No turn cover during generation');
    assert.equal(busy.diagnostics.renderer.interactionEnabled, false);
    assert.equal(busy.diagnostics.renderer.renderEnabled, false);
    assert.equal(busy.diagnostics.snapshot.interactive, false);
    assert.ok(busy.diagnostics.snapshot.blockReasons.some(reason => reason.startsWith('generation:')), 'Real pipeline busy guard is active');
    assert.ok(busy.diagnostics.epoch > before.epoch, 'Snapshot restore still invalidates old epoch');
    const busyCanvas = await canvasEvidence(page, directory, `${label}-busy`);
    // Hold the server gate across multiple real animation frames (not just one instant).
    await page.evaluate(() => new Promise(resolve => {
      let count = 0;
      const frame = () => ++count >= 12 ? resolve() : requestAnimationFrame(frame);
      requestAnimationFrame(frame);
    }));
    const held = await page.evaluate(() => GameSceneBridge.getDiagnostics());
    assert.equal(held.renderer.frames, busy.diagnostics.renderer.frames, 'Frozen frame must not keep rendering while busy');
    await page.screenshot({ path: path.join(directory, `${label}-held.png`) });
    const heldCanvas = await canvasEvidence(page, directory, `${label}-held`);
    const restorePixels = await compareCanvasPixels(page, preconfirmCanvas, heldCanvas);
    await artifact(directory, `${label}-restore-pixels.json`, {
      ...restorePixels,
      preconfirmRenderer: preconfirm.renderer,
      heldRenderer: held.renderer,
      scope: 'Pre-confirm paused canvas compositor screenshot versus held restored snapshot. Evidence only: opening/closing the regenerate modal changes its backdrop over the canvas, and snapshot restoration can introduce host NPC/title overlays. Not a raw framebuffer equality assertion.'
    });
    assert.equal(restorePixels.sameDimensions, true, 'Paused pre-confirm and held canvas screenshots retain dimensions');
    const pixels = await compareCanvasPixels(page, busyCanvas, heldCanvas);
    await artifact(directory, `${label}-pixels.json`, pixels);
    assert.equal(pixels.sameDimensions, true);
    assert.ok(pixels.comparedPixels > pixels.width * pixels.height * 0.3, 'Pixel comparison must cover at least 30% of the canvas outside animated host portraits');
    assert.ok(pixels.changedFraction < 0.005, `Frozen compositor canvas changed: ${JSON.stringify(pixels)}`);
    const busyTrace = await page.evaluate(() => {
      const result = { samples: __regenFrame.samples, violations: [...__regenFrame.violations], turnSeen: __regenFrame.turnSeen };
      __regenFrame.hold = false;
      return result;
    });
    await artifact(directory, `${label}-busy-trace.json`, busyTrace);
    assert.deepEqual(busyTrace.violations, [], 'Ready renderer, active scene, canvas and root position remain stable through snapshot restore and held generation');
    assert.equal(busyTrace.turnSeen, false);
    if (outcome === 'aborted') await page.evaluate(() => pipeline.abortCurrentTurn());
    else await server.release(channel, 'regenerate-release');
    await page.waitForFunction(() => !pipeline.isStreaming(), { timeout: 30000 });
    // Failure reporting uses a real modal; dismiss it before checking interaction recovery.
    await page.evaluate(() => closeModal());
    const recovered = await waitForLatestApplied(page, 'library');
    await page.waitForFunction(() => GameSceneBridge.getDiagnostics().renderer?.interactionEnabled === true && !document.querySelector('.scene3d-page-turn:not([hidden])'));
    await page.screenshot({ path: path.join(directory, `${label}-recovered.png`) });
    await canvasEvidence(page, directory, `${label}-recovered`);
    if (returnedToMap) assert.equal(await page.evaluate(() => __regenFrame.turnSeen), true, 'Cross-scene recovery must run and finish a page turn after unlock');
    assert.equal(recovered.renderer.activeSceneId, 'library');
    assert.equal(recovered.renderer.pending, 0);
    const trace = await page.evaluate(() => {
      __regenFrame.stop();
      return { samples: __regenFrame.samples, mutations: __regenFrame.mutations, violations: __regenFrame.violations };
    });
    await artifact(directory, `${label}-trace.json`, { before, recovered, trace });
    assert.ok(trace.samples >= 12 && trace.mutations > 0, 'Both animation frames and DOM mutations were observed');
    assert.deepEqual(trace.violations, [], 'No 2D fallback may be exposed from opening regenerate through recovery');
    const requests = server.requests.filter(r => r.channel === channel);
    assert.equal(requests.length, outcome === 'failed' ? 3 : 2, 'Only seed action, regenerate, and expected failure fallback hit the mock API');
    if (outcome === 'aborted') await server.waitFor(e => e.channel === channel && e.type === 'abort');
    if (outcome === 'failed') {
      assert.ok(server.events.some(e => e.channel === channel && e.type === 'disconnect'));
      assert.equal(requests[1].body.stream, true, 'Regenerate starts with the streaming request');
      // apiService._callOpenAI omits stream for non-stream requests (API default false).
      assert.equal(Object.hasOwn(requests[2].body, 'stream'), false, 'Failed SSE uses the real non-stream fallback');
    }
    assertSessionSafe(session, server, channel);
    return { outcome, returnedToMap, samples: trace.samples, mutations: trace.mutations, buildId: recovered.buildId };
  } finally {
    // Preserve observations even when the first held-generation assertion fails.
    const observation = await page.evaluate(() => window.__regenFrame && ({ samples: __regenFrame.samples, mutations: __regenFrame.mutations, violations: __regenFrame.violations })).catch(() => null);
    if (observation) await artifact(directory, `${label}-observation.json`, observation);
    await saveSessionEvidence(session, directory, channel);
    await session.close();
  }
}

export async function run() {
  const directory = path.join(workspace, '.scene3d-work', `regenerate-frame-${Date.now()}`);
  let browser, server;
  const report = { status: 'RUNNING', scope: 'Actual handleRegenerate / _confirmRegenerate, full snapshot restore, pipeline and published rendering; same-library and real backToMap -> restored library, each deferred mock SSE completion, abort and transport failure. Renderer identity/ready/activeScene/navigation and no-cover/root-position retention sampled during busy; cross-scene recovery turn must finish. Compositor canvas screenshots and held-frame pixel comparison (not golden-image fidelity or raw WebGL buffer validation).', results: [] };
  try {
    report.publication = await inspectPublishedBuild(workspace);
    server = await startTestServer({ gameRoot: workspace });
    browser = await launchBrowser();
    for (const returnedToMap of [false, true]) {
      for (const outcome of ['completed', 'aborted', 'failed']) {
        report.results.push(await runCase(browser, server, directory, outcome, returnedToMap));
        console.log('PASS regenerate frame:', returnedToMap ? 'map-to-library' : 'same-scene', outcome);
      }
    }
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.error = error.stack || String(error);
    console.error(report.error); process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (server) { await artifact(directory, 'transport.json', { events: server.events, requests: server.requests }); await server.close(); }
    await artifact(directory, 'report.json', report);
    console.log(JSON.stringify({ status: report.status, directory, results: report.results }));
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await run();
