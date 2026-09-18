import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'acorn';
import { build as viteBuild, version as viteVersion } from 'vite';
import { createScene3dConfig } from '../vite.config.js';
import { auditRenderRng } from './isolate-render-rng.mjs';
import { assert, exists, fileInfo, readJson, walkFiles, verifyFiles, verifyRelease, copyFiles, atomicJson, noSymlinks } from './artifact-utils.mjs';
import { withRun, requireStep, isMain, runCli } from './run-record.mjs';

async function sourceInputs(record) {
  const packageRoot = path.join(record.projectRoot, 'scene3d');
  const files = Object.create(null);
  for (const folder of ['src', 'scripts']) {
    for (const name of await walkFiles(path.join(packageRoot, folder))) files[`${folder}/${name}`] = await fileInfo(path.join(packageRoot, folder, ...name.split('/')));
  }
  for (const name of ['vite.config.js', 'package.json', 'package-lock.json']) files[name] = await fileInfo(path.join(packageRoot, name));
  return files;
}
export function assertMountExport(code) {
  const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  const hasMount = ast.body.some(node => node.type === 'ExportNamedDeclaration' && (
    node.declaration?.id?.name === 'mount' ||
    node.declaration?.declarations?.some(item => item.id.name === 'mount') ||
    node.specifiers.some(item => (item.exported.name ?? item.exported.value) === 'mount')
  ));
  assert(hasMount, 'ESM library entry must explicitly export mount');
}
export async function buildRelease(record, { runDir }) {
  const imported = requireStep(record, 'import-assets');
  assert(imported.resourceManifest === path.join(runDir, 'resources-manifest.json'), 'Resource inventory belongs to another run');
  assert((await fileInfo(imported.resourceManifest)).sha256 === imported.resourceManifestSha256, 'Imported inventory changed');
  const inventory = await readJson(imported.resourceManifest);
  assert(inventory.buildId === record.buildId && inventory.sourceManifestSha256 === record.sourceManifestSha256, 'Imported inventory baseline mismatch');
  await verifyFiles(record.resourceRoot, inventory.files);
  assert(!await exists(record.releaseDir), 'Immutable release already exists; choose a new run');
  const stage = path.join(runDir, 'release-stage'); await noSymlinks(stage);
  assert(!await exists(stage), 'Partial build stage exists; choose a new run or review it explicitly');
  const sources = await sourceInputs(record);
  assert(sources['src/scene3d.css'], 'Required standalone stylesheet src/scene3d.css is missing');
  const provenance = { schemaVersion: 1, buildId: record.buildId, sourceManifestSha256: record.sourceManifestSha256, lockSha256: record.lockSha256, resourceManifestSha256: imported.resourceManifestSha256, node: process.version, vite: viteVersion, sources };
  const inputPath = path.join(runDir, 'build-inputs.json');
  await atomicJson(inputPath, provenance, { exclusive: true });
  await fs.mkdir(stage);
  const config = createScene3dConfig(record, { outDir: stage });
  await viteBuild(config);
  const rngPlugin = config.plugins.find(plugin => plugin.name === 'scene3d-isolate-render-rng');
  const entry = 'entry.mjs';
  assertMountExport(await fs.readFile(path.join(stage, entry), 'utf8'));
  // Keep the source entry usable by native Node/browser ESM: CSS is a separate
  // manifest-managed resource, never a required JS import or injected side effect.
  await copyFiles(path.join(record.projectRoot, 'scene3d', 'src'), stage, { 'scene3d.css': sources['src/scene3d.css'] });
  const generated = await walkFiles(stage);
  const workerFiles = Object.entries(inventory.files).filter(([, meta]) => meta.realm === 'worker').map(([name]) => name);
  for (const name of generated) {
    assert(!name.endsWith('.html') && !name.startsWith('.'), `Preview/hidden build output prohibited: ${name}`);
    if (/\.[cm]?js$/.test(name)) auditRenderRng(await fs.readFile(path.join(stage, name), 'utf8'), name);
    assert(!Object.hasOwn(inventory.files, name), `Bundled/runtime path collision: ${name}`);
  }
  await copyFiles(record.resourceRoot, stage, inventory.files);
  const files = Object.create(null);
  for (const name of await walkFiles(stage)) files[name] = await fileInfo(path.join(stage, ...name.split('/')));
  const manifest = {
    schemaVersion: 1, buildId: record.buildId, bridgeProtocol: { min: 1, max: 1 }, entry,
    css: generated.filter(name => name.endsWith('.css')).sort(), files,
    resources: Object.fromEntries(Object.entries(inventory.files).map(([name, meta]) => [name, { kind: meta.kind ?? 'asset', required: meta.required === true, businessReachable: meta.businessReachable !== false, realm: meta.realm ?? 'host' }])),
    rngAudit: { schemaVersion: 1, hostChunks: generated.filter(name => /\.[cm]?js$/.test(name)), separatelyRegisteredWorkerFiles: workerFiles, separatelyRegisteredWorkerFunctions: rngPlugin.api.workers, unisolatedHostReferences: 0 }
  };
  assert(JSON.stringify(sources) === JSON.stringify(await sourceInputs(record)), 'Source/config changed during build');
  await verifyFiles(record.resourceRoot, inventory.files);
  await atomicJson(path.join(stage, 'manifest.json'), manifest, { exclusive: true });
  const verified = await verifyRelease(stage, record.buildId);
  await fs.rename(stage, record.releaseDir);
  await verifyRelease(record.releaseDir, record.buildId, verified.manifestSha256);
  return { releaseDir: record.releaseDir, manifestSha256: verified.manifestSha256, buildInputs: inputPath, buildInputsSha256: (await fileInfo(inputPath)).sha256, fileCount: Object.keys(files).length, rendererAcceptance: 'Not implied by build; requires separate real-renderer/browser evidence' };
}
if (isMain(import.meta.url)) runCli(() => withRun('build', buildRelease));
