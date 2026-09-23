// Real-host 2D map/HUD feedback lane.
// CLI: node tests/scene3d/map-label-feedback.browser.mjs <new absolute report directory>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { artifact, assertSessionSafe, fixturesRoot, json, launchBrowser, newGameContext, saveSessionEvidence, startGame, workspace } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';

const frames = (page, count = 12) => page.evaluate(count => new Promise(resolve => {
  let remaining = count;
  const tick = () => --remaining ? requestAnimationFrame(tick) : resolve();
  requestAnimationFrame(tick);
}), count);

async function sample(page) {
  return page.evaluate(() => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const map = document.querySelector('#map-scene.active');
    const viewport = document.querySelector('#main-viewport');
    const labels = Array.from(map.querySelectorAll('.location'), node => {
      const text = node.querySelector('.location-label-text');
      const style = getComputedStyle(text);
      const bounds = rect(node);
      const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      return {
        id: node.id,
        text: text?.textContent,
        bounds,
        fontSize: parseFloat(getComputedStyle(node).fontSize),
        textShadow: style.textShadow,
        strokeWidth: style.webkitTextStrokeWidth,
        pointerEvents: getComputedStyle(node).pointerEvents,
        hitId: document.elementFromPoint(center.x, center.y)?.closest('.location')?.id || null,
      };
    });
    const hud = Array.from(map.querySelectorAll('.status-display > div'), node => ({ id: node.id, bounds: rect(node), fontSize: parseFloat(getComputedStyle(node).fontSize) }));
    const mapBounds = rect(map), viewportBounds = rect(viewport);
    return {
      bodyClass: document.body.className,
      browserViewport: { width: innerWidth, height: innerHeight },
      mapBounds,
      viewportBounds,
      containerType: getComputedStyle(map).containerType,
      viewportContainerType: getComputedStyle(viewport).containerType,
      stylesheetLoaded: Array.from(document.styleSheets).some(sheet => new URL(sheet.href || location.href).pathname.endsWith('/module/map-label-feedback.css')),
      feedbackSelectors: Array.from(document.styleSheets).filter(sheet => new URL(sheet.href || location.href).pathname.endsWith('/module/map-label-feedback.css')).flatMap(sheet => Array.from(sheet.cssRules, rule => rule.selectorText).filter(Boolean)),
      labels,
      peopleDots: Array.from(map.querySelectorAll('.location > .location-people > .people-dot'), node => ({ width: parseFloat(getComputedStyle(node).width), height: parseFloat(getComputedStyle(node).height) })),
      hud,
      overflow: [...labels, ...hud].filter(item => item.bounds.left < mapBounds.left - .5 || item.bounds.right > mapBounds.right + .5 || item.bounds.top < mapBounds.top - .5 || item.bounds.bottom > mapBounds.bottom + .5).map(item => item.id),
    };
  });
}

export async function verifyMapLabelFeedback({ browser, server, directory }) {
  const lanes = [
    { name: 'phone-390x844', viewport: { width: 390, height: 844, deviceScaleFactor: 2 } },
    { name: 'landscape-844x390', viewport: { width: 844, height: 390, deviceScaleFactor: 2 } },
    { name: 'large-1280x900', viewport: { width: 1280, height: 900, deviceScaleFactor: 1 } },
  ];
  const results = [];
  for (const style of [0, 1]) for (const lane of lanes) {
    const name = `theme-${style}-${lane.name}`;
    const channel = `map-label-feedback-${name}`;
    const payload = await json(path.join(fixturesRoot, 'saves/map.json'));
    payload.gameData.layoutMode = lane.name.startsWith('landscape-') ? 1 : 0;
    const session = await newGameContext(browser, server, { payload, channel, style, viewport: lane.viewport, scene3dPreferences: { enabled: false, quality: 'low' } });
    const { page } = session;
    const checks = [];
    const check = (label, passed, detail) => checks.push({ label, status: passed ? 'PASS' : 'FAIL', detail });
    try {
      await startGame(session, server);
      if (await page.$eval('#modal', node => getComputedStyle(node).display !== 'none')) {
        const close = await page.$('#modal-buttons [onclick="closeModal()"]');
        if (close) await close.click();
      }
      await page.waitForSelector('#map-scene.active .location-label-text', { visible: true });
      if (await page.$eval('#location-info-popup', node => node.classList.contains('show'))) {
        await page.click('.story-area');
        await page.waitForFunction(() => !document.getElementById('location-info-popup').classList.contains('show'));
      }
      await frames(page);
      const initial = await sample(page);
      await artifact(directory, `${name}.json`, initial);
      await page.screenshot({ path: path.join(directory, `${name}-map.png`), fullPage: false });

      const landscape = lane.name.startsWith('landscape-');
      const clamp = (min, value, max) => Math.min(max, Math.max(min, value));
      check('feedback stylesheet loaded', initial.stylesheetLoaded, initial.stylesheetLoaded);
      check('HUD selector covers every landscape scene', initial.feedbackSelectors.includes('body.layout-landscape #main-viewport .scene .status-display'), initial.feedbackSelectors);
      check('all eleven real labels rendered', initial.labels.length === 11 && initial.labels.every(item => item.text), initial.labels.map(item => ({ id: item.id, text: item.text })));
      check('labels retain pointer handling', initial.labels.every(item => item.pointerEvents !== 'none'), initial.labels.map(item => ({ id: item.id, pointerEvents: item.pointerEvents })));
      check('map labels and HUD stay inside the real map', initial.overflow.length === 0, initial.overflow);
      if (landscape) {
        const expectedLabel = clamp(12, initial.mapBounds.width * .025, 28);
        const expectedHud = id => id === 'date-display' ? clamp(12, initial.mapBounds.width * .025, 26) : clamp(11, initial.mapBounds.width * .022, 22);
        check('landscape uses real viewport and map size containers', initial.containerType === 'size' && initial.viewportContainerType === 'size', { map: initial.containerType, viewport: initial.viewportContainerType });
        check('single crisp keyline targets real label text nodes', initial.labels.every(item => item.textShadow === 'none' && parseFloat(item.strokeWidth) >= .45 && parseFloat(item.strokeWidth) <= 1.01), initial.labels.map(item => ({ id: item.id, shadow: item.textShadow, stroke: item.strokeWidth })));
        check('landscape labels match 2.5 percent reference scale', initial.labels.every(item => Math.abs(item.fontSize - expectedLabel) < .2), { mapWidth: initial.mapBounds.width, expectedLabel, actual: initial.labels.map(item => item.fontSize) });
        check('all landscape HUD items use the shared viewport scale', initial.hud.every(item => Math.abs(item.fontSize - expectedHud(item.id)) < .2), { mapWidth: initial.mapBounds.width, expected: Object.fromEntries(initial.hud.map(item => [item.id, expectedHud(item.id)])), actual: initial.hud });
        check('real people-dot DOM uses bounded landscape size', initial.peopleDots.length > 0 && initial.peopleDots.every(dot => dot.width >= 6 && dot.width <= 12 && dot.height === dot.width), initial.peopleDots);
      } else {
        check('portrait and large layouts retain existing sizing cascade', initial.containerType === 'normal' && initial.viewportContainerType === 'normal', { map: initial.containerType, viewport: initial.viewportContainerType, labels: initial.labels.map(item => item.fontSize), hud: initial.hud.map(item => item.fontSize) });
      }

      await page.click('#yanwuchang');
      await page.waitForFunction(() => document.getElementById('location-info-popup').classList.contains('show'));
      check('real location click still opens popup', await page.$eval('#location-info-popup', node => node.classList.contains('show') && node.textContent.length > 0), await page.$eval('#location-info-popup', node => node.textContent));
      assertSessionSafe(session, server, channel);
    } catch (error) {
      check('execution', false, error.stack);
      try { await page.screenshot({ path: path.join(directory, `${name}-failure.png`), fullPage: false }); } catch {}
    } finally {
      await artifact(directory, `${name}-checks.json`, checks);
      await saveSessionEvidence(session, directory, name);
      await session.close();
    }
    results.push({ name, style, viewport: lane.viewport, checks, failures: checks.filter(item => item.status === 'FAIL') });
  }
  const summary = { scope: 'Real 2D map, both UI themes, phone portrait, phone landscape and large viewport. Screenshots are actual Chromium renders; no APK build.', results };
  await artifact(directory, 'map-label-feedback-results.json', summary);
  return summary;
}

async function main() {
  const directory = process.argv[2];
  assert.ok(directory && path.isAbsolute(directory), 'Provide a new absolute evidence directory');
  await mkdir(directory, { recursive: false });
  const server = await startTestServer({ gameRoot: workspace });
  let browser;
  try {
    browser = await launchBrowser();
    const result = await verifyMapLabelFeedback({ browser, server, directory });
    process.exitCode = result.results.some(lane => lane.failures.length) ? 1 : 0;
    console.log(JSON.stringify({ directory, status: process.exitCode ? 'FAIL' : 'PASS', failures: result.results.flatMap(lane => lane.failures.map(failure => ({ lane: lane.name, ...failure }))) }));
  } finally {
    try { if (browser) await browser.close(); } finally { await server.close(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
