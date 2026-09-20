import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source=await readFile(new URL('../../module/game-ui.js',import.meta.url),'utf8');
const start=source.indexOf('function fitModalToViewport(modal) {');
const end=source.indexOf('// 关闭所有特殊弹窗',start);
assert.ok(start>=0&&end>start);
function setup({rect={left:4,top:-64,width:1272,height:840},bottom=1285,visual=null,landscape=false,containerRight=1600}={}){
 const registrations=new Map(),frames=new Map();let sequence=0;
 const events=name=>({addEventListener(type,fn){registrations.set(`${name}:${type}`,fn);},removeEventListener(type,fn){assert.equal(registrations.get(`${name}:${type}`),fn);registrations.delete(`${name}:${type}`);}});
 const visualViewport=visual?{...visual,...events('visual')}:null;
 const classList={contains:name=>landscape&&name==='layout-landscape'};
 const document={...events('document'),body:{classList,getBoundingClientRect:()=>({bottom})},getElementById:()=>({getBoundingClientRect:()=>rect}),querySelector:()=>({getBoundingClientRect:()=>({bottom,right:containerRight})})};
 const window={...events('window'),innerWidth:1280,innerHeight:900,visualViewport};
 const context=vm.createContext({window,document,requestAnimationFrame(fn){const id=++sequence;frames.set(id,fn);return id;},cancelAnimationFrame(id){frames.delete(id);}});
 vm.runInContext(source.slice(start,end),context);
 const content={style:{}},modal={id:'history-summary-modal',style:{},querySelector:()=>content};
 return {context,modal,content,registrations,frames};
}
test('offscreen page anchors cannot place a fixed long dialog footer beyond the screen',()=>{
 const s=setup();s.context.fitModalToViewport(s.modal);
 assert.equal(s.modal.style.top,'0px');assert.equal(s.modal.style.height,'900px');
 assert.equal(s.modal.style.width,'1272px');assert.equal(s.modal.style.overflow,'auto');assert.equal(s.content.style.overflow,'auto');
});
test('long dialog fits a reduced visual viewport without requiring a larger test window',()=>{
 const s=setup({rect:{left:-80,top:-200,width:1200,height:900},bottom:1600,visual:{offsetLeft:20,offsetTop:70,width:390,height:310}});
 s.context.fitModalToViewport(s.modal);
 assert.equal(s.modal.style.left,'20px');assert.equal(s.modal.style.top,'70px');assert.equal(s.modal.style.width,'390px');assert.equal(s.modal.style.height,'310px');
 s.modal.id='inventory-modal';s.context.fitModalToViewport(s.modal);
 assert.equal(s.modal.style.top,'-200px','Existing non-tall placement is outside this change');
});
test('landscape layout breaks a long dialog out horizontally, not vertically',()=>{
 const s=setup({landscape:true,rect:{left:4,top:0,width:600,height:411},bottom:900,containerRight:1280});
 s.context.fitModalToViewport(s.modal);
 assert.equal(s.modal.style.left,'4px');
 assert.equal(s.modal.style.top,'0px');
 assert.equal(s.modal.style.width,'1276px','Width reaches the container right edge (horizontal breakout)');
 assert.equal(s.modal.style.height,'411px','Height stays the viewport height instead of the page bottom');
 assert.equal(s.modal.style.overflow,'auto');
});
test('portrait layout keeps the vertical breakout unchanged',()=>{
 const s=setup({landscape:false});
 s.context.fitModalToViewport(s.modal);
 assert.equal(s.modal.style.width,'1272px');
 assert.equal(s.modal.style.height,'900px');
});
test('visual viewport changes schedule fitting and disposal removes all listeners and queued work',()=>{
 const s=setup({visual:{offsetLeft:0,offsetTop:0,width:390,height:420}});
 s.context.bindModalAutoFit(s.modal);
 assert.equal(s.registrations.size,5);
 s.registrations.get('visual:resize')();assert.equal(s.frames.size,1);
 s.registrations.get('visual:scroll')();assert.equal(s.frames.size,1,'Repeated changes replace pending frame');
 s.modal._unbindFit();assert.equal(s.frames.size,0);assert.equal(s.registrations.size,0);
});
