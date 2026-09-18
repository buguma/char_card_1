import test from 'node:test';
import assert from 'node:assert/strict';
import { plannedCases as p1,isLatestApplied,implementations as p1Implementations } from './p1.browser.mjs';
import { plannedCases as p2,compareBusinessCheckpoints,implementations as p2Implementations } from './p2.browser.mjs';
import { registry,statusAfterAutomation } from './registry.mjs';
import { implementations } from './p0.browser.mjs';

test('P1/P2 executable map covers automated IDs but preserves real-device gate',()=>{
 for(const phase of ['P1','P2']) {
  const cases=phase==='P1'?p1:p2;
  assert.deepEqual(cases.map(x=>x.testId),registry.filter(x=>x.firstPhase===phase).map(x=>x.testId));
  for(const entry of cases) {
   const fn=({...p1Implementations,...p2Implementations})[entry.testId];
   assert.equal(typeof fn,'function');
   assert.equal(implementations[entry.testId],undefined); // no phase masquerades as a P0 fixture test
  }
 }
 assert.equal(registry.find(x=>x.testId==='P1-T05').manual,true);
 assert.equal(statusAfterAutomation(registry.find(x=>x.testId==='P1-T05')),'NOT RUN');
 assert.equal(statusAfterAutomation(registry.find(x=>x.testId==='P3-T05')),'NOT RUN');
 assert.equal(statusAfterAutomation(registry.find(x=>x.testId==='P2-T01')),'PASS');
});
test('renderer completion requires exact bridge epoch/revision and actual ready scene',()=>{
 const state={started:true,epoch:2,revision:5,readyScene:'library',snapshot:{sessionEpoch:2,revision:5,sceneId:'library'},renderer:{ready:true,activeSceneId:'library',appliedVersion:'2:5'}};
 assert.equal(isLatestApplied(state,'library'),true);
 for(const patch of [{revision:6},{epoch:3},{readyScene:'main'},{renderer:{...state.renderer,appliedVersion:'2:4'}},{renderer:{...state.renderer,ready:false}},{renderer:null}])assert.equal(isLatestApplied({...state,...patch},'library'),false);
});
test('future 2D/3D comparator retains business location/NPC and exact RNG',()=>{
 const baseline={GameMode:0,userLocation:'cangjingge',gameData:{npcLocations:{F:'cangjingge'}},rng:{count:3,next:0.5}};
 assert.deepEqual(compareBusinessCheckpoints(baseline,{...baseline,renderer:{frames:999}}),[]);
 assert.deepEqual(compareBusinessCheckpoints(baseline,{...baseline,userLocation:'tianshanpai'}).map(x=>x.path),['userLocation']);
 assert.deepEqual(compareBusinessCheckpoints(baseline,{...baseline,rng:{count:4,next:0.5}}).map(x=>x.path),['rng.count']);
});
