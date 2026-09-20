import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const html=await readFile(new URL('../../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('        let _gameOrientationPlugin = null;'),html.indexOf('        // 视窗右下角控制面板开关'));
function setup(cap) {
  const classes=new Set(),listeners={},warnings=[],fits=[];
  const modal={style:{display:'block'}};
  const context=vm.createContext({
    window:{Capacitor:cap,addEventListener:(name,callback)=>listeners[name]=callback},
    document:{body:{classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name)}},querySelectorAll:()=>[modal]},
    requestAnimationFrame:fn=>fn(),fitModalToViewport:m=>fits.push(m),console:{warn:(...args)=>warnings.push(args)}
  });
  vm.runInContext(source,context);
  return {context,classes,listeners,warnings,fits,apply:mode=>vm.runInContext(`applyLayoutMode(${mode})`,context)};
}
test('web layouts work without native APIs',()=>{
  const s=setup(undefined);s.apply(1);assert.ok(s.classes.has('layout-landscape'));
  s.apply(0);assert.ok(s.classes.has('layout-portrait'));assert.ok(!s.classes.has('layout-landscape'));
  assert.equal(s.warnings.length,0);
});
test('Android locks landscape, portrait and restored landscape with one plugin registration',()=>{
  const calls=[],registered=[];
  const s=setup({getPlatform:()=> 'android',registerPlugin:name=>{registered.push(name);return {lock:args=>{calls.push(args.orientation);return Promise.resolve();}};}});
  s.apply(1);s.apply(0);s.apply(1);
  assert.deepEqual(calls,['landscape','portrait','landscape']);assert.deepEqual(registered,['GameOrientation']);
  const count=s.fits.length;s.listeners.resize();assert.equal(s.fits.length,count+1);
});
test('plain HTML Android uses injected Plugins without registerPlugin',()=>{
  const calls=[];const s=setup({getPlatform:()=> 'android',Plugins:{GameOrientation:{lock:args=>{calls.push(args.orientation);return Promise.resolve();}}}});
  s.apply(1);s.apply(0);assert.deepEqual(calls,['landscape','portrait']);assert.equal(s.warnings.length,0);
});
test('orientation rejection is handled without breaking page layout',async()=>{
  const s=setup({getPlatform:()=> 'android',registerPlugin:()=>({lock:()=>Promise.reject(new Error('not installed'))})});
  s.apply(1);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(s.warnings.length,1);assert.ok(s.classes.has('layout-landscape'));
});
test('non-Android Capacitor platform does not use Android plugin',()=>{
  const s=setup({getPlatform:()=> 'web',registerPlugin:()=>assert.fail('Unexpected native call')});s.apply(1);
  assert.ok(s.classes.has('layout-landscape'));
});
