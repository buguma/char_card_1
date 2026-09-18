import path from 'node:path';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { artifact,assertSessionSafe,diff,exportJson,fixturesRoot,hashFile,importJsonFile,json,newGameContext,readState,runReadOnlyValidator,saveSessionEvidence,sha256,startGame,verifySnapshotTree,workspace } from '../../scene3d/scripts/test-support.mjs';

const baselineManifestPath=path.join(workspace,'开发文档/3D整合/P0-源码基线.json');
export async function restoredBaseline(env) {
 const bytes=await readFile(baselineManifestPath),manifest=JSON.parse(bytes);
 assert.equal(manifest.schemaVersion,1);assert.equal(manifest.complete,true);assert.ok(path.isAbsolute(manifest.snapshotRoot));
 const summary={manifest:baselineManifestPath,manifestSha256:sha256(bytes),snapshotRoot:manifest.snapshotRoot,source:'Frozen snapshotRoot/game and snapshotRoot/pro ONLY; never current workspace sources',trees:{}};
 for(const tree of ['game','pro']) {
  const result=await verifySnapshotTree(path.join(manifest.snapshotRoot,tree),manifest[tree].files);
  await artifact(env.directory,`${tree}-hash-verification.json`,result);
  summary.trees[tree]={fileCount:result.fileCount,expectedCount:result.expectedCount,bytes:result.bytes,inventorySha256:result.inventorySha256,differenceCount:result.differences.length};
 }
 await artifact(env.directory,'baseline-restoration.json',summary);
 assert.ok(Object.values(summary.trees).every(tree=>tree.differenceCount===0),'Frozen snapshot differs from P0 baseline manifest; see per-file hash evidence');
 return summary;
}
export async function previewResources(env) {
 const manifest=await json(baselineManifestPath),proRoot=path.resolve(workspace,'../pro');
 const script=path.join(proRoot,'tools/verify-package.mjs'),apk=path.join(proRoot,'yunxiu-debug.apk'),web=path.join(proRoot,'viewer-dist');
 // This exact validator and its sole local import were inspected: read/hash/ZIP only, no build or extraction.
 for(const name of ['tools/verify-package.mjs','interior-scenes.js']) {
  assert.deepEqual(await hashFile(path.join(proRoot,name)),manifest.pro.files[name],`Read-only validator input changed since reviewed P0 snapshot: ${name}`);
 }
 const tracked=['tools/verify-package.mjs','interior-scenes.js','yunxiu-debug.apk','viewer-dist/deployment-manifest.json',...Object.keys(manifest.pro.files).filter(name=>name.endsWith('.glb')||name.startsWith('npc/generated/'))];
 const before={};for(const name of tracked)before[name]=await hashFile(path.join(proRoot,name));
 const processResult=await runReadOnlyValidator(script,[apk,web],{cwd:proRoot,directory:env.directory});
 const after={};for(const name of tracked)after[name]=await hashFile(path.join(proRoot,name));
 const stdout=await readFile(processResult.stdout,'utf8'),stderr=await readFile(processResult.stderr,'utf8');
 const sourceModelDiff=[];
 for(const name of Object.keys(manifest.pro.files).filter(name=>name.endsWith('.glb')))if(diff(before[name],manifest.pro.files[name]).length)sourceModelDiff.push({file:name,expected:manifest.pro.files[name],actual:before[name]});
 const parsed=stdout.match(/(\d+) web files match SHA-256[\s\S]*?all (\d+) source GLBs/);
 const result={...processResult,validatorSha256:before['tools/verify-package.mjs'].sha256,apk:before['yunxiu-debug.apk'],deploymentManifest:before['viewer-dist/deployment-manifest.json'],webFileCount:parsed?Number(parsed[1]):null,sourceGlbCount:parsed?Number(parsed[2]):null,sourceModelDiff,readOnlyDifferences:diff(after,before),before,after,scope:'Existing pro preview Web/APK byte-and-manifest validation only; NOT integrated game APK or Android device evidence'};
 await artifact(env.directory,'preview-verification.json',result);
 assert.equal(processResult.timedOut,false,'Read-only preview verifier timed out');
 assert.equal(processResult.code,0,`Preview verifier failed: ${stderr}`);
 assert.ok(parsed,'Verifier did not emit the expected actual success summary');
 assert.equal(result.sourceGlbCount,13);assert.ok(result.webFileCount>0);
 assert.deepEqual(result.readOnlyDifferences,[]);assert.deepEqual(sourceModelDiff,[],'Current preview GLBs differ from frozen source baseline');
 return result;
}
function expectState(state,expected,payload) {
 for(const [key,value] of Object.entries(expected)) assert.deepEqual(state[key],value,`state.${key}`);
 assert.deepEqual(state.playerStats,payload.gameData.playerStats);
 assert.deepEqual(state.uiConversation,payload.uiConversation);
 for(const key of ['mapLocation','companionNPC','currentSpecialEvent','triggeredEvents']) if(key in payload.gameData) assert.deepEqual(state.gameData[key],payload.gameData[key],key);
 if(payload.gameData.npcLocations) assert.deepEqual(state.currentNpcLocations,payload.gameData.npcLocations);
}
async function withSession(env,payload,channel,callback,extra={}) {
 const session=await newGameContext(env.browser,env.server,{payload,channel,...extra});
 try { await startGame(session,env.server); return await callback(session); }
 finally { await saveSessionEvidence(session,env.directory,channel); await session.close(); }
}

export async function roundTrips(env) {
 const manifest=await json(path.join(fixturesRoot,'manifest.json'));
 const baseline=await json(path.join(fixturesRoot,'saves/map.json'));
 const cases=[];
 for(const fixture of manifest.fixtures) {
  try {
   const payload=await json(path.join(fixturesRoot,fixture.payloadFile));
   let output;
   const safetyFailures=[];
   await withSession(env,baseline,`roundtrip-${fixture.id}-a`,async session=>{
    await importJsonFile(session.page,path.join(fixturesRoot,fixture.payloadFile));
    expectState(await readState(session.page),fixture.expected,payload);
    // Export before navigating utility pages: original cultivation backToMap intentionally moves to map.
    output=await exportJson(session.page);
    await artifact(env.directory,`${fixture.id}-export.json`,output);
    await session.page.evaluate(()=>showRelationships());
    assert.equal((await readState(session.page)).logicalPage,'relationships');
    await session.page.evaluate(()=>backToMap());
    await session.page.evaluate(()=>showHistorySummary());
    assert.equal(await session.page.$eval('#history-summary-modal',el=>el.style.display),'block');
    await session.page.evaluate(()=>closeHistorySummaryModal());
    try {assertSessionSafe(session,env.server,`roundtrip-${fixture.id}-a`);} catch(error) {safetyFailures.push(error.message);}
   });
   await withSession(env,baseline,`roundtrip-${fixture.id}-b`,async session=>{
    await importJsonFile(session.page,path.join(env.directory,`${fixture.id}-export.json`));
    expectState(await readState(session.page),fixture.expected,payload);
    const output2=await exportJson(session.page);
    const differences=diff(output2,output);
    await artifact(env.directory,`${fixture.id}-roundtrip-diff.json`,differences);
    assert.deepEqual(differences,[],'Full serialized payload changed after export/import/export');
    try {assertSessionSafe(session,env.server,`roundtrip-${fixture.id}-b`);} catch(error) {safetyFailures.push(error.message);}
   });
   cases.push({id:fixture.id,status:safetyFailures.length?'FAIL':'PASS',saveRoundTrip:'PASS',safetyFailures});
  } catch(error) { cases.push({id:fixture.id,status:'FAIL',error:error.stack}); }
 }
 await artifact(env.directory,'roundtrip-cases.json',cases);
 assert.equal(cases.filter(x=>x.status!=='PASS').length,0,JSON.stringify(cases.filter(x=>x.status!=='PASS')));
 return {cases};
}

export async function deterministicAction(env) {
 const payload=await json(path.join(fixturesRoot,'saves/map.json'));
 const response=await json(path.join(fixturesRoot,'responses/action-stream.json'));
 const trajectories=[];
 for(let run=0;run<2;run++) {
  const channel=`action-${run}`;
  env.server.enqueue(channel,response);
  const result=await withSession(env,payload,channel,async session=>{
   const {page}=session;
   const initial=await readState(page);
   assert.deepEqual(await readState(page),initial,'Read-only probe must not advance RNG or synchronize');
   await page.evaluate(()=>goToLocation('cangjingge'));
   const arrived=await readState(page); assert.equal(arrived.logicalPage,'cangjingge'); assert.equal(arrived.userLocation,'cangjingge'); assert.equal(arrived.actionPoints,initial.actionPoints);
   await page.evaluate(()=>{
    window.__scene3dTest.actionDone=false;
    performAction('学习','cangjingge').then(()=>window.__scene3dTest.actionDone=true,error=>window.__scene3dTest.actionError=error.message);
   });
   await env.server.waitFor(event=>event.channel===channel&&event.type==='waiting');
   // Actual application render consumed the first partial response; no synthetic final-state injection.
   await page.waitForFunction(()=>window.__scene3dRead().currentStoryText.includes('合成流式第一段'),{timeout:15000});
   const partial=await readState(page);
   assert.equal(partial.streaming,true);
   assert.equal(partial.uiConversation.length,payload.uiConversation.length,'No commit before checkpoint release');
   await artifact(env.directory,`${channel}-partial.json`,partial);
   await page.screenshot({path:path.join(env.directory,`${channel}-partial.png`)});
   await env.server.release(channel,'paragraph-consumed');
   await page.waitForFunction(()=>window.__scene3dTest.actionDone || window.__scene3dTest.actionError,{timeout:30000});
   assert.equal(await page.evaluate(()=>window.__scene3dTest.actionError),undefined);
   const committed=await readState(page);
   assert.equal(committed.streaming,false);
   assert.equal(committed.uiConversation.length,payload.uiConversation.length+2);
   assert.match(committed.uiConversation.at(-1).content,/合成流式第二段/);
   assert.equal(committed.summaryHistory.length,1);
   assert.equal(committed.userLocation,'cangjingge');
   const requests=env.server.requests.filter(x=>x.channel===channel);
   assert.equal(requests.length,response.expected.requestCount);
   assert.ok(requests[0].body.messages.every(x=>['system','user','assistant'].includes(x.role) && typeof x.content==='string'));
   assert.match(JSON.stringify(requests[0].body.messages),/藏经阁/);
   assert.match(JSON.stringify(requests[0].body.messages),/学习/);
   await artifact(env.directory,`${channel}-prompt.json`,requests[0].body);
   const saved=await exportJson(page);
   const savedFile=await artifact(env.directory,`${channel}-export.json`,saved);
   await importJsonFile(page,savedFile);
   const restored=await readState(page);
   const { _activeEvent:serializedEvent,...serializedGameData }=saved.gameData;
   assert.deepEqual(restored.gameData,serializedGameData);
   assert.deepEqual(restored.currentRandomEvent || restored.currentBattleEvent || null,serializedEvent);
   // _activeEvent is a transport envelope consumed by the real importer, not an ignored business field.
   assert.deepEqual(restored.uiConversation,saved.uiConversation);
   const actualNextRandom=await page.evaluate(()=>Math.random()); // explicit next business sample, not a probe mutation
   assertSessionSafe(session,env.server,channel);
   return {initial,arrived,partial,committed,saved,restored,actualNextRandom,prompt:requests[0].body};
  });
  trajectories.push(result);
  await artifact(env.directory,`${channel}-trajectory.json`,result);
 }
 const differences=diff(trajectories[1],trajectories[0]);
 await artifact(env.directory,'business-prompt-diff.json',differences);
 assert.deepEqual(differences,[],'Same business trajectory must match without ignored business fields');
 return {repetitions:2,differences:0,transport:'real HTTP write + application-consumed checkpoint',ignoredPaths:[]};
}

export async function modeUi(env) {
 const cases=[];
 for(const mode of ['library','gal']) for(const style of [0,1]) {
  const channel=`ui-${mode}-${style}`;
  const payload=await json(path.join(fixturesRoot,`saves/${mode}.json`));
  try {
   await withSession(env,payload,channel,async session=>{
    const {page}=session;
    const initial=await readState(page);
    assert.equal(initial.uiStyle,style);
    const steps=[];
    for(const [method,expected] of [['showPlayerStats','player-stats'],['showRelationships','relationships']]) {
     if(initial.GameMode===0) await page.evaluate(()=>goToLocation('cangjingge'));
     await page.evaluate(name=>window[name](),method);
     assert.equal((await readState(page)).logicalPage,expected);
     await page.screenshot({path:path.join(env.directory,`${channel}-${expected}.png`)});
     await page.evaluate(()=>backToMap());
     const returned=await readState(page);
     // Freeze original index.html:2508-2536 behavior, not a proposed UX change.
     assert.equal(returned.logicalPage,initial.GameMode===1?initial.logicalPage:'map');
     assert.equal(returned.GameMode,initial.GameMode);
     assert.equal(returned.userLocation,initial.GameMode===1?initial.userLocation:'tianshanpai');
     steps.push({method,returned});
    }
    await page.evaluate(()=>toggleStoryExpand());
    await page.screenshot({path:path.join(env.directory,`${channel}-expanded.png`)});
    await page.evaluate(()=>toggleStoryExpand());
    await page.evaluate(()=>showFarmGame());
    await page.waitForFunction(()=>document.querySelector('#farm-iframe')?.contentDocument?.readyState==='complete' && document.querySelector('#farm-iframe')?.getAttribute('src'),{timeout:20000});
    assert.match(await page.$eval('#farm-iframe',element=>element.src),/farm\.html/);
    await page.screenshot({path:path.join(env.directory,`${channel}-farm.png`)});
    await artifact(env.directory,`${channel}-paths.json`,steps);
    assertSessionSafe(session,env.server,channel);
   },{style});
   cases.push({mode,style,status:'PASS'});
  } catch(error) { cases.push({mode,style,status:'FAIL',error:error.stack}); }
 }
 await artifact(env.directory,'ui-cases.json',cases);
 assert.equal(cases.filter(x=>x.status!=='PASS').length,0,JSON.stringify(cases.filter(x=>x.status!=='PASS')));
 return {cases,device:'Desktop Chromium 390x844, not Android evidence'};
}
export const implementations={'P0-T01':restoredBaseline,'P0-T02':roundTrips,'P0-T03':deterministicAction,'P0-T04':modeUi,'P0-T05':previewResources};
