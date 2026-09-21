import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {launchBrowser, workspace, artifact} from '../../scene3d/scripts/test-support.mjs';
import {startTestServer} from '../../scene3d/scripts/test-server.mjs';

const directory=path.join(workspace,'.scene3d-work/secondary-dialogs');
await mkdir(directory,{recursive:true});
const server=await startTestServer({gameRoot:workspace});
let browser;
const results={startedAt:new Date().toISOString(),viewports:[{width:390,height:844},{width:844,height:390}],cases:[],network:[],errors:[],notes:[
  'Fresh isolated browser contexts, local static resources only; no external API or user profile access.',
  'All stylesheets load through real HTTP; the test server explicitly permits secondary-pages-responsive.css without a substituted response.',
  'Only UI open/close/navigation actions; no purchases, planting, alchemy, battle resolution, travel or save confirmation.',
  'Synthetic event descriptions exercise real event rendering functions without applying event effects.',
  'Farm crop fixture replaces one disposable context plot; battle result calls the real presentation routine only. No user state exists in these temporary contexts.'
]};
const cases=[
 {name:'start-name',file:'start-screen-noST.html',panel:'#new-journey-modal',body:'.modal-body',control:'#btn-cancel',open:async p=>p.click('[data-action="new"]')},
 {name:'start-difficulty',file:'start-screen-noST.html',panel:'#new-journey-modal',body:'.modal-body',control:'#btn-cancel',open:async p=>{await p.click('[data-action="new"]');await p.type('.name-input','验收角色');await p.click('#btn-next');}},
 {name:'start-origin',file:'start-screen-noST.html',panel:'#new-journey-modal',body:'.modal-body',control:'#btn-cancel',open:async p=>{await p.click('[data-action="new"]');await p.type('.name-input','验收角色');await p.click('#btn-next');await p.click('.choice-btn');await p.click('#btn-next');}},
 {name:'start-custom-origin',file:'start-screen-noST.html',panel:'#new-journey-modal',body:'.modal-body',control:'#btn-cancel',open:async p=>{await p.click('[data-action="new"]');await p.type('.name-input','验收角色');await p.click('#btn-next');await p.click('.choice-btn');await p.click('#btn-next');await p.click('[data-origin="自定义"]');await p.click('#btn-next');}},
 {name:'start-allocate',file:'start-screen-noST.html',panel:'#new-journey-modal',body:'.modal-body',control:'#btn-cancel',open:async p=>{await p.click('[data-action="new"]');await p.type('.name-input','验收角色');await p.click('#btn-next');await p.click('.choice-btn');await p.click('#btn-next');await p.click('.choice-btn');await p.click('#btn-next');}},
 {name:'start-load',file:'start-screen-noST.html',panel:'#new-journey-modal',body:'.modal-body',control:'#btn-cancel',open:async p=>p.click('[data-action="load"]')},
 {name:'start-news',file:'start-screen-noST.html',panel:'#new-journey-modal',body:'.modal-body',control:'#btn-cancel',open:async p=>p.click('[data-action="difficulty"]')},
 {name:'farm-shop',file:'farm.html',panel:'#shopOverlay .shop',body:'.content',control:'#btnCloseShop',open:async p=>p.click('#btnShop')},
 {name:'farm-exit',file:'farm.html',panel:'#exitOverlay .exit-dialog',control:'#exitCancel',open:async p=>p.click('#btnExitFarm')},
 {name:'farm-prompt',file:'farm.html',panel:'#uiOverlay .exit-dialog',control:'#uiOk',open:async p=>p.evaluate(()=>showAlert('这是用于响应式验收的提示。'.repeat(18),'长内容提示'))},
 {name:'farm-event',file:'farm.html',panel:'#eventOverlay .event-popup',control:'#eventConfirm',open:async p=>p.evaluate(()=>showEventPopup('rain','天降甘霖','雨水滋润田地，作物茁壮成长。'.repeat(10)))},
 {name:'farm-seeds',file:'farm.html',panel:'#popup',open:async p=>{await p.waitForSelector('.tile.farm');await p.click('.tile.farm');}},
 {name:'farm-crop',file:'farm.html',panel:'#popup',open:async p=>p.evaluate(()=>{state.grid[0][0]={...createEmptyPlot(),planted:true,cropId:'wheat',maturity:1};openActionPopup({x:0,y:0,r:0,c:0});})},
 {name:'alchemy-herbs',file:'alchemy.html',panel:'#herb-modal-overlay > .modal',body:'.modal-content',control:'[onclick="closeHerbModal()"]',open:async p=>p.click('#start-alchemy-btn')},
 {name:'alchemy-shop',file:'alchemy.html',panel:'#shop-modal-overlay > .modal',body:'.modal-content',control:'[onclick="closeShopModal()"].modal-btn',open:async p=>p.evaluate(()=>openShopModal())},
 {name:'alchemy-inventory',file:'alchemy.html',panel:'#inventory-modal-overlay > .modal',body:'.modal-content',control:'[onclick="closeInventoryModal()"].modal-btn',open:async p=>p.evaluate(()=>openInventoryModal())},
 {name:'alchemy-event',file:'alchemy.html',panel:'#event-modal',control:'.event-close-btn',open:async p=>p.evaluate(()=>showEventModal({icon:'🌿',name:'药香四溢',desc:'测试药材事件说明。'.repeat(12),effectDesc:'仅预览事件文案，不应用业务效果。'}))},
 {name:'alchemy-exit',file:'alchemy.html',panel:'#exitOverlay .exit-dialog',control:'#exitCancel',open:async p=>p.click('.exit-btn')},
 {name:'world-location',file:'world_map.html',panel:'#locationModal .modal-content',body:'.modal-body',control:'.close-btn',open:async p=>p.evaluate(()=>showLocationInfo('伊州'))},
 {name:'world-companions',file:'world_map.html',panel:'#locationModal .modal-content',body:'.modal-body',control:'.close-btn',open:async p=>p.evaluate(()=>{showLocationInfo('伊州');showNPCList();})},
 {name:'battle-stats',file:'turn-based-battle-new.html',panel:'#stats-modal .modal-content',body:'.modal-body',control:'#stats-modal-close',open:async p=>p.evaluate(()=>showStatsModal('player'))},
 {name:'battle-items',file:'turn-based-battle-new.html',panel:'#item-modal .item-modal-content',body:'.item-list',control:'.item-close-btn',open:async p=>p.evaluate(()=>openItemModal())},
 {name:'battle-exit',file:'turn-based-battle-new.html',panel:'#exit-battle-overlay .modal-content',control:'.btn-cancel',open:async p=>p.evaluate(()=>confirmExitBattle())},
 {name:'battle-confirm',file:'turn-based-battle-new.html',panel:'#confirm-modal .modal-content',body:'.modal-body',control:'#cancel-action',open:async p=>p.click('#gather')},
 {name:'battle-result',file:'turn-based-battle-new.html',panel:'#game-over-modal .modal-content',body:'.modal-body',open:async p=>p.evaluate(()=>gameEnd(true))},
 {name:'blackjack-table',file:'blackjack.html',panel:'.container',control:'.exit-btn',documentScroll:true,open:async()=>{}}
];
try {
 browser=await launchBrowser();results.browser=await browser.version();
 for(const viewport of results.viewports) {
  for(const test of cases) {
   const context=await browser.createBrowserContext(),page=await context.newPage();
   const label=`${viewport.width}x${viewport.height}-${test.name}`;
   const record={label,file:test.file,viewport,panel:test.panel,status:'PASS',errors:[]};
   results.cases.push(record);
   try {
    await page.setViewport({...viewport,deviceScaleFactor:1});
    await page.setRequestInterception(true);
    page.on('request',req=>{
     const url=new URL(req.url());
     if((url.origin===server.origin && req.method()==='GET')||['data:','blob:'].includes(url.protocol)) req.continue().catch(()=>{});
     else {results.network.push({label,url:req.url(),method:req.method(),action:'blocked'});req.abort('blockedbyclient').catch(()=>{});}
    });
    page.on('response',response=>{
     if(new URL(response.url()).pathname==='/secondary-pages-responsive.css') record.cssHttp={status:response.status(),contentType:response.headers()['content-type'],fromCache:response.fromCache(),fromServiceWorker:response.fromServiceWorker()};
    });
    page.on('pageerror',err=>record.errors.push(err.message));
    page.on('dialog',dialog=>dialog.dismiss());
    await page.goto(`${server.origin}/${test.file}`,{waitUntil:'networkidle0',timeout:45000});
    await test.open(page);
    await page.waitForSelector(test.panel,{visible:true,timeout:5000});
    await page.evaluate(()=>document.fonts.ready);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    // Complete decorative entry animations before measuring and taking evidence.
    await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
    record.geometry=await page.evaluate(({panel,body,documentScroll})=>{
     const root=document.querySelector(panel),r=root.getBoundingClientRect(),sc=documentScroll?document.scrollingElement:(body?root.querySelector(body):root);
     const rect=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom};};
     return {panel:rect(root),bounded:r.left>=-1&&r.top>=-1&&r.right<=innerWidth+1&&(documentScroll||r.bottom<=innerHeight+1),horizontalOverflow:root.scrollWidth>root.clientWidth+2,scroll:{height:sc.clientHeight,total:sc.scrollHeight,overflow:getComputedStyle(sc).overflowY},viewportCover:document.querySelector('meta[name="viewport"]').content.includes('viewport-fit=cover'),cssLoaded:getComputedStyle(document.body).getPropertyValue('--dialog-height').trim()!==''};
    },test);
    if(!record.geometry.bounded||record.geometry.horizontalOverflow||!record.geometry.cssLoaded)record.status='FAIL';
    record.screenshot=`${label}.png`;
    await page.screenshot({path:path.join(directory,record.screenshot)});
    if(test.control){
     record.control=await page.evaluate(({panel,control})=>{
      const root=document.querySelector(panel),el=root.querySelector(control)||document.querySelector(control);
      if(!el)return {exists:false};el.scrollIntoView({block:'nearest',inline:'nearest'});
      const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
      return {exists:true,text:el.textContent.trim(),width:r.width,height:r.height,reachable:x>=0&&y>=0&&x<innerWidth&&y<innerHeight&&(hit===el||el.contains(hit))};
     },test);
     if(!record.control.reachable)record.status='FAIL';
    }
    if(record.geometry.scroll.total>record.geometry.scroll.height+2){
     await page.evaluate(({panel,body,documentScroll})=>{const root=document.querySelector(panel),sc=documentScroll?document.scrollingElement:(body?root.querySelector(body):root);sc.scrollTop=sc.scrollHeight;},test);
     record.bottomScreenshot=`${label}-bottom.png`;
     await page.screenshot({path:path.join(directory,record.bottomScreenshot)});
     record.scrolled=await page.evaluate(({panel,body,documentScroll})=>{const root=document.querySelector(panel),sc=documentScroll?document.scrollingElement:(body?root.querySelector(body):root);return {top:sc.scrollTop,bottomReached:sc.scrollTop+sc.clientHeight>=sc.scrollHeight-2};},test);
     if(!record.scrolled.bottomReached)record.status='FAIL';
    }
    if(test.control && !test.documentScroll){
     const control=await page.$(`${test.panel} ${test.control}`);
     if(control){await control.click();record.closed=await page.$eval(test.panel,el=>el.getClientRects().length===0);if(!record.closed)record.status='FAIL';}
    }
    if(record.errors.length || record.cssHttp?.status!==200 || !record.cssHttp.contentType?.startsWith('text/css') || record.cssHttp.fromServiceWorker)record.status='FAIL';
   } catch(error){record.status='FAIL';record.failure=error.message;await page.screenshot({path:path.join(directory,`${label}-failure.png`)}).catch(()=>{});}
   finally {await context.close();}
   console.log(record.status,label,record.failure||'');
  }
 }
} catch(error){results.errors.push(error.stack);}
finally {
 if(browser)await browser.close();await server.close();
 results.finishedAt=new Date().toISOString();results.summary={total:results.cases.length,passed:results.cases.filter(c=>c.status==='PASS').length,failed:results.cases.filter(c=>c.status==='FAIL').length,externalRequestsSent:0};
 await artifact(directory,'results.json',results);console.log(JSON.stringify(results.summary));
 if(results.summary.failed||results.errors.length)process.exitCode=1;
}
