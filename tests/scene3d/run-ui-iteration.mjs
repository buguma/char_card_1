import path from 'node:path';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchBrowser, newGameContext, startGame, json, fixturesRoot } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';
import { waitForLatestApplied } from './p1.browser.mjs';

const gameRoot = process.cwd();
const directory = process.argv[2];
assert.ok(directory && path.isAbsolute(directory), 'Supply a new absolute evidence directory');
await mkdir(directory, { recursive: false });
const save = (name, value) => writeFile(path.join(directory, name), JSON.stringify(value, null, 2));
const server = await startTestServer({ gameRoot });
const browser = await launchBrowser();
const results = [];
try {
  for (const width of [1280, 390]) for (const style of [0, 1]) {
    const label = `ui-${width}-${style}`;
    const payload = await json(path.join(fixturesRoot, 'saves/map.json'));
    const session = await newGameContext(browser, server, { payload, channel: label, style, viewport: { width, height: 900, deviceScaleFactor: 1 }, scene3dPreferences: { schema: 1, enabled: false, quality: 'low' } });
    const page = session.page;
    try {
      await startGame(session, server);
      await page.evaluate(() => closeModal());
      assert.equal(await page.evaluate(() => GameSceneBridge.getDiagnostics().preferences.quality), 'balanced', 'Legacy low/device default must migrate to balanced at either viewport size');
      const inspectPopup = () => {
        const popup = document.getElementById('location-info-popup');
        const props = ['width','height','padding','borderImageSource','borderImageSlice','borderBottom','fontFamily','fontSize','textAlign','display','gap','minWidth','maxWidth'];
        return [popup, ...popup.querySelectorAll('*')].map(element => ({ tag: element.tagName, text: element.textContent, style: Object.fromEntries(props.map(key => [key, getComputedStyle(element)[key]])) }));
      };
      await page.evaluate(() => { showLocationInfo('cangjingge', { currentTarget: { getBoundingClientRect: () => ({ left: 120, top: 100, width: 10, height: 10 }) } }); });
      const flat = await page.evaluate(inspectPopup);
      await page.evaluate(() => { closeLocationInfo({ target: document.body }); GameSceneBridge.setPreference({ enabled: true }); });
      await waitForLatestApplied(page, 'main', 120000);
      await page.evaluate(() => GameSceneBridge.showLocationInfoAtAnchor('cangjingge', { left: 120, top: 100, width: 10, height: 10 }));
      await page.waitForSelector('#location-info-popup.scene3d-menu.show', { visible: true });
      const three = await page.evaluate(inspectPopup);
      assert.deepEqual(three, flat, 'The same popup must retain identical sizing, dividers, typography and content');
      assert.equal(await page.$$eval('#location-info-popup', nodes => nodes.length), 1);
      await page.screenshot({ path: path.join(directory, `${label}-popup.png`) });
      // Sample every presented frame with the sheet's live opacity. This verifies the
      // cover -> swap -> reveal ordering from the actual visual state, not from the
      // WAAPI promise (the bridge's 750ms watchdog may cancel that promise first under
      // load, which would make a promise-based probe report a false negative).
      await page.evaluate(() => {
        window.__turnProbe = { frames: [], running: true };
        function record() {
          const p = __turnProbe, d = GameSceneBridge.getDiagnostics();
          const target = document.querySelector('#cangjingge-scene');
          const sheet = document.querySelector('.scene3d-page-sheet');
          p.frames.push({
            at: performance.now(),
            turning: document.getElementById('main-viewport').dataset.scene3dTurning === 'true',
            sheetOpacity: sheet ? getComputedStyle(sheet).opacity : null,
            active: d.renderer?.activeSceneId,
            targetActive: target.classList.contains('active'),
            targetVisibility: getComputedStyle(target).visibility
          });
          if (p.running) requestAnimationFrame(record);
        }
        requestAnimationFrame(record);
      });
      await page.click('#location-info-popup .location-go-btn');
      await waitForLatestApplied(page, 'library');
      await page.waitForFunction(() => document.querySelector('.scene3d-page-turn')?.hidden === true);
      const probe = await page.evaluate(() => { __turnProbe.running = false; return __turnProbe; });
      await save(`${label}-frames.json`, probe);
      const covered = f => f.turning && Number(f.sheetOpacity) >= 0.99;
      assert.ok(probe.frames.some(f => f.turning), 'The cover must start (data-scene3d-turning set)');
      assert.ok(probe.frames.some(covered), 'The sheet must reach full opacity before the scene swap');
      assert.ok(!probe.frames.some(f => f.active === 'library' && f.turning && Number(f.sheetOpacity) < 0.99), 'No target 3D frame while the sheet is still rotating in');
      assert.ok(!probe.frames.some(f => f.targetActive && f.targetVisibility === 'visible' && f.turning), 'No target 2D frame while the sheet is turning');
      assert.equal(await page.evaluate(() => GameSceneBridge.getDiagnostics().preferences.quality), 'balanced');
      await page.screenshot({ path: path.join(directory, `${label}-arrived.png`) });
      results.push({ label, status: 'PASS', frames: probe.frames.length, popupIdentical: true, balanced: true });
    } catch (error) { results.push({ label, status: 'FAIL', error: error.stack }); }
    finally { await session.close(); await save('results.json', results); }
  }
} finally { await browser.close(); await server.close(); }
console.log(JSON.stringify(results, null, 2));
process.exitCode = results.some(row => row.status !== 'PASS') ? 1 : 0;
