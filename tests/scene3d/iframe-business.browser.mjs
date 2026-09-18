// Real-control helpers only. No synthesized settlement messages or business writes.
import assert from 'node:assert/strict';
export const IFRAME_GAMES = Object.freeze({
  farm: { selector:'#farm-iframe', exit:'#btnExitFarm', confirm:'#exitConfirm', message:'farm-exit' },
  alchemy: { selector:'#alchemy-iframe', exit:'#btnExitAlchemy', confirm:'#exitConfirm', message:'alchemy-exit' },
  battle: { selector:'#battle-iframe', exit:'#escape', confirm:'#exit-battle-overlay .btn-danger', message:'battle-exit' },
  blackjack: { selector:'#blackjack-iframe', exit:'.exit-btn', message:'blackjack-exit' },
  worldmap: { selector:'#worldmap-iframe', exit:'.map-close-btn', message:'worldmap-close' }
});
export async function clickVisible(frame, selector) {
  const control=await frame.waitForSelector(selector, {visible:true,timeout:15000});
  await control.scrollIntoView();
  await frame.waitForFunction(selector => {
    const node=document.querySelector(selector); if(!node) return false;
    const box=node.getBoundingClientRect(), hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);
    return box.width>0 && box.height>0 && (hit===node || node.contains(hit)) && !node.disabled &&
      !document.getAnimations().some(a=>a.playState==='running' && a.effect?.getTiming().iterations!==Infinity);
  }, {timeout:15000}, selector);
  await frame.click(selector);
}
export async function awaitFrame(page, selector) {
  const element=await page.waitForSelector(selector,{visible:true});
  const frame=await element.contentFrame(); assert.ok(frame);
  await frame.waitForFunction(()=>document.readyState==='complete');
  return frame;
}
export async function assertRendererPausedDuringHostOverlay(page) {
  await page.waitForFunction(()=>{
    const r=window.GameSceneBridge?.getDiagnostics().renderer;
    return r && r.raf===0 && r.interactionEnabled===false;
  });
  const before=await page.evaluate(()=>GameSceneBridge.getDiagnostics().renderer);
  await page.evaluate(()=>new Promise(resolve=>{let count=0;const tick=()=>++count===12?resolve():requestAnimationFrame(tick);requestAnimationFrame(tick);}));
  const after=await page.evaluate(()=>GameSceneBridge.getDiagnostics().renderer);
  assert.equal(after.frames,before.frames); assert.equal(after.raf,0); assert.equal(after.interactionEnabled,false);
  return {before,after};
}
export async function exitIframeThroughRealControl(page,name) {
  const config=IFRAME_GAMES[name]; assert.ok(config,`Unknown iframe ${name}`);
  const frame=await awaitFrame(page,config.selector), frameUrl=frame.url();
  // Install and await the observer before clicking; exact window identity is captured
  // in the browser realm and retained even when the original handler clears src.
  await page.evaluate(({selector,type})=>{
    if(window.__p4IframeObserver) window.removeEventListener('message',window.__p4IframeObserver);
    const expected=document.querySelector(selector).contentWindow;
    window.__p4IframeObserved=[];
    window.__p4IframeObserver=event=>{if(event.data?.type===type) window.__p4IframeObserved.push({origin:event.origin,sameSource:event.source===expected,data:event.data});};
    window.addEventListener('message',window.__p4IframeObserver);
  },{selector:config.selector,type:config.message});
  try {
    if(name==='farm') {
      const shown=await frame.evaluate(()=>{const n=document.querySelector('#eventConfirm');return !!n?.getClientRects().length;});
      if(shown) await clickVisible(frame,'#eventConfirm');
    }
    await clickVisible(frame,config.exit);
    if(config.confirm) await clickVisible(frame,config.confirm);
    await page.waitForFunction(()=>window.__p4IframeObserved.length>0,{timeout:20000});
    await page.waitForFunction(selector=>getComputedStyle(document.querySelector(selector)).display==='none',{},config.selector.replace('-iframe','-modal'));
    const messages=await page.evaluate(()=>window.__p4IframeObserved);
    assert.equal(messages.length,1,'One real exit must produce one observed settlement message');
    assert.equal(messages[0].origin,new URL(page.url()).origin);
    assert.equal(messages[0].sameSource,true,'Real message must come from the selected iframe');
    return {frameUrl,message:messages[0],scope:'One actual UI exit; does not certify malicious replay rejection.'};
  } finally {
    await page.evaluate(()=>{window.removeEventListener('message',window.__p4IframeObserver);delete window.__p4IframeObserver;delete window.__p4IframeObserved;});
  }
}
