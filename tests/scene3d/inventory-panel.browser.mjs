import path from 'node:path';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchBrowser, newGameContext, startGame, json, fixturesRoot, artifact } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';

const output = process.argv[2] && path.isAbsolute(process.argv[2])
  ? process.argv[2]
  : path.resolve('.scene3d-work/inventory-panel-verify');
await mkdir(output, { recursive: true });

const server = await startTestServer({ gameRoot: process.cwd() });
const browser = await launchBrowser();
const profiles = [
  { width: 390, height: 844, landscape: false, style: 0 },
  { width: 390, height: 844, landscape: false, style: 1 },
  { width: 844, height: 390, landscape: true, style: 0 },
  { width: 844, height: 390, landscape: true, style: 1 },
  { width: 1440, height: 900, landscape: false, style: 0 },
];
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  for (const profile of profiles) {
    const label = `${profile.width}x${profile.height}-${profile.style ? 'flat' : 'ancient'}`;
    const payload = await json(path.join(fixturesRoot, 'saves/inventory-browser.json'));
    payload.gameData.layoutMode = profile.landscape ? 1 : 0;
    const session = await newGameContext(browser, server, {
      payload, channel: `inventory-panel-${label}`, style: profile.style,
      viewport: { width: profile.width, height: profile.height, deviceScaleFactor: 1, hasTouch: true, isMobile: true },
      scene3dPreferences: { schema: 2, enabled: false, quality: 'low' },
    });
    const { page } = session;
    const record = { label, pass: false };
    try {
      await startGame(session, server);
      await page.evaluate(() => { closeModal(); showInventory(); });
      await page.waitForFunction(() => document.getElementById('inventory-modal').style.display === 'block');

      // 1. Exactly fills #main-viewport (no overflow, no gap).
      const fill = await page.evaluate(() => {
        const m = document.getElementById('inventory-modal').getBoundingClientRect();
        const v = document.getElementById('main-viewport').getBoundingClientRect();
        return { dL: m.left - v.left, dT: m.top - v.top, dR: v.right - m.right, dB: v.bottom - m.bottom };
      });
      assert.ok(Math.abs(fill.dL) < 0.6 && Math.abs(fill.dT) < 0.6 && Math.abs(fill.dR) < 0.6 && Math.abs(fill.dB) < 0.6, JSON.stringify(fill));
      record.fill = fill;

      // 2. Five categories in the required order.
      const cats = await page.$$eval('[data-inventory-category]', els => els.map(e => e.textContent.trim()));
      assert.deepEqual(cats, ['武器', '防具', '饰品', '消耗品', '其他']);

      // 3. Three columns, no horizontal overflow anywhere.
      const layout = await page.evaluate(() => {
        const cols = document.querySelector('#inventory-modal .inventory-panel-columns');
        const m = document.getElementById('inventory-modal');
        return { template: getComputedStyle(cols).gridTemplateColumns.split(' ').length, hOverflow: m.scrollWidth > m.clientWidth + 1 };
      });
      assert.equal(layout.template, 3, JSON.stringify(layout));
      assert.equal(layout.hOverflow, false, JSON.stringify(layout));

      // 4. Default weapon category lists expected items.
      const weaponItems = await page.$$eval('[data-inventory-item]', els => els.map(e => e.dataset.inventoryItem));
      assert.ok(weaponItems.includes('制式铁剑') && weaponItems.includes('精钢长剑'), JSON.stringify(weaponItems));

      // 4b. Ancient-theme computed-style assertions (古风皮肤，仅 style 0)。
      if (profile.style === 0) {
        const ancient = await page.evaluate(() => {
          const shell = document.querySelector('#inventory-modal .inventory-panel-shell');
          const list = document.querySelector('#inventory-modal .inventory-panel-list');
          const closeBtn = document.querySelector('#inventory-modal [data-inventory-close]');
          const tab = document.querySelector('#inventory-modal .inventory-categories button');
          const selected = document.querySelector('#inventory-modal .inventory-panel-item[aria-pressed="true"]');
          return {
            shellBorderImage: decodeURIComponent(getComputedStyle(shell).borderImageSource),
            listBorderImage: decodeURIComponent(getComputedStyle(list).borderImageSource),
            closeBg: decodeURIComponent(getComputedStyle(closeBtn).backgroundImage),
            tabBgSize: getComputedStyle(tab).backgroundSize,
            selectedColor: selected ? getComputedStyle(selected).color : null,
          };
        });
        assert.ok(ancient.shellBorderImage.includes('边框-fill.png'), JSON.stringify(ancient));
        assert.ok(ancient.listBorderImage.includes('边框-fill.png'), JSON.stringify(ancient));
        assert.ok(ancient.closeBg.includes('框5-短.png'), JSON.stringify(ancient));
        assert.notEqual(ancient.tabBgSize, '100% 100%', JSON.stringify(ancient));
        assert.equal(ancient.selectedColor, 'rgb(255, 255, 255)', JSON.stringify(ancient));
        record.ancient = ancient;
      }

      // 5. Same-named already-equipped backup still offers equip without error.
      await page.click('[data-inventory-item="制式铁剑"]');
      await page.waitForFunction(() => document.querySelector('#inventory-actions [data-inventory-action="equip"]'));
      await page.click('#inventory-actions [data-inventory-action="equip"]');
      await page.waitForFunction(() => document.getElementById('inventory-modal').style.display === 'block');
      await sleep(120);
      assert.equal(await page.evaluate(() => equipment.武器), '制式铁剑');
      assert.equal(await page.evaluate(() => inventory['制式铁剑']), 2);

      // 5b. Equipping a different weapon decrements and swaps the slot.
      await page.click('[data-inventory-item="精钢长剑"]');
      await page.waitForFunction(() => document.querySelector('#inventory-actions [data-inventory-action="equip"]'));
      await page.click('#inventory-actions [data-inventory-action="equip"]');
      await page.waitForFunction(() => document.getElementById('inventory-modal').style.display === 'block');
      await sleep(120);
      assert.equal(await page.evaluate(() => equipment.武器), '精钢长剑');
      assert.equal(await page.evaluate(() => ('精钢长剑' in inventory)), false);
      assert.equal(await page.evaluate(() => inventory['制式铁剑']), 3);

      // 6. Consumable use decrements and stays in panel.
      await page.click('[data-inventory-category="消耗品"]');
      await page.click('[data-inventory-item="胡饼"]');
      await page.waitForFunction(() => document.querySelector('#inventory-actions [data-inventory-action="use"]'));
      const beforeFood = await page.evaluate(() => inventory['胡饼']);
      await page.click('#inventory-actions [data-inventory-action="use"]');
      await page.waitForFunction(() => document.getElementById('inventory-modal').style.display === 'block');
      await sleep(120);
      assert.equal(await page.evaluate(() => inventory['胡饼']), beforeFood - 1);

      // 7. Non-operable item (seed) has no action buttons.
      await page.click('[data-inventory-category="其他"]');
      await page.click('[data-inventory-item="小麦种子"]');
      await sleep(60);
      const seedActions = await page.$$eval('#inventory-actions button', els => els.map(e => e.dataset.inventoryAction));
      assert.deepEqual(seedActions, [], JSON.stringify(seedActions));

      // 8. Long description scrolls inside detail and stays inside viewport.
      await page.evaluate(() => { item_list['丹参'].描述 = '长介绍验证：此药材产自天山绝壁，需三伏采撷、九蒸九晒方能成药。'.repeat(80); });
      await page.click('[data-inventory-item="丹参"]');
      await sleep(60);
      const longDetail = await page.evaluate(() => {
        const d = document.getElementById('inventory-detail');
        const before = d.scrollTop; d.scrollTop = d.scrollHeight;
        const scrolled = d.scrollTop;
        const r = d.getBoundingClientRect();
        const m = document.getElementById('inventory-modal').getBoundingClientRect();
        return { scrollable: scrolled > before, within: r.left >= m.left && r.right <= m.right && r.top >= m.top && r.bottom <= m.bottom + 1, actions: document.querySelectorAll('#inventory-actions button').length };
      });
      assert.ok(longDetail.scrollable, JSON.stringify(longDetail));
      assert.ok(longDetail.within, JSON.stringify(longDetail));
      assert.equal(longDetail.actions, 0, JSON.stringify(longDetail));

      // 9. Close via 退出; modal hidden.
      await page.click('[data-inventory-close]');
      await page.waitForFunction(() => document.getElementById('inventory-modal').style.display === 'none');

      const pageErrors = session.logs.filter(x => x.type === 'pageerror').map(x => x.text);
      assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));

      await page.screenshot({ path: path.join(output, `${label}.png`) });
      record.pass = true;
      record.detail = { weaponItems, cats, fill, layout };
    } catch (error) {
      record.error = error.stack;
      try { await page.screenshot({ path: path.join(output, `${label}-failure.png`) }); } catch {}
    } finally {
      results.push(record);
      await artifact(output, `${label}-results.json`, record);
      await session.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results.map(({ label, pass, error }) => ({ label, pass, error })), null, 2));
if (results.some(r => !r.pass)) process.exitCode = 1;
