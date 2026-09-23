// Reuse an already-published scene3d build for a game-only (HTML/CSS/JS) change.
// Creates a fresh run record whose import-assets/build/publish:assets/verify:web
// steps are copied verbatim from the source build, so 打包APK.ps1 can run
// prepare:apk -> gradle -> verify:apk without rebuilding the unchanged renderer.
import path from 'node:path';
import { createRunRecord } from './run-record.mjs';
import { readJson, atomicJson, assert } from './artifact-utils.mjs';

const projectRoot = process.argv[2];
const runId = process.argv[3];
const buildId = process.argv[4] || 'backpack-map-20260921-161041';
assert(path.isAbsolute(projectRoot), 'projectRoot must be absolute');
assert(runId && !runId.includes('/') && !runId.includes('\\'), 'runId must be a plain name');

const runDir = path.join(projectRoot, '.scene3d-work', runId);
const recordPath = path.join(runDir, 'run.json');
const original = await readJson(path.join(projectRoot, '.scene3d-work', buildId, 'run.json'));

await createRunRecord(recordPath, {
  runId,
  buildId,
  projectRoot,
  sourceRoot: original.sourceRoot,
  sourceManifest: original.sourceManifest,
  lockFile: original.lockFile,
  resourceRoot: path.join(runDir, 'resources'),
  releaseDir: path.join(runDir, 'release'),
  publishRoot: original.publishRoot,
});

const record = await readJson(recordPath);
record.steps = {
  'import-assets': original.steps['import-assets'],
  'build': original.steps['build'],
  'publish:assets': original.steps['publish:assets'],
  'verify:web': original.steps['verify:web'],
};
await atomicJson(recordPath, record);
console.log(recordPath);
