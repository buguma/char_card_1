// Standalone real-file ST recovery regression. Usage: node this-file <NEW absolute .scene3d-work report dir>
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { launchBrowser, newGameContext, startGame, json, workspace, artifact, readState, saveSessionEvidence, assertSessionSafe } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';
const directory = process.argv[2];
assert.ok(directory && path.isAbsolute(directory), 'Explicit absolute new report directory required');
const relative = path.relative(path.join(workspace, '.scene3d-work'), directory);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Report must be inside .scene3d-work');
await mkdir(directory);
const server = await startTestServer({ gameRoot: workspace });
let browser;
const results = [], comparisons = [];
try {
  browser = await launchBrowser();
  for (const scenario of [
    { name: 'event-locked', input: 0, event: '测试特殊事件链', expected: 0 },
    { name: 'temporary-lock', input: 0, event: '', expected: 1 },
    { name: 'event-unlocked', input: 1, event: '测试特殊事件链', expected: 1 }
  ]) {
    const pair = [];
    for (const enabled of [false, true]) {
      let session;
      const label = `${scenario.name}-${enabled}`;
      try {
        const payload = await json(path.join(workspace, 'tests/scene3d/fixtures/saves/map.json'));
        session = await newGameContext(browser, server, { payload, channel: label });
        const page = session.page;
        await startGame(session, server);
        await page.evaluate(() => closeModal());
        if (enabled) {
          await page.evaluate(() => GameSceneBridge.setPreference({ enabled: true, quality: 'low' }));
          await page.waitForFunction(() => GameSceneBridge.getDiagnostics().readyScene === 'main', { timeout: 60000 });
        }
        const imported = structuredClone(payload);
        Object.assign(imported.gameData, { inputEnable: scenario.input, currentSpecialEvent: scenario.event });
        const text = [
          JSON.stringify({ chat_metadata: { variables: { gameData: JSON.stringify(imported.gameData) } } }),
          JSON.stringify({ is_user: false, send_date: '2026-01-01T00:00:00Z', mes: '<SLG_MODE><MAIN_TEXT>合成ST锁恢复。|none|藏经阁|none|none</MAIN_TEXT><SUMMARY>合成摘要。</SUMMARY></SLG_MODE>' })
        ].join('\n');
        const filename = await artifact(directory, `${label}.jsonl`, text);
        const epoch = await page.evaluate(() => GameSceneBridge.getDiagnostics().epoch);
        const chooser = page.waitForFileChooser();
        await page.evaluate(() => importSTSaveFromLoadModal());
        await (await chooser).accept([filename]);
        await page.waitForFunction(() => document.querySelector('#modal-text')?.textContent.includes('ST 存档导入成功'), { timeout: 30000 });
        await page.evaluate(() => closeModal());
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const state = await readState(page);
        const diagnostics = await page.evaluate(() => GameSceneBridge.getDiagnostics());
        assert.equal(state.inputEnable, scenario.expected);
        assert.equal(state.currentSpecialEvent, scenario.event);
        assert.ok(diagnostics.epoch > epoch);
        if (enabled && scenario.expected === 0) {
          assert.equal(diagnostics.snapshot.interactive, false);
          assert.notEqual(diagnostics.renderer?.interactionEnabled, true);
        }
        assertSessionSafe(session, server, label);
        pair.push(state);
        results.push({ label, status: 'PASS', inputEnable: state.inputEnable, currentSpecialEvent: state.currentSpecialEvent, epoch: diagnostics.epoch });
      } catch (error) {
        results.push({ label, status: 'FAIL', error: error.stack });
        process.exitCode = 1;
      } finally {
        if (session) { await saveSessionEvidence(session, directory, label); await session.close(); }
        await artifact(directory, 'results.json', results);
      }
    }
    try {
      assert.equal(pair.length, 2, 'Both lanes must finish before parity can pass');
      assert.deepEqual(pair[0], pair[1], 'Full 2D/3D business/history/RNG equality');
      comparisons.push({ scenario: scenario.name, status: 'PASS', differences: [] });
    } catch (error) {
      comparisons.push({ scenario: scenario.name, status: 'FAIL', error: error.stack });
      process.exitCode = 1;
    }
    await artifact(directory, 'comparisons.json', comparisons);
  }
} finally {
  if (browser) await browser.close();
  await server.close();
  await artifact(directory, 'summary.json', { status: process.exitCode ? 'FAIL' : 'PASS', cases: results.length, comparisons: comparisons.length, scope: 'Current host ST import recovery with real file chooser; 2D/3D paired desktop Chromium, mock API only, not Android.' });
}
