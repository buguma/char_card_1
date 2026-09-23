import path from 'node:path';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchBrowser, newGameContext, startGame, json, fixturesRoot, artifact } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';

const output = process.argv[2] && path.isAbsolute(process.argv[2])
  ? process.argv[2]
  : path.resolve('.scene3d-work/equipment-panel-verify');
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
    // Use only items that exist in item_list so every equipped slot renders (the
    // fixture's 青玉佩 is a bogus name absent from item_list).
    payload.gameData.equipment = { 武器: '制式铁剑', 防具: '普通弟子服', 饰品1: '血玉护符', 饰品2: null };
    const session = await newGameContext(browser, server, {
      payload, channel: `equipment-panel-${label}`, style: profile.style,
      viewport: { width: profile.width, height: profile.height, deviceScaleFactor: 1, hasTouch: true, isMobile: true },
      scene3dPreferences: { schema: 2, enabled: false, quality: 'low' },
    });
    const { page } = session;
    const record = { label, pass: false };
    try {
      await startGame(session, server);
      await page.evaluate(() => { closeModal(); showEquipment(); });
      await page.waitForFunction(() => document.getElementById('equipment-modal').style.display === 'block');

      // 1. Exactly fills #main-viewport.
      const fill = await page.evaluate(() => {
        const m = document.getElementById('equipment-modal').getBoundingClientRect();
        const v = document.getElementById('main-viewport').getBoundingClientRect();
        return { dL: m.left - v.left, dT: m.top - v.top, dR: v.right - m.right, dB: v.bottom - m.bottom };
      });
      assert.ok(Math.abs(fill.dL) < 0.6 && Math.abs(fill.dT) < 0.6 && Math.abs(fill.dR) < 0.6 && Math.abs(fill.dB) < 0.6, JSON.stringify(fill));
      record.fill = fill;

      // 2. Four slots in order, no legacy 当前装备效果 box, no detail modal.
      const structure = await page.evaluate(() => ({
        labels: [...document.querySelectorAll('#equipment-modal .equipment-panel-slot-label')].map(e => e.textContent.trim()),
        effectBox: !!document.querySelector('#equipment-modal .current-equipment-effects, #equipment-modal .equipped-effects'),
        detailModal: !!document.querySelector('#equipment-detail-modal, #equipped-item-detail'),
      }));
      assert.deepEqual(structure.labels, ['武器', '防具', '饰品1', '饰品2'], JSON.stringify(structure));
      assert.equal(structure.effectBox, false, JSON.stringify(structure));
      assert.equal(structure.detailModal, false, JSON.stringify(structure));

      // 3. Equipped items render name + 卸下 + inline attributes; empty slot renders 空.
      const slots = await page.$$eval('#equipment-modal .equipment-panel-slot', els => els.map(e => ({
        label: e.querySelector('.equipment-panel-slot-label')?.textContent.trim(),
        name: e.querySelector('.equipment-panel-name')?.textContent.trim() || null,
        unequip: e.querySelector('[data-equipment-unequip]')?.dataset.equipmentUnequip || null,
        attrs: e.querySelector('.equipment-panel-attrs')?.textContent.trim() || null,
        empty: e.querySelector('.equipment-panel-empty')?.textContent.trim() || null,
      })));
      assert.deepEqual(slots.map(s => s.name), ['制式铁剑', '普通弟子服', '血玉护符', null], JSON.stringify(slots));
      assert.deepEqual(slots.map(s => s.unequip), ['制式铁剑', '普通弟子服', '血玉护符', null], JSON.stringify(slots));
      assert.equal(slots[3].empty, '空', JSON.stringify(slots));
      record.slots = slots;

      // 4. Every equipped slot shows its own inline attribute text (never the old summary box).
      for (const s of slots.slice(0, 3)) assert.ok(s.attrs && s.attrs.length > 0, JSON.stringify(s));

      // 5. 卸下 removes the weapon: equipment cleared, item returned to inventory, panel re-renders.
      const invBefore = await page.evaluate(() => inventory['制式铁剑']);
      await page.click('[data-equipment-unequip="制式铁剑"]');
      await page.waitForFunction(() => equipment['武器'] === null, { timeout: 5000 });
      await sleep(120);
      const afterUnequip = await page.evaluate(() => ({ weapon: equipment['武器'], inv: inventory['制式铁剑'] }));
      assert.equal(afterUnequip.weapon, null, JSON.stringify(afterUnequip));
      assert.equal(afterUnequip.inv, invBefore + 1, JSON.stringify(afterUnequip));

      // 6. Close via 退出; modal hidden.
      await page.click('[data-equipment-close]');
      await page.waitForFunction(() => document.getElementById('equipment-modal').style.display === 'none');

      const pageErrors = session.logs.filter(x => x.type === 'pageerror').map(x => x.text);
      assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));

      await page.screenshot({ path: path.join(output, `${label}.png`) });
      record.pass = true;
      record.detail = { slots, fill, afterUnequip };
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
