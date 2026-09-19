import path from 'node:path';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { implementations } from './p3p4.browser.mjs';
import { launchBrowser, json, hashFile } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';
import { safeRelative, verifyRelease } from '../../scene3d/scripts/artifact-utils.mjs';

const gameRoot = 'E:\\JJBurst\\git';
const args = process.argv.slice(2);
const option = name => {
  const token=args.find(value=>value.startsWith(`${name}=`)), index=args.indexOf(name);
  if(token!==undefined)return token.slice(name.length+1);
  if(index<0)return undefined;
  if(args[index+1]===undefined || args[index+1].startsWith('--'))throw Error(`${name} requires a value`);
  return args[index+1];
};
const reportDir = option('--reportDir');
if (!reportDir || !path.isAbsolute(reportDir)) throw Error('--reportDir must be a new absolute directory');
const expectedBuildId = option('--buildId');
const relativeReport = path.relative(path.join(gameRoot,'.scene3d-work'),reportDir);
if(relativeReport.startsWith('..') || path.isAbsolute(relativeReport)) throw Error('Reports must remain within workspace .scene3d-work');
const cases = option('--cases')?.split(',') || Object.keys(implementations);
if (!cases.length || cases.some(id=>!implementations[id]) || new Set(cases).size!==cases.length) throw Error('Unknown or duplicate --cases; use comma-separated registry IDs');
const pointerPath=path.join(gameRoot,'assets/sect3d/current.json');
const pointer=await json(pointerPath);
assert.equal(pointer.schemaVersion,1,'Unsupported current pointer schema');
safeRelative(pointer.buildId);assert.ok(!pointer.buildId.includes('/'),'Invalid current build ID');
assert.deepEqual(pointer.bridgeProtocol,{min:1,max:1},'Unsupported current bridge protocol');
assert.equal(pointer.manifest,`${pointer.buildId}/manifest.json`,'Current manifest must belong to selected build');
assert.match(pointer.manifestSha256,/^[a-f0-9]{64}$/,'Current manifest hash required');
if(expectedBuildId!==undefined && pointer.buildId!==expectedBuildId) throw Error(`Requested ${expectedBuildId}, published ${pointer.buildId}; no browser launched`);
const buildId=pointer.buildId;
await verifyRelease(path.join(gameRoot,'assets/sect3d',buildId),buildId,pointer.manifestSha256);
await mkdir(path.dirname(reportDir),{recursive:true});
await mkdir(reportDir); // EEXIST is intentional: never overwrite prior evidence.
const save=(name,value)=>writeFile(path.join(reportDir,name),JSON.stringify(value,null,2));
async function tree(relative) {
  const entries=await readdir(path.join(gameRoot,relative),{withFileTypes:true});
  return (await Promise.all(entries.filter(entry=>!['node_modules','.git','dist'].includes(entry.name)).map(entry=>entry.isDirectory()?tree(`${relative}/${entry.name}`):`${relative}/${entry.name}`))).flat();
}
const watched=[...new Set(['index.html','start-screen-noST.html','assets/sect3d/current.json',...await tree('module'),...await tree('scene3d/src'),...await tree('scene3d/scripts'),...await tree('tests/scene3d'),...await tree(path.posix.join('assets/sect3d',path.posix.dirname(pointer.manifest)))])].sort();
const hashes=()=>Promise.all(watched.map(async file=>({file,...await hashFile(path.join(gameRoot,file))})));
const results=[]; let browser,server;
const run={buildId,gameRoot,reportDir,startedAt:new Date().toISOString(),before:await hashes(),results};
try {
  server=await startTestServer({gameRoot}); browser=await launchBrowser();
  run.browser=await browser.version(); run.origin=server.origin;
  for(const testId of cases) {
    const directory=path.join(reportDir,testId);await mkdir(directory);
    const row={testId,startedAt:new Date().toISOString()};console.log('START',testId);
    try {
      const current=await json(pointerPath);if(current.buildId!==buildId)throw Error(`VERSION_SWITCH: ${buildId} -> ${current.buildId}`);
      row.value=await implementations[testId]({browser,server,directory,gameRoot,runId:`${buildId}-cli-${Date.now()}`,buildId});
      if(row.value?.automatedStatus) assert.equal(row.value.automatedStatus,'PASS');
      row.status='PASS';row.automatedStatus='PASS';row.manual=row.value?.manual||[];
    } catch(error) {
      row.status=error.message?.includes('INCOMPLETE')?'INCOMPLETE':'FAIL';row.error=error.stack||String(error);
      await writeFile(path.join(directory,'failure.json'),JSON.stringify(row,null,2));console.error(testId,row.error);
    }
    row.endedAt=new Date().toISOString();results.push(row);await save('results.json',results);console.log('END',testId,row.status);
  }
} finally {
  try {await save('transport.json',{events:server?.events||[],requests:server?.requests||[]});}
  finally {
    try {if(browser)await browser.close();}
    finally {if(server)await server.close();run.endedAt=new Date().toISOString();run.after=await hashes();run.inputsUnchanged=JSON.stringify(run.before)===JSON.stringify(run.after);await save('run.json',run);}
  }
}
process.exitCode=results.some(row=>row.status!=='PASS')||!run.inputsUnchanged?1:0;
