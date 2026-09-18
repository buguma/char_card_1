import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assert, absolute, noSymlinks, safeRelative, exists, sha256, jsonBytes, atomicJson, fileInfo, validateFiles, verifyFiles } from './artifact-utils.mjs'
import { cliArguments, configurationHash, loadRunRecord, requireStep, withRun, isMain, runCli } from './run-record.mjs'

const STEP = 'activate-release'
const SCOPE = 'Verified local Web resource pointer only; no game/save/storage/APK changes, no browser or signed-upgrade acceptance.'
const HASH = /^[a-f0-9]{64}$/
function identifier(value, label) {
  safeRelative(value)
  assert(!value.includes('/') && !value.startsWith('.') && value !== 'current.json', `Invalid ${label}`)
  return value
}
function supportsProtocolOne(value) {
  assert(value && Number.isSafeInteger(value.min) && Number.isSafeInteger(value.max) && value.min >= 1 && value.min <= 1 && value.max >= 1, 'Unsupported bridge protocol: range must include protocol 1')
}
async function rawJson(filename) {
  absolute(filename); await noSymlinks(filename)
  assert((await fs.lstat(filename)).isFile(), `Not a regular JSON file: ${filename}`)
  const bytes = await fs.readFile(filename)
  return { bytes, sha256: sha256(bytes), value: JSON.parse(bytes.toString('utf8')) }
}
async function exclusiveBytes(filename, bytes) {
  await noSymlinks(filename)
  const handle = await fs.open(filename, 'wx')
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}
function pointerShape(pointer) {
  assert(pointer?.schemaVersion === 1, 'Unsupported current pointer schema')
  identifier(pointer.buildId, 'current buildId')
  supportsProtocolOne(pointer.bridgeProtocol)
  assert(pointer.manifest === `${pointer.buildId}/manifest.json` && HASH.test(pointer.manifestSha256), 'Current pointer manifest mismatch')
}
async function verifyArchivedRelease(root, buildId, manifestSha256) {
  absolute(root); await noSymlinks(root)
  const raw = await rawJson(path.join(root, 'manifest.json')), manifest = raw.value
  assert(raw.sha256 === manifestSha256, 'Manifest hash mismatch')
  assert(manifest?.schemaVersion === 1 && manifest.buildId === buildId, 'Manifest build/schema mismatch')
  supportsProtocolOne(manifest.bridgeProtocol)
  validateFiles(manifest.files)
  assert(!Object.hasOwn(manifest.files, 'manifest.json'), 'Manifest cannot hash itself')
  assert(typeof manifest.entry === 'string' && /\.m?js$/.test(manifest.entry) && Object.hasOwn(manifest.files, manifest.entry), 'Missing ESM entry')
  assert(Array.isArray(manifest.css) && new Set(manifest.css).size === manifest.css.length, 'Invalid CSS list')
  for (const css of manifest.css) assert(typeof css === 'string' && css.endsWith('.css') && Object.hasOwn(manifest.files, css), `Missing CSS: ${css}`)
  await verifyFiles(root, manifest.files, ['manifest.json'])
  // Pin the bytes parsed above as well as all file hashes, not a second JSON parse.
  assert((await fileInfo(path.join(root, 'manifest.json'))).sha256 === raw.sha256, 'Manifest changed during verification')
  return { ...raw, manifest, fileCount: Object.keys(manifest.files).length + 1,
    totalBytes: raw.bytes.length + Object.values(manifest.files).reduce((sum, item) => sum + item.bytes, 0) }
}

/**
 * Historical build records are immutable provenance, not a request to rebuild.
 * Do NOT use loadRunRecord here: its live lock/source checks correctly protect a
 * new operation, but a newer installed lock must not prevent a verified rollback.
 */
async function historicalRun(filename, operation) {
  absolute(filename, 'targetRunRecord')
  const raw = await rawJson(filename), record = raw.value
  assert(record?.schemaVersion === 1, 'Unsupported historical run schema')
  identifier(record.runId, 'target runId'); identifier(record.buildId, 'target buildId')
  for (const name of ['projectRoot', 'sourceRoot', 'sourceManifest', 'lockFile', 'resourceRoot', 'releaseDir', 'publishRoot']) {
    absolute(record[name], `target ${name}`); await noSymlinks(record[name])
  }
  assert(record.projectRoot === operation.projectRoot && record.publishRoot === operation.publishRoot, 'Target belongs to another project/publish root')
  const runDir = path.join(record.projectRoot, '.scene3d-work', record.runId)
  assert(filename === path.join(runDir, 'run.json'), 'Historical runRecord path does not match its runId')
  assert(record.releaseDir === path.join(runDir, 'release'), 'Historical release belongs to another run')
  assert(record.resourceRoot === path.join(runDir, 'resources'), 'Historical resources belong to another run')
  assert(record.publishRoot === path.join(record.projectRoot, 'assets', 'sect3d'), 'Historical publish root mismatch')
  assert(record.lockFile === path.join(record.projectRoot, 'scene3d', 'package-lock.json'), 'Historical lock path mismatch')
  const relation = path.relative(record.sourceRoot, record.projectRoot)
  assert(relation !== '' && (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)), 'Historical project cannot be inside sourceRoot')
  assert(HASH.test(record.sourceManifestSha256) && HASH.test(record.lockSha256), 'Invalid historical input hashes')
  assert(record.configurationSha256 === configurationHash(record), 'Frozen historical run configuration changed')
  const built = requireStep(record, 'build'), published = requireStep(record, 'publish:assets')
  assert(built.releaseDir === record.releaseDir && HASH.test(built.manifestSha256), 'Historical build release/hash mismatch')
  const versionRoot = path.join(record.publishRoot, record.buildId)
  assert(published.versionRoot === versionRoot && published.manifestSha256 === built.manifestSha256, 'Historical publish provenance mismatch')
  assert(operation.buildId === record.buildId, 'Operation buildId must name the explicitly selected target buildId')
  return { raw, record, versionRoot, manifestSha256: built.manifestSha256 }
}
async function unchangedPointer(filename, before, expectedBuildId) {
  const current = await rawJson(filename)
  pointerShape(current.value)
  assert(current.value.buildId === expectedBuildId && current.bytes.equals(before.bytes), 'Current pointer changed during activation; expected original bytes and buildId')
}

/** Only withRun calls this in production. All artifact roots derive from its validated record. */
export async function activateRelease(record, { recordPath, runDir, targetRunRecord, expectedCurrentBuildId }) {
  assert(recordPath !== targetRunRecord, 'Activation requires a distinct independent operation run')
  assert(runDir === path.dirname(recordPath), 'Operation evidence run path mismatch')
  const evidenceDir = path.join(runDir, 'activation'), evidencePath = path.join(evidenceDir, 'transaction.json')
  await noSymlinks(evidenceDir)
  assert(!await exists(evidenceDir), 'Activation evidence already exists; use a new run')
  await fs.mkdir(evidenceDir)
  const evidence = { schemaVersion: 1, runId: record.runId, status: 'preparing', pointerCommitted: false, startedAt: new Date().toISOString(),
    expectedCurrentBuildId, targetRunRecord, scope: SCOPE }
  const pointerPath = path.join(record.publishRoot, 'current.json'), lockPath = path.join(record.publishRoot, '.publish.lock')
  let lock = null, lockToken = null
  try {
    await atomicJson(path.join(evidenceDir, 'request.json'), { ...evidence, operationRunRecord: recordPath, publishRoot: record.publishRoot }, { exclusive: true })
    await atomicJson(evidencePath, evidence, { exclusive: true })
    await noSymlinks(record.publishRoot)
    assert((await fs.lstat(record.publishRoot)).isDirectory(), 'Publish root must already exist')
    await noSymlinks(lockPath)
    lock = await fs.open(lockPath, 'wx') // Shared with publish-assets; never break a preexisting lock.
    lockToken = jsonBytes({ runId: record.runId, operation: STEP, token: randomUUID(), pid: process.pid })
    await lock.writeFile(lockToken); await lock.sync()

    const before = await rawJson(pointerPath)
    pointerShape(before.value)
    evidence.before = { buildId: before.value.buildId, sha256: before.sha256, bytes: before.bytes.length, file: 'before-pointer.json' }
    await exclusiveBytes(path.join(evidenceDir, 'before-pointer.json'), before.bytes)
    assert(before.value.buildId === expectedCurrentBuildId, `Expected current buildId ${expectedCurrentBuildId}, observed ${before.value.buildId}`)

    const target = await historicalRun(targetRunRecord, record)
    const release = await verifyArchivedRelease(target.record.releaseDir, target.record.buildId, target.manifestSha256)
    const published = await verifyArchivedRelease(target.versionRoot, target.record.buildId, target.manifestSha256)
    assert(release.bytes.equals(published.bytes), 'Archived/published manifest bytes differ')
    const next = { schemaVersion: 1, buildId: target.record.buildId, bridgeProtocol: { ...release.manifest.bridgeProtocol },
      manifest: `${target.record.buildId}/manifest.json`, manifestSha256: target.manifestSha256 }
    const nextBytes = jsonBytes(next)
    evidence.target = { runRecord: targetRunRecord, runRecordSha256: target.raw.sha256, buildId: target.record.buildId,
      releaseDir: target.record.releaseDir, versionRoot: target.versionRoot, manifestSha256: target.manifestSha256,
      fileCount: release.fileCount, totalBytes: release.totalBytes, bridgeProtocol: { ...next.bridgeProtocol },
      historicalLockSha256: target.record.lockSha256, currentOperationLockSha256: record.lockSha256 }
    evidence.intended = { buildId: next.buildId, sha256: sha256(nextBytes), bytes: nextBytes.length, file: 'next-pointer.json' }
    await exclusiveBytes(path.join(evidenceDir, 'target-manifest.json'), release.bytes)
    await exclusiveBytes(path.join(evidenceDir, 'next-pointer.json'), nextBytes)

    // Immutable means never edit in place. Still recheck inputs and original
    // pointer immediately before committing, in addition to the cooperative lock.
    await verifyArchivedRelease(target.record.releaseDir, target.record.buildId, target.manifestSha256)
    await verifyArchivedRelease(target.versionRoot, target.record.buildId, target.manifestSha256)
    assert((await rawJson(targetRunRecord)).sha256 === target.raw.sha256, 'Historical run changed during activation')
    await unchangedPointer(pointerPath, before, expectedCurrentBuildId)
    evidence.status = 'prepared'; evidence.preparedAt = new Date().toISOString()
    await atomicJson(evidencePath, evidence)
    await unchangedPointer(pointerPath, before, expectedCurrentBuildId)

    const changed = !before.bytes.equals(nextBytes)
    // atomicJson writes and fsyncs a unique file in the SAME directory then renames.
    // All publishers must use .publish.lock; this is not a CAS against rogue writers.
    if (changed) await atomicJson(pointerPath, next)
    evidence.pointerCommitted = true
    const after = await rawJson(pointerPath)
    assert(after.bytes.equals(nextBytes), 'Pointer changed after commit; inspect evidence, do not blindly restore')
    evidence.after = { buildId: after.value.buildId, sha256: after.sha256, bytes: after.bytes.length }
    evidence.status = 'committed'; evidence.changed = changed; evidence.endedAt = new Date().toISOString()
    await atomicJson(evidencePath, evidence)
    return { fromBuildId: before.value.buildId, toBuildId: next.buildId, changed, evidencePath,
      evidenceSha256: (await fileInfo(evidencePath)).sha256, beforePointerSha256: before.sha256, afterPointerSha256: after.sha256, scope: SCOPE }
  } catch (error) {
    evidence.status = 'failed'; evidence.endedAt = new Date().toISOString()
    evidence.error = { name: error.name, message: String(error.message || error) }
    // A post-commit evidence failure must not cause a blind rollback over a later
    // publisher. The prepared record and actual pointer allow explicit recovery.
    try { await atomicJson(evidencePath, evidence) }
    catch (evidenceError) { throw new AggregateError([error, evidenceError], `Activation failed; evidence write also failed; pointerCommitted=${evidence.pointerCommitted}`) }
    throw error
  } finally {
    if (lock) {
      await lock.close()
      // Never delete another writer's replacement lock after an out-of-band edit.
      await noSymlinks(lockPath)
      const actual = await fs.readFile(lockPath)
      assert(actual.equals(lockToken), 'Publish lock ownership changed; retained for operator review')
      await fs.unlink(lockPath)
    }
  }
}

export async function activateReleaseCli(argv = process.argv.slice(2)) {
  const args = cliArguments(argv)
  const allowed = new Set(['runRecord', 'targetRunRecord', 'expectedCurrentBuildId'])
  for (const key of Object.keys(args)) assert(allowed.has(key), `Unknown activation argument: ${key}`)
  absolute(args.targetRunRecord, 'targetRunRecord')
  identifier(args.expectedCurrentBuildId, 'expectedCurrentBuildId')
  assert(args.runRecord !== args.targetRunRecord, 'Use a distinct independent operation run, not the historical run')
  const own = await loadRunRecord(args.runRecord)
  assert(!own.steps?.build && !own.steps?.['publish:assets'], 'Use an independent activation run, not a build/publish run')
  assert(!own.steps?.[STEP], 'Activation evidence/step already exists; use a new run')
  return withRun(STEP, (record, context) => activateRelease(record, { ...context,
    targetRunRecord: args.targetRunRecord, expectedCurrentBuildId: args.expectedCurrentBuildId }), [`--runRecord=${args.runRecord}`])
}
if (isMain(import.meta.url)) runCli(async () => {
  const result = await activateReleaseCli()
  console.log(JSON.stringify(result, null, 2))
})
