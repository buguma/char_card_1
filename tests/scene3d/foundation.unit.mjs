import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import http from 'node:http';
import { createRng,diff,exists,fixturesRoot,hashFile,json,loadKnownAssets,requestPolicy,sha256,verifySnapshotTree,workspace } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer,validateResponse,isWithin } from '../../scene3d/scripts/test-server.mjs';
import { registry,selectTests } from './registry.mjs';

test('fixed seed/count and non-consuming peek',()=>{
 const a=createRng(12345),b=createRng(12345);
 assert.equal(a.next(),0.02040268573909998);
 assert.equal(b.next(),0.02040268573909998);
 const snapshot=a.snapshot(); assert.equal(a.peek(),b.next()); assert.deepEqual(a.snapshot(),snapshot);
 for(let i=0;i<100;i++) a.next(); assert.equal(a.snapshot().count,101);
});
test('diff never discards business fields or absent keys implicitly',()=>{
 assert.deepEqual(diff({npcLocations:{B:'map'}},{npcLocations:{B:'library'}}).map(x=>x.path),['npcLocations.B']);
 assert.equal(diff({id:1,location:'map'},{id:2,location:'library'},['id']).length,1);
 assert.equal(diff({}, {a:null}).length,1);
});
test('registry is fixed and all includes future/manual required items',()=>{
 assert.equal(registry.length,40); assert.equal(selectTests('all').length,40);
 assert.equal(new Set(registry.map(x=>x.testId)).size,40);
 assert.ok(selectTests('P0').every(x=>!x.manual));
 assert.equal(registry.find(x=>x.testId==='P1-T05').manual,true);
 assert.equal(registry.find(x=>x.testId==='P0-T01').requiresBrowser,false);
 assert.throws(()=>selectTests('P7'));
});
test('five synthetic old-format saves match frozen manifest SHA256',async()=>{
 const manifest=await json(path.join(fixturesRoot,'manifest.json')); assert.equal(manifest.fixtures.length,5);
 for(const fixture of manifest.fixtures){
   const bytes=await readFile(path.join(fixturesRoot,fixture.payloadFile)); assert.equal(sha256(bytes),fixture.payloadSha256);
   const payload=JSON.parse(bytes); assert.ok(payload.saveName && payload.gameData); assert.ok(Array.isArray(payload.uiConversation));
   assert.deepEqual(diff(payload.gameData.playerStats,{'武学':20,'学识':20,'声望':20,'金钱':500}),[]);
 }
});
test('baseline tree verification hashes exact files and rejects missing/extra/tampered inventories',async()=>{
 const root=path.join(fixturesRoot,'network'),expected={};
 for(const name of ['known-assets.json','gal-background-placeholder.svg'])expected[name]=await hashFile(path.join(root,name));
 assert.deepEqual((await verifySnapshotTree(root,expected)).differences,[]);
 assert.ok((await verifySnapshotTree(root,{...expected,'missing.bin':{bytes:0,sha256:'0'.repeat(64)}})).differences.some(x=>x.error==='missing'));
 assert.ok((await verifySnapshotTree(root,{'known-assets.json':expected['known-assets.json']})).differences.some(x=>x.error==='unexpected file'));
 assert.ok((await verifySnapshotTree(root,{...expected,'known-assets.json':{...expected['known-assets.json'],sha256:'0'.repeat(64)}})).differences.some(x=>x.file==='known-assets.json'));
 await assert.rejects(()=>verifySnapshotTree(root,{'../escape':{bytes:0,sha256:'0'.repeat(64)}}),/Unsafe baseline name/);
});
test('Gal synthetic story scene fields name actual packaged backgrounds',async()=>{
 for(const id of ['gal','special-event']) {
  const payload=await json(path.join(fixturesRoot,`saves/${id}.json`));
  const scene=payload.uiConversation.at(-1).content.split('|')[2];
  assert.ok(await exists(path.join(workspace,'img/location/scene_webp',payload.gameData.mapLocation,'昼',`${scene}.webp`)),`${id}: missing background ${scene}`);
 }
});
test('response samples use actual OpenAI SSE and real host parser tags',async()=>{
 const context=vm.createContext({console}); vm.runInContext(await readFile(path.join(workspace,'module/response-parser.js'),'utf8'),context);
 const fixture=await json(path.join(fixturesRoot,'responses/action-stream.json')); validateResponse(fixture);
 const content=fixture.steps.flatMap(x=>x.body.split('\n')).filter(x=>x.startsWith('data: ')&&x!=='data: [DONE]').map(x=>JSON.parse(x.slice(6)).choices[0].delta.content).join('');
 const parsed=context.responseParser.run(content); assert.match(parsed.mainText,/合成流式第二段/); assert.equal(parsed.summaries.length,1); assert.equal(parsed.sideNote.时间,'09:30');
 for(const name of ['action-json','action-truncated','action-error','action-abort','action-disconnect']) validateResponse(await json(path.join(fixturesRoot,`responses/${name}.json`)));
});
test('approved known-image substitution is hashed and exact; every other external request fails closed',async()=>{
 const assets=await loadKnownAssets();assert.equal(assets.substitutions.length,1);
 const fixture=assets.substitutions[0],origin='http://127.0.0.1:12345';
 const request={url:fixture.url,method:'GET',resourceType:'image'};
 assert.equal(requestPolicy(request,origin,assets.substitutions).action,'substitute');
 assert.equal(sha256(fixture.body),fixture.payloadSha256);
 for(const patch of [{url:fixture.url+'?x=1'},{url:'https://files.catbox.moe/unknown.png'},{url:'https://api.example.test/chat/completions'},{method:'POST'},{resourceType:'fetch'}]) {
  assert.equal(requestPolicy({...request,...patch},origin,assets.substitutions).action,'deny');
 }
 assert.equal(requestPolicy({...request,url:origin+'/index.html'},origin,assets.substitutions).action,'allow');
 assert.match(assets.scope,/NOT evidence/);
});
test('request evidence preserves UTF-8 when a Chinese character straddles real HTTP chunks',async()=>{
 const server=await startTestServer({gameRoot:workspace});let request;
 try {
  const channel='utf8-split',body={messages:[{role:'user',content:'中文全句。'}]},bytes=Buffer.from(JSON.stringify(body));
  const split=bytes.indexOf(Buffer.from('中'))+1;assert.ok(split>0);
  server.enqueue(channel,{status:200,headers:{'Content-Type':'application/json'},steps:[{body:'{}'}],terminal:'end'});
  const finished=new Promise((resolve,reject)=>{
   request=http.request(`${server.origin}/__mock/${channel}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json','Transfer-Encoding':'chunked'}},response=>{response.resume();response.on('end',resolve);});
   request.on('error',reject);request.write(bytes.subarray(0,split));
  });
  await server.waitFor(event=>event.type==='api-body-chunk'&&event.channel===channel&&event.totalBytes===split);
  request.end(bytes.subarray(split));await finished;
  assert.deepEqual(server.requests[0].body,body);assert.equal(server.requests[0].bodySha256,sha256(bytes));assert.equal(server.requests[0].bodyBytes,bytes.length);
  assert.equal(server.events.filter(event=>event.type==='api-body-chunk'&&event.channel===channel).length,2);
 } finally {request?.destroy();await server.close();}
});
test('static asset faults and gates are exact, real HTTP, and require authenticated release',async()=>{
 const server=await startTestServer({gameRoot:workspace});
 try {
  assert.throws(()=>server.setAssetRule('../outside',{channel:'test',status:404}));
  assert.throws(()=>server.setAssetRule('assets/../outside',{channel:'test',status:404}));
  server.setAssetRule('assets/controlled-test.glb',{channel:'asset-unit',waitFor:'continue',status:200,body:'synthetic-negative-fixture'});
  let settled=false;const pending=fetch(`${server.origin}/assets/controlled-test.glb`).then(response=>{settled=true;return response.text();});
  await server.waitFor(event=>event.type==='asset-waiting'&&event.channel==='asset-unit');assert.equal(settled,false);
  assert.equal((await fetch(`${server.origin}/__control/asset-unit:continue`,{method:'POST'})).status,403);
  await server.release('asset-unit','continue');assert.equal(await pending,'synthetic-negative-fixture');
  server.clearAssetRules();assert.equal((await fetch(`${server.origin}/assets/controlled-test.glb`)).status,404);
  server.setAssetRule('assets/controlled-test.glb',{channel:'asset-fail',status:503});
  assert.equal((await fetch(`${server.origin}/assets/controlled-test.glb`)).status,503);
 }finally{await server.close();}
});
test('loopback static server denies traversal/private source and writes real gated SSE',async()=>{
 const server=await startTestServer({gameRoot:workspace});
 try {
   assert.equal((await fetch(`${server.origin}/index.html`,{method:'HEAD'})).status,200);
   assert.equal((await fetch(`${server.origin}/.git/config`)).status,403);
   assert.equal((await fetch(`${server.origin}/module/%2e%2e%2f.git/config`)).status,403);
   assert.equal((await fetch(`${server.origin}/index.html`,{method:'PUT'})).status,405);
   assert.equal((await fetch(`${server.origin}/__control/test:next`,{method:'POST'})).status,403);
   assert.equal(isWithin(workspace,path.resolve(workspace,'../outside')),false);
   server.enqueue('test',{status:200,headers:{'Content-Type':'text/event-stream'},steps:[{body:'first\n'},{body:'second\n',waitFor:'next'}],terminal:'end'});
   const response=await fetch(`${server.origin}/__mock/test/chat/completions`,{method:'POST',body:'{"messages":[]}'});
   const reader=response.body.getReader(); assert.equal(new TextDecoder().decode((await reader.read()).value),'first\n');
   await server.waitFor(x=>x.type==='waiting'); assert.equal(server.events.filter(x=>x.type==='write').length,1);
   await server.release('test','next'); let remaining=''; for(;;){const r=await reader.read(); if(r.done)break; remaining+=new TextDecoder().decode(r.value);} assert.equal(remaining,'second\n');
   server.enqueue('cancel',{status:200,headers:{'Content-Type':'text/event-stream'},steps:[{body:'partial\n'}],terminal:'await-abort'});
   const controller=new AbortController(); const open=await fetch(`${server.origin}/__mock/cancel/chat/completions`,{method:'POST',body:'{}',signal:controller.signal});
   await open.body.getReader().read(); controller.abort();
   await server.waitFor(x=>x.type==='abort'&&x.channel==='cancel');
 } finally {await server.close();}
});
