import path from 'node:path';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { artifact,exists,fixturesRoot,hashFile,json,launchBrowser,sha256,workspace } from './test-support.mjs';
import { startTestServer } from './test-server.mjs';
import { registry,selectTests,statusAfterAutomation } from '../../tests/scene3d/registry.mjs';
import { implementations as p0Implementations } from '../../tests/scene3d/p0.browser.mjs';
import { implementations as p1Implementations } from '../../tests/scene3d/p1.browser.mjs';
import { implementations as p2Implementations } from '../../tests/scene3d/p2.browser.mjs';
import { implementations as p3p4Implementations } from '../../tests/scene3d/p3p4.browser.mjs';
const implementations={...p0Implementations,...p1Implementations,...p2Implementations,...p3p4Implementations};

function options(args) {
 const result={phase:'P0'};
 for(let index=0;index<args.length;index++) {
  const arg=args[index];
  if(arg==='--list') {result.list=true;continue;}
  const match=/^--(phase|gameRoot|reportDir|buildId|tests)(?:=(.*))?$/.exec(arg);
  if(!match) throw Error(`Unknown argument ${arg}`);
  result[match[1]]=match[2]??args[++index];
  if(!result[match[1]]) throw Error(`Missing value for ${arg}`);
 }
 return result;
}
async function sourceManifest(root) {
 const files=['index.html'];
 async function scan(relative) {
  const entries=await readdir(path.join(root,relative),{withFileTypes:true});
  for(const entry of entries) {const filename=path.posix.join(relative,entry.name);if(entry.isDirectory())await scan(filename);else if(/\.(?:js|mjs|css)$/.test(entry.name))files.push(filename);}
 }
 await scan('module');await scan('ui');
 const entries=[];for(const file of files.sort())entries.push({file,sha256:sha256(await readFile(path.join(root,file)))});
 return {sha256:sha256(JSON.stringify(entries)),entries};
}
async function main() {
 const opt=options(process.argv.slice(2)),selected=selectTests(opt.phase);
 if(opt.list){console.log(JSON.stringify({phase:opt.phase,tests:selected.map(test=>({...test,implemented:!!implementations[test.testId],status:'NOT RUN'}))},null,2));return;}
 if(opt.phase!=='P0'&&!opt.buildId)throw Error('--buildId is required for integrated renderer phases');
 const diagnosticTests=opt.tests?opt.tests.split(','):null;
 if(diagnosticTests)for(const id of diagnosticTests)if(!selected.some(test=>test.testId===id))throw Error(`Test ${id} is not selected by phase ${opt.phase}`);
 if(!opt.reportDir || !path.isAbsolute(opt.reportDir))throw Error('--reportDir must be an explicit absolute NEW run directory');
 if(opt.gameRoot&&!path.isAbsolute(opt.gameRoot))throw Error('--gameRoot must be absolute');
 const baseline=path.join(workspace,'.scene3d-work/baseline-original/game');
 const gameRoot=opt.gameRoot||(await exists(path.join(baseline,'index.html'))?baseline:workspace);
 if(!(await exists(path.join(gameRoot,'index.html'))))throw Error(`No real game index.html under ${gameRoot}`);
 await mkdir(path.dirname(opt.reportDir),{recursive:true});
 await mkdir(opt.reportDir); // EEXIST is deliberate: never overwrite evidence
 const runId=randomUUID(),startedAt=new Date().toISOString(),results=[];
 const environment={runId,startedAt,argv:process.argv.slice(2),node:process.version,os:process.platform,architecture:process.arch,pid:process.pid,gameRoot,phase:opt.phase,buildId:opt.buildId||null,diagnosticTests,reportDir:opt.reportDir,headless:true,profile:'Puppeteer-owned temporary profile; new BrowserContext per case',networkPolicy:'Only exact run loopback origin, data/blob; exact approved GET/image URLs fulfilled by local fixtures; all other external requests denied and fail',knownAssetSubstitutions:await json(path.join(fixturesRoot,'network/known-assets.json')),sourceManifest:await sourceManifest(gameRoot)};
 if(opt.buildId)environment.publicationBefore=await hashFile(path.join(gameRoot,'assets/sect3d/current.json'));
 await artifact(opt.reportDir,'environment.json',environment);
 const fixtureManifest=await json(path.join(fixturesRoot,'manifest.json'));
 let browser,server,infrastructureError;
 try {
  server=await startTestServer({gameRoot}); environment.server={origin:server.origin,pid:server.pid}; console.log(`TEST_SERVER ${server.origin} root=${server.root} pid=${server.pid}`);
  try {browser=await launchBrowser();environment.browser={version:await browser.version(),pid:browser.process()?.pid};}
  catch(error){infrastructureError=error.stack;}
  await artifact(opt.reportDir,'environment.json',environment); // persist owned PIDs before any test can fail
  for(const entry of selected) {
   const result={testId:entry.testId,phase:entry.firstPhase,name:entry.name,required:entry.required,manual:entry.manual,expected:entry.completion,inputFixtureHashes:fixtureManifest.fixtures.map(f=>({id:f.id,sha256:f.payloadSha256})),startedAt:new Date().toISOString(),artifacts:[]};
   if(diagnosticTests&&!diagnosticTests.includes(entry.testId)){result.status='NOT RUN';result.actual='Not selected in this explicitly scoped diagnostic run';}
   else if(!implementations[entry.testId]) {result.status='NOT RUN';result.actual=entry.manual?'Requires same-version manual/external evidence and named review; runner does not auto-approve':'Required test not implemented';}
   else if(!browser && entry.requiresBrowser) {result.status='BLOCKED';result.actual=infrastructureError;}
   else {
    const directory=path.join(opt.reportDir,entry.testId);await mkdir(directory);result.artifacts.push(directory);
    try {result.actual=await implementations[entry.testId]({browser,server,directory,gameRoot,runId,buildId:opt.buildId});result.automatedStatus='PASS';result.status=statusAfterAutomation(entry);if(entry.manual)result.manualEvidenceRequired='Desktop branch passed, but the fixed manual/device requirement is still NOT RUN';}
    catch(error){result.status='FAIL';result.actual=error.stack;}
   }
   result.endedAt=new Date().toISOString();results.push(result);console.log(`${result.testId}: ${result.status}`);
   await artifact(opt.reportDir,'results.json',{runId,phase:opt.phase,complete:false,results});
  }
 } finally {
  if(server){await artifact(opt.reportDir,'mock-transport.json',{events:server.events,requests:server.requests});await server.close();}
  if(browser)await browser.close();
  environment.endedAt=new Date().toISOString();environment.sourceAfter=await sourceManifest(gameRoot);environment.sourceUnchanged=environment.sourceAfter.sha256===environment.sourceManifest.sha256;
  if(opt.buildId){environment.publicationAfter=await hashFile(path.join(gameRoot,'assets/sect3d/current.json'));environment.publicationUnchanged=environment.publicationAfter.sha256===environment.publicationBefore.sha256;}
  await artifact(opt.reportDir,'environment.json',environment);
 }
 const failed=results.some(x=>x.required&&x.status!=='PASS') || !environment.sourceUnchanged || environment.publicationUnchanged===false;
 await artifact(opt.reportDir,'results.json',{runId,phase:opt.phase,complete:!failed,sourceUnchanged:environment.sourceUnchanged,visualResourceScope:environment.knownAssetSubstitutions.scope,knownAssetSubstitutions:environment.knownAssetSubstitutions.substitutions,results});
 await artifact(opt.reportDir,'defects.json',results.filter(x=>x.status!=='PASS').map(x=>({testId:x.testId,status:x.status,detail:x.actual})));
 const markdown=`# ${opt.phase} 验收记录\n\nRun: ${runId}\n\nRoot: ${gameRoot}\n\nSource SHA256: ${environment.sourceManifest.sha256}\n\nNode: ${environment.node}; Browser: ${environment.browser?.version||'NOT AVAILABLE'}\n\n命令：\`node scene3d/scripts/run-browser.mjs ${process.argv.slice(2).join(' ')}\`\n\n| ID | 状态 | 项目 |\n|---|---|---|\n${results.map(x=>`| ${x.testId} | ${x.status} | ${x.name} |`).join('\n')}\n\n源文件只读校验：${environment.sourceUnchanged?'PASS':'FAIL'}。\n\n结论：${failed?'未完成全部阶段门槛；退出码1。NOT RUN不是PASS。':'所选registry全部PASS。'}\n\n实际断言、夹具hash、状态/prompt差异、截图及日志见results.json和每ID目录。Android/设备/人工证据不会由桌面测试自动代签。\n\n素材替代限制：${environment.knownAssetSubstitutions.scope} 原Gal远程CSS图片用固定本地合成placeholder履行请求，未真实外发；这些截图不是原素材视觉一致性或生产离线验证证据。具体URL/fixture SHA256见environment.json与各case网络日志。\n`;
 await artifact(opt.reportDir,`${opt.phase}-验收记录.md`,markdown);
 process.exitCode=failed?1:0;
}
main().catch(error=>{console.error(error.stack);process.exitCode=2;});
