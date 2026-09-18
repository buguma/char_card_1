import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert, absolute, noSymlinks, fileInfo, atomicJson, readJson, sha256, jsonBytes, safeRelative } from './artifact-utils.mjs';

const FROZEN = ['schemaVersion', 'runId', 'buildId', 'projectRoot', 'sourceRoot', 'sourceManifest', 'sourceManifestSha256', 'lockFile', 'lockSha256', 'resourceRoot', 'releaseDir', 'publishRoot'];
export function configurationHash(record) { return sha256(jsonBytes(Object.fromEntries(FROZEN.map(key => [key, record[key]])))); }
export function cliArguments(argv = process.argv.slice(2)) {
  assert(argv[0]?.startsWith('--runRecord='), 'First argument must be --runRecord=<absolute run.json>');
  const args = Object.create(null);
  for (const arg of argv) {
    const match = /^--([a-zA-Z][a-zA-Z0-9]*)=(.+)$/.exec(arg);
    assert(match && !Object.hasOwn(args, match[1]), `Invalid/duplicate argument: ${arg}`);
    args[match[1]] = match[2];
  }
  absolute(args.runRecord, 'runRecord'); return args;
}
export async function validateRecord(recordPath, record) {
  absolute(recordPath, 'runRecord');
  assert(record.schemaVersion === 1, 'Unsupported run schema');
  for (const key of ['runId', 'buildId']) { safeRelative(record[key]); assert(!record[key].includes('/'), `Invalid ${key}`); }
  for (const key of ['projectRoot', 'sourceRoot', 'sourceManifest', 'lockFile', 'resourceRoot', 'releaseDir', 'publishRoot']) {
    absolute(record[key], key); await noSymlinks(record[key]);
  }
  const runDir = path.join(record.projectRoot, '.scene3d-work', record.runId);
  assert(recordPath === path.join(runDir, 'run.json'), 'runRecord must be projectRoot/.scene3d-work/runId/run.json');
  assert(record.releaseDir === path.join(runDir, 'release'), 'releaseDir must belong exclusively to this run');
  assert(record.resourceRoot === path.join(runDir, 'resources'), 'resourceRoot must belong exclusively to this run');
  assert(record.publishRoot === path.join(record.projectRoot, 'assets', 'sect3d'), 'publishRoot must be projectRoot/assets/sect3d');
  assert(record.lockFile === path.join(record.projectRoot, 'scene3d', 'package-lock.json'), 'Lock must be local scene3d/package-lock.json');
  const relation = path.relative(record.sourceRoot, record.projectRoot);
  assert(relation !== '' && (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)), 'projectRoot cannot be inside sourceRoot');
  await noSymlinks(recordPath);
  assert((await fileInfo(record.sourceManifest)).sha256 === record.sourceManifestSha256, 'Source manifest changed');
  assert((await fileInfo(record.lockFile)).sha256 === record.lockSha256, 'Lock file changed');
  assert(record.configurationSha256 === configurationHash(record), 'Frozen run configuration changed');
  return record;
}
export async function createRunRecord(recordPath, input) {
  absolute(recordPath, 'runRecord');
  const record = { schemaVersion: 1, ...input };
  if (record.resourcesRoot !== undefined) {
    assert(record.resourceRoot === undefined || record.resourcesRoot === record.resourceRoot, 'Conflicting resource roots');
    record.resourceRoot = record.resourcesRoot; delete record.resourcesRoot;
  }
  record.lockFile ??= path.join(record.projectRoot, 'scene3d', 'package-lock.json');
  record.sourceManifestSha256 = (await fileInfo(record.sourceManifest)).sha256;
  record.lockSha256 = (await fileInfo(record.lockFile)).sha256;
  record.configurationSha256 = configurationHash(record);
  record.createdAt = new Date().toISOString(); record.steps = {};
  await validateRecord(recordPath, record);
  await atomicJson(recordPath, record, { exclusive: true });
  return record;
}
export async function loadRunRecord(recordPath, args = {}) {
  const record = await readJson(recordPath);
  for (const [key, value] of Object.entries(args)) {
    if (key === 'runRecord') continue;
    const normalizedKey = key === 'resourcesRoot' ? 'resourceRoot' : key;
    assert(FROZEN.includes(normalizedKey) && String(record[normalizedKey]) === value, `Unknown/conflicting argument: ${key}`);
  }
  return validateRecord(recordPath, record);
}
export function requireStep(record, name) { assert(record.steps?.[name]?.status === 'succeeded', `Current run requires succeeded ${name}`); return record.steps[name].result; }
// One writer per run; stale locks are retained after crashes for explicit operator review.
export async function withRun(step, operation, argv = process.argv.slice(2)) {
  const args = cliArguments(argv), recordPath = args.runRecord;
  let record = await loadRunRecord(recordPath, args);
  const lockPath = path.join(path.dirname(recordPath), '.operation.lock');
  await noSymlinks(lockPath);
  const lock = await fs.open(lockPath, 'wx');
  try {
    record = await loadRunRecord(recordPath, args);
    record.steps ??= {};
    record.steps[step] = { status: 'running', startedAt: new Date().toISOString() };
    await atomicJson(recordPath, record);
    try {
      const result = await operation(record, { recordPath, runDir: path.dirname(recordPath) });
      await validateRecord(recordPath, record);
      record.steps[step] = { ...record.steps[step], status: 'succeeded', endedAt: new Date().toISOString(), result };
      await atomicJson(recordPath, record);
      return result;
    } catch (error) {
      record.steps[step] = { ...record.steps[step], status: 'failed', endedAt: new Date().toISOString(), error: String(error.stack || error) };
      await atomicJson(recordPath, record);
      throw error;
    }
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
export function isMain(url) { return process.argv[1] && url === pathToFileURL(path.resolve(process.argv[1])).href; }
export function runCli(main) { main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }); }
if (isMain(import.meta.url)) runCli(async () => {
  const args = cliArguments(); const { runRecord, ...input } = args;
  const allowed = new Set(['runId', 'buildId', 'projectRoot', 'sourceRoot', 'sourceManifest', 'lockFile', 'resourceRoot', 'resourcesRoot', 'releaseDir', 'publishRoot']);
  for (const key of Object.keys(input)) assert(allowed.has(key), `Unknown initialization argument: ${key}`);
  await createRunRecord(runRecord, input); console.log(`Created immutable configuration: ${runRecord}`);
});
