import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../../module/scene3d-bridge.js', import.meta.url), 'utf8');
const drain = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
// Test-only injection, never a production export: exercise the real private apply /
// animation state machine with independently controlled WAAPI and renderer promises.
function host() {
  const animations = [], calls = [], timers = new Set(), elements = new Map();
  class Element {
    constructor(id='') { this.id=id;this.hidden=false;this.dataset={};this.style={};this.children=[];this.classes=new Set();this.classList={contains:n=>this.classes.has(n),add:(...ns)=>ns.forEach(n=>this.classes.add(n)),remove:(...ns)=>ns.forEach(n=>this.classes.delete(n))}; }
    append(...ns) {this.children.push(...ns);this.firstChild=this.firstElementChild=this.children[0];}
    querySelector(selector) {return this.children.flatMap(n=>[n,...(n.children||[])]).find(n=>n.className===selector.slice(1));}
    setAttribute() {} removeAttribute(name) { if(name==='data-scene3d-ready')delete this.dataset.scene3dReady; } addEventListener() {} closest() {return null;}
    getBoundingClientRect() {return {left:0,top:0,width:800,height:600,right:800,bottom:600};} getClientRects() {return [this.getBoundingClientRect()];}
    animate(frames) {const d=deferred();const a={finished:d.promise,cancel:()=>d.reject(Error('cancel')),finish:d.resolve,frames};animations.push(a);return a;}
  }
  for(const id of ['main-viewport','sect-3d-root','map-scene','cangjingge-scene','huofang-scene','player-stats-scene'])elements.set(id,new Element(id));
  elements.get('map-scene').classes.add('active');
  const document={baseURI:'http://localhost/index.html',hidden:false,body:new Element(),head:new Element(),
    createElement:()=>new Element(),createTextNode:textContent=>({textContent}),getElementById:id=>elements.get(id),addEventListener(){},
    querySelectorAll:s=>s==='#main-viewport > .scene.active'?[...elements.values()].filter(e=>e.classes.has('active')):s==='#main-viewport > .scene'?[...elements.values()].filter(e=>e.id.endsWith('-scene')):[],
    querySelector(s){return this.querySelectorAll(s)[0];}};
  const renderer={visible:true,renderEnabled:true,interactionEnabled:true,
    setVisible(v){this.visible=v;},setRenderEnabled(v){this.renderEnabled=v;},setInteractionEnabled(v){this.interactionEnabled=v;},clearSelection(){},resize(){},destroy(){},
    applyState(s){const d=deferred();calls.push({s,...d});return d.promise;},getDiagnostics(){return {visible:this.visible,renderEnabled:this.renderEnabled,interactionEnabled:this.interactionEnabled};},
    retry(){throw Error('Direct retry must not bypass apply');}};
  const sandbox={document,location:{protocol:'http:'},URL,queueMicrotask,console,innerWidth:800,innerHeight:600,
    setTimeout:(fn,ms)=>{const id=setTimeout(fn,ms);id.unref();timers.add(id);return id;},clearTimeout,
    matchMedia:()=>({matches:false}),getComputedStyle:()=>({display:'block',visibility:'visible'}),MutationObserver:class{observe(){}},addEventListener(){},
    localStorage:{getItem:()=>null,setItem(){}},renderer};sandbox.window=sandbox;
  const ctx=vm.createContext(sandbox);
  vm.runInContext("let GameMode=0,userLocation='tianshanpai',inputEnable=1;",ctx);
  vm.runInContext(source.replace('    window.GameSceneBridge =', '    window.__test = { install() { view = renderer; preferences.enabled = true; }, onEvent, abortTurn };\n    window.GameSceneBridge ='),ctx);
  const bridge=sandbox.GameSceneBridge;bridge.start();sandbox.__test.install();
  const navigate=(id,force=false)=>{for(const e of elements.values())e.classes.delete('active');elements.get(id+'-scene').classes.add('active');vm.runInContext(`userLocation=${JSON.stringify(id==='map'?'tianshanpai':id)}`,ctx);bridge.notify('navigate',force);};
  const complete=(index,status='applied')=>{const c=calls[index];c.resolve({status,epoch:c.s.sessionEpoch,revision:c.s.revision,sceneId:c.s.sceneId});};
  return {bridge,renderer,calls,animations,elements,document,navigate,complete,
    event: e=>sandbox.__test.onEvent(e),run:s=>vm.runInContext(s,ctx),
    cleanup(){sandbox.__test.abortTurn();timers.forEach(clearTimeout);}};
}
async function ready(g) {await drain();g.complete(0);await drain();assert.equal(g.bridge.getDiagnostics().readyScene,'main');}
async function cover(g) {g.animations.at(-1).finish();await drain();}

test('force, retry and observer echoes cannot submit a swap before full cover',async t=>{
 const g=host();t.after(()=>g.cleanup());await ready(g);
 g.navigate('cangjingge');await drain();assert.equal(g.calls.length,1);assert.equal(g.elements.get('main-viewport').dataset.scene3dTurning,'true');
 g.bridge.notify('force',true);await g.bridge.retry();await drain();assert.equal(g.calls.length,1);
 const d=g.bridge.getDiagnostics();g.event({type:'ready',epoch:d.epoch,revision:d.revision,sceneId:'library'});assert.equal(g.bridge.getDiagnostics().readyScene,'main');
 await cover(g);assert.equal(g.calls.length,2);assert.equal(g.calls[1].s.sceneId,'library');
 g.complete(1);await drain();assert.equal(g.bridge.getDiagnostics().readyScene,'library');assert.equal(g.animations.length,2);
 await cover(g);assert.equal(g.renderer.interactionEnabled,true);
});
test('reveal republishes canonical interactive snapshot after the loading apply releases ownership',async t=>{
 const g=host();t.after(()=>g.cleanup());await ready(g);
 g.navigate('cangjingge');await drain();await cover(g);
 assert.equal(g.calls.length,2);const loading=g.calls[1].s;
 assert.equal(loading.sceneId,'library');assert.equal(loading.interactive,false,'Page turn loads with NPC input locked');
 g.complete(1);await drain();assert.equal(g.calls.length,2,'Canonical unlock waits for reveal');
 await cover(g);
 assert.equal(g.calls.length,3,'Reveal must apply canonical state, not merely unlock the renderer setter');
 const unlocked=g.calls[2].s;
 assert.equal(unlocked.sceneId,loading.sceneId);assert.equal(unlocked.sessionEpoch,loading.sessionEpoch);assert.equal(unlocked.revision,loading.revision);
 assert.equal(unlocked.interactive,true,'NPC copied snapshot must receive the canonical interactive flag');
 assert.equal(g.animations.length,2,'Canonical reapply must not start another page turn');
 g.complete(2);await drain();assert.equal(g.calls.length,3);assert.equal(g.renderer.interactionEnabled,true);
});
test('new route before initial ready still covers; stale ready/completion cannot publish',async t=>{
 const g=host();t.after(()=>g.cleanup());await drain();g.navigate('cangjingge');await drain();assert.equal(g.animations.length,1);assert.equal(g.renderer.visible,false);
 g.complete(0);await drain();assert.equal(g.bridge.getDiagnostics().readyScene,null);assert.equal(g.calls.length,1);
 await cover(g);assert.equal(g.calls[1].s.sceneId,'library');
});
test('rapid routes share cover, newer load owns reveal, stale completion cannot remove mask',async t=>{
 const g=host();t.after(()=>g.cleanup());await ready(g);g.navigate('cangjingge');await drain();await cover(g);
 g.navigate('huofang',true);await drain();assert.equal(g.calls.length,3);assert.equal(g.animations.length,1);
 g.complete(1);await drain();assert.equal(g.elements.get('main-viewport').dataset.scene3dTurning,'true');assert.equal(g.animations.length,1);
 g.complete(2);await drain();assert.equal(g.bridge.getDiagnostics().readyScene,'kitchen');assert.equal(g.animations.length,2);
});
test('navigation during reveal pins opaque sheet; cancelled animation cannot hide new owner',async t=>{
 const g=host();t.after(()=>g.cleanup());await ready(g);g.navigate('cangjingge');await drain();await cover(g);g.complete(1);await drain();
 const oldReveal=g.animations.at(-1);g.navigate('huofang',true);await drain();oldReveal.finish();await drain();
 const viewport=g.elements.get('main-viewport'),page=viewport.children.find(e=>e.className==='scene3d-page-turn');
 assert.equal(page.hidden,false);assert.equal(page.firstChild.style.opacity,'1');assert.equal(viewport.dataset.scene3dTurning,'true');
 g.complete(2);await drain();await cover(g);assert.equal(page.hidden,true);
});
test('special pages abort immediately and stale cover cannot revive the renderer',async t=>{
 const g=host();t.after(()=>g.cleanup());await ready(g);g.navigate('cangjingge');await drain();const animation=g.animations.at(-1);
 g.navigate('player-stats');await drain();assert.equal(g.bridge.getDiagnostics().snapshot.visible,false);assert.equal(g.renderer.visible,false);assert.equal(g.elements.get('main-viewport').dataset.scene3dTurning,undefined);
 animation.finish();await drain();assert.equal(g.calls.length,1);assert.equal(g.bridge.getDiagnostics().readyScene,null);
});
test('overlay locks and restore invalidation remain timely during a pending load',async t=>{
 const g=host();t.after(()=>g.cleanup());await ready(g);g.navigate('cangjingge');await drain();await cover(g);
 g.run('inputEnable=0');g.bridge.notify('overlay');await drain();assert.equal(g.renderer.renderEnabled,false);assert.equal(g.bridge.getDiagnostics().snapshot.interactive,false);
 const before=g.bridge.getDiagnostics().epoch;g.bridge.afterRestore('restore');await drain();assert.ok(g.bridge.getDiagnostics().epoch>before);
 g.complete(1);await drain();assert.equal(g.elements.get('main-viewport').dataset.scene3dTurning,'true');assert.equal(g.bridge.getDiagnostics().readyScene,null);
 const latest=g.calls.length-1;g.complete(latest);await drain();assert.equal(g.bridge.getDiagnostics().readyScene,'library');assert.equal(g.renderer.renderEnabled,false);
});
