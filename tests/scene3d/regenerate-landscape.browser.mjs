// Run: node tests/scene3d/regenerate-landscape.browser.mjs
// Repro: landscape layout + ancient UI + 3D enabled, then LLM regenerate.
// Samples whether the 3D root/canvas stays visible through snapshot restore + generation.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifact, fixturesRoot, json, launchBrowser, newGameContext, startGame, workspace } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';
import { inspectPublishedBuild, waitForLatestApplied } from './p1.browser.mjs';
import { studyWithStream } from './p2.browser.mjs';

async function run() {
  const directory = path.join(workspace, '.scene3d-work', `regenerate-landscape-${Date.now()}`);
  let browser, server;
  const report = { status: 'RUNNING', results: [] };
  try {
    report.publication = await inspectPublishedBuild(workspace);
    server = await startTestServer({ gameRoot: workspace });
    browser = await launchBrowser();
    const channel = 'regenerate-landscape';
    const payload = await json(path.join(fixturesRoot, 'saves/library.json'));
    payload.gameData.layoutMode = 1; // 横屏
    payload.gameData.uiStyle = 0;    // 古风
    const session = await newGameContext(browser, server, {
      payload, channel,
      viewport: { width: 844, height: 390 },
      scene3dPreferences: { enabled: true, quality: 'low' }
    });
    const { page } = session;
    const sample = () => page.evaluate(() => {
      const root = document.querySelector('#sect-3d-root');
      const shell = root?.querySelector('.scene3d-runtime');
      const canvas = root?.querySelector('canvas');
      const d = GameSceneBridge.getDiagnostics();
      return {
        rootHidden: root?.hidden ?? null,
        rootDisplay: root ? getComputedStyle(root).display : null,
        shellHidden: shell?.hidden ?? null,
        shellState: shell?.dataset?.state ?? null,
        canvasVisibility: canvas ? getComputedStyle(canvas).visibility : null,
        canvasDisplay: canvas ? getComputedStyle(canvas).display : null,
        readyScene: d.readyScene,
        readyAttr: document.querySelector('#main-viewport')?.dataset.scene3dReady,
        rendererReady: d.renderer?.ready,
        renderEnabled: d.renderer?.renderEnabled,
        activeSceneId: d.renderer?.activeSceneId,
        instanceId: d.renderer?.instanceId,
        snapshotVisible: d.snapshot?.visible,
        sceneId: d.snapshot?.sceneId,
        blockReasons: d.snapshot?.blockReasons,
        landscape: document.body.classList.contains('layout-landscape'),
        ancient: document.body.classList.contains('ui-style-ancient'),
        errors: d.errors
      };
    });
    try {
      await startGame(session, server);
      await page.evaluate(() => closeModal());
      await waitForLatestApplied(page, 'library');
      await studyWithStream({ directory }, server, page, channel);
      await waitForLatestApplied(page, 'library');
      assert.equal(await page.evaluate(() => storageService.hasSnapshot()), true);
      // 横屏下先回到门派（map），再用快照重生成——重生成会把地点还原回藏经阁，
      // 属于跨场景恢复（渲染 scene 与快照 scene 不一致）。
      await page.evaluate(() => backToMap());
      await waitForLatestApplied(page, 'main');
      assert.equal(await page.evaluate(() => userLocation), 'tianshanpai');
      const before = await sample();
      assert.equal(before.landscape, true, 'landscape layout must be active');
      assert.equal(before.ancient, true, 'ancient UI must be active');
      assert.equal(before.rootHidden, false, '3D root visible before regenerate');
      assert.equal(before.activeSceneId, 'main', 'rendered scene is main before cross-scene regenerate');
      const fixture = await json(path.join(fixturesRoot, 'responses/action-stream.json'));
      fixture.steps[1].waitFor = 'regenerate-release';
      server.enqueue(channel, fixture);
      await page.evaluate(() => handleRegenerate());
      await page.waitForSelector('#regen-msg-input', { visible: true });
      const opened = await sample();
      await page.evaluate(() => _confirmRegenerate());
      await server.waitFor(e => e.channel === channel && e.key === `${channel}:regenerate-release` && e.type === 'waiting');
      await page.waitForFunction(() => pipeline.isStreaming());
      await page.evaluate(() => new Promise(resolve => {
        let c = 0; const f = () => ++c >= 20 ? resolve() : requestAnimationFrame(f); requestAnimationFrame(f);
      }));
      const during = await sample();
      await artifact(directory, 'samples.json', { before, opened, during });
      console.log('SAMPLES', JSON.stringify({ before, opened, during }, null, 2));
      assert.equal(during.rootHidden, false, 'root must stay visible during regenerate');
      assert.equal(during.shellState, 'ready', 'renderer shell must stay ready');
      assert.equal(during.canvasVisibility, 'visible', 'canvas must stay visible');
      assert.equal(during.rendererReady, true, 'renderer must stay ready');
      assert.equal(during.activeSceneId, 'main', 'held frame must stay main during cross-scene regenerate');
      report.results.push({ before, opened, during });
      report.status = 'PASS';
      await server.release(channel, 'regenerate-release');
      await page.waitForFunction(() => !pipeline.isStreaming(), { timeout: 30000 });
      await page.evaluate(() => closeModal());
      await waitForLatestApplied(page, 'library');
    } finally {
      await session.close();
    }
  } catch (error) {
    report.status = 'FAIL'; report.error = error.stack || String(error);
    console.error(report.error); process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    await artifact(directory, 'report.json', report);
    console.log(JSON.stringify({ status: report.status, directory }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await run();
