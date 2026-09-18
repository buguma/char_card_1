// Desktop verification of the exact prepared APK Web tree; not Android installation acceptance.
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { launchBrowser, newGameContext, json, workspace, artifact, saveSessionEvidence, assertSessionSafe } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';
import { clickVisible } from './iframe-business.browser.mjs';
const runPath=process.argv[2], directory=process.argv[3];
assert.ok(runPath&&directory&&path.isAbsolute(runPath)&&path.isAbsolute(directory),'Explicit absolute runRecord and NEW report directory required');
const relative=path.relative(path.join(workspace,'.scene3d-work'),directory);
assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Report must be isolated under .scene3d-work');
await mkdir(directory);
const run=await json(runPath),prepared=run.steps?.['prepare:apk']?.result;
assert.equal(run.steps?.['verify:apk']?.status,'succeeded','Use a content-verified APK run');
assert.ok(prepared?.wwwRoot);
const pointer=await json(path.join(prepared.wwwRoot,'assets/sect3d/current.json'));assert.equal(pointer.buildId,run.buildId);
const server=await startTestServer({gameRoot:prepared.wwwRoot,basePath:'/apk-web/'});
let browser,session;const mime=[],routes=[];
try{
 browser=await launchBrowser();
 const payload=await json(path.join(workspace,'tests/scene3d/fixtures/saves/map.json'));
 session=await newGameContext(browser,server,{payload,channel:'apk-web-offline',viewport:{width:1280,height:900,deviceScaleFactor:1}});
 const page=session.page;
 page.on('response',response=>{const u=new URL(response.url());if(u.pathname.includes('/assets/sect3d/'))mime.push({path:u.pathname,status:response.status(),type:response.headers()['content-type']});});
 await page.goto(server.baseUrl+'index.html',{waitUntil:'networkidle0',timeout:45000});
 assert.equal(new URL(page.url()).pathname,'/apk-web/index.html');
 assert.equal(session.network.filter(e=>e.url?.includes('/assets/sect3d/')).length,0,'APK start screen must not prefetch 3D');
 await clickVisible(page,'[data-action="load"]');
 await Promise.all([page.waitForNavigation({waitUntil:'load'}),clickVisible(page,'[data-save-id="scene3d-fixture"]')]);
 assert.equal(new URL(page.url()).pathname,'/apk-web/game.html','Actual packaged start screen must route to game.html');
 await page.waitForFunction(()=>window.__scene3dTest?.initDone||window.__scene3dTest?.initError,{timeout:30000});
 assert.equal(await page.evaluate(()=>window.__scene3dTest.initError),null);
 await page.evaluate(()=>closeModal());
 assert.equal(session.network.filter(e=>e.url?.includes('/assets/sect3d/')).length,0,'Default off game must not load 3D');
 const before=await page.evaluate(()=>({gameData:JSON.parse(JSON.stringify(gameData)),rng:__scene3dTest.rng()}));
 await page.evaluate(()=>GameSceneBridge.setPreference({enabled:true,quality:'low'}));
 async function ready(id){await page.waitForFunction(id=>{const d=GameSceneBridge.getDiagnostics();return d.readyScene===id&&d.renderer?.ready&&d.renderer.interactionEnabled;},{timeout:60000},id);const d=await page.evaluate(()=>GameSceneBridge.getDiagnostics());assert.equal(d.buildId,run.buildId);assert.deepEqual(d.errors,[]);return d;}
 const main=await ready('main');
 const after=await page.evaluate(()=>({gameData:JSON.parse(JSON.stringify(gameData)),rng:__scene3dTest.rng()}));assert.deepEqual(after,before,'Initial rendering must preserve all business and RNG state');
 await artifact(directory,'main.json',main);await page.screenshot({path:path.join(directory,'main.png')});
 for(const [location,scene]of [['yanwuchang','training'],['cangjingge','library'],['huofang','kitchen'],['houshan','back_mountain'],['yishiting','council'],['tiejiangpu','forge'],['nandizi','male_quarters'],['nvdizi','female_quarters'],['shanmen','gate'],['gongtian','fields'],['danfang','alchemy']]){
  await page.evaluate(location=>goToLocation(location),location);const d=await ready(scene);routes.push({location,scene,epoch:d.epoch,revision:d.revision,appliedVersion:d.renderer.appliedVersion});
  await clickVisible(page,'.scene.active .back-btn');await ready('main');
 }
 await page.evaluate(()=>GameSceneBridge.setPreference({enabled:false}));
 await page.waitForFunction(()=>!document.querySelector('#main-viewport').hasAttribute('data-scene3d-ready'));
 assert.equal(await page.evaluate(()=>document.querySelector('.scene.active').id),'map-scene');
 assertSessionSafe(session,server,'apk-web-offline');
 assert.equal(server.requests.length,0,'Scene traversal must not call any API');
 assert.ok(mime.length>0);for(const item of mime){assert.equal(item.status,200);assert.ok(item.path.startsWith('/apk-web/assets/sect3d/'));if(item.path.endsWith('.mjs'))assert.match(item.type,/javascript/);if(item.path.endsWith('.wasm'))assert.match(item.type,/application\/wasm/);if(item.path.endsWith('.glb'))assert.match(item.type,/model\/gltf-binary/);}
 assert.equal(session.network.filter(e=>e.action==='substitute').length,0,'Cultivation lane must not need synthetic external artwork');
 await artifact(directory,'result.json',{status:'PASS',buildId:run.buildId,manifestSha256:pointer.manifestSha256,browser:await browser.version(),routes,apiRequests:0,externalSubstitutions:0,scope:'Exact APK www served under nested loopback path; all external traffic blocked; desktop Chrome real GLB/Draco/WebGL, not Android/WebView first-install offline acceptance. Start-screen original load button -> game.html, 11 locations and original returns.'});
}catch(error){process.exitCode=1;await artifact(directory,'result.json',{status:'FAIL',error:error.stack,routes});}
finally{await artifact(directory,'resource-mime.json',mime);if(session){await saveSessionEvidence(session,directory,'final');await session.close();}if(browser)await browser.close();await server.close();}
