import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {launchBrowser, workspace, artifact} from '../../scene3d/scripts/test-support.mjs';
import {startTestServer} from '../../scene3d/scripts/test-server.mjs';

const directory = path.join(workspace, '.scene3d-work/farm-alchemy-iframe');
await mkdir(directory, {recursive: true});
const server = await startTestServer({gameRoot: workspace});
const sizes = [{width: 390, height: 267}, {width: 360, height: 246}, {width: 640, height: 246}];
const cases = [
  {name: 'farm-crop-actions', file: 'farm.html', open: frame => frame.evaluate(() => {
    state.grid[0][0] = {...createEmptyPlot(), planted: true, cropId: 'wheat', maturity: 1};
    openActionPopup({x: 0, y: 0, r: 0, c: 0});
  }), panel: '#popup', close: '.popup-close', scroll: '.body'},
  {name: 'alchemy-herbs', file: 'alchemy.html', open: frame => frame.click('#start-alchemy-btn'), panel: '#herb-modal-overlay > .modal', close: '[onclick="closeHerbModal()"]', scroll: '.modal-content'},
  {name: 'alchemy-shop', file: 'alchemy.html', open: frame => frame.evaluate(() => openShopModal()), panel: '#shop-modal-overlay > .modal', close: '[onclick="closeShopModal()"].modal-btn', scroll: '.modal-content'}
];
const results = {startedAt: new Date().toISOString(), sizes, cases: [], errors: []};
let browser;
try {
  browser = await launchBrowser();
  for (const size of sizes) for (const test of cases) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const label = `${size.width}x${size.height}-${test.name}`;
    const record = {label, size, file: test.file, status: 'PASS', errors: []};
    results.cases.push(record);
    try {
      await page.setViewport({...size, deviceScaleFactor: 1});
      await page.setRequestInterception(true);
      page.on('request', req => {
        const url = new URL(req.url());
        if ((url.origin === server.origin && req.method() === 'GET') || ['data:', 'blob:'].includes(url.protocol)) req.continue().catch(() => {});
        else req.abort('blockedbyclient').catch(() => {});
      });
      const frameSrc = `${server.origin}/${test.file}`;
      page.on('pageerror', error => record.errors.push(error.message));
      await page.goto(server.origin + '/farm.html', {waitUntil: 'domcontentloaded'});
      await page.setContent(`<style>body{margin:0}</style><iframe id="game" src="${frameSrc}" style="display:block;width:${size.width}px;height:${size.height}px;border:0"></iframe>`, {waitUntil: 'domcontentloaded'});
      const frame = await (await page.waitForSelector('#game', {timeout: 10000})).contentFrame();
      await frame.waitForFunction(() => typeof openActionPopup === 'function' || typeof openHerbModal === 'function', {timeout: 15000});
      await frame.evaluate(() => document.fonts.ready);
      await test.open(frame);
      await frame.waitForSelector(test.panel, {visible: true, timeout: 5000});
      await frame.evaluate(() => document.fonts.ready);
      const geometry = await frame.evaluate(({panel, scroll, close}) => {
        const root = document.querySelector(panel), r = root.getBoundingClientRect();
        const sc = root.querySelector(scroll) || root;
        const button = root.querySelector(close), br = button?.getBoundingClientRect();
        return {panel: {x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom}, bounded: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, horizontalOverflow: root.scrollWidth > root.clientWidth + 2, scroll: {height: sc.clientHeight, total: sc.scrollHeight}, close: button ? {text: button.textContent.trim(), width: br.width, height: br.height, reachable: br.x >= 0 && br.y >= 0 && br.right <= innerWidth && br.bottom <= innerHeight} : null};
      }, test);
      record.geometry = geometry;
      if (!geometry.bounded || geometry.horizontalOverflow || !geometry.close?.reachable) record.status = 'FAIL';
      await page.screenshot({path: path.join(directory, `${label}-top.png`)});
      if (geometry.scroll.total > geometry.scroll.height + 2) {
        await frame.evaluate(({panel, scroll}) => { const root = document.querySelector(panel), sc = root.querySelector(scroll) || root; sc.scrollTop = sc.scrollHeight; }, test);
        record.scrolled = await frame.evaluate(({panel, scroll}) => { const root = document.querySelector(panel), sc = root.querySelector(scroll) || root; return sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2; }, test);
        if (!record.scrolled) record.status = 'FAIL';
      }
      record.screenshot = `${label}.png`;
      await page.screenshot({path: path.join(directory, record.screenshot)});
      await frame.click(test.close);
      record.closed = await frame.$eval(test.panel, el => el.getClientRects().length === 0 || getComputedStyle(el).display === 'none');
      if (!record.closed || record.errors.length) record.status = 'FAIL';
    } catch (error) {
      record.status = 'FAIL'; record.failure = error.message;
      await page.screenshot({path: path.join(directory, `${label}-failure.png`)}).catch(() => {});
    } finally { await context.close(); }
    console.log(record.status, label, record.failure || JSON.stringify(record.geometry), record.errors);
  }
} catch (error) { results.errors.push(error.stack); }
finally {
  if (browser) await browser.close();
  await server.close();
  results.finishedAt = new Date().toISOString();
  results.summary = {total: results.cases.length, passed: results.cases.filter(c => c.status === 'PASS').length, failed: results.cases.filter(c => c.status === 'FAIL').length};
  await artifact(directory, 'results.json', results);
  console.log(JSON.stringify(results.summary));
  if (results.summary.failed || results.errors.length) process.exitCode = 1;
}
