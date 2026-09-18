import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, access, readdir, realpath, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
export const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const fixturesRoot = path.join(workspace,'tests/scene3d/fixtures');
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const json = async filename => JSON.parse(await readFile(filename,'utf8'));
export async function artifact(directory,name,value) { await mkdir(directory,{recursive:true}); const filename=path.join(directory,name); await writeFile(filename,typeof value === 'string' ? value : JSON.stringify(value,null,2)+'\n','utf8'); return filename; }
export async function exists(filename) { try { await access(filename); return true; } catch { return false; } }
export async function hashFile(filename) {
  const hash=createHash('sha256');let bytes=0;
  for await(const chunk of createReadStream(filename)) {hash.update(chunk);bytes+=chunk.length;}
  return {bytes,sha256:hash.digest('hex')};
}
export async function verifySnapshotTree(root,expectedFiles) {
  assert.ok(expectedFiles && Object.keys(expectedFiles).length,'Empty baseline inventory');
  const resolvedRoot=await realpath(root),actualPaths=[];
  const inside=target=>{const relative=path.relative(resolvedRoot,target);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
  async function walk(relative='') {
    for(const entry of await readdir(path.join(resolvedRoot,relative),{withFileTypes:true})) {
      const name=relative?`${relative}/${entry.name}`:entry.name;
      assert.ok(!entry.isSymbolicLink(),`Unexpected baseline symlink: ${name}`);
      if(entry.isDirectory())await walk(name);else if(entry.isFile())actualPaths.push(name);else throw Error(`Unsupported baseline entry: ${name}`);
    }
  }
  await walk();
  const expectedPaths=Object.keys(expectedFiles).sort();
  const differences=[],records=[];
  for(const name of expectedPaths) {
    assert.ok(!path.isAbsolute(name)&&!name.includes('\\')&&!name.split('/').some(p=>p==='..'||p==='.'||!p),`Unsafe baseline name: ${name}`);
    const expected=expectedFiles[name];assert.match(expected.sha256,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(expected.bytes));
    if(!actualPaths.includes(name)){differences.push({file:name,error:'missing'});continue;}
    const filename=await realpath(path.join(resolvedRoot,name));assert.ok(inside(filename),`Baseline path escaped: ${name}`);
    const actual=await hashFile(filename);records.push({file:name,...actual});
    if(actual.bytes!==expected.bytes||actual.sha256!==expected.sha256)differences.push({file:name,expected,actual});
  }
  for(const name of actualPaths)if(!Object.hasOwn(expectedFiles,name))differences.push({file:name,error:'unexpected file'});
  return {root:resolvedRoot,fileCount:records.length,expectedCount:expectedPaths.length,bytes:records.reduce((sum,r)=>sum+r.bytes,0),inventorySha256:sha256(JSON.stringify(records)),differences,records};
}
export async function runReadOnlyValidator(script,args,{cwd,directory,timeoutMs=120000}) {
  // File descriptors preserve verbatim output without shell interpolation or piped child stdio.
  const stdoutPath=path.join(directory,'validator-stdout.txt'),stderrPath=path.join(directory,'validator-stderr.txt');
  const stdout=await open(stdoutPath,'wx'),stderr=await open(stderrPath,'wx');
  let child,timer,timedOut=false;
  const startedAt=new Date().toISOString();
  try {
    const exit=await new Promise((resolve,reject)=>{
      child=spawn(process.execPath,[script,...args],{cwd,stdio:['ignore',stdout.fd,stderr.fd],windowsHide:true});
      timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
      child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));
    });
    return {executable:process.execPath,node:process.version,args:[script,...args],cwd,pid:child.pid,startedAt,endedAt:new Date().toISOString(),...exit,timedOut,stdout:stdoutPath,stderr:stderrPath};
  } finally {clearTimeout(timer);await stdout.close();await stderr.close();}
}
export function diff(actual,expected,ignore = [], prefix='') {
  if (ignore.includes(prefix)) return [];
  if (Object.is(actual,expected)) return [];
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object' && Array.isArray(actual) === Array.isArray(expected)) {
    return [...new Set([...Object.keys(actual),...Object.keys(expected)])].sort().flatMap(key => diff(actual[key],expected[key],ignore,prefix ? `${prefix}.${key}` : key));
  }
  return [{path:prefix,actual:actual === undefined ? '<missing>' : actual,expected:expected === undefined ? '<missing>' : expected}];
}
export function createRng(seed) { let state=seed>>>0, count=0; return { next() { count++; state=(Math.imul(1664525,state)+1013904223)>>>0; return state/4294967296; }, snapshot() { return {state,count}; }, peek() { return ((Math.imul(1664525,state)+1013904223)>>>0)/4294967296; } }; }
export async function findBrowser() {
  const candidates=[process.env.BROWSER_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/google-chrome'];
  for (const filename of candidates.filter(Boolean)) if (await exists(filename)) return filename;
  throw Error('No browser found: set BROWSER_PATH to a dedicated installed Chromium executable (never a profile).');
}
export async function launchBrowser() {
  const { default:puppeteer }=await import('puppeteer-core'); // resolves ONLY through scene3d/node_modules
  return puppeteer.launch({executablePath:await findBrowser(),headless:true,args:['--disable-background-networking','--disable-component-update','--no-first-run','--disable-sync','--disable-extensions','--disable-features=MediaRouter','--mute-audio'],defaultViewport:{width:390,height:844,deviceScaleFactor:1}});
}
export function requestPolicy({url,method,resourceType},origin,substitutions=[]) {
  const parsed=new URL(url);
  if(parsed.origin===origin || ['data:','blob:'].includes(parsed.protocol)) return {action:'allow'};
  const fixture=substitutions.find(item=>item.url===url && item.method===method && item.resourceType===resourceType);
  return fixture ? {action:'substitute',fixture} : {action:'deny'};
}
export async function loadKnownAssets() {
  const manifest=await json(path.join(fixturesRoot,'network/known-assets.json'));
  const substitutions=[];
  for(const fixture of manifest.substitutions) {
    if(path.isAbsolute(fixture.payloadFile)||fixture.payloadFile.split(/[\\/]/).includes('..'))throw Error('Unsafe network fixture path');
    const body=await readFile(path.join(fixturesRoot,fixture.payloadFile));
    assert.equal(sha256(body),fixture.payloadSha256,'Known synthetic asset hash mismatch');
    substitutions.push({...fixture,body});
  }
  return {...manifest,substitutions};
}
export async function newGameContext(browser,server,{payload,channel,seed=12345,businessTime='2026-01-01T00:00:00Z',style,scene3dPreferences,viewport}={}) {
  const knownAssets=await loadKnownAssets();
  const context=await browser.createBrowserContext();
  const page=await context.newPage();
  if(viewport)await page.setViewport(viewport);
  const logs=[], network=[], violations=[];
  await page.setBypassServiceWorker(true);
  await page.setRequestInterception(true);
  page.on('request',request => {
    const url=new URL(request.url());
    const decision=requestPolicy({url:request.url(),method:request.method(),resourceType:request.resourceType()},server.origin,knownAssets.substitutions);
    network.push({method:request.method(),url:url.origin===server.origin ? url.pathname : `${url.protocol}//${url.host}${url.pathname}`,allowed:decision.action!=='deny',action:decision.action,
      ...(decision.fixture?{fixture:decision.fixture.payloadFile,fixtureSha256:decision.fixture.payloadSha256,originalNetworkAccess:false,visualResourceScope:knownAssets.scope}:{})});
    if(decision.action==='substitute') {
      const {fixture}=decision;
      request.respond({status:200,contentType:fixture.contentType,headers:{'Cache-Control':'no-store','X-Scene3d-Synthetic-Asset':fixture.payloadSha256},body:fixture.body}).catch(error=>{violations.push(`Fixture response failed: ${error.message}`);});
    } else if(decision.action==='deny') { violations.push(request.url().split('?')[0]); request.abort('blockedbyclient').catch(()=>{}); }
    else request.continue().catch(()=>{});
  });
  page.on('response',response=>{const url=new URL(response.url());network.push({event:'response',url:url.origin===server.origin?url.pathname:`${url.protocol}//${url.host}${url.pathname}`,status:response.status()});});
  page.on('requestfailed',request=>{const url=new URL(request.url());network.push({event:'requestfailed',url:url.origin===server.origin?url.pathname:`${url.protocol}//${url.host}${url.pathname}`,error:request.failure()?.errorText});});
  page.on('console',msg=>logs.push({type:msg.type(),text:msg.text().replace(/Bearer\s+\S+/g,'Bearer [redacted]')}));
  page.on('pageerror',error=>logs.push({type:'pageerror',text:error.message}));
  page.on('dialog',dialog=>dialog.dismiss());
  const config=await json(path.join(fixturesRoot,'config/fake-api.json'));
  await page.evaluateOnNewDocument(({payload,origin,channel,seed,businessTime,config,style,scene3dPreferences})=>{
    if (location.origin !== origin) return;
    // Test-only bootstrap is injected before host scripts. rAF/performance remain untouched.
    let state=seed>>>0,count=0;
    const next=()=>{count++; state=(Math.imul(1664525,state)+1013904223)>>>0; return state/4294967296;};
    Math.random=next;
    const RealDate=Date, fixed=RealDate.parse(businessTime);
    function BusinessDate(...args) { if (!new.target) return new RealDate(fixed).toString(); return new RealDate(...(args.length ? args : [fixed])); }
    BusinessDate.prototype=RealDate.prototype; Object.setPrototypeOf(BusinessDate,RealDate); BusinessDate.now=()=>fixed; window.Date=BusinessDate;
    window.__scene3dTest={initDone:false,initError:null,rng:()=>({state,count,next:((Math.imul(1664525,state)+1013904223)>>>0)/4294967296})};
    if (window.top===window && !sessionStorage.getItem('scene3d-fixture-initialized')) {
      localStorage.clear();
      const save=structuredClone(payload); save.id='scene3d-fixture'; if(style!==undefined) save.gameData.uiStyle=style;
      localStorage.setItem('jxz_saves',JSON.stringify([save]));
      localStorage.setItem('jxz_apiConfig',JSON.stringify({...config,endpoint:`${origin}/__mock/${channel}`}));
      // schema:2 marks this as a current-schema preference, which is the only case the
      // bridge still honours a stored quality in (v1 legacy values are treated as the
      // old device auto-detection and ignored in favour of the 均衡 default).
      if(scene3dPreferences)localStorage.setItem('jxz_scene3d_preferences_v1',JSON.stringify({schema:2,...scene3dPreferences}));
      sessionStorage.setItem('scene3d-fixture-initialized','1');
    }
    document.addEventListener('DOMContentLoaded',()=>{
      const original=window.onload;
      if (typeof original !== 'function') return;
      window.onload=async function(...args) { try { const result=await original.apply(this,args); window.__scene3dTest.initDone=true; return result; } catch(error) { window.__scene3dTest.initError=error.message; throw error; } };
    },{once:true});
  },{payload,origin:server.origin,channel,seed,businessTime,config,style,scene3dPreferences});
  return {context,page,logs,network,violations,async close(){await context.close();}};
}
export async function startGame(session,server) {
  await session.page.goto(`${server.baseUrl||server.origin+'/'}index.html?intent=loadSave&saveId=scene3d-fixture`,{waitUntil:'load',timeout:45000});
  await session.page.waitForFunction(()=>window.__scene3dTest?.initDone || window.__scene3dTest?.initError,{timeout:30000});
  const error=await session.page.evaluate(()=>window.__scene3dTest.initError); if(error) throw Error(error);
  await session.page.addScriptTag({content:`
    Object.defineProperty(window, '__scene3dRead', { configurable: false, value: function() {
      return JSON.parse(JSON.stringify({GameMode,userLocation,userLocation_old,logicalPage:document.querySelector('.scene.active')?.id.replace(/-scene$/,''),
        gameData,actionPoints,currentWeek,playerStats,npcFavorability,npcVisibility,currentNpcLocations,currentSpecialEvent,inputEnable,uiStyle,
        currentRandomEvent,currentBattleEvent,currentStoryText,previousScene,wasInSLGMode,
        uiConversation:storageService.loadUIConversation(),summaryHistory:summaryHistoryService.getAll(),weekHistory:weekHistoryService.getAll(),
        rng:window.__scene3dTest.rng(),streaming:pipeline.isStreaming(),
        visibleNpcIds:Array.from(document.querySelectorAll('.scene.active .npc-container [data-npc-id]')).map(e=>e.dataset.npcId)
      }));
    }});
  `});
}
export const readState=page=>page.evaluate(()=>window.__scene3dRead());
export async function importJsonFile(page,filename) {
  const chooser=page.waitForFileChooser();
  await page.evaluate(()=>{
    closeModal();
    // Host importSave creates a detached input; keep that exact original input alive/attached
    // until Puppeteer resolves the chooser backend node. Never replace onchange/FileReader.
    const original=HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click=function(...args) {
      if(this.type==='file'&&!this.isConnected) {
        this.hidden=true;this.dataset.scene3dTestUpload='true';document.body.appendChild(this);
        window.__scene3dTest.uploadInput=this;
      }
      return original.apply(this,args);
    };
    try {importSave();} finally {HTMLInputElement.prototype.click=original;}
  });
  await (await chooser).accept([filename]);
  await page.waitForFunction(()=>document.querySelector('#modal-text')?.textContent.includes('存档导入'),{timeout:20000});
  const text=await page.$eval('#modal-text',element=>element.textContent);
  assert.match(text,/存档导入成功/);
  await page.evaluate(()=>{closeModal();window.__scene3dTest.uploadInput?.remove();delete window.__scene3dTest.uploadInput;});
  // importSave ends by toggling the history menu. This transport invokes it
  // directly rather than through that already-open menu, so close its resulting
  // UI with the real toggle before the next action; never hide it with test CSS.
  if(await page.$('#history-dropdown.show')) {
    const toggle=await page.$('.dropdown-toggle[onclick*="history-dropdown"]');
    assert.ok(toggle,'Original history menu toggle must exist');
    await toggle.scrollIntoView(); await toggle.click();
    await page.waitForFunction(()=>!document.querySelector('#history-dropdown.show'));
  }
}
export async function exportJson(page) {
  // Exercise actual exportSave/_doExportSave; substitute only the final OS download transport.
  await page.evaluate(()=>{
    window.__scene3dTest.exported=null;
    const original=storageService.downloadJson;
    storageService.downloadJson=function(filename,text) { window.__scene3dTest.exported={filename,text}; storageService.downloadJson=original; return Promise.resolve('modal'); };
    exportSave(); _skipExportName();
  });
  await page.waitForFunction(()=>window.__scene3dTest.exported!==null);
  return JSON.parse(await page.evaluate(()=>window.__scene3dTest.exported.text));
}
export async function saveSessionEvidence(session,directory,label) {
  await artifact(directory,`${label}-console.json`,session.logs);
  await artifact(directory,`${label}-network.json`,session.network);
  if (!session.page.isClosed()) {
    try { await artifact(directory,`${label}-state.json`,await readState(session.page)); } catch(error) { await artifact(directory,`${label}-state-error.txt`,error.message); }
    try { await session.page.screenshot({path:path.join(directory,`${label}.png`)}); } catch { /* context may be gone; logs remain */ }
  }
}
export function assertSessionSafe(session,server,channel) {
  assert.deepEqual(session.violations,[],'Unexpected external request (blocked; never sent)');
  assert.deepEqual(session.logs.filter(x=>x.type==='pageerror'),[],'Uncaught host error');
  assert.deepEqual(server.events.filter(x=>x.channel===channel && x.type==='unmatched-api'),[],'Unexpected mock API request');
}
