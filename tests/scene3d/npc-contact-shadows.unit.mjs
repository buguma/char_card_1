import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createNpcContactShadows, NPC_SHADOW_LIFT } from '../../scene3d/src/npc-contact-shadows.js'
import { createResourceRegistry } from '../../scene3d/src/resources.js'

const require = createRequire(new URL('../../scene3d/package.json', import.meta.url))
const THREE = await import(pathToFileURL(path.join(path.dirname(require.resolve('three')), 'three.module.js')).href)
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`)
function fixture() {
  const root = new THREE.Group(), parent = new THREE.Group()
  root.position.set(2, 3, -4); root.rotation.y = .7; root.scale.set(1.3, 1.6, .9); root.add(parent)
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, alphaTest: .5, opacity: 0 }))
  floor.name = 'floor'; floor.userData.npcSpawn = true; floor.userData.navigationOnly = true
  floor.position.y = .4; floor.visible = false; root.add(floor)
  const card = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, .5, 0), new THREE.MeshBasicMaterial())
  card.userData.gameNpcId = 'A'; card.position.set(.2, .4, .3); card.scale.set(1, 2, 1); parent.add(card)
  const shadows = createNpcContactShadows({ parent, floor }); shadows.add(card); shadows.update(true)
  const mesh = parent.getObjectByName('NPC_ContactShadow_A')
  return { root, parent, floor, card, shadows, mesh, cleanup() {
    shadows.dispose(); card.geometry.dispose(); card.material.dispose(); floor.geometry.dispose(); floor.material.dispose()
  } }
}
const first = f => f.shadows.snapshot().residents[0]

test('contact shadows use world feet and invisible alpha-mask floor under nonuniform parents', () => {
  const f = fixture()
  try {
    const foot = f.card.getWorldPosition(new THREE.Vector3()), s = first(f)
    assert.equal(s.gameNpcId, 'A'); assert.equal(s.visible, true); assert.equal(s.supported, true)
    close(s.position[0], foot.x); close(s.position[2], foot.z); close(s.position[1], foot.y + NPC_SHADOW_LIFT)
    close(s.depth, new THREE.Vector3().setFromMatrixColumn(f.card.matrixWorld, 1).length() * .23)
    const before = { ...s }; f.card.scale.multiplyScalar(2); f.card.position.x += 1
    f.shadows.update()
    close(first(f).width, before.width * 2); close(first(f).depth, before.depth * 2)
    f.root.position.y += 4; f.shadows.update()
    close(first(f).position[1], f.card.getWorldPosition(new THREE.Vector3()).y + NPC_SHADOW_LIFT)
    assert.equal(f.floor.visible, false); assert.equal(f.floor.material.opacity, 0)
  } finally { f.cleanup() }
})

test('unchanged feet/floor reuse support; yaw and height change the ellipse without extra raycasts', () => {
  const f = fixture()
  try {
    const probes = f.shadows.snapshot().raycasts, width = first(f).width
    for (let i = 0; i < 20; i++) f.shadows.update()
    assert.equal(f.shadows.snapshot().raycasts, probes)
    f.card.scale.multiplyScalar(1.5); f.card.rotation.y = .4; f.shadows.update()
    assert.equal(f.shadows.snapshot().raycasts, probes); assert.ok(first(f).width > width)
    f.floor.geometry.attributes.position.needsUpdate = true; f.shadows.update()
    assert.equal(f.shadows.snapshot().raycasts, probes + 1)
    f.card.position.x += .2; f.shadows.update()
    assert.equal(f.shadows.snapshot().raycasts, probes + 2)
  } finally { f.cleanup() }
})

test('disabled, hidden and unsupported shadows never float or leave visible ghosts', () => {
  const f = fixture()
  try {
    f.shadows.update(false); assert.equal(first(f).visible, false)
    f.shadows.update(true); assert.equal(first(f).visible, true)
    f.root.visible = false; assert.equal(first(f).visible, false)
    f.root.visible = true; f.card.visible = false; f.shadows.update(); assert.equal(first(f).visible, false)
    f.card.visible = true; f.card.material.visible = false; f.shadows.update(); assert.equal(first(f).visible, false)
    f.card.material.visible = true; f.card.position.x = 100; f.shadows.update()
    assert.equal(first(f).supported, false); assert.equal(first(f).visible, false)
    f.card.position.x = 0; f.card.position.y += 2; f.shadows.update()
    assert.equal(first(f).supported, false); assert.equal(first(f).visible, false)
  } finally { f.cleanup() }
})

test('gradient edges are transparent; decorations do not write depth, cast shadows or pick', () => {
  const f = fixture()
  try {
    const { mesh } = f, material = mesh.material
    assert.equal(mesh.castShadow, false); assert.equal(mesh.receiveShadow, false)
    assert.equal(mesh.userData.npcContactShadow, true)
    assert.equal(material.depthWrite, false); assert.equal(material.depthTest, true)
    assert.equal(material.opacity, .44); assert.equal(material.toneMapped, false)
    const { data, width, height } = material.map.image
    assert.equal(width, 64); assert.equal(height, 64)
    for (let i = 0; i < width; i++) {
      for (const pixel of [i, (height - 1) * width + i, i * width, i * width + width - 1]) assert.equal(data[pixel * 4 + 3], 0)
    }
    assert.ok(data[(32 * width + 32) * 4 + 3] > 250)
    const hits = []; mesh.raycast(null, hits); assert.equal(hits.length, 0)
    assert.equal(f.shadows.add(f.card), false); assert.equal(f.shadows.snapshot().residents.length, 1)
  } finally { f.cleanup() }
})

test('multi-level triangle support does not snap every shadow to the floor bbox top', () => {
  const f = fixture()
  try {
    f.floor.geometry.dispose(); f.floor.geometry = new THREE.BufferGeometry()
    f.floor.geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -2, 0, -1, -2, 0, 1, 0, 0, 1, -2, 0, -1, 0, 0, 1, 0, 0, -1,
      0, 1, -1, 0, 1, 1, 2, 1, 1, 0, 1, -1, 2, 1, 1, 2, 1, -1,
    ], 3))
    f.card.position.set(-1, .4, 0); f.shadows.update(); const lower = first(f)
    f.card.position.set(1, 1.4, 0); f.shadows.update(); const upper = first(f)
    assert.ok(lower.supported && upper.supported)
    close(upper.position[1] - lower.position[1], 1.6)
    close(upper.position[1] - upper.foot[1], NPC_SHADOW_LIFT)
    // .2 world metres above a floor is deliberately out of the support window.
    f.card.position.y += .2 / 1.6; f.shadows.update(); assert.equal(first(f).supported, false)
  } finally { f.cleanup() }
})

test('sloped floor uses inverse-transpose world normal and lift tangent to the support', () => {
  const f = fixture()
  try {
    f.floor.rotation.z = .15; f.card.position.set(0, .4, 0); f.shadows.update()
    const s = first(f), foot = f.card.getWorldPosition(new THREE.Vector3())
    assert.ok(s.supported); assert.ok(Math.abs(s.normal[0]) > .01)
    s.position.forEach((p, i) => close(p, foot.getComponent(i) + s.normal[i] * NPC_SHADOW_LIFT))
    const actualNormal = new THREE.Vector3(0, 0, 1).applyMatrix3(new THREE.Matrix3().getNormalMatrix(f.mesh.matrixWorld)).normalize()
    s.normal.forEach((v, i) => close(v, actualNormal.getComponent(i)))
  } finally { f.cleanup() }
})

test('shadow stats are deeply immutable reads and detached shared resources dispose exactly once', () => {
  const f = fixture(), registry = createResourceRegistry()
  try {
    // The model is tracked before NPC decorations attach, as in runtime loadModel.
    f.parent.removeFromParent(); registry.track(f.root); f.root.add(f.parent)
    const before = f.shadows.snapshot(), savedUpdate = f.parent.updateWorldMatrix, savedRay = f.floor.raycast
    f.parent.updateWorldMatrix = f.floor.raycast = () => { throw Error('Stats must not mutate or raycast') }
    try { assert.deepEqual(f.shadows.snapshot(), before) }
    finally { f.parent.updateWorldMatrix = savedUpdate; f.floor.raycast = savedRay }
    assert.ok(Object.isFrozen(before.residents)); assert.ok(Object.isFrozen(before.residents[0].normal))
    assert.throws(() => { before.residents[0].position[0] = 100 }, TypeError)
    const resources = [f.mesh.geometry, f.mesh.material, f.mesh.material.map], disposals = [0, 0, 0]
    resources.forEach((resource, i) => resource.addEventListener('dispose', () => disposals[i]++))
    f.shadows.dispose(); f.shadows.dispose(); f.shadows.update()
    // Emulate NPC clearCurrent detaching before registry release's final traversal.
    f.parent.removeFromParent(); registry.release(f.root)
    assert.deepEqual(disposals, [1, 1, 1]); assert.equal(f.shadows.snapshot().residents.length, 0)
    assert.equal(f.parent.getObjectByName('NPC_ContactShadow_A'), undefined)
    assert.equal(resources[2].image, null); assert.equal(f.shadows.add(f.card), false)
  } finally { registry.dispose(); f.cleanup() }
})
