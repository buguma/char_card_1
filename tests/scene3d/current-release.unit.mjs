import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { currentRelease } from './current-release.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scene3d-current-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const publish = path.join(root, 'assets/sect3d')
  const pointers = []
  for (const buildId of ['test-a', 'test-b']) {
    const release = path.join(publish, buildId), entry = Buffer.from(`export const build = '${buildId}';\n`)
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, buildId, bridgeProtocol: { min: 1, max: 1 },
      entry: 'entry.mjs', css: [], files: { 'entry.mjs': { bytes: entry.length, sha256: hash(entry) } } }))
    await fs.mkdir(release, { recursive: true })
    await fs.writeFile(path.join(release, 'entry.mjs'), entry)
    await fs.writeFile(path.join(release, 'manifest.json'), manifest)
    pointers.push({ schemaVersion: 1, buildId, bridgeProtocol: { min: 1, max: 1 }, manifest: `${buildId}/manifest.json`, manifestSha256: hash(manifest) })
  }
  const set = p => fs.writeFile(path.join(publish, 'current.json'), JSON.stringify(p))
  await set(pointers[0])
  return { root, publish, pointers, set }
}

test('real-asset resolution follows a valid current pointer after old release deletion', async t => {
  const f = await fixture(t)
  assert.equal((await currentRelease(f.root)).manifest.buildId, 'test-a')
  await f.set(f.pointers[1])
  await fs.rm(path.join(f.publish, 'test-a'), { recursive: true })
  assert.equal((await currentRelease(f.root)).manifest.buildId, 'test-b')
})

test('current pointer rejects traversal, noncanonical paths, invalid schemas and missing hashes', async t => {
  const f = await fixture(t), original = f.pointers[0]
  for (const patch of [ { buildId: '../test-a' }, { buildId: 'nested/test-a' }, { schemaVersion: 2 },
    { manifest: 'test-b/manifest.json' }, { manifestSha256: undefined }, { bridgeProtocol: { min: 1, max: 2 } } ]) {
    await f.set({ ...original, ...patch })
    await assert.rejects(currentRelease(f.root))
  }
})

test('missing or modified assets fail instead of silently skipping real-model regressions', async t => {
  const f = await fixture(t), root = path.join(f.publish, 'test-a')
  await fs.writeFile(path.join(root, 'entry.mjs'), 'tampered')
  await assert.rejects(currentRelease(f.root), /Byte\/hash mismatch/)
  await f.set({ ...f.pointers[1], manifestSha256: '0'.repeat(64) })
  await assert.rejects(currentRelease(f.root), /Manifest hash mismatch/)
  await f.set(f.pointers[1])
  await fs.rm(path.join(f.publish, 'test-b'), { recursive: true })
  await assert.rejects(currentRelease(f.root))
})
