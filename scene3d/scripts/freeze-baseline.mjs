import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const pro = path.resolve(process.argv.find(a => a.startsWith('--proRoot='))?.slice(10) || path.join(root, '..', 'pro'));
const dest = path.join(root, '.scene3d-work', 'baseline-original');
const reportRoot = path.join(root, '开发文档', '3D整合');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
const record = { schemaVersion: 1, capturedAt: new Date().toISOString(), node: process.version, game: {}, pro: {} };
const exclusions = new Set(['node_modules', '.git', '.gradle', '.idea', 'build', 'www', 'scene3d', 'tests', '.scene3d-work', '开发文档']);
async function walk(base, relative = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(base, relative), { withFileTypes: true })) {
    const rel = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refuse symlink in baseline: ${rel}`);
    if (entry.isDirectory()) {
      if (!exclusions.has(entry.name) && rel !== 'android/app/src/main/assets/public') result.push(...await walk(base, rel));
    } else if (!/\.(?:apk|jks|keystore|p12|pem)$/i.test(entry.name) && !entry.name.startsWith('.env')) result.push(rel);
  }
  return result;
}
async function copyAndHash(sourceBase, targetBase, relative, output = relative) {
  const bytes = await fs.readFile(path.join(sourceBase, relative));
  const target = path.join(targetBase, output);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes, { flag: 'wx' });
  const copied = await fs.readFile(target);
  const digest = sha(bytes);
  if (sha(copied) !== digest) throw new Error(`Copy verification failed: ${relative}`);
  return { bytes: bytes.length, sha256: digest };
}
await fs.mkdir(path.dirname(dest), { recursive: true });
// An existing capture is never overwritten, even after an interrupted attempt.
await fs.mkdir(dest);
await fs.mkdir(reportRoot, { recursive: true });
try {
  record.game.commit = git(root, ['rev-parse', 'HEAD']);
  record.pro.commit = git(pro, ['rev-parse', 'HEAD']);
  record.game.statusBefore = git(root, ['status', '--short', '--untracked-files=no']);
  record.pro.statusBefore = git(pro, ['status', '--short', '--untracked-files=no']);
  record.game.files = {};
  const roots = await fs.readdir(root, { withFileTypes: true });
  const gameFiles = roots.filter(e => e.isFile() && /\.(?:html|css|js|ps1)$/.test(e.name)).map(e => e.name);
  for (const dir of ['module', 'ui', 'assets', 'img', 'bgm', 'music', 'worker', 'tools', 'apk']) {
    if (await fs.stat(path.join(root, dir)).catch(() => null)) {
      const inner = await walk(path.join(root, dir));
      gameFiles.push(...inner.filter(p => !(dir === 'assets' && p.startsWith('sect3d/'))).map(p => `${dir}/${p}`));
    }
  }
  for (const rel of gameFiles.sort()) record.game.files[rel] = await copyAndHash(root, path.join(dest, 'game'), rel);
  console.log(`Game baseline: ${gameFiles.length} files copied and rehashed`);
  const { INTERIOR_SCENES } = await import(new URL(`file:///${pro.replaceAll('\\', '/')}/interior-scenes.js`));
  const modelFiles = ['sect_diorama.glb', ...Object.values(INTERIOR_SCENES).map(s => s.file)];
  const npcManifest = JSON.parse(await fs.readFile(path.join(pro, 'npc/generated/manifest.json'), 'utf8'));
  const npcFiles = ['npc/generated/manifest.json', ...npcManifest.npcs.flatMap(n => n.sheets.map(s => s.file))];
  const runtimeFiles = [...new Set([...modelFiles, ...npcFiles])];
  const proRootFiles = (await fs.readdir(pro, { withFileTypes: true })).filter(e => e.isFile() && /\.(?:js|css|json|html|md)$/.test(e.name)).map(e => e.name);
  const proFiles = [...new Set([...proRootFiles, ...runtimeFiles, 'tools/verify-package.mjs'])].sort();
  record.pro.files = {};
  const assets = { schemaVersion: 1, capturedAt: record.capturedAt, sourceRoot: path.join(dest, 'pro'), files: {} };
  for (const rel of proFiles) {
    const meta = await copyAndHash(pro, path.join(dest, 'pro'), rel);
    record.pro.files[rel] = meta;
    if (runtimeFiles.includes(rel)) assets.files[rel] = { ...meta, publish: true, required: rel === 'sect_diorama.glb', kind: rel.endsWith('.glb') ? 'model' : 'npc', businessReachable: !rel.includes('guest_quarters') };
  }
  for (const file of ['draco_wasm_wrapper.js', 'draco_decoder.wasm']) {
    const rel = `draco/${file}`;
    const meta = await copyAndHash(pro, path.join(dest, 'pro'), `node_modules/three/examples/jsm/libs/draco/gltf/${file}`, rel);
    record.pro.files[rel] = meta;
    assets.files[rel] = { ...meta, publish: true, kind: 'decoder', realm: 'worker' };
  }
  // Record, but never copy, the old distributed APK; no signing secrets are read.
  record.existingApks = [];
  for (const e of roots.filter(e => e.isFile() && e.name.endsWith('.apk'))) {
    const bytes = await fs.readFile(path.join(root, e.name));
    record.existingApks.push({ path: e.name, bytes: bytes.length, sha256: sha(bytes) });
  }
  record.snapshotRoot = dest;
  record.complete = true;
  await fs.writeFile(path.join(dest, 'baseline.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(path.join(reportRoot, 'P0-源码基线.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(path.join(reportRoot, 'P0-资产清单.json'), JSON.stringify(assets, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ snapshotRoot: dest, gameFiles: gameFiles.length, proFiles: Object.keys(record.pro.files).length, runtimeAssets: Object.keys(assets.files).length, verified: true }, null, 2));
} catch (error) {
  await fs.writeFile(path.join(dest, 'INCOMPLETE.json'), JSON.stringify({ error: error.message, capturedAt: record.capturedAt }, null, 2));
  throw error;
}
