// Read-only Pro capture into a new immutable synchronization baseline.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fileInfo,atomicJson,copyFiles,verifyFiles,walkFiles} from './artifact-utils.mjs';
const [proArg,destArg,gameArg]=process.argv.slice(2);
if(![proArg,destArg,gameArg].every(p=>p&&path.isAbsolute(p)))throw Error('Usage: node snapshot-pro-update.mjs <absolute pro> <new absolute destination> <absolute game>');
const pro=path.resolve(proArg),dest=path.resolve(destArg),game=path.resolve(gameArg);
if(dest===pro||dest.startsWith(pro+path.sep))throw Error('Destination must not be inside Pro');
await fs.mkdir(dest); // No reuse/overwrite even after a partial failed capture.
const sourceRoot=path.join(dest,'pro');
const {INTERIOR_SCENES}=await import(pathToFileURL(path.join(pro,'interior-scenes.js')));
const npc=JSON.parse(await fs.readFile(path.join(pro,'npc/generated/manifest.json'),'utf8'));
const runtimeNames=[...new Set(['sect_diorama.glb',...Object.values(INTERIOR_SCENES).map(s=>s.file),'npc/generated/manifest.json',...npc.npcs.flatMap(n=>n.sheets.map(s=>s.file))])];
const referenceNames=(await fs.readdir(pro,{withFileTypes:true})).filter(e=>e.isFile()&&/\.(js|css|json)$/.test(e.name)).map(e=>e.name);
referenceNames.push('docs/viewer/CURRENT_STATE.md','npc/NPC身高.csv');
const files={};for(const name of [...new Set([...runtimeNames,...referenceNames])].sort())files[name]=await fileInfo(path.join(pro,name));
await copyFiles(pro,sourceRoot,files);await verifyFiles(sourceRoot,files);
for(const [name,info]of Object.entries(files))if(JSON.stringify(await fileInfo(path.join(pro,name)))!==JSON.stringify(info))throw Error('Pro input changed: '+name);
const runtime={};for(const name of runtimeNames)runtime[name]={...files[name],publish:true,required:name==='sect_diorama.glb',kind:name.endsWith('.glb')?'model':'npc',businessReachable:!name.includes('guest_quarters')};
for(const name of ['draco_wasm_wrapper.js','draco_decoder.wasm']){
 const from='node_modules/three/examples/jsm/libs/draco/gltf/'+name,rel='draco/'+name;
 const info=await fileInfo(path.join(pro,from));await fs.mkdir(path.join(sourceRoot,'draco'),{recursive:true});await fs.copyFile(path.join(pro,from),path.join(sourceRoot,rel));
 runtime[rel]={...info,publish:true,kind:'decoder',realm:'worker'};
}
await verifyFiles(sourceRoot,{...files,...runtime});
const gameFiles={};
for(const directory of ['module','ui','scene3d/src'])for(const name of await walkFiles(path.join(game,directory)))if(/\.(js|mjs|css)$/.test(name))gameFiles[directory+'/'+name]=await fileInfo(path.join(game,directory,name));
for(const name of ['index.html','assets/sect3d/current.json'])gameFiles[name]=await fileInfo(path.join(game,name));
await copyFiles(game,path.join(dest,'game-before'),gameFiles);await verifyFiles(path.join(dest,'game-before'),gameFiles);
await atomicJson(path.join(dest,'source-manifest.json'),{schemaVersion:1,sourceRoot,files:runtime},{exclusive:true});
await atomicJson(path.join(dest,'capture.json'),{schemaVersion:1,capturedAt:new Date().toISOString(),proRoot:pro,sourceRoot,proFiles:files,gameFiles,runtimeFiles:runtimeNames.length,npcs:npc.npcs.length,notes:['Current manifest and atlas assets frozen; stale Pro verification reports are not imported as proof.','Read-only capture; imported source CSV may be GBK and must not be treated as unconditional UTF8.']},{exclusive:true});
console.log(JSON.stringify({dest,sourceRoot,runtimeFiles:Object.keys(runtime).length,npcs:npc.npcs.length}));
