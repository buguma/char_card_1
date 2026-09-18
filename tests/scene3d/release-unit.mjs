// P6 Web pointer unit tests use isolated dummy artifacts, NOT browser/APK/upgrade evidence.
// Requires the separately authorized scripts/activate-release.mjs implementation.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { atomicJson, fileInfo, readJson, sha256, walkFiles } from '../../scene3d/scripts/artifact-utils.mjs'
import { createRunRecord, loadRunRecord } from '../../scene3d/scripts/run-record.mjs'
import { publishAssets } from '../../scene3d/scripts/publish-assets.mjs'
import { activateReleaseCli } from '../../scene3d/scripts/activate-release.mjs'

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'scene3d-release-unit-'))
  t.after(() => fs.rm(temporary, { recursive: true, force: true }))
  const projectRoot = path.join(temporary, 'game'), sourceRoot = path.join(temporary, 'source')
  const sourceManifest = path.join(temporary, 'source-manifest.json'), lockFile = path.join(projectRoot, 'scene3d', 'package-lock.json')
  const publishRoot = path.join(projectRoot, 'assets', 'sect3d')
  await fs.mkdir(path.dirname(lockFile), { recursive: true }); await fs.mkdir(sourceRoot)
  await atomicJson(sourceManifest, { schemaVersion: 1, sourceRoot, files: {} })
  await atomicJson(lockFile, { name: 'fixture-only', lockfileVersion: 3, packages: {} })
  let serial = 0
  async function newRecord(runId, buildId) {
    const runDir = path.join(projectRoot, '.scene3d-work', runId), recordPath = path.join(runDir, 'run.json')
    const record = await createRunRecord(recordPath, { runId, buildId, projectRoot, sourceRoot, sourceManifest, lockFile,
      resourceRoot: path.join(runDir, 'resources'), releaseDir: path.join(runDir, 'release'), publishRoot })
    return { runDir, recordPath, record }
  }
  const versions = {}
  for (const buildId of ['版本甲', 'version-b', 'version-c']) {
    const version = await newRecord(`build-${buildId}`, buildId)
    const root = version.record.releaseDir
    const contents = { 'entry.mjs': `export function mount(){return ${JSON.stringify(buildId)}}\n`, 'scene3d.css': '.scene3d-fixture{color:red}\n',
      '模型/天山派.glb': `DUMMY MODEL ${buildId} — not a renderable GLB`, '人物/洞庭君 立绘.txt': `中文路径与字节 ${buildId}\n` }
    const files = {}
    for (const [name, value] of Object.entries(contents)) {
      const filename = path.join(root, ...name.split('/'))
      await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, value)
      files[name] = await fileInfo(filename)
    }
    const manifest = { schemaVersion: 1, buildId, bridgeProtocol: { min: 1, max: 1 }, entry: 'entry.mjs', css: ['scene3d.css'], files }
    await atomicJson(path.join(root, 'manifest.json'), manifest)
    version.record.steps.build = { status: 'succeeded', result: { releaseDir: root, manifestSha256: (await fileInfo(path.join(root, 'manifest.json'))).sha256 } }
    await atomicJson(version.recordPath, version.record)
    version.record.steps['publish:assets'] = { status: 'succeeded', result: await publishAssets(version.record) }
    await atomicJson(version.recordPath, version.record)
    version.versionRoot = path.join(publishRoot, buildId)
    versions[buildId] = version
  }
  const pointerPath = path.join(publishRoot, 'current.json')
  const protectedFiles = ['gameData.json', 'saves/第一代真实导出.fixture.json', 'saves/第二代真实导出.fixture.json', 'localStorage.fixture.json', 'apk/original.apk']
  for (const name of protectedFiles) {
    const target = path.join(projectRoot, ...name.split('/'))
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, `UNCHANGED fixture sentinel: ${name}`)
  }
  async function operation(target = versions['版本甲']) {
    const own = await newRecord(`activation-${++serial}`, target.record.buildId)
    return { ...own, args: expected => [`--runRecord=${own.recordPath}`, `--targetRunRecord=${target.recordPath}`, `--expectedCurrentBuildId=${expected}`],
      evidencePath: path.join(own.runDir, 'activation', 'transaction.json') }
  }
  const pointerBytes = () => fs.readFile(pointerPath)
  async function unchangedOnFailure(action, operationRecord, pattern = undefined) {
    const before = await pointerBytes()
    await assert.rejects(action, pattern)
    assert.deepEqual(await pointerBytes(), before, 'failed activation must preserve current.json byte-for-byte')
    if (operationRecord) {
      const value = await loadRunRecord(operationRecord.recordPath)
      assert.equal(value.steps['activate-release'].status, 'failed')
      const evidence = await readJson(operationRecord.evidencePath)
      assert.equal(evidence.status, 'failed'); assert.equal(evidence.pointerCommitted, false)
    }
  }
  return { temporary, projectRoot, sourceRoot, sourceManifest, lockFile, publishRoot, pointerPath, versions, protectedFiles, newRecord, operation, pointerBytes, unchangedOnFailure }
}
async function digestTree(root) {
  const result = {}
  for (const name of await walkFiles(root)) result[name] = await fileInfo(path.join(root, ...name.split('/')))
  return result
}
async function changeTargetManifest(version, change) {
  const manifestPath = path.join(version.record.releaseDir, 'manifest.json')
  const manifest = await readJson(manifestPath); change(manifest)
  for (const root of [version.record.releaseDir, version.versionRoot]) await atomicJson(path.join(root, 'manifest.json'), manifest)
  const manifestSha256 = (await fileInfo(manifestPath)).sha256
  version.record.steps.build.result.manifestSha256 = manifestSha256
  version.record.steps['publish:assets'].result.manifestSha256 = manifestSha256
  await atomicJson(version.recordPath, version.record)
}

test('rollback and forward reactivation switch only the verified pointer and preserve every version/data/APK', async t => {
  const f = await fixture(t), target = f.versions['版本甲'], newest = f.versions['version-c']
  const beforeVersions = {}
  for (const [id, version] of Object.entries(f.versions)) beforeVersions[id] = { release: await digestTree(version.record.releaseDir), published: await digestTree(version.versionRoot), record: await fs.readFile(version.recordPath) }
  const protectedBefore = {}
  for (const name of [...f.protectedFiles, 'scene3d/package-lock.json']) protectedBefore[name] = await fileInfo(path.join(f.projectRoot, ...name.split('/')))
  const previous = await f.pointerBytes(), rollback = await f.operation(target)
  const result = await activateReleaseCli(rollback.args('version-c'))
  assert.equal(result.fromBuildId, 'version-c'); assert.equal(result.toBuildId, '版本甲'); assert.equal(result.changed, true)
  assert.equal((await readJson(f.pointerPath)).buildId, '版本甲')
  const evidence = await readJson(rollback.evidencePath)
  assert.equal(evidence.status, 'committed'); assert.equal(evidence.pointerCommitted, true)
  assert.equal(evidence.before.sha256, sha256(previous)); assert.equal(evidence.target.buildId, '版本甲')
  assert.deepEqual(await fs.readFile(path.join(rollback.runDir, 'activation', 'before-pointer.json')), previous)
  assert.equal(evidence.after.sha256, (await fileInfo(f.pointerPath)).sha256)
  assert.match(evidence.scope, /pointer|静态/i)
  assert.equal((await loadRunRecord(rollback.recordPath)).steps['activate-release'].status, 'succeeded')
  await assert.rejects(fs.stat(rollback.record.releaseDir), /ENOENT/)
  const forward = await f.operation(newest)
  assert.equal((await activateReleaseCli(forward.args('版本甲'))).toBuildId, 'version-c')
  assert.notEqual(rollback.evidencePath, forward.evidencePath)
  assert.equal((await readJson(rollback.evidencePath)).after.buildId, '版本甲')
  for (const [id, version] of Object.entries(f.versions)) {
    assert.deepEqual(await digestTree(version.record.releaseDir), beforeVersions[id].release)
    assert.deepEqual(await digestTree(version.versionRoot), beforeVersions[id].published)
    assert.deepEqual(await fs.readFile(version.recordPath), beforeVersions[id].record, 'historical run record is read-only')
  }
  for (const [name, info] of Object.entries(protectedBefore)) assert.deepEqual(await fileInfo(path.join(f.projectRoot, ...name.split('/'))), info)
  assert.deepEqual((await fs.readdir(f.publishRoot)).sort(), ['current.json', ...Object.keys(f.versions)].sort())
})

test('an already active exact target is a recorded no-op, not a resource republish', async t => {
  const f = await fixture(t), own = await f.operation(f.versions['version-c']), before = await f.pointerBytes()
  const result = await activateReleaseCli(own.args('version-c'))
  assert.equal(result.changed, false); assert.deepEqual(await f.pointerBytes(), before)
  assert.equal((await readJson(own.evidencePath)).status, 'committed')
})

test('missing published immutable directory is rejected, never recreated by copying archived files', async t => {
  const f = await fixture(t), target = f.versions['版本甲'], own = await f.operation(target)
  await fs.rename(target.versionRoot, path.join(f.temporary, 'offline-target'))
  await f.unchangedOnFailure(() => activateReleaseCli(own.args('version-c')), own)
  await assert.rejects(fs.stat(target.versionRoot), /ENOENT/)
})

for (const kind of ['missing-file', 'same-size-tamper', 'unexpected-file', 'manifest-tamper', 'archive-tamper', 'archive-missing']) {
  test(`activation rejects ${kind} before changing the pointer`, async t => {
    const f = await fixture(t), target = f.versions['版本甲'], own = await f.operation(target)
    const published = path.join(target.versionRoot, '模型', '天山派.glb')
    if (kind === 'missing-file') await fs.unlink(published)
    if (kind === 'same-size-tamper') await fs.writeFile(published, Buffer.alloc((await fs.stat(published)).size, 88))
    if (kind === 'unexpected-file') await fs.writeFile(path.join(target.versionRoot, 'unlisted.mjs'), 'not in manifest')
    if (kind === 'manifest-tamper') await fs.appendFile(path.join(target.versionRoot, 'manifest.json'), '\n')
    if (kind === 'archive-tamper') await fs.appendFile(path.join(target.record.releaseDir, '模型', '天山派.glb'), '!')
    if (kind === 'archive-missing') await fs.rename(target.record.releaseDir, path.join(f.temporary, 'missing-archive'))
    await f.unchangedOnFailure(() => activateReleaseCli(own.args('version-c')), own)
  })
}

test('unsupported protocol is rejected; an explicit range including protocol 1 is accepted', async t => {
  const f = await fixture(t), target = f.versions['版本甲']
  await changeTargetManifest(target, manifest => { manifest.bridgeProtocol = { min: 2, max: 3 } })
  const bad = await f.operation(target)
  await f.unchangedOnFailure(() => activateReleaseCli(bad.args('version-c')), bad, /protocol/i)
  await changeTargetManifest(target, manifest => { manifest.bridgeProtocol = { min: 1, max: 2 } })
  const good = await f.operation(target)
  await activateReleaseCli(good.args('version-c'))
  assert.deepEqual((await readJson(f.pointerPath)).bridgeProtocol, { min: 1, max: 2 })
})

test('unknown target, failed provenance and frozen run tampering all fail closed', async t => {
  const f = await fixture(t), target = f.versions['版本甲']
  const unknown = await f.operation(target)
  const args = unknown.args('version-c'); args[1] = `--targetRunRecord=${path.join(f.projectRoot, '.scene3d-work', 'unknown', 'run.json')}`
  await f.unchangedOnFailure(() => activateReleaseCli(args), unknown)
  const saved = await fs.readFile(target.recordPath)
  for (const change of [record => { record.steps.build.status = 'failed' }, record => { record.steps['publish:assets'].status = 'failed' }, record => { record.sourceManifestSha256 = '0'.repeat(64) }]) {
    const record = JSON.parse(saved); change(record); await atomicJson(target.recordPath, record)
    const own = await f.operation(target)
    await f.unchangedOnFailure(() => activateReleaseCli(own.args('version-c')), own)
  }
})

test('explicit expected current ID prevents stale operator commands', async t => {
  const f = await fixture(t), own = await f.operation()
  await f.unchangedOnFailure(() => activateReleaseCli(own.args('version-b')), own, /expected|current/i)
})

test('concurrent activations share the publisher lock and cannot both commit a stale expected ID', async t => {
  const f = await fixture(t), a = await f.operation(f.versions['版本甲']), b = await f.operation(f.versions['version-b'])
  const results = await Promise.allSettled([activateReleaseCli(a.args('version-c')), activateReleaseCli(b.args('version-c'))])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  const winner = results.find(result => result.status === 'fulfilled').value
  assert.equal((await readJson(f.pointerPath)).buildId, winner.toBuildId)
  for (const own of [a, b]) assert.ok(['committed', 'failed'].includes((await readJson(own.evidencePath)).status))
  await assert.rejects(fs.stat(path.join(f.publishRoot, '.publish.lock')), /ENOENT/)
})

test('same-ID pointer byte changes after prepared evidence are detected before replacement', async t => {
  const f = await fixture(t), own = await f.operation(), initial = await f.pointerBytes()
  const originalRename = fs.rename
  let interveningBytes
  fs.rename = async (from, to) => {
    const result = await originalRename(from, to)
    if (to === own.evidencePath && !interveningBytes && (await readJson(to)).status === 'prepared') {
      const pointer = await readJson(f.pointerPath)
      interveningBytes = Buffer.from(JSON.stringify({ ...pointer, operatorNote: 'out-of-band write; same buildId' }))
      await fs.writeFile(f.pointerPath, interveningBytes)
    }
    return result
  }
  try { await assert.rejects(() => activateReleaseCli(own.args('version-c')), /Current pointer changed/) }
  finally { fs.rename = originalRename }
  assert.ok(interveningBytes)
  assert.deepEqual(await f.pointerBytes(), interveningBytes, 'do not overwrite the other writer even if its buildId is unchanged')
  const evidence = await readJson(own.evidencePath)
  assert.equal(evidence.status, 'failed'); assert.equal(evidence.pointerCommitted, false)
  assert.equal(evidence.before.sha256, sha256(initial))
})

test('a post-commit out-of-band pointer change is reported without blindly rolling it back', async t => {
  const f = await fixture(t), own = await f.operation(), originalRename = fs.rename
  const b = f.versions['version-b']
  const nextWriterBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, buildId: 'version-b', bridgeProtocol: { min: 1, max: 1 },
    manifest: 'version-b/manifest.json', manifestSha256: b.record.steps.build.result.manifestSha256 }))
  let intervened = false
  fs.rename = async (from, to) => {
    const result = await originalRename(from, to)
    if (to === f.pointerPath && !intervened) { intervened = true; await fs.writeFile(f.pointerPath, nextWriterBytes) }
    return result
  }
  try { await assert.rejects(() => activateReleaseCli(own.args('version-c')), /after commit/) }
  finally { fs.rename = originalRename }
  assert.equal(intervened, true); assert.deepEqual(await f.pointerBytes(), nextWriterBytes)
  const evidence = await readJson(own.evidencePath)
  assert.equal(evidence.status, 'failed'); assert.equal(evidence.pointerCommitted, true)
  assert.equal((await loadRunRecord(own.recordPath)).steps['activate-release'].status, 'failed')
})

test('actual CLI entry exits zero on verified activation and nonzero on stale expected version', async t => {
  const f = await fixture(t), good = await f.operation(), script = fileURLToPath(new URL('../../scene3d/scripts/activate-release.mjs', import.meta.url))
  const success = spawnSync(process.execPath, [script, ...good.args('version-c')], { stdio: 'inherit' })
  assert.ifError(success.error); assert.equal(success.status, 0)
  const bad = await f.operation(f.versions['version-c']), before = await f.pointerBytes()
  const failure = spawnSync(process.execPath, [script, ...bad.args('version-c')], { stdio: 'inherit' })
  assert.ifError(failure.error); assert.notEqual(failure.status, 0)
  assert.deepEqual(await f.pointerBytes(), before)
  assert.equal((await readJson(bad.evidencePath)).status, 'failed')
})

test('preexisting publisher lock is not removed or bypassed', async t => {
  const f = await fixture(t), own = await f.operation(), lockPath = path.join(f.publishRoot, '.publish.lock')
  await fs.writeFile(lockPath, 'another operation or crash; review required', { flag: 'wx' })
  await f.unchangedOnFailure(() => activateReleaseCli(own.args('version-c')), own, /EEXIST|lock/i)
  assert.equal(await fs.readFile(lockPath, 'utf8'), 'another operation or crash; review required')
})

test('historical release can be activated after live dependency lock changed without rewriting dependencies', async t => {
  const f = await fixture(t), target = f.versions['版本甲']
  await atomicJson(f.lockFile, { name: 'newer-live-lock', lockfileVersion: 3, packages: { changed: true } })
  const currentLock = await fs.readFile(f.lockFile), own = await f.operation(target)
  await activateReleaseCli(own.args('version-c'))
  assert.deepEqual(await fs.readFile(f.lockFile), currentLock)
  assert.equal((await readJson(f.pointerPath)).buildId, target.record.buildId)
})

test('old run is never used as the activation operation record, and CLI extras are rejected', async t => {
  const f = await fixture(t), target = f.versions['版本甲'], oldBytes = await fs.readFile(target.recordPath), before = await f.pointerBytes()
  await assert.rejects(() => activateReleaseCli([`--runRecord=${target.recordPath}`, `--targetRunRecord=${target.recordPath}`, '--expectedCurrentBuildId=version-c']), /independent|distinct|same|separate/i)
  assert.deepEqual(await fs.readFile(target.recordPath), oldBytes)
  const own = await f.operation(target)
  for (const args of [own.args('version-c').concat('--force=true'), own.args('version-c').slice(0, 2), own.args('../unsafe'), ['--runRecord=relative.json', `--targetRunRecord=${target.recordPath}`, '--expectedCurrentBuildId=version-c']]) {
    await assert.rejects(() => activateReleaseCli(args))
  }
  assert.deepEqual(await f.pointerBytes(), before)
})

test('an operation cannot overwrite its previous evidence or silently reuse a success record', async t => {
  const f = await fixture(t), own = await f.operation()
  await activateReleaseCli(own.args('version-c'))
  const evidence = await fs.readFile(own.evidencePath), before = await f.pointerBytes()
  await assert.rejects(() => activateReleaseCli(own.args('版本甲')), /exist|new run|evidence/i)
  assert.deepEqual(await fs.readFile(own.evidencePath), evidence); assert.deepEqual(await f.pointerBytes(), before)
})

test('symlink/junction evidence paths are refused rather than writing outside the operation run', async t => {
  const f = await fixture(t), own = await f.operation(), outside = path.join(f.temporary, 'outside-evidence')
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'sentinel.txt'), 'do not change')
  try { await fs.symlink(outside, path.join(own.runDir, 'activation'), process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('OS cannot create symlink fixture'); return } throw error }
  const before = await f.pointerBytes()
  await assert.rejects(() => activateReleaseCli(own.args('version-c')), /Symlink|evidence|exist/i)
  assert.deepEqual(await f.pointerBytes(), before)
  assert.deepEqual(await fs.readdir(outside), ['sentinel.txt'])
})
