// Pure Node infrastructure tests. Fake GLB and dummy ESM are intentional: NOT real renderer acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { safeRelative, uniquePaths, sha256, fileInfo, verifyFiles, verifyRelease, atomicJson, readJson, noSymlinks } from '../../scene3d/scripts/artifact-utils.mjs';
import { createRunRecord, loadRunRecord, cliArguments, withRun } from '../../scene3d/scripts/run-record.mjs';
import { importAssets } from '../../scene3d/scripts/import-assets.mjs';
import { buildRelease, assertMountExport } from '../../scene3d/scripts/build.mjs';
import { publishAssets } from '../../scene3d/scripts/publish-assets.mjs';
import { verifyWeb } from '../../scene3d/scripts/verify-web.mjs';
import { transformRenderRng, auditRenderRng } from '../../scene3d/scripts/isolate-render-rng.mjs';
import { renderRandom, setRenderRandomSeed, createLayoutRandom, getRenderRandomStats } from '../../scene3d/src/render-random.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ownScripts = ['artifact-utils', 'run-record', 'import-assets', 'build', 'publish-assets', 'verify-web', 'isolate-render-rng'];
async function fixture(t, { runtimeOnly = false } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'scene3d-build-unit-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true })); // Only this test's newly allocated root.
  const projectRoot = path.join(temporary, 'game'), sourceRoot = path.join(temporary, 'source');
  await fs.mkdir(path.join(projectRoot, 'scene3d', 'src'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'scene3d', 'scripts'));
  await fs.mkdir(path.join(sourceRoot, '模型'), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, '参考'));
  await fs.writeFile(path.join(sourceRoot, '模型', '门派.glb'), 'DUMMY GLB fixture, not a renderable model');
  await fs.writeFile(path.join(sourceRoot, '参考', 'draft.blend'), 'not published');
  const files = {
    '模型/门派.glb': { ...await fileInfo(path.join(sourceRoot, '模型', '门派.glb')), publish: true, required: true, kind: 'model', businessReachable: true },
    '参考/draft.blend': { ...await fileInfo(path.join(sourceRoot, '参考', 'draft.blend')), publish: false }
  };
  if (runtimeOnly) {
    for (const name of Object.keys(files)) delete files[name];
    for (const name of ['sect_diorama.glb', 'npc/generated/manifest.json', 'draco/draco_wasm_wrapper.js', 'draco/draco_decoder.wasm']) {
      await fs.mkdir(path.dirname(path.join(sourceRoot, name)), { recursive: true });
      await fs.writeFile(path.join(sourceRoot, name), 'dummy runtime-only fixture');
      files[name] = await fileInfo(path.join(sourceRoot, name));
    }
  }
  const sourceManifest = path.join(temporary, 'source-manifest.json');
  await atomicJson(sourceManifest, { schemaVersion: 1, sourceRoot, files });
  await atomicJson(path.join(projectRoot, 'scene3d', 'package.json'), { name: 'dummy-scene3d-fixture', type: 'module', private: true });
  await atomicJson(path.join(projectRoot, 'scene3d', 'package-lock.json'), { name: 'dummy-scene3d-fixture', lockfileVersion: 3, packages: {} });
  await fs.copyFile(path.join(repository, 'scene3d', 'vite.config.js'), path.join(projectRoot, 'scene3d', 'vite.config.js'));
  for (const script of ownScripts) await fs.copyFile(path.join(repository, 'scene3d', 'scripts', `${script}.mjs`), path.join(projectRoot, 'scene3d', 'scripts', `${script}.mjs`));
  await fs.copyFile(path.join(repository, 'scene3d', 'src', 'render-random.js'), path.join(projectRoot, 'scene3d', 'src', 'render-random.js'));
  await fs.writeFile(path.join(projectRoot, 'scene3d', 'src', 'index.js'), `export function mount() { return { fixtureOnly: true, value: Math.random() }; }\n`);
  await fs.writeFile(path.join(projectRoot, 'scene3d', 'src', 'scene3d.css'), '.scene3d-fixture { color: red; }\n');
  const runId = 'unit-run', buildId = 'unit-build';
  const runDir = path.join(projectRoot, '.scene3d-work', runId), recordPath = path.join(runDir, 'run.json');
  const input = { runId, buildId, projectRoot, sourceRoot, sourceManifest, resourceRoot: path.join(runDir, 'resources'), releaseDir: path.join(runDir, 'release'), publishRoot: path.join(projectRoot, 'assets', 'sect3d') };
  await createRunRecord(recordPath, input);
  const args = [`--runRecord=${recordPath}`];
  return { temporary, input, runDir, recordPath, args, run: (step, fn) => withRun(step, fn, args), record: () => loadRunRecord(recordPath) };
}

test('relative paths permit Chinese and reject traversal, URLs, encodings, collisions', () => {
  assert.equal(safeRelative('模型/门派.glb'), '模型/门派.glb');
  for (const name of ['', '/etc/a', '../a', './a', 'a//b', 'a\\b', 'https://x/a', '%2e%2e/a', 'a/%252e', 'a?x', 'a#x', 'CON.glb', 'a./b', 'a /b']) assert.throws(() => safeRelative(name));
  assert.throws(() => uniquePaths(['NPC/a.png', 'npc/b.png']), /collision/);
  assert.throws(() => uniquePaths(['模型/A.glb', '模型/a.glb']), /collision/);
  assert.throws(() => uniquePaths(['a', 'a/b']), /collision/);
});

test('RNG AST transforms direct globals and honors lexical/hoisted shadows', () => {
  const code = `const a = Math.random(); const b = globalThis.Math['random']; function shadow(Math) { return Math.random(); } function hoisted() { return Math.random(); var Math; } export { a, b };`;
  const output = transformRenderRng(code, 'fixture.js', './render-random.js');
  assert.equal(output.replacements, 2);
  assert.match(output.code, /return Math.random\(\);/);
  assert.doesNotThrow(() => auditRenderRng(output.code));
  assert.equal(transformRenderRng(`import Math from 'local'; export const a = Math.random();`, 'local.js', './rng.js'), null);
  assert.equal(transformRenderRng(`const { Math } = source; Math.random();`, 'local.js', './rng.js'), null);
  assert.equal(transformRenderRng(`const text = 'Math.random()'; // Math.random()\n`, 'text.js', './rng.js'), null);
});

test('RNG audit fails closed on aliases, dynamic access, writes, dynamic execution', () => {
  for (const code of [
    'const m = Math; m.random();', 'const {random} = Math;', 'Math[key]();', `Math['ran' + 'dom']();`,
    'const g = window; g.Math.random();', 'window[key].random();', 'window.window.Math.random();',
    'Math.random = () => 0;', 'delete Math.random;', 'eval("Math.random()")', 'new Function("return Math.random()")',
    'globalThis["eval"]("Math.random()")'
  ]) assert.throws(() => transformRenderRng(code, 'negative.js', './rng.js'), /RNG isolation rejected/);
  assert.throws(() => auditRenderRng('Math.random();'), /Unisolated/);
  assert.throws(() => auditRenderRng('globalThis.Math.random();'), /Unisolated/);
});

test('locked Three browser dependencies are AST-isolated without modifying node_modules', async () => {
  for (const name of ['build/three.module.js', 'build/three.core.js', 'examples/jsm/loaders/GLTFLoader.js', 'examples/jsm/loaders/DRACOLoader.js', 'examples/jsm/controls/OrbitControls.js', 'examples/jsm/postprocessing/EffectComposer.js']) {
    const filename = path.join(repository, 'scene3d/node_modules/three', ...name.split('/'));
    const original = await fs.readFile(filename, 'utf8');
    const output = transformRenderRng(original, filename, './render-random.js');
    auditRenderRng(output?.code ?? original, name);
    assert.equal(await fs.readFile(filename, 'utf8'), original);
    if (name.endsWith('three.core.js')) assert.ok(output.replacements >= 4, 'Three UUID global calls must be transformed');
    if (name.endsWith('three.module.js')) assert.match(output.code, /requestAnimationFrame: callback => self.requestAnimationFrame/);
  }
});

test('transformed real Three object UUID generation preserves host business stream (Node, no renderer)', async () => {
  const filename = path.join(repository, 'scene3d/node_modules/three/build/three.core.js');
  const helper = pathToFileURL(path.join(repository, 'scene3d/src/render-random.js')).href;
  const output = transformRenderRng(await fs.readFile(filename, 'utf8'), filename, helper);
  const three = await import(`data:text/javascript;base64,${Buffer.from(output.code).toString('base64')}`);
  const freshRandom = await import(`${helper}?crypto-seed-unit`);
  const original = Math.random; let calls = 0, state = 123;
  const business = () => { calls++; state = Math.imul(state, 1664525) + 1013904223 | 0; return (state >>> 0) / 4294967296; };
  const expected = business(); calls = 0; state = 123;
  Math.random = business;
  try {
    freshRandom.renderRandom(); // Fresh helper must seed from crypto, not host random.
    const objects = [new three.Object3D(), new three.Scene(), new three.BufferGeometry(), new three.MeshBasicMaterial()];
    assert.equal(new Set(objects.map(object => object.uuid)).size, objects.length);
    for (const object of objects) object.dispose?.();
    assert.equal(calls, 0); assert.equal(business(), expected); assert.equal(calls, 1);
  } finally { Math.random = original; }
});

test('private render/layout streams never consume host random', () => {
  const original = Math.random; let hostCalls = 0;
  Math.random = () => { hostCalls++; throw new Error('host random consumed'); };
  try {
    setRenderRandomSeed(123); const first = Array.from({ length: 10 }, renderRandom);
    setRenderRandomSeed(123); assert.deepEqual(Array.from({ length: 10 }, renderRandom), first);
    const a = createLayoutRandom('地点|季节|npc'), b = createLayoutRandom('地点|季节|npc');
    assert.equal(a(), b()); renderRandom(); assert.equal(a(), b());
    assert.equal(getRenderRandomStats().calls, 11); assert.equal(hostCalls, 0);
  } finally { Math.random = original; }
});

test('run paths are absolute/frozen; source and lock hashes cannot silently change', async t => {
  const f = await fixture(t);
  assert.throws(() => cliArguments(['--buildId=wrong', ...f.args]), /First argument/);
  assert.throws(() => cliArguments(['--runRecord=relative.json']), /absolute/);
  await assert.rejects(() => loadRunRecord(f.recordPath, { buildId: 'conflict' }), /conflicting/);
  await assert.rejects(() => createRunRecord(f.recordPath, f.input), /EEXIST/);
  const record = await f.record(); record.releaseDir = path.join(f.temporary, 'arbitrary');
  await atomicJson(f.recordPath, record);
  await assert.rejects(() => f.record(), /exclusively/);
});

test('whitelist import preserves Chinese source paths and excludes inventory-only files', async t => {
  const f = await fixture(t);
  await f.run('import-assets', importAssets);
  const record = await f.record();
  await verifyFiles(record.resourceRoot, { '模型/门派.glb': await fileInfo(path.join(record.sourceRoot, '模型', '门派.glb')) });
  await f.run('import-assets', importAssets); // Exact idempotence, not destructive recopy.
  await fs.writeFile(path.join(record.resourceRoot, 'manual.txt'), 'must not be deleted');
  await assert.rejects(() => f.run('import-assets', importAssets), /File set mismatch/);
  assert.equal((await f.record()).steps['import-assets'].status, 'failed');
  assert.equal(await fs.readFile(path.join(record.resourceRoot, 'manual.txt'), 'utf8'), 'must not be deleted');
});

test('P0 runtime-only bytes/hash whitelist normalizes main GLB and known Draco worker assets', async t => {
  const f = await fixture(t, { runtimeOnly: true });
  const imported = await f.run('import-assets', importAssets);
  const inventory = await readJson(imported.resourceManifest);
  assert.equal(inventory.files['sect_diorama.glb'].required, true);
  assert.equal(inventory.files['draco/draco_wasm_wrapper.js'].realm, 'worker');
  assert.equal(inventory.files['draco/draco_decoder.wasm'].kind, 'decoder');
  assert.equal(inventory.files['npc/generated/manifest.json'].publish, true);
  assert.equal(Object.keys(inventory.files).length, 4);
  await verifyFiles(f.input.resourceRoot, inventory.files);
});

test('import rejects preexisting resources without generated provenance', async t => {
  const f = await fixture(t); await fs.mkdir(f.input.resourceRoot);
  await assert.rejects(() => f.run('import-assets', importAssets), /no generated inventory/);
});

test('source byte tampering fails import and creates no release', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.input.sourceRoot, '模型', '门派.glb'), 'tampered');
  await assert.rejects(() => f.run('import-assets', importAssets), /baseline mismatch/);
  await assert.rejects(() => fs.stat(f.input.releaseDir), /ENOENT/);
});

test('symlink sources and artifact directories are rejected', async t => {
  const f = await fixture(t), link = path.join(f.temporary, 'link');
  try { await fs.symlink(f.input.sourceRoot, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('OS account cannot create symlinks'); return; } throw error; }
  await assert.rejects(() => noSymlinks(path.join(link, '模型', '门派.glb')), /Symlink/);
});

test('dummy ESM build, exact manifests, atomic publish, corruption/missing/old-file negatives', async t => {
  const f = await fixture(t);
  await f.run('import-assets', importAssets);
  await f.run('build', buildRelease);
  let record = await f.record();
  const { manifest } = await verifyRelease(record.releaseDir, record.buildId, record.steps.build.result.manifestSha256);
  assert.equal(manifest.entry, 'entry.mjs'); assert.deepEqual(manifest.css, ['scene3d.css']);
  assert.deepEqual(manifest.files['scene3d.css'], await fileInfo(path.join(record.projectRoot, 'scene3d', 'src', 'scene3d.css')));
  assert.ok(manifest.files['模型/门派.glb']); assert.ok(!manifest.files['参考/draft.blend']);
  assert.equal(manifest.rngAudit.unisolatedHostReferences, 0);
  assertMountExport(await fs.readFile(path.join(record.releaseDir, 'entry.mjs'), 'utf8'));
  await f.run('verify:web', verifyWeb); // Release-only before publication.
  await f.run('publish:assets', publishAssets);
  await f.run('verify:web', verifyWeb);
  await f.run('publish:assets', publishAssets); // Exact immutable idempotence.
  record = await f.record();
  const pointerPath = path.join(record.publishRoot, 'current.json');
  const originalPointer = await fs.readFile(pointerPath);
  const versionRoot = path.join(record.publishRoot, record.buildId);
  const model = path.join(versionRoot, '模型', '门派.glb');
  const originalModel = await fs.readFile(model);
  await fs.unlink(model);
  await assert.rejects(() => f.run('verify:web', verifyWeb), /File set mismatch/);
  await fs.writeFile(model, originalModel);
  await fs.writeFile(model, Buffer.alloc(originalModel.length, 65));
  await assert.rejects(() => f.run('verify:web', verifyWeb), /Byte\/hash mismatch/);
  await assert.rejects(() => f.run('publish:assets', publishAssets), /Byte\/hash mismatch/);
  assert.deepEqual(await fs.readFile(pointerPath), originalPointer, 'failed publish must not switch pointer');
  await fs.writeFile(model, originalModel);
  await f.run('publish:assets', publishAssets);
  await fs.writeFile(path.join(versionRoot, 'old-bundle.js'), 'stale');
  await assert.rejects(() => f.run('verify:web', verifyWeb), /File set mismatch/);
  await fs.unlink(path.join(versionRoot, 'old-bundle.js'));
  await f.run('verify:web', verifyWeb);
  const manifestPath = path.join(versionRoot, 'manifest.json');
  await fs.appendFile(manifestPath, '\n');
  await assert.rejects(() => f.run('verify:web', verifyWeb), /Manifest hash mismatch/);
  const child = spawnSync(process.execPath, [path.join(repository, 'scene3d/scripts/verify-web.mjs'), ...f.args], { stdio: 'inherit' });
  assert.ifError(child.error); assert.notEqual(child.status, 0, 'CLI verification failure exits nonzero');
});

test('standalone CSS is required while source entry remains native-Node importable', async t => {
  const f = await fixture(t);
  const sourceEntry = await import(pathToFileURL(path.join(f.input.projectRoot, 'scene3d/src/index.js')).href);
  assert.equal(typeof sourceEntry.mount, 'function');
  await f.run('import-assets', importAssets);
  await fs.unlink(path.join(f.input.projectRoot, 'scene3d/src/scene3d.css'));
  await assert.rejects(() => f.run('build', buildRelease), /standalone stylesheet/);
  await assert.rejects(() => fs.stat(f.input.releaseDir), /ENOENT/);
});

test('build never fabricates output when prerequisites or mount export are absent', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.run('build', buildRelease), /requires succeeded import-assets/);
  await assert.rejects(() => fs.stat(f.input.releaseDir), /ENOENT/);
  assert.throws(() => assertMountExport('export const unrelated = 1;'), /export mount/);
});
