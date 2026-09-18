// UI-only regression: real browser, synthetic saves, no production state writes.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {launchBrowser,newGameContext,startGame,json,workspace,artifact,readState,assertSessionSafe,saveSessionEvidence} from '../../scene3d/scripts/test-support.mjs';
import {startTestServer} from '../../scene3d/scripts/test-server.mjs';
import {clickVisible} from './iframe-business.browser.mjs';
const directory=process.argv[2];assert.ok(directory&&path.isAbsolute(directory));await fs.mkdir(directory);
const hash=b=>createHash('sha256').update(b).digest('hex');
const cssPath=path.join(workspace,'module/game-styles-elegant.css');
const beforeCss=await fs.readFile(cssPath);const html=await fs.readFile(path.join(workspace,'index.html'),'utf8');
const frozenHtml=await fs.readFile(path.join(workspace,'.scene3d-work/integration-006/apk-copy/index.html'),'utf8');
const link='    <link rel="stylesheet" href="module/game-styles-elegant.css" id="elegant-css">'+(html.includes('\r\n')?'\r\n':'\n');
assert.equal(html.split(link).length,2,'Exactly one new stylesheet link');
assert.equal(html.replace(link,''),frozenHtml,'The only host HTML change must be a stylesheet link');
const input=await json(path.join(workspace,'.scene3d-work/integration-006/apk-input-manifest.json'));
let jsCount=0;
for(const [name,expected]of Object.entries(input.files))if(/^(module|ui)\/.*\.(js|mjs)$/.test(name)){assert.equal(hash(await fs.readFile(path.join(workspace,name))),expected.sha256,`Business code changed: ${name}`);jsCount++;}
const server=await startTestServer({gameRoot:workspace});let browser;
const results=[];
async function settle(page){await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});}
async function styles(page){return page.evaluate(()=>{
 const selectors=['body','.viewport','.bottom-panel','.control-buttons','.control-btn','.story-area','.story-expand-btn','.status-display','.modal-content'];
 return Object.fromEntries(selectors.map(selector=>[selector,Array.from(document.querySelectorAll(selector)).map(el=>{const c=getComputedStyle(el);return ['color','backgroundColor','backgroundImage','fontFamily','fontSize','borderImageSource','borderWidth','padding','margin','boxShadow','width','height'].map(k=>c[k]);})]));
});}
try{
 browser=await launchBrowser();
 for(const width of [1280,390])for(const style of [0,1]){
  const label=`${width}-${style===0?'ancient':'flat'}`,payload=await json(path.join(workspace,'tests/scene3d/fixtures/saves/map.json'));
  const session=await newGameContext(browser,server,{payload,channel:'elegant-'+label,style,viewport:{width,height:width===390?844:900,deviceScaleFactor:1},scene3dPreferences:{enabled:true,quality:'low'}});
  const page=session.page;
  try{
   await startGame(session,server);await page.evaluate(()=>closeModal());
   await page.waitForFunction(()=>{const d=GameSceneBridge.getDiagnostics();return d.renderer?.ready&&d.renderer.interactionEnabled;},{timeout:60000});await settle(page);
   const originalState=await readState(page),enabledStyles=await styles(page);
   const scope=await page.evaluate(()=>{const sheet=document.getElementById('elegant-css').sheet,selectors=[];const visit=rules=>{for(const rule of rules){if(rule.selectorText)selectors.push(rule.selectorText);if(rule.cssRules)visit(rule.cssRules);}};visit(sheet.cssRules);return selectors;});
   assert.ok(scope.length>20);for(const selector of scope)assert.ok(selector.startsWith('body.ui-style-ancient'),selector);
   await page.evaluate(()=>document.getElementById('elegant-css').disabled=true);await settle(page);
   const disabledStyles=await styles(page);assert.deepEqual(await readState(page),originalState,'CSS toggle must preserve business and RNG');
   if(style===1)assert.deepEqual(enabledStyles,disabledStyles,'New stylesheet must not affect flat theme');else assert.notDeepEqual(enabledStyles,disabledStyles,'Ancient visual change must be applied');
   await page.evaluate(()=>document.getElementById('elegant-css').disabled=false);await settle(page);assert.deepEqual(await readState(page),originalState);
   await page.screenshot({path:path.join(directory,`${label}-map3d.png`),fullPage:true});
   await page.evaluate(()=>showHistorySummary());await settle(page);
   await page.screenshot({path:path.join(directory,`${label}-history.png`)});
   await clickVisible(page,'[onclick="closeHistorySummaryModal()"]');
   await page.evaluate(()=>goToLocation('cangjingge'));
   await page.waitForFunction(()=>{const d=GameSceneBridge.getDiagnostics();return d.readyScene==='library'&&d.renderer?.interactionEnabled;},{timeout:60000});await settle(page);
   await page.screenshot({path:path.join(directory,`${label}-library3d.png`),fullPage:true});
   assertSessionSafe(session,server,'elegant-'+label);
   results.push({label,status:'PASS',scopedSelectors:scope.length,flatUnchanged:style===1,cssPreservesBusinessAndRng:true});
  }finally{await saveSessionEvidence(session,directory,label);await session.close();}
 }
 assert.equal(hash(await fs.readFile(cssPath)),hash(beforeCss));
 await artifact(directory,'result.json',{status:'PASS',results,businessJsUnchanged:jsCount,onlyHtmlChange:'stylesheet link',cssSha256:hash(beforeCss),browser:await browser.version(),scope:'UI CSS toggling, exact flat computed-style equality, real 3D map/library and original modal close; no Android claim'});
}catch(error){await artifact(directory,'failure.json',{error:error.stack,results});process.exitCode=1;console.error(error.stack);}
finally{await browser?.close();await server.close();}
