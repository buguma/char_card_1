import path from 'node:path';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { implementations } from './p3p4.browser.mjs';
import { launchBrowser, json, hashFile } from '../../scene3d/scripts/test-support.mjs';
import { startTestServer } from '../../scene3d/scripts/test-server.mjs';

const gameRoot = 'E:\\JJBurst\\git';
const args = process.argv.slice(2);
const option = name => { const token=args.find(value=>value.startsWith(`${name}=`)); const index=args.indexOf(name); return token ? token.slice(name.length+1) : index>=0 ? args[index+1] : undefined; };
const reportDir = option('--reportDir');
if (!reportDir || !path.isAbsolute(reportDir)) throw Error('--reportDir must be a new absolute directory');
const buildId = option('--buildId') || 'integration-006';
const relativeReport = path.relative(path.join(gameRoot,'.scene3d-work'),reportDir);
if(relativeReport.startsWith('..') || path.isAbsolute(relativeReport)) throw Error('Reports must remain within workspace .scene3d-work');
const cases = option('--cases')?.split(',') || Object.keys(implementations);
if (!cases.length || cases.some(id=>!implementations[id]) || new Set(cases).size!==cases.length) throw Error('Unknown or duplicate --cases; use comma-separated registry IDs');
const pointerPath=path.join(gameRoot,'assets/sect3d/current.json');
const pointer=await json(pointerPath);
if(pointer.buildId!==buildId) throw Error(`Requested ${buildId}, published ${pointer.buildId}; no browser launched`);
if(buildId==='integration-006') assert.equal(pointer.manifestSha256,'5efd5283f25bff5b763541d312012fed673f03a82088fe137cf48259abfd367d');
assert.equal((await hashFile(path.join(gameRoot,'assets/sect3d',pointer.manifest))).sha256,pointer.manifestSha256);
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
