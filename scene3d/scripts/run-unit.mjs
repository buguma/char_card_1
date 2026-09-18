import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { workspace } from './test-support.mjs';
async function discover(directory) {
 const entries=await readdir(directory,{withFileTypes:true});
 return (await Promise.all(entries.map(entry=>entry.isDirectory()?discover(path.join(directory,entry.name)):/(?:\.unit|-unit)\.mjs$/.test(entry.name)?[path.join(directory,entry.name)]:[]))).flat().sort();
}
const files=await discover(path.join(workspace,'tests/scene3d'));
if (!files.length) throw Error('No explicit .unit.mjs / -unit.mjs tests found; refusing an empty green run');
console.log(`node:test: ${files.length} discovered files\n${files.join('\n')}`);
const child=spawn(process.execPath,['--test',...files],{stdio:'inherit',cwd:workspace});
child.on('error',error=>{console.error(error);process.exitCode=2;});
child.on('exit',code=>{process.exitCode=code??2;});
