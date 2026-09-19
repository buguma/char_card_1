// Import-safe CLI regression; do not execute until integration-015 is published.
// Uses isolated synthetic saves and trusted native input, never direct NPC intents.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { artifact, assertSessionSafe, hashFile, json, launchBrowser, newGameContext, saveSessionEvidence, startGame, workspace } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';
import { installObservation, realNpcClick } from './npc-focus.browser.mjs';

const ids = [...'ABCDEFGHIJKLMNO'];
const routes = { yanwuchang:'training', cangjingge:'library', huofang:'kitchen', houshan:'back_mountain', yishiting:'council', tiejiangpu:'forge', nandizi:'male_quarters', nvdizi:'female_quarters', shanmen:'gate', gongtian:'fields', danfang:'alchemy' };
const frames = (page, ms = 500) => page.evaluate(ms => new Promise(resolve => {
  const start = performance.now(); let count = 0;
  const step = now => { if (++count >= 5 && now - start >= ms) resolve(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}), ms);
const diagnostics = page => page.evaluate(() => GameSceneBridge.getDiagnostics());
const business = page => page.evaluate(() => JSON.parse(JSON.stringify({
  rng: __scene3dTest.rng(), gameData, currentNpcLocations, npcVisibility, npcFavorability,
  npcGiftGiven, npcSparred, playerStats, actionPoints, currentWeek,
  saves: localStorage.getItem('jxz_saves'),
})));
const errorRecord = (stage, error) => ({ stage, message: String(error?.message || error), stack: error?.stack });

async function identity(root) {
  const pointer = await json(path.join(root, 'assets/sect3d/current.json'));
  const manifest = await json(path.join(root, 'assets/sect3d', pointer.manifest));
  const files = ['module/game-helpers.js', 'module/scene3d-bridge.js', 'module/scene3d-host.css', 'module/game-styles.css', 'module/game-styles-theme.css',
    'assets/sect3d/current.json', `assets/sect3d/${pointer.manifest}`, `assets/sect3d/${pointer.buildId}/${manifest.entry}`, ...manifest.css.map(file => `assets/sect3d/${pointer.buildId}/${file}`)];
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await hashFile(path.join(root, file))])));
}
async function waitRoom(page, count) {
  await page.waitForFunction(count => {
    const d = GameSceneBridge.getDiagnostics();
    return d.readyScene === 'library' && d.renderer?.interactionEnabled && d.renderer.npc?.cards === count && d.renderer.npc.fallbacks.length === 0;
  }, { timeout: 120000 }, count);
  await frames(page);
  const d = await diagnostics(page), npc = d.renderer.npc;
  assert.equal(npc.cards, count); assert.deepEqual(npc.fallbacks, []);
  assert.deepEqual(npc.residents.map(n => n.gameNpcId).sort(), ids.slice(0, count));
  assert.deepEqual(d.snapshot.renderedNpcs.map(n => n.gameNpcId).sort(), ids.slice(0, count));
  assert.ok(npc.placementScale > 0 && npc.placementScale <= 1, 'Dense placement may uniformly shrink cards, never enlarge');
  for (const n of npc.residents) {
    assert.equal(n.placementScale, npc.placementScale);
    assert.ok(Math.abs(n.height - n.baseHeight * 1.5 * npc.placementScale) < 1e-7, `Authored height ×1.5 × placementScale: ${n.gameNpcId}`);
  }
  assert.equal(await page.$$eval('.scene3d-npc-fallback-button', nodes => nodes.length), 0);
  return d;
}
async function capture(page, directory, name) {
  const value = await page.evaluate(() => ({ diagnostics: GameSceneBridge.getDiagnostics(), business: __scene3dRead(), trace: window.__npcFocusTrace }));
  await artifact(directory, `${name}.json`, value);
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
  return value;
}
async function remember2D(page, key) {
  return page.evaluate(key => {
    const container = document.querySelector('#cangjingge-npcs');
    const nodes = [...container.querySelectorAll('.npc-portrait')];
    window.__rosterDom ??= {};
    window.__rosterDom[key] = { container, nodes, html: container.innerHTML };
    return { ids: nodes.map(n => n.dataset.npcId), html: container.innerHTML };
  }, key);
}
async function unchanged2D(page, key) {
  const result = await page.evaluate(key => {
    const saved = __rosterDom[key], nodes = [...saved.container.querySelectorAll('.npc-portrait')];
    return { count: nodes.length, identical: nodes.every((node, i) => node === saved.nodes[i]), html: saved.container.innerHTML === saved.html };
  }, key);
  assert.deepEqual(result, { count: 3, identical: true, html: true }, 'Original 2D nodes and exact markup/styles survive 3D toggle');
}
async function dismiss(page) {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => {
    const d = GameSceneBridge.getDiagnostics();
    return !document.querySelector('.scene3d-npc-selection.show') && !d.renderer.returningNpcView && !d.renderer.focusingNpc && d.renderer.interactionEnabled;
  }, { timeout: 15000 });
  await frames(page, 150);
}
async function nativeSelection(page, id, directory, name) {
  const before = await page.evaluate(() => __npcFocusTrace.calls.length);
  const attempts = await realNpcClick(page, id);
  await page.waitForFunction(id => {
    const d = GameSceneBridge.getDiagnostics();
    return d.renderer.selectedNpcId === id && !d.renderer.focusingNpc && document.querySelector('.scene3d-npc-selection.show')?.dataset.npcId === id;
  }, { timeout: 15000 }, id);
  const proof = await page.evaluate(() => {
    const d = GameSceneBridge.getDiagnostics(), n = d.renderer.npc.residents.find(n => n.gameNpcId === d.renderer.selectedNpcId);
    const r = document.querySelector('canvas.scene3d-canvas').getBoundingClientRect();
    return { selected: d.renderer.selectedNpcId, fraction: n.anchor.height / r.height,
      calls: __npcFocusTrace.calls, trusted: __npcFocusTrace.pointers.filter(p => p.type === 'pointerup' && p.trusted),
      actions: [...document.querySelectorAll('.scene3d-npc-selection.show .npc-selection-option')].map(n => ({ text:n.textContent, disabled:n.disabled })) };
  });
  assert.ok(proof.calls.slice(before).some(call => call.npcId === id), 'Native hit reaches original bridge for exact intended NPC');
  assert.ok(proof.trusted.length); assert.equal(proof.selected, id);
  assert.ok(Math.abs(proof.fraction - .29) < .002, 'Selected card stays .29 canvas height even when dense placement shrinks it');
  assert.ok(proof.actions.some(a => a.text === '互动' && !a.disabled), 'Extra resident has enabled native business action');
  await artifact(directory, `${name}-native-proof.json`, { attempts, ...proof });
  await capture(page, directory, name);
}
async function assertInteractionAction(page, id, directory) {
  const buttons = await page.$$('.scene3d-npc-selection.show .npc-selection-option');
  const action = [];
  for (const button of buttons) if (await button.evaluate(n => n.textContent === '互动')) action.push(button);
  assert.equal(action.length, 1); await action[0].click();
  await page.waitForSelector('#modal-buttons .cancel', { visible:true, timeout:15000 });
  const proof = await page.evaluate(() => ({ id:currentInteractionNpc, operations:__npcFocusTrace.operations, modal:document.querySelector('#modal-text')?.textContent }));
  assert.equal(proof.id, id);
  assert.ok(proof.operations.some(o => o.name === 'npcAction' && o.args.npcId === id && o.args.action === '互动'), 'Trusted action button reaches unmodified original npcAction');
  await artifact(directory, 'fourth-native-action.json', proof);
  // Ancient-theme modal animates into place: visible is not a stable hit box.
  // Match the existing native-focus harness's settle window before trusted input.
  await frames(page, 500);
  const cancelHit = await page.$eval('#modal-buttons .cancel', button => {
    const r = button.getBoundingClientRect(), target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { rect:r.toJSON(), target:target?.outerHTML, onButton:target === button || button.contains(target) };
  });
  await artifact(directory, 'fourth-cancel-hit.json', cancelHit); assert.ok(cancelHit.onButton, 'Settled cancel button owns its native hit coordinate');
  // Cancel before any dialogue submission: zero model/API calls.
  await page.click('#modal-buttons .cancel');
  await page.waitForFunction(() => GameSceneBridge.getDiagnostics().renderer.interactionEnabled, { timeout:15000 });
  await frames(page, 150);
}
async function fixtureRoster(page, count) {
  await page.evaluate(count => {
    // Only this isolated synthetic context is changed; original host display owns RNG.
    for (const id of Object.keys(currentNpcLocations)) currentNpcLocations[id] = 'none';
    for (const id of Object.keys(npcs)) currentNpcLocations[id] = 'none';
    for (const id of 'ABCDEFGHIJKLMNO'.slice(0, count)) { currentNpcLocations[id] = 'cangjingge'; npcVisibility[id] = true; }
    displayNpcs('cangjingge'); updateLocationHeadcountLabels(); GameSceneBridge.notify('isolated-roster-fixture');
  }, count);
}
async function mapSample(page) {
  return page.evaluate(routes => {
    const css = (node, keys) => node ? Object.fromEntries(keys.map(k => [k, getComputedStyle(node)[k]])) : null;
    const dotKeys = ['width','height','borderRadius','backgroundColor','color','boxShadow'];
    const dividerKeys = ['borderTopWidth','borderTopStyle','borderTopColor','borderRightWidth','borderRightStyle','borderRightColor','borderBottomWidth','borderBottomStyle','borderBottomColor','borderLeftWidth','borderLeftStyle','borderLeftColor','color','backgroundColor','marginTop','marginRight','marginBottom','marginLeft','boxShadow'];
    const sample = node => node ? { html:node.innerHTML, style:node.getAttribute('style'), locationClass:node.classList.contains('location'),
      dots:node.querySelectorAll('.people-dot').length, dotStyles:[...node.querySelectorAll('.people-dot')].map(n => css(n, dotKeys)),
      divider:css(node.querySelector('.location-label-divider'), dividerKeys), opacity:node.querySelector('.location-label-divider') && getComputedStyle(node.querySelector('.location-label-divider')).opacity } : null;
    const expected = Object.fromEntries(Object.keys(routes).map(id => [id, 0]));
    for (const loc of Object.values(currentNpcLocations)) if (Object.hasOwn(expected, loc)) expected[loc]++;
    return { diagnostics:GameSceneBridge.getDiagnostics(), expected, labels:document.querySelectorAll('.scene3d-location-label').length,
      locations:Object.entries(routes).map(([id, scene]) => ({ id, original:sample(document.querySelector(`.location#${id}`)), projected:sample(document.querySelector(`.scene3d-location-label[data-scene-id="${scene}"]`)) })) };
  }, routes);
}
async function verifyMap(page, count, directory, name) {
  await page.waitForFunction(count => {
    const d = GameSceneBridge.getDiagnostics(), label = document.querySelector('.scene3d-location-label[data-scene-id="library"]');
    return d.readyScene === 'main' && d.renderer.interactionEnabled && d.snapshot.locationNpcCounts.cangjingge === count && label?.querySelectorAll('.people-dot').length === count;
  }, { timeout:120000 }, count);
  await frames(page, 300);
  const sample = await mapSample(page);
  await artifact(directory, `${name}-parity.json`, sample); await page.screenshot({ path:path.join(directory, `${name}.png`) });
  assert.equal(sample.labels, 11); assert.equal(sample.expected.cangjingge, count);
  assert.deepEqual(sample.diagnostics.snapshot.locationNpcCounts, sample.expected);
  assert.equal(sample.diagnostics.snapshot.residents.length, 0);
  for (const { id, original, projected } of sample.locations) {
    assert.ok(original && projected, `Both original and 3D labels exist: ${id}`);
    assert.equal(original.locationClass, true); assert.equal(projected.locationClass, false, 'Projected label never adopts .location business geometry');
    assert.equal(original.dots, sample.expected[id]); assert.equal(projected.dots, original.dots, id);
    assert.equal(original.opacity, sample.expected[id] ? '1' : '0.35'); assert.equal(projected.opacity, original.opacity);
    assert.deepEqual(projected.dotStyles, original.dotStyles, `${id}: exact original computed dot dimensions/radius/color/glow`);
    assert.deepEqual(projected.divider, original.divider, `${id}: exact original computed divider border/color/margins/shadow`);
  }
  return sample;
}

export async function npcRosterBrowser({ browser, server, directory, buildId, lanes = [
  { style:0, width:1280, height:900, quality:'low' }, { style:1, width:390, height:844, quality:'low' },
] }) {
  assert.ok(directory && path.isAbsolute(directory), 'Absolute evidence directory required');
  const pointer = await json(path.join(server.root, 'assets/sect3d/current.json'));
  if (buildId !== undefined) assert.equal(pointer.buildId, buildId, 'Publish requested release before running this regression');
  buildId = pointer.buildId;
  const before = await identity(server.root), results = [], errors = [];
  await artifact(directory, 'source-before.json', before);
  for (const lane of lanes) {
    const label = `${lane.style === 0 ? 'ancient' : 'flat'}-${lane.width}-${lane.quality}`, channel = `npc-roster-${label}`, dir = path.join(directory, label);
    const failures = []; let session, cdp;
    const attempt = async (stage, fn) => { try { return await fn(); } catch (error) { failures.push(errorRecord(stage, error)); } };
    try {
      const payload = await json(path.join(workspace, 'tests/scene3d/fixtures/saves/library.json'));
      payload.gameData.npcLocations = Object.fromEntries(ids.map(id => [id, 'ABCD'.includes(id) ? 'cangjingge' : 'none']));
      payload.gameData.npcVisibility = Object.fromEntries(ids.map(id => [id, true]));
      session = await newGameContext(browser, server, { payload, channel, style:lane.style, viewport:{ width:lane.width, height:lane.height, deviceScaleFactor:1 }, scene3dPreferences:{ enabled:false, quality:lane.quality } });
      const { page } = session; page.setDefaultTimeout(120000);
      await startGame(session, server); await frames(page);
      const initial = await remember2D(page, 'four');
      assert.equal(initial.ids.length, 3); assert.ok(initial.ids.every(id => 'ABCD'.includes(id)));
      const extra = [...'ABCD'].find(id => !initial.ids.includes(id)); assert.ok(extra);
      const baseline = await business(page); await capture(page, dir, 'initial-2d-three');
      assert.equal((await diagnostics(page)).preferences.enabled, false);
      await page.evaluate(() => GameSceneBridge.setPreference({ enabled:true }));
      await waitRoom(page, 4); await unchanged2D(page, 'four'); assert.deepEqual(await business(page), baseline);
      cdp = await installObservation(page, buildId);
      await capture(page, dir, 'four-real-cards');
      await nativeSelection(page, extra, dir, 'fourth-omitted-from-2d'); await dismiss(page);
      assert.deepEqual(await business(page), baseline);
      await nativeSelection(page, extra, dir, 'fourth-native-action-menu'); await assertInteractionAction(page, extra, dir);
      assert.deepEqual(await business(page), baseline);
      await page.evaluate(() => GameSceneBridge.setPreference({ enabled:false }));
      await page.waitForFunction(() => !GameSceneBridge.getDiagnostics().snapshot.visible, { timeout:15000 });
      await unchanged2D(page, 'four'); assert.deepEqual(await business(page), baseline);
      await capture(page, dir, 'returned-same-2d-three');
      await page.evaluate(() => GameSceneBridge.setPreference({ enabled:true })); await waitRoom(page, 4);
      await fixtureRoster(page, 15); const denseBaseline = await business(page); await remember2D(page, 'fifteen');
      await waitRoom(page, 15); await unchanged2D(page, 'fifteen'); assert.deepEqual(await business(page), denseBaseline);
      await page.evaluate(() => __npcFocusLoadVisuals()); await capture(page, dir, 'fifteen-real-cards');
      // Prefer the foreground row by projected foot position; still require the exact native ID.
      const denseId = await page.evaluate(() => GameSceneBridge.getDiagnostics().renderer.npc.residents.filter(n => n.anchor).sort((a,b) => (b.anchor.top+b.anchor.height)-(a.anchor.top+a.anchor.height))[0]?.gameNpcId);
      assert.ok(denseId); await nativeSelection(page, denseId, dir, 'fifteen-native-selection'); await dismiss(page);
      assert.deepEqual(await business(page), denseBaseline);
      await page.click('#cangjingge-scene .back-btn');
      await verifyMap(page, 15, dir, 'main-fifteen');
      for (const count of [0, 4, 15]) {
        const revision = (await diagnostics(page)).revision;
        await fixtureRoster(page, count);
        const fixtureState = await business(page), sample = await verifyMap(page, count, dir, `main-live-${count}`);
        assert.ok(sample.diagnostics.revision > revision, 'Headcount update without main-map reentry advances snapshot');
        assert.deepEqual(await business(page), fixtureState, 'Projection itself consumes no business RNG/state');
        const original = sample.locations.map(n => ({ id:n.id, original:n.original }));
        await page.evaluate(() => GameSceneBridge.setPreference({ enabled:false }));
        await page.waitForFunction(() => !GameSceneBridge.getDiagnostics().snapshot.visible, { timeout:15000 });
        assert.deepEqual((await mapSample(page)).locations.map(n => ({ id:n.id, original:n.original })), original, 'Disabling 3D never changes original map markup/styles/dots');
        assert.deepEqual(await business(page), fixtureState);
        await page.evaluate(() => GameSceneBridge.setPreference({ enabled:true }));
        const enabled = await verifyMap(page, count, dir, `main-retoggle-${count}`);
        assert.deepEqual(enabled.locations.map(n => ({ id:n.id, original:n.original })), original, 'Reenabling 3D preserves original map markup/styles/dots');
        assert.deepEqual(await business(page), fixtureState);
      }
    } catch (error) { failures.push(errorRecord('scenario', error)); }
    finally {
      if (session) {
        await attempt('session-safety', async () => {
          assertSessionSafe(session, server, channel);
          assert.deepEqual((await diagnostics(session.page)).errors, [], 'No bridge/renderer errors hidden behind fallback');
          assert.deepEqual(session.network.filter(n => n.method && n.url.includes('/__mock/')), [], 'No model/API requests, even mocked');
        });
        await attempt('final-diagnostics', async () => artifact(dir, 'final-diagnostics.json', await diagnostics(session.page)));
        await attempt('final-native-trace', async () => artifact(dir, 'final-native-trace.json', await session.page.evaluate(() => window.__npcFocusTrace || null)));
        await attempt('session-evidence', () => saveSessionEvidence(session, dir, 'final'));
        if (cdp) await attempt('cdp-detach', () => cdp.detach());
        await attempt('context-close', () => session.close());
      }
      await attempt('failure-evidence', () => artifact(dir, 'errors.json', failures));
    }
    results.push({ label, lane, status:failures.length ? 'FAIL' : 'PASS', errors:failures });
  }
  let sourceStable = false;
  try { const after = await identity(server.root); await artifact(directory, 'source-after.json', after); sourceStable = JSON.stringify(before) === JSON.stringify(after); assert.ok(sourceStable, 'Test never mutates source/release files'); }
  catch (error) { errors.push(errorRecord('source-integrity', error)); }
  const result = { status:results.every(r => r.status === 'PASS') && !errors.length && sourceStable ? 'PASS' : 'FAIL', buildId, sourceStable, results, errors };
  await artifact(directory, 'result.json', result); return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let browser, server; const directory = process.argv[2], errors = [];
  try {
    assert.ok(directory && path.isAbsolute(directory), 'Usage: node tests/scene3d/npc-roster.browser.mjs <absolute evidence dir> [expectedBuildId]');
    await mkdir(directory, { recursive:false }); server = await startTestServer({ gameRoot:workspace }); browser = await launchBrowser();
    const result = await npcRosterBrowser({ browser, server, directory, buildId:process.argv[3] });
    console.log(JSON.stringify({ ...result, directory })); if (result.status !== 'PASS') process.exitCode = 1;
  } catch (error) { errors.push(errorRecord('cli', error)); }
  finally {
    for (const [stage, resource] of [['browser-close', browser], ['server-close', server]]) if (resource) {
      try { await resource.close(); } catch (error) { errors.push(errorRecord(stage, error)); }
    }
    if (errors.length) { console.error(JSON.stringify({ errors })); process.exitCode = 1; }
  }
}
