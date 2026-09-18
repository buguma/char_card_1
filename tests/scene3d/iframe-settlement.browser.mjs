import path from 'node:path';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { newGameContext, startGame, json, artifact, saveSessionEvidence, assertSessionSafe } from '../../scene3d/scripts/test-support.mjs';
import { awaitFrame, clickVisible, exitIframeThroughRealControl, assertRendererPausedDuringHostOverlay } from './iframe-business.browser.mjs';

// Original iframe UI settlement only. Fixtures enter through the normal save bootstrap;
// no fabricated postMessage, live business mutation, victory, or weekly-lock bypass.
export async function iframeSettlement(ctx) {
  await mkdir(ctx.directory, { recursive: true });
  const pointer = await json(path.join(ctx.gameRoot || ctx.server.root, 'assets/sect3d/current.json'));
  assert.equal(pointer.buildId, ctx.buildId);
  const results = [];
  const business = page => page.evaluate(() => JSON.parse(JSON.stringify({ money:playerStats.金钱, inventory, lastFarmWeek, farmGrid, alchemyDone })));
  for (const name of ['farm', 'alchemy', 'blackjack']) {
    const channel = `${ctx.runId || ctx.buildId}-settlement-${name}`;
    const payload = await json(path.join(ctx.gameRoot || ctx.server.root, 'tests/scene3d/fixtures/saves/map.json'));
    payload.gameData.lastFarmWeek = payload.gameData.currentWeek; payload.gameData.farmGrid = [];
    await artifact(ctx.directory, `${name}-fixture.json`, payload);
    const session = await newGameContext(ctx.browser, ctx.server, { payload, channel });
    const page = session.page;
    try {
      await startGame(session, ctx.server); await page.evaluate(() => closeModal());
      await page.evaluate(() => GameSceneBridge.setPreference({enabled:true,quality:'low'}));
      await page.waitForFunction(() => GameSceneBridge.getDiagnostics().readyScene === 'main', {timeout:60000});
      assert.equal((await page.evaluate(() => GameSceneBridge.getDiagnostics())).buildId, ctx.buildId);
      const open = () => page.evaluate(name => ({farm:showFarmGame,alchemy:showAlchemyGame,blackjack:showBlackjackGame})[name](), name);
      const before = await business(page); await open(); const paused = await assertRendererPausedDuringHostOverlay(page);
      let price = 0, round = null, expectedMoney = before.money;
      if (name === 'farm') {
        const frame = await awaitFrame(page, '#farm-iframe'); await clickVisible(frame, '#btnShop');
        price = await frame.evaluate(() => CROPS.wheat.basePrice);
        await clickVisible(frame, '#shopItems .card:first-child .card-controls button:first-child'); await clickVisible(frame, '#btnCloseShop');
        expectedMoney -= price;
      } else if (name === 'alchemy') {
        const frame = await awaitFrame(page, '#alchemy-iframe');
        for (const selector of ['#start-alchemy-btn','.modal-shop-btn','#shop-content .shop-item:first-child .shop-item-btn','#shop-modal-overlay .modal-btn','#herb-modal-overlay .modal-buttons button:last-child']) await clickVisible(frame, selector);
        price = 500; expectedMoney -= price;
      } else {
        const frame = await awaitFrame(page, '#blackjack-iframe'); await frame.type('#bet-amount', '10'); await clickVisible(frame, '#deal');
        for (let hits=0; hits<22 && !(await frame.evaluate(() => document.querySelector('#result').textContent.length>0)); hits++) await clickVisible(frame, '#hit');
        await frame.waitForFunction(() => document.querySelector('#result').textContent.length>0);
        round = await frame.evaluate(() => ({player:Number(document.querySelector('#player-points').textContent),dealer:Number(document.querySelector('#dealer-points').textContent),money:Number(document.querySelector('#total-money').textContent),result:document.querySelector('#result').textContent}));
        assert.ok(Number.isFinite(round.player) && Number.isFinite(round.dealer));
        expectedMoney += round.player>21 ? -10 : round.dealer>21 || round.player>round.dealer ? 10 : round.player===round.dealer ? 0 : -10;
        assert.equal(round.money, expectedMoney);
      }
      const first = await exitIframeThroughRealControl(page, name), after = await business(page);
      assert.equal(after.money, expectedMoney); assert.notEqual(after.money, before.money, 'Require real nonzero settlement');
      let second=null, afterSecond=null;
      if (name === 'farm') { assert.equal(after.inventory['小麦种子'], (before.inventory['小麦种子']||0)+1); assert.equal(after.lastFarmWeek,payload.gameData.currentWeek); }
      if (name === 'farm' || name === 'blackjack') {
        if(name === 'blackjack') await page.evaluate(() => closeModal());
        await open(); await assertRendererPausedDuringHostOverlay(page); second=await exitIframeThroughRealControl(page,name); afterSecond=await business(page);
        assert.deepEqual(afterSecond,after,'Normal reopen/exit must not settle again');
      }
      if(name === 'alchemy') { assert.equal(after.alchemyDone,true); assert.equal(after.inventory['丹参'],(before.inventory['丹参']||0)+1); }
      assertSessionSafe(session,ctx.server,channel);
      results.push({name,status:'PASS',before,after,afterSecond,price,round,expectedMoney,paused,first,second});
    } catch(error) { results.push({name,status:'FAIL',error:error.stack}); }
    finally { try { await saveSessionEvidence(session,ctx.directory,name); } finally { await session.close(); await artifact(ctx.directory,'results.json',results); } }
  }
  assert.ok(results.every(row => row.status === 'PASS'), JSON.stringify(results.filter(row => row.status !== 'PASS')));
  return {automatedStatus:'PASS',buildId:ctx.buildId,results,scope:'Farm purchase, herb purchase and real blackjack round; normal reopen/exit once-only for farm/blackjack. No malicious replay certification; NPC weekly quit covered by P3-T02, worldmap departure/return by P4-T01.'};
}
