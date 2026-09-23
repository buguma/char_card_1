// Import-safe P4-T05 desktop host controls. CLI: node tests/scene3d/host-ui.browser.mjs <new absolute report dir> [width height [expected build ID]]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { artifact, assertSessionSafe, diff, fixturesRoot, json, hashFile, findBrowser, newGameContext, readState, saveSessionEvidence, startGame, workspace } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';
import { safeRelative, verifyRelease } from '../../scene3d/scripts/artifact-utils.mjs';
import { clickVisible } from './iframe-business.browser.mjs';
const button = fn => `[onclick="${fn}"]`;
const frames = (page,n=18) => page.evaluate(n=>new Promise(resolve=>{let i=0;const tick=()=>++i>=n?resolve():requestAnimationFrame(tick);requestAnimationFrame(tick);}),n);
const diagnostic = page => page.evaluate(()=>window.GameSceneBridge?.getDiagnostics());
async function state(page) { return { ...await readState(page), live:await page.evaluate(()=>JSON.parse(JSON.stringify({inventory,equipment,learnedSkills,equippedSkills}))), prompt:await page.evaluate(()=>({messages:window._lastPipelineMessages??null,reply:window._lastPipelineLLMReply??null})) }; }
async function fixture() {
  const p=await json(path.join(fixturesRoot,'saves/library.json'));
  Object.assign(p.gameData,{userLocation:'huofang',inputEnable:1,currentSpecialEvent:'',inventory:{'胡饼':2,'制式铁剑':1},learnedSkills:Object.fromEntries(['beng_ji_xiao_dian_le','bin_xin_jue','rou_zhan_gu_duan','tie_bu_shan','xiao_li_fei_dao','kai_shan_jiu_shi','bing_chuan_dian_xue_shou','yuan_bi_quan','gui_yi_jian_jue','wu_jian_zhen_yi','ling_hu_lian_zhan','wan_juan_gui_zong','lian_yu_chan_si','tian_xiang_shi_jing','zao_hua_du_e_zhen','bai_cao_xin_jing'].map(id=>[id,1])),equippedSkills:{},bgmEnabled:false,bgmName:'bgm/主界面.mp3',summary_Backup:Array.from({length:100},(_,i)=>`合成历史第${i+1}段：弟子在伙房阅读旧日记录，今日尚未行动。`).join('\n'),compressSummary:false});
  p.gameData.playerStats.金钱=5000;
  p.saveName='合成P4-T05桌面UI';return p;
}
async function sourceIdentity(root) {
  const files=['index.html','start-screen-noST.html','assets/sect3d/current.json',...(await readdir(path.join(root,'module'))).filter(n=>/\.(js|css)$/.test(n)).map(n=>`module/${n}`)];
  return Object.fromEntries(await Promise.all(files.sort().map(async file=>[file,await hashFile(path.join(root,file))])));
}
/** ctx: {browser,server,directory,gameRoot?,buildId?,runId?,viewport?}; owns only its fresh contexts. Returns explicit FAIL records without suppressing other lanes. */
export async function hostUi(ctx) {
  const sourceRoot=ctx.gameRoot||ctx.server.root||workspace;
  const release=await json(path.join(sourceRoot,'assets/sect3d/current.json'));
  assert.equal(release.schemaVersion,1,'Unsupported current pointer schema');
  safeRelative(release.buildId);assert.ok(!release.buildId.includes('/'),'Invalid current build ID');
  assert.deepEqual(release.bridgeProtocol,{min:1,max:1},'Unsupported current bridge protocol');
  assert.equal(release.manifest,`${release.buildId}/manifest.json`,'Current manifest must belong to selected build');
  assert.match(release.manifestSha256,/^[a-f0-9]{64}$/,'Current manifest hash required');
  if(ctx.buildId!==undefined)assert.equal(release.buildId,ctx.buildId,'Expected build must match current pointer');
  await verifyRelease(path.join(sourceRoot,'assets/sect3d',release.buildId),release.buildId,release.manifestSha256);
  const sourceBefore=await sourceIdentity(sourceRoot);await artifact(ctx.directory,'host-source-before.json',sourceBefore);
  const results=[],lanes=[],comparisons=[];
  for(const style of [0,1]) for(const enabled of [false,true]) {
    const label=`host-ui-${style}-${enabled?'3d':'2d'}`,channel=`${ctx.runId||'p4t05'}-${label}`;
    const payload=await fixture();await artifact(ctx.directory,`${label}-fixture.json`,payload);
    const session=await newGameContext(ctx.browser,ctx.server,{payload,channel,style,viewport:{width:1280,height:900,deviceScaleFactor:1,...ctx.viewport},scene3dPreferences:{enabled,quality:'low'}});
    const page=session.page,trace=[],snapshots=[];
    const check=(name,actual,expected)=>{const differences=diff(actual,expected);results.push({label,name,status:differences.length?'FAIL':'PASS',differences});};
    const click=async selector=>{trace.push({action:'click',selector});await clickVisible(page,selector);};
    const openDock=async()=>{if(!(await page.$eval('#viewport-dock',n=>n.classList.contains('open')))){await click('#viewport-dock-gear');await page.waitForFunction(()=>document.getElementById('viewport-dock').classList.contains('open'));}};
    const menu=async (id,fn)=>{await openDock();await click(`.dropdown-toggle[onclick*="${id}-dropdown"]`);await click(button(fn));};
    const capture=async name=>{const s=await state(page);snapshots.push({name,state:s});await artifact(ctx.directory,`${label}-${name}.json`,{state:s,diagnostics:await diagnostic(page)});await page.screenshot({path:path.join(ctx.directory,`${label}-${name}.png`)});return s;};
    const paused=async selector=>{
      await page.waitForSelector(selector,{visible:true});await frames(page);
      const before=await diagnostic(page);await frames(page);const after=await diagnostic(page);
      const dom=await page.$eval(selector,n=>{const r=n.getBoundingClientRect();return {id:n.id,display:getComputedStyle(n).display,rect:{x:r.x,y:r.y,width:r.width,height:r.height},activeElement:document.activeElement?.id};});
      trace.push({action:'overlay-probe',selector,dom,before,after});
      if(enabled)check(`pause ${selector}`,{raf:after.renderer?.raf,input:after.renderer?.interactionEnabled,frames:after.renderer?.frames},{raf:0,input:false,frames:before.renderer?.frames});
    };
    const resumed=async()=>{if(enabled){await page.waitForFunction(()=>{const r=GameSceneBridge.getDiagnostics().renderer;return r?.raf>0&&r.interactionEnabled;},{timeout:10000});const a=await diagnostic(page);await frames(page);const b=await diagnostic(page);check('resume rendering',b.renderer.frames>a.renderer.frames,true);}};
    try {
      await startGame(session,ctx.server);
      if(await page.$eval('#modal',n=>getComputedStyle(n).display!=='none'))await click('#modal-buttons '+button('closeModal()'));
      if(enabled)await page.waitForFunction(()=>GameSceneBridge.getDiagnostics().readyScene==='kitchen'&&GameSceneBridge.getDiagnostics().renderer?.frames>0,{timeout:120000});
      const initial=await capture('initial');
      for(const [fn,selector,closeSel] of [['showInventory()','#inventory-modal','[data-inventory-close]'],['showEquipment()','#equipment-modal','[data-equipment-close]']]) {
        await menu('attribute',fn);await paused(selector);
        if(fn==='showInventory()')check('nonzero real inventory',await page.$eval('#inventory-grid',n=>n.textContent.includes('制式铁剑')&&n.textContent.includes('×1')),true);
        if(fn==='showSkillEquipment()')check('learned skill visible',await page.$eval('#learned-skill-list',n=>n.textContent.includes('绷急孝典乐')),true);
        await capture(fn.slice(4,-2));await click(`${selector} ${closeSel}`);await resumed();check(`${fn} no mutation`,await state(page),initial);
      }
      await menu('history','showHistorySummary()');await paused('#history-summary-modal');
      const scroller='#history-summary-content';await page.hover(scroller);const scrollBefore=await page.$eval(scroller,n=>({top:n.scrollTop,height:n.clientHeight,total:n.scrollHeight}));await page.mouse.wheel({deltaY:650});await frames(page,30);const scrollAfter=await page.$eval(scroller,n=>n.scrollTop);check('history real wheel scroll',scrollAfter>scrollBefore.top&&scrollBefore.total>scrollBefore.height,true);trace.push({action:'wheel',scrollBefore,scrollAfter});await capture('history-scrolled');await click(button('closeHistorySummaryModal()'));await resumed();check('history no mutation',await state(page),initial);
      // 3D intentionally has one action set: exercise its real floating control,
      // not the hidden legacy button (the 2D lane still exercises that original).
      if(enabled)check('no duplicate fixed 3D action buttons',await page.$eval('.scene.active .scene-actions',node=>getComputedStyle(node).display),'none');
      await click(enabled ? '.scene3d-hotspot[data-mesh="Kitchen_counter"]' : '.scene.active '+button("showTrading('food')"));await paused('#trading-modal');await capture('trading');
      await click('#trading-modal [data-trade-item="胡饼"]');await page.waitForFunction(()=>document.querySelector('#trading-actions [data-trade-action="buy"]'));await capture('shop-detail');await click('#trading-actions [data-trade-action="buy"]');
      const bought=await capture('bought');const expectedBuy=structuredClone(initial);expectedBuy.playerStats.金钱-=500;expectedBuy.gameData.playerStats.金钱-=500;expectedBuy.live.inventory['胡饼']++;expectedBuy.gameData.inventory['胡饼']++;check('purchase full business/prompt/RNG mutation',bought,expectedBuy);await artifact(ctx.directory,`${label}-purchase-full-diff.json`,diff(bought,initial));check('purchase money delta',bought.playerStats.金钱-initial.playerStats.金钱,-500);check('purchase quantity delta',bought.live.inventory['胡饼']-initial.live.inventory['胡饼'],1);
      await click('#trading-modal [data-dialog-tab="sell"]');await page.waitForFunction(()=>document.querySelector('#trading-modal [data-trade-item="胡饼"]'));await click('#trading-modal [data-trade-item="胡饼"]');await page.waitForFunction(()=>document.querySelector('#trading-actions [data-trade-action="sell"]'));await click('#trading-actions [data-trade-action="sell"]');const sold=await capture('sold');const expectedSale=structuredClone(bought);expectedSale.playerStats.金钱+=250;expectedSale.gameData.playerStats.金钱+=250;expectedSale.live.inventory['胡饼']--;expectedSale.gameData.inventory['胡饼']--;check('sale full business/prompt/RNG mutation',sold,expectedSale);await artifact(ctx.directory,`${label}-sale-full-diff.json`,diff(sold,bought));check('sale money delta',sold.playerStats.金钱-bought.playerStats.金钱,250);check('sale quantity delta',sold.live.inventory['胡饼']-bought.live.inventory['胡饼'],-1);await click('#trading-modal [data-dialog-close]');await resumed();
      await click('#free-action-input');await page.keyboard.type('desktop keyboard check');check('textarea focused and typed',await page.$eval('#free-action-input',n=>({focus:document.activeElement===n,value:n.value})),{focus:true,value:'desktop keyboard check'});await capture('focused');await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.press('Backspace');await page.keyboard.press('Tab');check('draft input no business mutation',await state(page),sold);await resumed();
      await click('#huofang-scene '+button('backToMap()'));await page.waitForFunction(()=>document.querySelector('#map-scene.active'));if(enabled)await page.waitForFunction(()=>GameSceneBridge.getDiagnostics().readyScene==='main',{timeout:60000});await capture('original-return');check('original kitchen return path',(await state(page)).userLocation,'tianshanpai');
      lanes.push({style,enabled,label,snapshots,api:ctx.server.requests.filter(r=>r.channel===channel).map(r=>r.body)});
      await menu('attribute','showSkillEquipment()');await paused('#skill-equipment-modal');await click('#skill-equipment-modal [data-dialog-tab="learned"]');check('learned skill visible',await page.$eval('#skill-equipment-list',n=>n.textContent.includes('绷急孝典乐')),true);await capture('skill-view');const skillScrollBefore=await page.$eval('#skill-equipment-list',n=>({top:n.scrollTop,height:n.clientHeight,total:n.scrollHeight}));await page.hover('#skill-equipment-list');await page.mouse.wheel({deltaY:650});await frames(page,30);const skillScrollAfter=await page.$eval('#skill-equipment-list',n=>n.scrollTop);check('skill real internal wheel scroll',skillScrollAfter>skillScrollBefore.top&&skillScrollBefore.total>skillScrollBefore.height,true);trace.push({action:'skill-wheel',skillScrollBefore,skillScrollAfter});await capture('skill-scrolled');await click('#skill-equipment-modal [data-dialog-close]');await resumed();check('skill view no mutation',await state(page),snapshots.find(s=>s.name==='original-return').state);
      assertSessionSafe(session,ctx.server,channel);
    } catch(error) {results.push({label,name:'execution',status:'FAIL',error:error.stack});}
    finally {try {try {assertSessionSafe(session,ctx.server,channel);} catch(error){results.push({label,name:'network/host safety',status:'FAIL',error:error.stack});}await artifact(ctx.directory,`${label}-dom.json`,await page.evaluate(()=>Array.from(document.querySelectorAll('.modal')).filter(n=>getComputedStyle(n).display!=='none').map(n=>({id:n.id,html:n.outerHTML,controls:Array.from(n.querySelectorAll('button')).map(b=>{const r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {text:b.textContent,rect:{x:r.x,y:r.y,width:r.width,height:r.height},hit:hit?.outerHTML,scrollHeight:b.parentElement.scrollHeight};})}))));await artifact(ctx.directory,`${label}-trace.json`,trace);await saveSessionEvidence(session,ctx.directory,label);}finally{await session.close();}}
  }
  for(const style of [0,1]) {const pair=lanes.filter(l=>l.style===style);const differences=pair.length===2?diff({snapshots:pair[0].snapshots,api:pair[0].api},{snapshots:pair[1].snapshots,api:pair[1].api}):[{error:'Both lanes did not finish'}];comparisons.push({style,status:differences.length?'FAIL':'PASS',differences});}
  const audio=await hostAudio(ctx);results.push(...audio.results);
  const sourceAfter=await sourceIdentity(sourceRoot),sourceChanges=diff(sourceAfter,sourceBefore);await artifact(ctx.directory,'host-source-after.json',sourceAfter);await artifact(ctx.directory,'host-source-diff.json',sourceChanges);results.push({name:'host source unchanged throughout run',status:sourceChanges.length?'FAIL':'PASS',differences:sourceChanges});
  const summary={release,viewport:{width:1280,height:900,...ctx.viewport},sourceStable:sourceChanges.length===0,certification:sourceChanges.length?'DIAGNOSTIC ONLY: source changed':'STABLE SOURCE',results,comparisons,audio,limitations:['Physical Android soft keyboard: NOT RUN','Android system Back: NOT RUN','Draft typing is not submission; prompt/API trace expected empty for these local-only operations.']};
  await artifact(ctx.directory,'host-ui-results.json',summary);return summary;
}
async function hostAudio(ctx) {
  const results=[],events=[],states=[];
  const payload=await fixture(),channel=`${ctx.runId||'p4t05'}-host-audio`;
  const session=await newGameContext(ctx.browser,ctx.server,{payload,channel,viewport:{width:1280,height:900,...ctx.viewport},scene3dPreferences:{enabled:false,quality:'low'}}),page=session.page;
  await page.exposeFunction('__hostAudioObserved',event=>events.push(event));
  await page.evaluateOnNewDocument(()=>{for(const type of ['play','playing','pause','loadeddata','error','emptied'])document.addEventListener(type,event=>{const a=event.target;if(a instanceof HTMLMediaElement)window.__hostAudioObserved({type,id:a.id,src:a.currentSrc||a.src,paused:a.paused,time:a.currentTime,readyState:a.readyState,error:a.error?.code,url:location.pathname});},true);});
  const snap=async name=>{const s=await page.evaluate(()=>({url:location.pathname,enabled:window.bgmManager?.getEnabled(),path:window.bgmManager?.getPlayingPath(),audio:Array.from(document.querySelectorAll('audio')).map(a=>({id:a.id,paused:a.paused,time:a.currentTime,src:a.currentSrc||a.src,readyState:a.readyState,error:a.error?.code}))}));states.push({name,...s});await page.screenshot({path:path.join(ctx.directory,`host-audio-${name}.png`)});return s;};
  try {
    await startGame(session,ctx.server);
    if(await page.$eval('#modal',n=>getComputedStyle(n).display!=='none'))await clickVisible(page,'#modal-buttons '+button('closeModal()'));
    await clickVisible(page,'#viewport-dock-gear');
    await page.waitForFunction(()=>document.getElementById('viewport-dock').classList.contains('open'));
    await clickVisible(page,'.dropdown-toggle[onclick*="system-dropdown"]');await clickVisible(page,button('showGameSettings()'));await clickVisible(page,'.gs-tab[data-tab="switches"]');
    await snap('disabled');await clickVisible(page,'label:has(#gs-bgm-toggle)');
    await page.waitForFunction(()=>{const a=document.querySelector('#bgm-player');return bgmManager.getEnabled()&&!a.paused&&a.readyState>=2&&a.currentTime>0;},{timeout:15000});await snap('playing');
    assert.ok(events.some(e=>e.id==='bgm-player'&&e.type==='playing'),'Real media playing event required');
    await clickVisible(page,'label:has(#gs-bgm-toggle)');await page.waitForFunction(()=>!bgmManager.getEnabled()&&bgmManager.getPlayingPath()===''&&document.querySelector('#bgm-player').paused);await snap('stopped');assert.ok(events.some(e=>e.id==='bgm-player'&&['pause','emptied'].includes(e.type)),'Stop must emit pause or emptied (src reset cancels pending pause event)');
    await clickVisible(page,button('closeGameSettings()'));await clickVisible(page,'#viewport-dock-gear');await page.waitForFunction(()=>document.getElementById('viewport-dock').classList.contains('open'));await clickVisible(page,'.dropdown-toggle[onclick*="history-dropdown"]');
    page.removeAllListeners('dialog');page.on('dialog',d=>d.accept());await Promise.all([page.waitForNavigation({waitUntil:'load'}),clickVisible(page,'#btn-return-menu')]);
    await clickVisible(page,'[data-action="load"]');await page.waitForFunction(()=>{const a=document.querySelector('#bgm');return !a.paused&&a.currentTime>0;},{timeout:15000});await snap('start-menu-playing');
    await Promise.all([page.waitForNavigation({waitUntil:'load'}),clickVisible(page,'[data-save-id="scene3d-fixture"]')]);await page.waitForFunction(()=>window.__scene3dTest?.initDone);await snap('reentered-save');
    assert.ok(events.some(e=>e.id==='bgm'&&e.type==='playing'));assert.ok(events.some(e=>e.id==='bgm'&&e.type==='pause'),'Actual start-menu exit pause event required');
    assertSessionSafe(session,ctx.server,channel);results.push({name:'local BGM real toggle/start-menu exit/reentry',status:'PASS'});
  }catch(error){results.push({name:'local BGM real toggle/start-menu exit/reentry',status:'FAIL',error:error.stack});}
  finally{try{await artifact(ctx.directory,'host-audio-evidence.json',{events,states,results,scope:'Fresh BrowserContext; original local MP3 decoded by real audio elements; trusted Puppeteer clicks; no autoplay-policy bypass or media source changes; speaker audibility not certified.'});await saveSessionEvidence(session,ctx.directory,'host-audio');}finally{await session.close();}}
  return {results,events,states};
}
async function main() {
  const directory=process.argv[2];assert.ok(directory&&path.isAbsolute(directory),'New absolute .scene3d-work directory required');const rel=path.relative(path.join(workspace,'.scene3d-work'),directory);assert.ok(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel));await mkdir(directory);
  const viewport=process.argv[3]?{width:Number(process.argv[3]),height:Number(process.argv[4])}:{width:1280,height:900};assert.ok(viewport.width>0&&viewport.height>0,'Valid CLI width/height required');
  const server=await startTestServer({gameRoot:workspace});let browser;
  try {const puppeteer=createRequire(new URL('../../scene3d/package.json',import.meta.url))('puppeteer-core');browser=await puppeteer.launch({executablePath:await findBrowser(),headless:true,args:['--disable-background-networking','--disable-component-update','--no-first-run','--disable-sync','--disable-extensions','--disable-features=MediaRouter'],defaultViewport:viewport});const result=await hostUi({browser,server,directory,viewport,gameRoot:workspace,buildId:process.argv[5]});process.exitCode=[...result.results,...result.comparisons].some(r=>r.status==='FAIL')?1:0;console.log(JSON.stringify({directory,checks:result.results.length,failures:result.results.filter(r=>r.status==='FAIL').map(r=>({label:r.label,name:r.name,error:r.error})),comparisons:result.comparisons.map(({style,status})=>({style,status}))}));}
  finally {try{if(browser)await browser.close();}finally{await server.close();}}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
