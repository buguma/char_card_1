import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, verifyRelease } from '../../scene3d/scripts/artifact-utils.mjs'

const workspace = fileURLToPath(new URL('../../', import.meta.url))

// Real-model tests must follow the shipped release, not retain an obsolete copy
// of identical GLB/decoder files. Missing or altered published assets are failures,
// never a reason to silently skip a regression.
export async function currentRelease(gameRoot = workspace) {
  const publishRoot = path.join(gameRoot, 'assets/sect3d')
  const pointer = await readJson(path.join(publishRoot, 'current.json'))
  assert.equal(pointer.schemaVersion, 1, 'Unsupported current pointer schema')
  assert.match(pointer.buildId || '', /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Unsafe current build ID')
  assert.deepEqual(pointer.bridgeProtocol, { min: 1, max: 1 })
  assert.equal(pointer.manifest, `${pointer.buildId}/manifest.json`)
  assert.match(pointer.manifestSha256 || '', /^[a-f0-9]{64}$/, 'Missing current manifest hash')
  const releaseRoot = path.join(publishRoot, pointer.buildId)
  const verified = await verifyRelease(releaseRoot, pointer.buildId, pointer.manifestSha256)
  return { pointer, releaseRoot, ...verified }
}
