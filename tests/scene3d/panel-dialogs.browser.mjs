import path from 'node:path';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchBrowser, newGameContext, startGame, json, fixturesRoot, artifact } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';

const output = process.argv[2] && path.isAbsolute(process.argv[2])
  ? process.argv[2]
  : path.resolve('.scene3d-work/panel-dialogs-verify');
await mkdir(output, { recursive: true });

const server = await startTestServer({ gameRoot: process.cwd() });
const browser = await launchBrowser();
const profiles = [
  { width: 390, height: 844, landscape: false, style: 0 },
  { width: 390, height: 844, landscape: false, style: 1 },
  { width: 844, height: 390, landscape: true, style: 0 },
  { width: 1440, height: 900, landscape: false, style: 0 },
];
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fillCheck(page, modalId) {
  return page.evaluate(id => {
    const m = document.getElementById(id).getBoundingClientRect();
    const v = document.getElementById('main-viewport').getBoundingClientRect();
    return { dL: m.left - v.left, dT: m.top - v.top, dR: v.right - m.right, dB: v.bottom - m.bottom };
  }, modalId);
}

try {
  for (const profile of profiles) {
    const label = `${profile.width}x${profile.height}-${profile.style ? 'flat' : 'ancient'}`;
    const payload = await json(path.join(fixturesRoot, 'saves/skills-trade-browser.json'));
    payload.gameData.layoutMode = profile.landscape ? 1 : 0;
    const session = await newGameContext(browser, server, {
      payload, channel: `panel-dialogs-${label}`, style: profile.style,
      viewport: { width: profile.width, height: profile.height, deviceScaleFactor: 1, hasTouch: true, isMobile: true },
      scene3dPreferences: { schema: 2, enabled: false, quality: 'low' },
    });
    const { page } = session;
    const record = { label, pass: false };
    try {
      await startGame(session, server);

      /* ============ 1. 查看技能（技能管理） ============ */
      await page.evaluate(() => { closeModal(); showSkillEquipment(); });
      await page.waitForFunction(() => document.getElementById('skill-equipment-modal').style.display === 'block');

      const equipFill = await fillCheck(page, 'skill-equipment-modal');
      assert.ok(Math.abs(equipFill.dL) < 0.6 && Math.abs(equipFill.dT) < 0.6 && Math.abs(equipFill.dR) < 0.6 && Math.abs(equipFill.dB) < 0.6, JSON.stringify(equipFill));
      record.equipFill = equipFill;

      // 选项卡顺序 + 记忆点槽
      const equipTabs = await page.$$eval('#skill-equipment-modal [data-dialog-tab]', els => els.map(e => e.textContent.trim()));
      assert.deepEqual(equipTabs, ['已装备', '已学习']);
      assert.equal(await page.evaluate(() => document.getElementById('skill-equipment-memory-summary').textContent), '1 / 7');

      // 已装备选项卡默认：显示肉斩骨断
      let equippedItems = await page.$$eval('#skill-equipment-modal [data-skill-item]', els => els.map(e => e.textContent.trim()));
      assert.ok(equippedItems.some(t => t.includes('肉斩骨断')), JSON.stringify(equippedItems));

      // 切到已学习：冰心诀/绷急孝典乐在列，肉斩骨断不在
      await page.click('#skill-equipment-modal [data-dialog-tab="learned"]');
      await sleep(60);
      const learnedNames = await page.$$eval('#skill-equipment-modal [data-skill-item]', els => els.map(e => e.textContent.trim()));
      assert.ok(learnedNames.some(t => t.includes('冰心诀')) && learnedNames.some(t => t.includes('绷急孝典乐')), JSON.stringify(learnedNames));
      assert.ok(!learnedNames.some(t => t.includes('肉斩骨断')), JSON.stringify(learnedNames));

      // 装备冰心诀：从已学习消失，进入已装备；记忆点 1→4
      await page.click('#skill-equipment-modal [data-skill-item="bin_xin_jue"]');
      await page.waitForFunction(() => document.querySelector('#skill-equipment-actions [data-skill-action="equip"]'));
      await page.click('#skill-equipment-actions [data-skill-action="equip"]');
      await sleep(120);
      assert.equal(await page.evaluate(() => equippedSkills['bin_xin_jue']), 2);
      assert.equal(await page.evaluate(() => document.getElementById('skill-equipment-memory-summary').textContent), '4 / 7');
      const learnedAfterEquip = await page.$$eval('#skill-equipment-modal [data-skill-item]', els => els.map(e => e.dataset.skillItem));
      assert.ok(!learnedAfterEquip.includes('bin_xin_jue'), JSON.stringify(learnedAfterEquip));

      // 已装备选项卡出现冰心诀，可卸下
      await page.click('#skill-equipment-modal [data-dialog-tab="equipped"]');
      await sleep(60);
      const equippedAfter = await page.$$eval('#skill-equipment-modal [data-skill-item]', els => els.map(e => e.dataset.skillItem));
      assert.ok(equippedAfter.includes('bin_xin_jue'), JSON.stringify(equippedAfter));
      await page.click('#skill-equipment-modal [data-skill-item="bin_xin_jue"]');
      await page.waitForFunction(() => document.querySelector('#skill-equipment-actions [data-skill-action="unequip"]'));
      await page.click('#skill-equipment-actions [data-skill-action="unequip"]');
      await sleep(120);
      assert.equal(await page.evaluate(() => !!equippedSkills['bin_xin_jue']), false);
      assert.equal(await page.evaluate(() => document.getElementById('skill-equipment-memory-summary').textContent), '1 / 7');

      await page.click('#skill-equipment-modal [data-dialog-close]');
      await page.waitForFunction(() => document.getElementById('skill-equipment-modal').style.display === 'none');

      /* ============ 2. 技能习得（藏经阁） ============ */
      await page.evaluate(() => { closeModal(); showSkillLibrary(); });
      await page.waitForFunction(() => document.getElementById('skill-library-modal').style.display === 'block');

      const libFill = await fillCheck(page, 'skill-library-modal');
      assert.ok(Math.abs(libFill.dL) < 0.6 && Math.abs(libFill.dT) < 0.6 && Math.abs(libFill.dR) < 0.6 && Math.abs(libFill.dB) < 0.6, JSON.stringify(libFill));
      record.libFill = libFill;

      const libTabs = await page.$$eval('#skill-library-modal [data-dialog-tab]', els => els.map(e => e.textContent.trim()));
      assert.deepEqual(libTabs, ['攻击', '防御', '辅助', '控制']);

      // 辅助选项卡：冰心诀 badge = Lv2 → Lv3
      await page.click('#skill-library-modal [data-dialog-tab="辅助"]');
      await sleep(60);
      const auxItems = await page.$$eval('#skill-library-modal [data-library-item]', els => els.map(e => e.textContent.trim()));
      const bingxin = auxItems.find(t => t.includes('冰心诀'));
      assert.ok(bingxin && bingxin.includes('Lv2') && bingxin.includes('Lv3'), JSON.stringify(auxItems));

      // 选中冰心诀：右侧显示费用/记忆点/条件/效果/学习按钮
      await page.click('#skill-library-modal [data-library-item="bin_xin_jue"]');
      await page.waitForFunction(() => document.querySelector('#skill-library-actions button'));
      const libDetail = await page.$eval('#skill-library-detail', el => el.textContent);
      assert.ok(libDetail.includes('学习费用：9000 金'), libDetail);
      assert.ok(libDetail.includes('记忆点：3 点'), libDetail);
      assert.ok(libDetail.includes('学识 ≥ 70'), libDetail);
      assert.ok(libDetail.includes('学习条件'), libDetail);
      assert.ok(libDetail.includes('效果：'), libDetail);
      const learnBtn = await page.$eval('#skill-library-actions button', el => ({ text: el.textContent, disabled: el.disabled }));
      assert.equal(learnBtn.disabled, false, JSON.stringify(learnBtn));
      assert.equal(learnBtn.text, '学习', JSON.stringify(learnBtn));

      // 学习：确认弹窗 → 冰心诀升至 Lv3
      const beforeMoney = await page.evaluate(() => playerStats.金钱);
      await page.click('#skill-library-actions button');
      await page.waitForFunction(() => document.getElementById('modal').style.display === 'block');
      await page.click('#modal-buttons .modal-btn:not(.cancel)');
      await page.waitForFunction(() => learnedSkills['bin_xin_jue'] === 3);
      assert.equal(await page.evaluate(() => playerStats.金钱), beforeMoney - 9000);
      // 学习成功后会再弹一次提示，关闭它
      await page.waitForFunction(() => document.getElementById('modal').style.display === 'block');
      await page.click('#modal-buttons .modal-btn');
      await page.waitForFunction(() => document.getElementById('modal').style.display === 'none');
      // badge 更新为 Lv3 → Lv4
      const auxAfter = await page.$$eval('#skill-library-modal [data-library-item]', els => els.map(e => e.textContent.trim()));
      const bingxinAfter = auxAfter.find(t => t.includes('冰心诀'));
      assert.ok(bingxinAfter.includes('Lv3') && bingxinAfter.includes('Lv4'), JSON.stringify(auxAfter));

      await page.click('#skill-library-modal [data-dialog-close]');
      await page.waitForFunction(() => document.getElementById('skill-library-modal').style.display === 'none');

      /* ============ 3. 交易（伙房） ============ */
      await page.evaluate(() => { closeModal(); showTrading('food'); });
      await page.waitForFunction(() => document.getElementById('trading-modal').style.display === 'block');

      const tradeFill = await fillCheck(page, 'trading-modal');
      assert.ok(Math.abs(tradeFill.dL) < 0.6 && Math.abs(tradeFill.dT) < 0.6 && Math.abs(tradeFill.dR) < 0.6 && Math.abs(tradeFill.dB) < 0.6, JSON.stringify(tradeFill));
      record.tradeFill = tradeFill;

      const tradeTabs = await page.$$eval('#trading-modal [data-dialog-tab]', els => els.map(e => e.textContent.trim()));
      assert.deepEqual(tradeTabs, ['买入', '卖出']);
      assert.ok((await page.$eval('#trading-title', e => e.textContent)).includes('伙房'));

      // 买入选项卡：列表含伙房商品；选中胡饼 → 买入
      const buyNames = await page.$$eval('#trading-modal [data-trade-item]', els => els.map(e => e.dataset.tradeItem));
      assert.ok(buyNames.includes('胡饼') && buyNames.includes('桂花糕'), JSON.stringify(buyNames));
      await page.click('#trading-modal [data-trade-item="胡饼"]');
      await page.waitForFunction(() => document.querySelector('#trading-actions [data-trade-action="buy"]'));
      const buyDetail = await page.$eval('#trading-detail', el => el.textContent);
      assert.ok(buyDetail.includes('买入价格'), buyDetail);
      const moneyBeforeBuy = await page.evaluate(() => playerStats.金钱);
      const huBingBefore = await page.evaluate(() => inventory['胡饼']);
      await page.click('#trading-actions [data-trade-action="buy"]');
      await sleep(120);
      assert.equal(await page.evaluate(() => playerStats.金钱), moneyBeforeBuy - 500);
      assert.equal(await page.evaluate(() => inventory['胡饼']), huBingBefore + 1);

      // 卖出选项卡：列表含背包可交易物品；选中胡饼 → 卖出
      await page.click('#trading-modal [data-dialog-tab="sell"]');
      await sleep(60);
      const sellNames = await page.$$eval('#trading-modal [data-trade-item]', els => els.map(e => e.dataset.tradeItem));
      assert.ok(sellNames.includes('胡饼'), JSON.stringify(sellNames));
      await page.click('#trading-modal [data-trade-item="胡饼"]');
      await page.waitForFunction(() => document.querySelector('#trading-actions [data-trade-action="sell"]'));
      const moneyBeforeSell = await page.evaluate(() => playerStats.金钱);
      const huBingBeforeSell = await page.evaluate(() => inventory['胡饼']);
      await page.click('#trading-actions [data-trade-action="sell"]');
      await sleep(120);
      assert.equal(await page.evaluate(() => playerStats.金钱), moneyBeforeSell + 250);
      assert.equal(await page.evaluate(() => inventory['胡饼']), huBingBeforeSell - 1);

      await page.click('#trading-modal [data-dialog-close]');
      await page.waitForFunction(() => document.getElementById('trading-modal').style.display === 'none');

      /* ============ 古风皮肤计算样式（style 0） ============ */
      if (profile.style === 0) {
        const ancient = await page.evaluate(() => {
          const shell = document.querySelector('#skill-equipment-modal .dialog-panel-shell');
          const tab = document.querySelector('#skill-library-modal .dialog-tabs button');
          return {
            shellBorderImage: decodeURIComponent(getComputedStyle(shell).borderImageSource),
            tabBgImage: decodeURIComponent(getComputedStyle(tab).backgroundImage),
            tabBgSize: getComputedStyle(tab).backgroundSize,
          };
        });
        assert.ok(ancient.shellBorderImage.includes('边框-fill.png'), JSON.stringify(ancient));
        assert.ok(ancient.tabBgImage.includes('框5-短.png'), JSON.stringify(ancient));
        assert.notEqual(ancient.tabBgSize, '100% 100%', JSON.stringify(ancient));
        record.ancient = ancient;
      }

      const pageErrors = session.logs.filter(x => x.type === 'pageerror').map(x => x.text);
      assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));

      await page.screenshot({ path: path.join(output, `${label}.png`) });
      record.pass = true;
      record.detail = { equipTabs, libTabs, tradeTabs, buyNames, sellNames };
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
