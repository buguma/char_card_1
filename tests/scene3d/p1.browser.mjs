import path from 'node:path';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { artifact,assertSessionSafe,diff,fixturesRoot,hashFile,json,newGameContext,readState,saveSessionEvidence,sha256,startGame } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';

// Real-browser cases require an explicitly named, hash-verified published renderer.
// Integration-001 is known stale and is deliberately rejected; no stub page replaces the game.
export const plannedCases=Object.freeze([
 {testId:'P1-T01',fixtures:['map','gal'],steps:['native import published entry without mount','cold Gal with preference enabled','cold cultivation map with preference enabled'],completion:'Import has no canvas/listeners; Gal no GLB/renderer; cultivation exactly one applied renderer'},
 {testId:'P1-T02',fixtures:['map','library'],widths:[320,390,768,1280],themes:[0,1],steps:['resize parent only','zero container then restore','scroll'],completion:'Real ResizeObserver and drawingBuffer dimensions match container/DPR, no NaN or overflow'},
 {testId:'P1-T03',fixtures:['map'],repetitions:20,steps:['mount/toggle/unmount','wait explicit renderer completion','hide and observe frame counter','destroy and measure resources'],completion:'At most one renderer, hidden frames stable, owned resources/listeners/rAF cleaned'},
 {testId:'P1-T04',fixtures:['map'],faults:['main GLB 404','Draco 404','controlled timeout','renderer failure','context loss where supported'],completion:'Same business state retains functional 2D, retries do not reload page or double commit'},
 {testId:'P1-T05',fixtures:['map'],manual:true,steps:['published static subpath desktop smoke','separate named target Android evidence'],completion:'Both local static asset resolution and real device smoke; desktop alone never clears manual requirement'}
]);
export function isLatestApplied(diagnostics,sceneId) {
 const state=diagnostics?.snapshot,renderer=diagnostics?.renderer;
 return !!(state && renderer && diagnostics.started && diagnostics.readyScene===sceneId &&
  state.sceneId===sceneId && state.sessionEpoch===diagnostics.epoch && state.revision===diagnostics.revision &&
  renderer.ready && renderer.activeSceneId===sceneId && renderer.appliedVersion===`${state.sessionEpoch}:${state.revision}`);
}
export async function readBridgeDiagnostics(page) {
 return page.evaluate(()=>{
  const bridge=window.GameSceneBridge;
  if(!bridge?.getDiagnostics)throw Error('Host GameSceneBridge diagnostics not present; real integration is not ready');
  return JSON.parse(JSON.stringify(bridge.getDiagnostics()));
 });
}
export async function waitForLatestApplied(page,sceneId,timeout=90000) {
 // Only observes the real bridge/runtime public diagnostics. It never calls sync/save/apply.
 await page.waitForFunction(expected=>{
  const bridge=window.GameSceneBridge?.getDiagnostics?.(),state=bridge?.snapshot,renderer=bridge?.renderer;
  return !!(state&&renderer&&bridge.started&&bridge.readyScene===expected&&state.sceneId===expected&&state.sessionEpoch===bridge.epoch&&state.revision===bridge.revision&&renderer.ready&&renderer.activeSceneId===expected&&renderer.appliedVersion===`${state.sessionEpoch}:${state.revision}`);
 },{timeout},sceneId);
 const diagnostics=await readBridgeDiagnostics(page);assert.ok(isLatestApplied(diagnostics,sceneId));return diagnostics;
}
export async function inspectPublishedBuild(gameRoot) {
 const current=await json(path.join(gameRoot,'assets/sect3d/current.json'));
 assert.equal(current.schemaVersion,1);assert.ok(current.buildId);
 assert.ok(typeof current.manifest==='string'&&!path.isAbsolute(current.manifest)&&!current.manifest.split(/[\\/]/).includes('..'));
 const bytes=await readFile(path.join(gameRoot,'assets/sect3d',current.manifest));
 assert.equal(sha256(bytes),current.manifestSha256,'Do not test a mixed/stale release');
 return {current,manifest:JSON.parse(bytes),scope:'Prerequisite inspection only; not renderer validation'};
}

export async function requirePublishedBuild(env) {
 assert.ok(env.buildId,'P1/P2 require --buildId=<explicit tested publication>');
 assert.ok(!['integration-001','integration-002'].includes(env.buildId),'Known stale/failed integration-001/002 cannot be acceptance input');
 const build=await inspectPublishedBuild(env.gameRoot);
 assert.equal(build.current.buildId,env.buildId,'Publication changed or wrong expected build');
 assert.ok(build.manifest.css?.length,'Real renderer publication must include CSS');
 for(const [name,expected] of Object.entries(build.manifest.files)) {
  assert.ok(!path.isAbsolute(name)&&!name.split(/[\\/]/).includes('..'));
  assert.deepEqual(await hashFile(path.join(env.gameRoot,'assets/sect3d',env.buildId,name)),{bytes:expected.bytes,sha256:expected.sha256},`Published byte mismatch: ${name}`);
 }
 build.basePath=`assets/sect3d/${env.buildId}/`;
 build.baseUrl=`${env.server.origin}/${build.basePath}`;
 build.entryUrl=new URL(build.manifest.entry,build.baseUrl).href;
 await artifact(env.directory,'tested-build.json',{current:build.current,entry:build.manifest.entry,css:build.manifest.css,fileCount:Object.keys(build.manifest.files).length});
 return build;
}
export async function withIntegrated(env,build,label,operation,{fixture='map',enabled,style=0,viewport,prepare}={}) {
 const payload=await json(path.join(fixturesRoot,`saves/${fixture}.json`));
 const session=await newGameContext(env.browser,env.server,{payload,channel:label,style,viewport,scene3dPreferences:enabled===undefined?undefined:{enabled,quality:'low'}});
 try {
  if(prepare)await prepare(session.page);
  await startGame(session,env.server);
  await session.page.waitForFunction(()=>window.GameSceneBridge?.getDiagnostics?.().started,{timeout:15000});
  const result=await operation(session,payload);
  assertSessionSafe(session,env.server,label);
  return result;
 } finally {
  try {await artifact(env.directory,`${label}-bridge.json`,await readBridgeDiagnostics(session.page));}catch{}
  await saveSessionEvidence(session,env.directory,label);await session.close();env.server.clearAssetRules();
 }
}
export async function runBrowserCases(env,cases) {
 const results=[];
 for(const [name,run] of cases) {
  const startedAt=new Date().toISOString();
  try {results.push({name,startedAt,status:'PASS',actual:await run()});}
  catch(error){results.push({name,startedAt,status:'FAIL',error:error.stack});}
  await artifact(env.directory,'subcases.json',results);
 }
 assert.equal(results.filter(x=>x.status!=='PASS').length,0,JSON.stringify(results.filter(x=>x.status!=='PASS')));
 return {cases:results,scope:'Real published renderer in desktop Chromium, not Android performance acceptance'};
}
export async function frames(page,count=3) {
 await page.evaluate(n=>new Promise(resolve=>{function next(){if(--n<=0)resolve();else requestAnimationFrame(next);}requestAnimationFrame(next);}),count);
}
export async function setEnabled(page,enabled) {
 await page.evaluate(value=>window.GameSceneBridge.setPreference({enabled:value}),enabled);
 if(!enabled)await page.waitForFunction(()=>window.GameSceneBridge.getDiagnostics().renderer===null,{timeout:15000});
}
export async function componentMount(page,build,options={}) {
 await setEnabled(page,false);
 await page.evaluate(async({entry,base,options})=>{
  const module=await import(entry),container=document.createElement('div');
  container.dataset.scene3dOwned='test-component';container.style.cssText='position:fixed;left:0;top:0;width:390px;height:500px;z-index:3000';document.body.append(container);
  const snapshot=window.GameSceneBridge.getDiagnostics().snapshot;
  window.__scene3dTest.componentContainer=container;
  window.__scene3dTest.component=module.mount(container,{protocol:1,assetBaseUrl:base,quality:'low',debug:true,...options});
  window.__scene3dTest.componentSnapshot={...snapshot,mode:0,logicalPage:'map',gameLocationId:'tianshanpai',sceneId:'main',visible:true,renderEnabled:true,interactive:true,blockReasons:[],residents:[],renderedNpcs:[]};
 },{entry:build.entryUrl,base:build.baseUrl,options});
}
export async function componentApply(page,patch={}) {
 return page.evaluate(async patch=>{
  const test=window.__scene3dTest;test.componentSnapshot={...test.componentSnapshot,...patch};
  const result=await test.component.applyState(test.componentSnapshot);
  return {result,diagnostics:test.component.getDiagnostics()};
 },patch);
}
export async function componentDestroy(page) {
 return page.evaluate(async()=>{const test=window.__scene3dTest;await test.component.destroy();const result=test.component.getDiagnostics();test.componentContainer.remove();return result;});
}

async function coldImports(env) {
 const build=await requirePublishedBuild(env);
 return runBrowserCases(env,[
  ['default-off',()=>withIntegrated(env,build,'p1-default-off',async({page,network})=>{
   await frames(page);const diagnostic=await readBridgeDiagnostics(page);
   assert.equal(diagnostic.preferences.enabled,false);assert.equal(diagnostic.renderer,null);
   assert.equal(network.filter(x=>x.method&&x.url.startsWith('/assets/sect3d/')).length,0);
   return diagnostic;
  })],
  ['gal-enabled-no-renderer',()=>withIntegrated(env,build,'p1-gal-enabled',async({page,network})=>{
   await frames(page);const diagnostic=await readBridgeDiagnostics(page);
   assert.equal(diagnostic.preferences.enabled,true);assert.equal(diagnostic.snapshot.mode,1);assert.equal(diagnostic.renderer,null);
   assert.equal(network.filter(x=>x.method&&x.url.startsWith('/assets/sect3d/')).length,0);return diagnostic;
  },{fixture:'gal',enabled:true})],
  ['published-import-is-inert',()=>withIntegrated(env,build,'p1-inert-import',async({page})=>{
   // Original host image/font layout may finish after its async onload handler; observe
   // actual outstanding resource completion before measuring import-only side effects.
   await page.waitForNetworkIdle({idleTime:300,timeout:15000});await page.evaluate(()=>document.fonts.ready);await frames(page,3);
   const before=await readState(page);
   const observation=await page.evaluate(async entry=>{
    const before={body:document.body.outerHTML,canvas:document.querySelectorAll('canvas').length},original=EventTarget.prototype.addEventListener;let added=0;
    const mutations=[],observer=new MutationObserver(records=>mutations.push(...records.map(record=>({type:record.type,target:record.target.nodeName+'#'+(record.target.id||''),attribute:record.attributeName,oldValue:record.oldValue,value:record.attributeName?record.target.getAttribute(record.attributeName):null,added:[...record.addedNodes].map(node=>node.nodeName),removed:[...record.removedNodes].map(node=>node.nodeName)}))));
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeOldValue:true,characterData:true});
    EventTarget.prototype.addEventListener=function(...args){added++;return original.apply(this,args);};
    try {const module=await import(entry);const after=document.body.outerHTML;return {hasMount:typeof module.mount==='function',added,bodyEqual:after===before.body,canvasDelta:document.querySelectorAll('canvas').length-before.canvas,mutations,beforeBody:before.body,afterBody:after};}
    finally {EventTarget.prototype.addEventListener=original;observer.disconnect();}
   },build.entryUrl);
   await artifact(env.directory,'inert-import-before.html',observation.beforeBody);await artifact(env.directory,'inert-import-after.html',observation.afterBody);
   const {beforeBody,afterBody,...importObservation}=observation;await artifact(env.directory,'inert-import-observation.json',importObservation);
   assert.equal(importObservation.hasMount,true);assert.equal(importObservation.added,0);assert.equal(importObservation.canvasDelta,0);assert.equal(importObservation.bodyEqual,true,JSON.stringify(importObservation.mutations));
   assert.deepEqual((await readState(page)).rng,before.rng);return importObservation;
  })],
  ['cultivation-actual-model',()=>withIntegrated(env,build,'p1-main-real',async({page,network})=>{
   const before=await readState(page);await setEnabled(page,true);
   const diagnostic=await waitForLatestApplied(page,'main');
   assert.equal(diagnostic.renderer.renderers,1);assert.equal(diagnostic.renderer.canvases,1);
   assert.ok(network.some(x=>x.method==='GET'&&x.url.endsWith('/sect_diorama.glb')));
   assert.deepEqual((await readState(page)).rng,before.rng);return diagnostic;
  })]
 ]);
}
async function resizeContainers(env) {
 const build=await requirePublishedBuild(env),cases=[];
 for(const width of [320,390,768,1280])for(const style of [0,1]) {
  const label=`p1-resize-${width}-${style}`;
  cases.push([label,()=>withIntegrated(env,build,label,async({page})=>{
   await waitForLatestApplied(page,'main');
   const samples=[],hostRect=await page.$eval('#main-viewport',element=>({width:Math.floor(element.clientWidth),height:Math.floor(element.clientHeight)}));
   const restoredSize={width:Math.max(100,hostRect.width-12),height:Math.max(100,hostRect.height-12)};
   for(const size of [{width:Math.max(100,hostRect.width-24),height:Math.max(100,hostRect.height-24)},{width:Math.max(100,hostRect.width-80),height:Math.max(100,hostRect.height-80)}]) {
    await page.evaluate(size=>{const root=document.getElementById('sect-3d-root');root.style.width=`${size.width}px`;root.style.height=`${size.height}px`;root.style.right='auto';root.style.bottom='auto';},size);
    await page.waitForFunction(size=>{const d=window.GameSceneBridge.getDiagnostics().renderer;return d?.width===size.width&&d.height===size.height;},{timeout:15000},size);
    const d=(await readBridgeDiagnostics(page)).renderer;
    assert.ok(Number.isFinite(d.width)&&Number.isFinite(d.height)&&d.width>0&&d.height>0);
    assert.ok(Math.abs(d.drawingWidth-d.width*d.dpr)<=1&&Math.abs(d.drawingHeight-d.height*d.dpr)<=1);samples.push(d);
   }
   await page.evaluate(()=>{const root=document.getElementById('sect-3d-root');root.style.width='0px';root.style.height='0px';});
   await frames(page,4);
   const zero=(await readBridgeDiagnostics(page)).renderer;assert.ok(Number.isFinite(zero.width)&&Number.isFinite(zero.height));
   await page.evaluate(size=>{const root=document.getElementById('sect-3d-root');root.style.width=`${size.width}px`;root.style.height=`${size.height}px`;},restoredSize);
   await page.waitForFunction(size=>{const d=window.GameSceneBridge.getDiagnostics().renderer;return d?.width===size.width&&d.height===size.height;},{timeout:15000},restoredSize);
   await waitForLatestApplied(page,'main');await page.evaluate(()=>window.scrollTo(0,30));await frames(page);
   return {width,style,samples,restored:await readBridgeDiagnostics(page)};
  },{enabled:true,style,viewport:{width,height:844,deviceScaleFactor:1}})]);
 }
 return runBrowserCases(env,cases);
}
async function lifecycles(env) {
 const build=await requirePublishedBuild(env);
 return runBrowserCases(env,[['20-host-enable-disable',()=>withIntegrated(env,build,'p1-lifecycle',async({page})=>{
  const before=await readState(page),cycles=[];
  for(let i=0;i<20;i++) {
   await setEnabled(page,true);const on=await waitForLatestApplied(page,'main');assert.equal(on.renderer.renderers,1);assert.equal(on.renderer.canvases,1);
   await setEnabled(page,false);const off=await readBridgeDiagnostics(page);
   assert.equal(off.counters.mounts,off.counters.destroys);assert.equal(await page.$$eval('#sect-3d-root canvas',nodes=>nodes.length),0);cycles.push({on,off});
  }
  assert.deepEqual((await readState(page)).rng,before.rng);
  await setEnabled(page,true);await waitForLatestApplied(page,'main');await page.evaluate(()=>showPlayerStats());
  await page.waitForFunction(()=>window.GameSceneBridge.getDiagnostics().renderer?.visible===false);
  const hidden=await page.evaluate(()=>new Promise(resolve=>{const start=performance.now(),first=window.GameSceneBridge.getDiagnostics().renderer.frames;function sample(){if(performance.now()-start>=10000){resolve({first,last:window.GameSceneBridge.getDiagnostics().renderer.frames,elapsed:performance.now()-start});}else requestAnimationFrame(sample);}requestAnimationFrame(sample);}));
  assert.equal(hidden.first,hidden.last);await page.evaluate(()=>backToMap());await waitForLatestApplied(page,'main');
  await componentMount(page,build);const applied=await componentApply(page);assert.equal(applied.result.status,'applied');
  const destroyed=await componentDestroy(page);
  for(const key of ['renderers','canvases','raf','listeners','observers','controls','decoders','fetches','resources','geometries','textures'])assert.equal(destroyed[key],0,`destroyed ${key}`);
  return {cycles,hidden,destroyed};
 })]]);
}
async function failures(env) {
 const build=await requirePublishedBuild(env),mainPath=build.basePath+'sect_diorama.glb';
 const cases=[];
 for(const [label,rule] of [['main-404',{status:404}],['main-corrupt',{status:200,body:'synthetic invalid GLB'}],['draco-404',{status:404,path:build.basePath+'draco/draco_decoder.wasm'}]]) {
  cases.push([label,()=>withIntegrated(env,build,`p1-${label}`,async({page})=>{
   const before=await readState(page);env.server.setAssetRule(rule.path||mainPath,{...rule,channel:`p1-${label}`});
   await setEnabled(page,true);
   await page.waitForFunction(()=>{const d=window.GameSceneBridge.getDiagnostics();return (d.errors.length>0&&d.readyScene===null)||d.readyScene==='main';},{timeout:90000});
   assert.ok(env.server.events.some(event=>event.type==='asset-request'&&event.channel===`p1-${label}`),'Faulted resource was never requested');
   const degraded=await readBridgeDiagnostics(page);assert.equal(degraded.readyScene,null,'Fault did not produce the required fallback');assert.equal((await readState(page)).userLocation,before.userLocation);
   await page.evaluate(()=>{goToLocation('cangjingge');backToMap();});assert.equal((await readState(page)).logicalPage,'map');
   env.server.clearAssetRules();await page.evaluate(()=>window.GameSceneBridge.retry());const recovered=await waitForLatestApplied(page,'main');
   assert.deepEqual((await readState(page)).rng,before.rng);return {degraded,recovered};
  })]);
 }
 cases.push(['renderer-creation-failure',()=>withIntegrated(env,build,'p1-renderer-failure',async({page})=>{
  await page.evaluate(()=>{window.__scene3dTest.originalContext=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(type==='webgl'||type==='webgl2')return null;return window.__scene3dTest.originalContext.call(this,type,...args);};});
  await setEnabled(page,true);await page.waitForFunction(()=>window.GameSceneBridge.getDiagnostics().errors.length>0,{timeout:30000});
  const degraded=await readBridgeDiagnostics(page);assert.equal(degraded.readyScene,null);
  await page.evaluate(()=>{HTMLCanvasElement.prototype.getContext=window.__scene3dTest.originalContext;});
  await page.evaluate(()=>window.GameSceneBridge.retry());return {degraded,recovered:await waitForLatestApplied(page,'main')};
 })]);
 cases.push(['real-component-timeout-same-revision-retry',()=>withIntegrated(env,build,'p1-timeout',async({page})=>{
  await componentMount(page,build,{mainTimeoutMs:2000});env.server.setAssetRule(mainPath,{channel:'p1-timeout',waitFor:'release'});
  const failed=await componentApply(page);assert.equal(failed.result.status,'degraded');
  env.server.clearAssetRules();await env.server.release('p1-timeout','release');
  const retried=await page.evaluate(async()=>{const t=window.__scene3dTest;const before=t.componentSnapshot.revision;const result=await t.component.retry();return {before,result,diagnostics:t.component.getDiagnostics()};});
  assert.equal(retried.result.revision,retried.before);assert.equal(retried.result.status,'applied');await componentDestroy(page);return {failed,retried};
 })]);
 cases.push(['webgl-context-loss-recovery',()=>withIntegrated(env,build,'p1-context-loss',async({page})=>{
  await setEnabled(page,true);await waitForLatestApplied(page,'main');
  const supported=await page.evaluate(()=>{const canvas=document.querySelector('#sect-3d-root canvas'),gl=canvas.getContext('webgl2');const ext=gl?.getExtension('WEBGL_lose_context');if(!ext)return false;ext.loseContext();return true;});
  assert.ok(supported,'WEBGL_lose_context unsupported; this subcase needs explicit applicability review');
  await page.waitForFunction(()=>window.GameSceneBridge.getDiagnostics().errors.some(error=>error.code==='CONTEXT_LOST'),{timeout:15000});
  await page.evaluate(()=>window.GameSceneBridge.retry());return waitForLatestApplied(page,'main');
 })]);
 return runBrowserCases(env,cases);
}
async function staticDeployment(env) {
 const build=await requirePublishedBuild(env),server=await startTestServer({gameRoot:env.gameRoot,basePath:'/test-deployment/game/'});
 try {
  return await withIntegrated({...env,server},build,'p1-static-subpath',async({page,network})=>{
   assert.ok(page.url().startsWith(server.baseUrl));await waitForLatestApplied(page,'main');
   await page.evaluate(()=>goToLocation('cangjingge'));await waitForLatestApplied(page,'library');
   await page.click('#cangjingge-scene .back-btn');await waitForLatestApplied(page,'main');
   const assets=network.filter(item=>item.method==='GET'&&item.url.includes('/assets/sect3d/'));
   assert.ok(assets.some(item=>item.url.endsWith('/sect_diorama.glb')));assert.ok(assets.some(item=>item.url.endsWith('/sub_scene/library_interior.glb')));
   assert.ok(assets.every(item=>item.url.startsWith(server.basePath)),JSON.stringify(assets));
   const failed=network.filter(item=>item.event==='response'&&item.url.includes('/assets/sect3d/')&&item.status>=400);assert.deepEqual(failed,[]);
   return {desktopStatic:{status:'PASS',url:page.url(),assetRequests:assets.length,diagnostics:await readBridgeDiagnostics(page)},android:{status:'NOT RUN',reason:'No named physical target/Android package deployment evidence supplied'}};
  },{enabled:true});
 } finally {await artifact(env.directory,'nested-static-transport.json',{origin:server.origin,basePath:server.basePath,events:server.events,requests:server.requests});await server.close();}
}
export const implementations={'P1-T01':coldImports,'P1-T02':resizeContainers,'P1-T03':lifecycles,'P1-T04':failures,'P1-T05':staticDeployment};
