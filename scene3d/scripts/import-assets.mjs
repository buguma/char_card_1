import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, readJson, validateFiles, fileInfo, atomicJson, exists, verifyFiles, copyFiles } from './artifact-utils.mjs';
import { withRun, isMain, runCli } from './run-record.mjs';

export async function importAssets(record, { runDir }) {
  const source = await readJson(record.sourceManifest);
  assert(source.schemaVersion === 1, 'Unsupported source manifest schema');
  if (source.sourceRoot !== undefined) assert(source.sourceRoot === record.sourceRoot, 'Source manifest root differs from frozen run');
  validateFiles(source.files);
  const runtime = Object.create(null);
  // P0 may provide either an exclusively-runtime whitelist of {bytes, sha256},
  // or a mixed inventory whose EVERY entry carries an explicit publish boolean.
  // Do not guess publication for a partially annotated mixed inventory.
  const runtimeOnly = Object.values(source.files).every(meta => !Object.hasOwn(meta, 'publish'));
  if (runtimeOnly) assert(Object.hasOwn(source.files, 'sect_diorama.glb'), 'Runtime-only whitelist must include required main model sect_diorama.glb');
  for (const [name, original] of Object.entries(source.files)) {
    const meta = runtimeOnly ? { ...original, publish: true } : { ...original };
    if (name === 'sect_diorama.glb') { meta.kind ??= 'model'; meta.required ??= true; }
    if (/^draco\/(?:draco_wasm_wrapper\.js|draco_decoder\.wasm|decoder\.wasm)$/.test(name)) { meta.kind ??= 'decoder'; meta.realm ??= 'worker'; }
    assert(typeof meta.publish === 'boolean', `Explicit publish boolean required in mixed inventory: ${name}`);
    const actual = await fileInfo(path.join(record.sourceRoot, ...name.split('/')));
    assert(actual.bytes === meta.bytes && actual.sha256 === meta.sha256, `Input baseline mismatch: ${name}`);
    if (!meta.publish) continue;
    assert(/\.(?:glb|gltf|bin|png|jpe?g|webp|ktx2?|basis|wasm|js|json)$/i.test(name), `Non-runtime asset prohibited: ${name}`);
    if (/\.js$/i.test(name)) assert(meta.kind === 'decoder' && meta.realm === 'worker', `JavaScript imports require explicit decoder/worker classification: ${name}`);
    runtime[name] = { ...meta };
  }
  assert(Object.keys(runtime).length > 0, 'No runtime assets in source whitelist');
  assert(Object.entries(runtime).some(([name, meta]) => /\.glb$/i.test(name) && meta.required === true), 'Source whitelist must mark a required GLB main model');
  const inventoryPath = path.join(runDir, 'resources-manifest.json');
  const inventory = { schemaVersion: 1, buildId: record.buildId, sourceManifestSha256: record.sourceManifestSha256, files: runtime };
  if (await exists(record.resourceRoot)) {
    assert(await exists(inventoryPath), 'Existing resources have no generated inventory; refusing manual files');
    const previous = await readJson(inventoryPath);
    assert(JSON.stringify(previous) === JSON.stringify(inventory), 'Resource baseline differs');
    await verifyFiles(record.resourceRoot, runtime);
  } else {
    // Never delete/reuse partial imports: a failed run requires explicit operator review or a new runId.
    await fs.mkdir(record.resourceRoot);
    await copyFiles(record.sourceRoot, record.resourceRoot, runtime);
    await verifyFiles(record.resourceRoot, runtime);
    await atomicJson(inventoryPath, inventory, { exclusive: true });
  }
  return { resourceManifest: inventoryPath, resourceManifestSha256: (await fileInfo(inventoryPath)).sha256, fileCount: Object.keys(runtime).length };
}
if (isMain(import.meta.url)) runCli(() => withRun('import-assets', importAssets));
