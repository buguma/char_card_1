import assert from 'node:assert/strict';
import path from 'node:path';
import { artifact,assertSessionSafe,diff,exportJson,fixturesRoot,importJsonFile,json,newGameContext,readState,saveSessionEvidence,startGame,workspace } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';
import { componentApply,componentDestroy,componentMount,frames,readBridgeDiagnostics,requirePublishedBuild,runBrowserCases,setEnabled,waitForLatestApplied,withIntegrated } from './p1.browser.mjs';

// Real published-renderer E2E plus explicitly labelled component race/timeout lanes.
export const plannedCases=Object.freeze([
 {testId:'P2-T01',fixtures:['map','responses/action-stream.json'],steps:['same seed/time in frozen 2D and integrated 3D contexts','map building info then confirm library travel','ordinary study through actual parser/pipeline','controlled partial response release','return then export/import'],completion:'Each logicalPage/location/AP/NPC/prompt/payload/RNG checkpoint equal; renderer latest applied scene matches host'},
 {testId:'P2-T02',fixtures:['map'],repetitions:20,steps:['rotate/pan/zoom/reset actual canvas','open/close building info without travel'],completion:'No business/RNG/save/API changes until original travel action confirmed'},
 {testId:'P2-T03',fixtures:['map','library','gal'],transport:'Exact static GLB fault/gate through owned loopback server; runner-token release after host invalidation',steps:['hold library GLB response','return map, switch Gal, open attributes or import another save','release obsolete response'],completion:'Old revision cannot become ready/current or reenable input; actual host transaction final state wins'},
 {testId:'P2-T04',fixtures:['library'],faults:['library GLB 404','held response timeout','invalid GLB bytes'],completion:'Same-location 2D fallback remains usable; explicit retry restores latest scene; no double action or save'},
 {testId:'P2-T05',fixtures:['map','gal','library'],steps:['unknown location intention','Gal intention','modal/generation lock','load non-integrated route'],completion:'Invalid or blocked navigation rejected by host; unsupported scene falls back without false successful interior entry'}
]);
export function businessProjection(state) {
 // This list excludes only presentation/diagnostic fields; no business field inside gameData is ignored.
 const keys=['GameMode','userLocation','userLocation_old','logicalPage','gameData','actionPoints','currentWeek','playerStats','npcFavorability','npcVisibility','currentNpcLocations','currentSpecialEvent','inputEnable','currentRandomEvent','currentBattleEvent','currentStoryText','uiConversation','summaryHistory','weekHistory','rng','visibleNpcIds'];
 return Object.fromEntries(keys.filter(key=>Object.hasOwn(state,key)).map(key=>[key,state[key]]));
}
export function compareBusinessCheckpoints(baseline,integrated) {
 return diff(businessProjection(integrated),businessProjection(baseline));
}
export function assertBusinessCheckpoints(baseline,integrated) {
 const differences=compareBusinessCheckpoints(baseline,integrated);
 assert.deepEqual(differences,[],'2D/3D business checkpoint mismatch');
 return differences;
}
export async function enterFromBuildingMenu(page,locationId='cangjingge') {
 await page.evaluate(id=>window.GameSceneBridge.showLocationInfoAtAnchor(id,{left:100,top:100,width:30,height:30}),locationId);
 await page.waitForSelector('.scene3d-menu',{visible:true});
 const text=await page.$eval('.scene3d-menu',element=>element.textContent);assert.match(text,/前往/);
 const buttons=await page.$$('.scene3d-menu button');let clicked=false;
 for(const button of buttons)if((await button.evaluate(element=>element.textContent)).includes('前往')){await button.click();clicked=true;break;}
 assert.ok(clicked,'No original travel action in 3D host menu');
}
export async function studyWithStream(env,server,page,channel,onPartial) {
 const response=await json(path.join(fixturesRoot,'responses/action-stream.json'));
 server.enqueue(channel,response);
 const before=await readState(page);
 await page.evaluate(()=>{window.__scene3dTest.actionDone=false;window.__scene3dTest.actionError=null;performAction('学习','cangjingge').then(()=>window.__scene3dTest.actionDone=true,error=>window.__scene3dTest.actionError=error.message);});
 await server.waitFor(event=>event.channel===channel&&event.type==='waiting');
 await page.waitForFunction(()=>window.__scene3dRead().currentStoryText.includes('合成流式第一段'));
 const partial=await readState(page);assert.equal(partial.uiConversation.length,before.uiConversation.length);assert.equal(partial.streaming,true);
 if(onPartial)await onPartial(partial);
 await artifact(env.directory,`${channel}-partial.json`,partial);
 await server.release(channel,'paragraph-consumed');
 await page.waitForFunction(()=>window.__scene3dTest.actionDone||window.__scene3dTest.actionError,{timeout:30000});
 assert.equal(await page.evaluate(()=>window.__scene3dTest.actionError),null);
 await page.evaluate(()=>closeModal());
 const committed=await readState(page);assert.equal(committed.uiConversation.length,before.uiConversation.length+2);
 const requests=server.requests.filter(request=>request.channel===channel);assert.equal(requests.length,1);
 assert.match(JSON.stringify(requests[0].body.messages),/藏经阁/);assert.match(JSON.stringify(requests[0].body.messages),/学习/);
 await artifact(env.directory,`${channel}-prompt.json`,requests[0].body);
 return {partial,committed,prompt:requests[0].body};
}
async function businessRoundTrip(env) {
 const build=await requirePublishedBuild(env),baselineRoot=path.join(workspace,'.scene3d-work/baseline-original/game');
 const baselineServer=await startTestServer({gameRoot:baselineRoot});
 let baseline;
 async function trajectory(session,server,channel,integrated) {
  const {page}=session;
  const initial=await readState(page);
  if(integrated){await setEnabled(page,true);await waitForLatestApplied(page,'main');await enterFromBuildingMenu(page);await waitForLatestApplied(page,'library');}
  else await page.evaluate(()=>goToLocation('cangjingge'));
  const arrived=await readState(page);assert.equal(arrived.userLocation,'cangjingge');assert.equal(arrived.actionPoints,initial.actionPoints);
  const {partial,committed,prompt}=await studyWithStream(env,server,page,channel,integrated?async()=>{
   const diagnostic=await readBridgeDiagnostics(page);assert.equal(diagnostic.snapshot.interactive,false);assert.equal(diagnostic.renderer.renderEnabled,false);
  }:undefined);
  if(integrated){await waitForLatestApplied(page,'library');await page.click('#cangjingge-scene .back-btn');await waitForLatestApplied(page,'main');}
  else await page.evaluate(()=>backToMap());
  const returned=await readState(page);assert.equal(returned.userLocation,'tianshanpai');
  const exported=await exportJson(page),filename=await artifact(env.directory,`${channel}-export.json`,exported);
  await importJsonFile(page,filename);if(integrated)await waitForLatestApplied(page,'main');
  const restored=await readState(page);
  assertSessionSafe(session,server,channel);
  const result={initial:businessProjection(initial),arrived:businessProjection(arrived),partial:businessProjection(partial),committed:businessProjection(committed),returned:businessProjection(returned),restored:businessProjection(restored),exported,prompt};
  await artifact(env.directory,`${channel}-trajectory.json`,result);return result;
 }
 try {
  const payload=await json(path.join(fixturesRoot,'saves/map.json'));
  const session=await newGameContext(env.browser,baselineServer,{payload,channel:'p2-business-2d'});
  try {await startGame(session,baselineServer);baseline=await trajectory(session,baselineServer,'p2-business-2d',false);}
  finally {await saveSessionEvidence(session,env.directory,'p2-business-2d');await session.close();}
  const integrated=await withIntegrated(env,build,'p2-business-3d',session=>trajectory(session,env.server,'p2-business-3d',true));
  const differences=diff(integrated,baseline);await artifact(env.directory,'2d-3d-business-prompt-diff.json',differences);
  assert.deepEqual(differences,[],'Actual 2D/3D business trajectories differ');return {differences:0,baselineRoot,buildId:build.current.buildId};
 } finally {await artifact(env.directory,'baseline-transport.json',{origin:baselineServer.origin,events:baselineServer.events,requests:baselineServer.requests});await baselineServer.close();}
}
async function nonBusinessInput(env) {
 const build=await requirePublishedBuild(env);
 return withIntegrated(env,build,'p2-nonbusiness',async({page})=>{
  await waitForLatestApplied(page,'main');const before=await readState(page),saves=await page.evaluate(()=>storageService.listSaves());
  const samples=[];
  for(let index=0;index<20;index++) {
   const rect=await page.$eval('#sect-3d-root canvas',element=>{const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
   await page.mouse.move(rect.x+rect.width*.4,rect.y+rect.height*.45);await page.mouse.down();await page.mouse.move(rect.x+rect.width*.65,rect.y+rect.height*.6,{steps:8});await page.mouse.up();
   await page.mouse.move(rect.x+rect.width*.4,rect.y+rect.height*.45);await page.mouse.down({button:'right'});await page.mouse.move(rect.x+rect.width*.55,rect.y+rect.height*.6,{steps:8});await page.mouse.up({button:'right'});
   await page.mouse.wheel({deltaY:index%2?80:-80});await page.click('#sect-3d-root .scene3d-reset');
   await page.evaluate(()=>window.GameSceneBridge.showLocationInfoAtAnchor('cangjingge',{left:120,top:120,width:30,height:30}));
   await page.waitForSelector('.scene3d-menu',{visible:true});await page.evaluate(()=>document.body.dispatchEvent(new Event('pointerdown',{bubbles:true})));await waitForLatestApplied(page,'main');
   samples.push((await readState(page)).rng);
  }
  const after=await readState(page);assertBusinessCheckpoints(before,after);
  assert.deepEqual(await page.evaluate(()=>storageService.listSaves()),saves);
  assert.equal(env.server.requests.filter(request=>request.channel==='p2-nonbusiness').length,0);
  return {iterations:20,rngSamples:samples};
 },{enabled:true});
}
async function latestWins(env) {
 const build=await requirePublishedBuild(env),libraryPath=build.basePath+'sub_scene/library_interior.glb',cases=[];
 for(const target of ['map','gal','attributes','other-save']) {
  const channel=`p2-race-${target}`;
  cases.push([target,()=>withIntegrated(env,build,channel,async({page})=>{
   await waitForLatestApplied(page,'main');env.server.setAssetRule(libraryPath,{channel,waitFor:'release'});
   await enterFromBuildingMenu(page);await env.server.waitFor(event=>event.type==='asset-waiting'&&event.channel===channel);
   const pending=await readBridgeDiagnostics(page);
   if(target==='map')await page.evaluate(()=>backToMap());
   if(target==='gal')await importJsonFile(page,path.join(fixturesRoot,'saves/gal.json'));
   if(target==='attributes')await page.evaluate(()=>showPlayerStats());
   if(target==='other-save') {
    const save=await json(path.join(fixturesRoot,'saves/library.json'));save.gameData.userLocation='houshan';save.saveName='合成乱序恢复后山';
    const filename=await artifact(env.directory,`${channel}-input.json`,save);await importJsonFile(page,filename);
   }
   const atInvalidation=await readState(page);
   env.server.clearAssetRules();await env.server.release(channel,'release');
   if(target==='map')await waitForLatestApplied(page,'main');
   if(target==='other-save')await waitForLatestApplied(page,'back_mountain');
   await page.waitForFunction(()=>{const d=window.GameSceneBridge.getDiagnostics();return !d.renderer||d.renderer.pendingLoads===0;},{timeout:60000});await frames(page,4);
   const final=await readBridgeDiagnostics(page),after=await readState(page);
   assert.equal(after.logicalPage,atInvalidation.logicalPage);assert.equal(after.userLocation,atInvalidation.userLocation);assert.notEqual(final.readyScene,'library');
   if(target==='gal'||target==='attributes'){assert.equal(final.snapshot.visible,false);assert.equal(final.renderer?.interactionEnabled??false,false);}
   if(target==='gal'||target==='other-save')assert.ok(final.epoch>pending.epoch);
   return {pending,atInvalidation,final};
  },{enabled:true})]);
 }
 cases.push(['same-revision-cancel-resume-component',()=>withIntegrated(env,build,'p2-same-revision',async({page})=>{
  await componentMount(page,build);assert.equal((await componentApply(page)).result.status,'applied');
  env.server.setAssetRule(libraryPath,{channel:'p2-same-revision',waitFor:'release'});
  const patch={sceneId:'library',logicalPage:'cangjingge',gameLocationId:'cangjingge'};
  const first=componentApply(page,patch).then(value=>({value}),error=>({error:error.message}));
  await env.server.waitFor(event=>event.type==='asset-waiting'&&event.channel==='p2-same-revision');
  const second=page.evaluate(async()=>{const t=window.__scene3dTest;t.component.setVisible(false);t.component.setVisible(true);const pending=t.component.applyState(t.componentSnapshot);t.sameRevisionReentered=true;const result=await pending;return {result,diagnostics:t.component.getDiagnostics()};}).then(value=>({value}),error=>({error:error.message}));
  await page.waitForFunction(()=>window.__scene3dTest.sameRevisionReentered===true);
  env.server.clearAssetRules();await env.server.release('p2-same-revision','release');
  const [a,b]=await Promise.all([first,second]);assert.ok(!a.error&&!b.error,JSON.stringify({a,b}));assert.equal(a.value.result.status,'superseded');assert.equal(b.value.result.status,'applied');assert.equal(b.value.diagnostics.activeSceneId,'library');
  assert.equal(a.value.result.revision,b.value.result.revision);const destroyed=await componentDestroy(page);return {first:a,second:b,destroyed,scope:'Actual renderer component lifecycle on real host page; not a fabricated business commit'};
 })]);
 return runBrowserCases(env,cases);
}
async function roomFailures(env) {
 const build=await requirePublishedBuild(env),libraryPath=build.basePath+'sub_scene/library_interior.glb';
 const cases=[];
 for(const [label,rule] of [['404',{status:404}],['corrupt',{status:200,body:'not a GLB'}]]) {
  const channel=`p2-room-${label}`;
  cases.push([label,()=>withIntegrated(env,build,channel,async({page})=>{
   await waitForLatestApplied(page,'main');const before=await readState(page);env.server.setAssetRule(libraryPath,{...rule,channel});
   await enterFromBuildingMenu(page);await page.waitForFunction(()=>{const d=window.GameSceneBridge.getDiagnostics();return d.snapshot.gameLocationId==='cangjingge'&&d.errors.length>0&&d.readyScene===null;},{timeout:90000});
   const failed=await readBridgeDiagnostics(page),state=await readState(page);assert.equal(state.userLocation,'cangjingge');assert.equal(state.actionPoints,before.actionPoints);
   assert.equal(await page.$eval('#cangjingge-scene .scene-btn',element=>!element.disabled&&element.getClientRects().length>0),true);
   env.server.clearAssetRules();await page.evaluate(()=>window.GameSceneBridge.retry());const recovered=await waitForLatestApplied(page,'library');
   assert.equal(recovered.revision,failed.revision);assert.equal(recovered.epoch,failed.epoch);assert.equal((await readState(page)).actionPoints,before.actionPoints);
   return {failed,recovered};
  },{enabled:true})]);
 }
 cases.push(['room-timeout-component',()=>withIntegrated(env,build,'p2-room-timeout',async({page})=>{
  await componentMount(page,build,{roomTimeoutMs:2000});assert.equal((await componentApply(page)).result.status,'applied');
  env.server.setAssetRule(libraryPath,{channel:'p2-room-timeout',waitFor:'release'});
  const failed=await componentApply(page,{sceneId:'library',logicalPage:'cangjingge',gameLocationId:'cangjingge'});assert.equal(failed.result.status,'degraded');
  env.server.clearAssetRules();await env.server.release('p2-room-timeout','release');
  const retry=await page.evaluate(async()=>{const t=window.__scene3dTest;return {result:await t.component.retry(),diagnostics:t.component.getDiagnostics()};});
  assert.equal(retry.result.status,'applied');assert.equal(retry.result.revision,failed.result.revision);await componentDestroy(page);return {failed,retry};
 })]);
 return runBrowserCases(env,cases);
}
async function navigationGuards(env) {
 const build=await requirePublishedBuild(env);
 return runBrowserCases(env,[
  ['unknown-modal-and-generation-lock',()=>withIntegrated(env,build,'p2-guards',async({page})=>{
   await waitForLatestApplied(page,'main');const initial=await readState(page);
   await page.evaluate(()=>window.GameSceneBridge.showLocationInfoAtAnchor('unknown-route',{}));assert.equal(await page.$('.scene3d-menu'),null);assertBusinessCheckpoints(initial,await readState(page));
   await page.evaluate(()=>showModal('合成模态输入锁'));await frames(page);
   await page.evaluate(()=>window.GameSceneBridge.showLocationInfoAtAnchor('cangjingge',{}));assert.equal(await page.$('.scene3d-menu'),null);assertBusinessCheckpoints(initial,await readState(page));
   await page.evaluate(()=>closeModal());await waitForLatestApplied(page,'main');await enterFromBuildingMenu(page);await waitForLatestApplied(page,'library');
   await studyWithStream(env,env.server,page,'p2-guards',async partial=>{
    await page.evaluate(()=>window.GameSceneBridge.showLocationInfoAtAnchor('houshan',{}));assert.equal(await page.$('.scene3d-menu'),null);
    const current=await readState(page);assert.equal(current.userLocation,partial.userLocation);assert.equal(current.actionPoints,partial.actionPoints);
    const diagnostic=await readBridgeDiagnostics(page);assert.equal(diagnostic.snapshot.interactive,false);assert.equal(diagnostic.renderer.interactionEnabled,false);
   });
   await waitForLatestApplied(page,'library');return readBridgeDiagnostics(page);
  },{enabled:true})],
  ['gal-intent-rejected',()=>withIntegrated(env,build,'p2-gal-guard',async({page})=>{
   const before=await readState(page);await page.evaluate(()=>window.GameSceneBridge.showLocationInfoAtAnchor('cangjingge',{}));await frames(page);
   assert.equal(await page.$('.scene3d-menu'),null);assertBusinessCheckpoints(before,await readState(page));const diagnostic=await readBridgeDiagnostics(page);assert.equal(diagnostic.renderer,null);return diagnostic;
  },{enabled:true,fixture:'gal'})],
  ['unsupported-save-route-retains-business',()=>withIntegrated(env,build,'p2-unsupported',async({page})=>{
   await waitForLatestApplied(page,'main');const save=await json(path.join(fixturesRoot,'saves/library.json'));save.gameData.userLocation='unsupported-test-location';save.saveName='合成异常地点负测';
   const filename=await artifact(env.directory,'unsupported-route-input.json',save);await importJsonFile(page,filename);await frames(page);
   const state=await readState(page),diagnostic=await readBridgeDiagnostics(page);assert.equal(state.userLocation,'unsupported-test-location');assert.equal(diagnostic.snapshot.sceneId,null);assert.equal(diagnostic.snapshot.visible,false);assert.equal(diagnostic.renderer?.interactionEnabled??false,false);
   return {state,diagnostic,scope:'Deliberately malformed location fixture; no claim to repair original 2D route behavior'};
  },{enabled:true})]
 ]);
}
export const implementations={'P2-T01':businessRoundTrip,'P2-T02':nonBusinessInput,'P2-T03':latestWins,'P2-T04':roomFailures,'P2-T05':navigationGuards};
