import path from 'node:path';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {launchBrowser,newGameContext,startGame,json,fixturesRoot} from '../../scene3d/scripts/test-support.mjs';
import {startTestServer} from '../../scene3d/scripts/test-server.mjs';
const output=path.resolve('.scene3d-work/relationship-feedback');
await mkdir(output,{recursive:true});
const server=await startTestServer({gameRoot:process.cwd()});
const browser=await launchBrowser();
const results=[];
try {
 for(const [width,height,style] of [[390,844,0],[390,844,1],[844,390,0],[844,390,1],[1440,900,0],[1440,900,1]]) {
  const label=`${width}x${height}-${style?'flat':'ancient'}`;
  const payload=await json(path.join(fixturesRoot,'saves/map.json'));
  const session=await newGameContext(browser,server,{payload,channel:label,style,viewport:{width,height,deviceScaleFactor:1,hasTouch:true,isMobile:true},scene3dPreferences:{schema:2,enabled:false,quality:'low'}});
  const {page}=session;
  try {
   await startGame(session,server);
   await page.evaluate(landscape=>{
    closeModal();
    if(landscape){const t=document.getElementById('gs-layout-toggle');t.checked=true;gsOnLayoutMode(t);}
    const ids=Object.keys(npcs);npcFavorability[ids[0]]=-100;npcFavorability[ids[1]]=100;
    npcs[ids[0]].description='长介绍验证：山间风雪，同门相伴。'.repeat(100)+'介绍末尾';
    showRelationships();
   },width>height);
   await page.waitForSelector('#relationships-scene.active');
   await page.screenshot({path:path.join(output,`${label}-cards.png`)});
   const gridCols=await page.evaluate(()=>getComputedStyle(document.querySelector('#relationship-grid')).gridTemplateColumns.trim().split(/\s+/).length);
   if(width>height){assert.equal(gridCols,4,`landscape ${label} grid cols=${gridCols}`);}else{assert.ok(gridCols>=3,`portrait ${label} grid cols=${gridCols}`);}
   const cards=await page.evaluate(()=>[...document.querySelectorAll('.relationship-value')].slice(0,2).map(e=>{const number=e.querySelector('.relationship-value-number');const range=document.createRange();range.selectNodeContents(number);const rects=[...range.getClientRects()];return {text:e.textContent,font:parseFloat(getComputedStyle(e).fontSize),overflow:e.scrollWidth>e.clientWidth,lines:rects.length,rects:rects.map(r=>({top:r.top,bottom:r.bottom}))};}));
   const expectedFont=(width<=600||(width>height&&width<=900))?11:14;
   assert.ok(cards.every(c=>c.lines===1&&!c.overflow&&c.font===expectedFont),JSON.stringify(cards));
   assert.equal(await page.$$eval('#relationship-grid .gift-btn',e=>e.length),0);
   await page.tap('.relationship-card:first-child .relationship-name');
   const bounds=await page.evaluate(()=>{const t=document.getElementById('tooltip').getBoundingClientRect(),v=document.getElementById('main-viewport').getBoundingClientRect();return {within:t.left>=v.left&&t.right<=v.right&&t.top>=v.top&&t.bottom<=v.bottom,tip:{left:t.left,top:t.top,right:t.right,bottom:t.bottom},viewport:{left:v.left,top:v.top,right:v.right,bottom:v.bottom}};});
   assert.ok(bounds.within,JSON.stringify(bounds));
   await page.screenshot({path:path.join(output,`${label}-long.png`)});
   const scroll=await page.$eval('#tooltip .tooltip-item',e=>{e.scrollTop=e.scrollHeight;return e.scrollTop;});
   assert.ok(scroll>0);
   await page.screenshot({path:path.join(output,`${label}-scrolled.png`)});
   await page.tap('.relationship-tooltip-close');
   assert.equal(await page.$eval('#tooltip',e=>e.classList.contains('show')),false);
   await page.tap('.relationship-card:first-child .relationship-name');
   await page.tap('#story-text');
   assert.equal(await page.$eval('#tooltip',e=>e.classList.contains('show')),false);
   await page.tap('.relationship-card:first-child .relationship-name');
   await page.$eval('#relationship-grid',e=>{e.scrollTop=e.scrollHeight;e.dispatchEvent(new Event('scroll'));});
   assert.equal(await page.$eval('#tooltip',e=>e.classList.contains('show')),false);
   results.push({label,pass:true,cards,bounds,scroll});
  } catch(e) {results.push({label,pass:false,error:e.stack});await page.screenshot({path:path.join(output,`${label}-failure.png`)});}
  finally {await session.close();}
 }
} finally {await browser.close();await server.close();await writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2));}
console.log(JSON.stringify(results,null,2));
if(results.some(r=>!r.pass))process.exitCode=1;
