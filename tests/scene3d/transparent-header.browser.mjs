import path from 'node:path';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {launchBrowser,newGameContext,startGame,json,fixturesRoot} from '../../scene3d/scripts/test-support.mjs';
import {startTestServer} from '../../scene3d/scripts/test-server.mjs';
import {waitForLatestApplied} from './p1.browser.mjs';
const directory=process.argv[2];assert.ok(directory&&path.isAbsolute(directory),'Supply a new absolute evidence directory');
await mkdir(directory,{recursive:false});
const server=await startTestServer({gameRoot:process.cwd()}),browser=await launchBrowser();
const results=[];
try {
 for(const viewport of [{width:1280,height:900},{width:844,height:390}]) {
  const payload=await json(path.join(fixturesRoot,'saves/map.json'));
  const session=await newGameContext(browser,server,{payload,channel:'transparent-header',style:0,viewport,scene3dPreferences:{enabled:true,quality:'low'}});
  try {
   const page=session.page;await startGame(session,server);await waitForLatestApplied(page,'main');
   await page.evaluate(()=>closeModal());
   for(const style of [0,1,0]) {
    await page.evaluate(s=>{uiStyle=s;applyUIStyle(s);},style);
    await page.waitForFunction(s=>{const r=document.getElementById('sect-3d-root');return s===0?parseFloat(r.style.top)===0:parseFloat(r.style.top)>0;},{timeout:15000},style);
    const value=await page.evaluate(()=>{
     const vp=document.getElementById('main-viewport'),root=document.getElementById('sect-3d-root'),header=document.querySelector('#map-scene>.status-display');
     const s=getComputedStyle(header),r=root.getBoundingClientRect(),v=vp.getBoundingClientRect();
     return {background:s.backgroundColor,image:s.backgroundImage,top:parseFloat(root.style.top),rootTop:r.top,contentTop:v.top+vp.clientTop,canvas:!!root.querySelector('canvas'),ready:vp.dataset.scene3dReady,texts:Array.from(header.children).map(e=>e.textContent)};
    });
    assert.equal(value.ready,'true');assert.equal(value.canvas,true);assert.equal(value.texts.length,3);
    if(style===0){assert.equal(value.background,'rgba(0, 0, 0, 0)');assert.equal(value.image,'none');assert.equal(value.top,0);assert.ok(Math.abs(value.rootTop-value.contentTop)<1);}
    else {assert.ok(value.top>0);assert.notEqual(value.background,'rgba(0, 0, 0, 0)');}
    results.push({viewport,style,...value});
   }
   await page.screenshot({path:path.join(directory,`ancient-${viewport.width}.png`)});
  } finally {await session.close();}
 }
 await writeFile(path.join(directory,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
} finally {await browser.close();await server.close();}
