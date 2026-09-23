// Run: node tests/scene3d/portrait-layout.browser.mjs
// Visual/layout check: portrait mode must pin the free-action input to the bottom edge.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifact, fixturesRoot, json, launchBrowser, newGameContext, startGame, workspace } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';

async function run() {
  const directory = path.join(workspace, '.scene3d-work', `portrait-layout-${Date.now()}`);
  let browser, server;
  const report = { status: 'RUNNING' };
  try {
    server = await startTestServer({ gameRoot: workspace });
    browser = await launchBrowser();
    const payload = await json(path.join(fixturesRoot, 'saves/map.json'));
    payload.gameData.layoutMode = 0;
    payload.gameData.uiStyle = 0;
    const session = await newGameContext(browser, server, {
      payload, channel: 'portrait-layout',
      viewport: { width: 390, height: 844 }
    });
    const { page } = session;
    await startGame(session, server);
    await page.evaluate(() => closeModal());
    await page.waitForFunction(() => document.body.classList.contains('layout-portrait'));
    mkdirSync(directory, { recursive: true });
    const metrics = await page.evaluate(() => {
      const rect = sel => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
      };
      return {
        screen: { w: innerWidth, h: innerHeight, dvh: document.documentElement.clientHeight },
        viewportWrapper: rect('.viewport-wrapper'),
        gameViewport: rect('.viewport'),
        storyArea: rect('.story-area'),
        storyContent: rect('.story-content-wrapper'),
        freeAction: rect('.free-action-container'),
        container: rect('.container'),
        bodyScroll: { scrollHeight: document.body.scrollHeight, clientHeight: document.body.clientHeight }
      };
    });
    await page.screenshot({ path: path.join(directory, 'portrait.png'), fullPage: false });
    await artifact(directory, 'metrics.json', metrics);
    console.log('METRICS', JSON.stringify(metrics, null, 2));
    assert.ok(metrics.freeAction, 'free-action-container present');
    // 文本区应填满视口（下边沿贴屏幕底部）
    assert.ok(Math.abs(metrics.storyArea.bottom - metrics.screen.h) <= 1, `story-area bottom ${metrics.storyArea.bottom} should be ~${metrics.screen.h}`);
    // 输入栏底部应贴紧屏幕下边沿（古风边框 10px + 少量内边距容差）
    assert.ok(metrics.screen.h - metrics.freeAction.bottom <= 25, `input bottom ${metrics.freeAction.bottom} should be within 25px of ${metrics.screen.h}`);
    report.status = 'PASS';
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
