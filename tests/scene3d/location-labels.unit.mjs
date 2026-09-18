import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { createLocationLabels } from '../../scene3d/src/location-labels.js'
import { INTERIOR_SCENES } from '../../scene3d/src/interior-scenes.js'

const require = createRequire(new URL('../../scene3d/package.json', import.meta.url))
const THREE = await import(pathToFileURL(path.join(path.dirname(require.resolve('three')), 'three.module.js')).href)
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`)
function dom() {
  const doc = { createElement(tagName) { return { tagName, ownerDocument: doc, children: [], style: {}, dataset: {}, hidden: false,
    setAttribute(name, value) { this[name] = value },
    appendChild(child) { this.children.push(child); child.parentNode = this },
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null },
  } } }
  const container = doc.createElement('div'); container.clientWidth = 800; container.clientHeight = 600
  return container
}
function location(id = 'library', name) {
  const group = new THREE.Group()
  group.userData = { category: 'location', interactionId: id, label: name }
  const model = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial())
  model.name = `${id}_matte`; group.add(model)
  return group
}
function fixture(camera = new THREE.OrthographicCamera(-10, 10, 7.5, -7.5, .1, 100)) {
  const container = dom(), root = new THREE.Group(), model = location()
  root.add(model)
  camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0); camera.updateProjectionMatrix()
  const labels = createLocationLabels({ THREE, container, camera })
  const layer = container.children[0]
  return { container, root, model, camera, labels, layer, show() { labels.bind(root, 'main'); labels.setVisible(true) },
    dispose() { labels.dispose(); root.traverse(node => { node.geometry?.dispose(); node.material?.dispose() }) } }
}

test('main labels cover 11 authored locations, suppress only guest name, never environment or absent models', () => {
  const f = fixture()
  try {
    f.root.remove(f.model); f.model.children[0].geometry.dispose(); f.model.children[0].material.dispose()
    for (const id of Object.keys(INTERIOR_SCENES)) f.root.add(location(id))
    const env = location('library', 'not a location'); env.userData.category = 'environment'; f.root.add(env)
    const unknown = location('unknown'); f.root.add(unknown)
    const duplicate = location('library'); f.root.add(duplicate)
    f.show()
    assert.equal(f.labels.getStats().count, 11)
    assert.equal(f.labels.getStats().labels.find(item => item.sceneId === 'guest_quarters'), undefined)
    const guest = f.root.children.find(node => node.userData.interactionId === 'guest_quarters')
    assert.equal(guest.visible, true); assert.equal(guest.children[0].visible, true)
    assert.equal(guest.parent, f.root); assert.equal(guest.children.length, 1)
    assert.equal(f.layer['aria-hidden'], 'true')
    for (const label of f.layer.children) { assert.equal(label.tagName, 'span'); assert.equal(label.style.pointerEvents, 'none'); assert.equal(label.tabIndex, undefined) }
    f.labels.bind(f.root, 'library'); f.labels.setVisible(true)
    assert.equal(f.labels.getStats().count, 0); assert.equal(f.layer.hidden, true)
    f.labels.bind(null, 'main'); assert.equal(f.labels.getStats().count, 0)
  } finally { f.dispose() }
})

test('anchors use transformed solid-model top-center, not foliage or screen-space guesses', () => {
  const f = fixture()
  try {
    f.root.position.set(1, 2, 0); f.root.rotation.y = .6; f.root.scale.set(1.2, 1.5, .8)
    f.model.position.set(2, 0, 0)
    const foliage = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20), new THREE.MeshBasicMaterial())
    foliage.name = 'library_foliage'; foliage.position.set(20, 30, 0); f.model.add(foliage)
    f.show()
    const bounds = new THREE.Box3().setFromObject(f.model.children[0]), expected = bounds.getCenter(new THREE.Vector3())
    expected.y = bounds.max.y; expected.project(f.camera)
    const label = f.layer.children[0]
    close(parseFloat(label.style.left), (expected.x + 1) * 400)
    close(parseFloat(label.style.top), (1 - expected.y) * 300)
    const before = parseFloat(label.style.left)
    f.root.position.x += 2; f.labels.update()
    close(parseFloat(label.style.left) - before, 80)
  } finally { f.dispose() }
})

test('camera motion, zoom and resized CSS viewport reproject without DPR dependence', () => {
  const f = fixture()
  try {
    f.model.position.x = 2; f.show(); const label = f.layer.children[0]
    close(parseFloat(label.style.left), 480)
    f.camera.position.x = 1; f.labels.update(); close(parseFloat(label.style.left), 440)
    f.camera.zoom = 2; f.camera.updateProjectionMatrix(); f.labels.update(); close(parseFloat(label.style.left), 480)
    f.container.clientWidth = 400; f.container.clientHeight = 300; f.labels.update()
    close(parseFloat(label.style.left), 240); close(parseFloat(label.style.top), 110)
    f.container.clientWidth = 0; f.labels.update(); assert.equal(label.hidden, true)
    f.container.clientWidth = 400; f.labels.update(); assert.equal(label.hidden, false)
  } finally { f.dispose() }
})

for (const kind of ['orthographic', 'perspective']) test(`${kind} hides behind-camera, clipped and hidden-model names`, () => {
  // Negative ortho near ensures the explicit camera-space test is necessary.
  const camera = kind === 'orthographic' ? new THREE.OrthographicCamera(-10, 10, 7.5, -7.5, -10, 100) : new THREE.PerspectiveCamera(60, 4 / 3, .1, 100)
  const f = fixture(camera)
  try {
    f.show(); const label = f.layer.children[0]; assert.equal(label.hidden, false)
    f.model.position.z = 15; f.labels.update(); assert.equal(label.hidden, true)
    f.model.position.set(100, 0, 0); f.labels.update(); assert.equal(label.hidden, true)
    f.model.position.set(0, 0, -200); f.labels.update(); assert.equal(label.hidden, true)
    f.model.position.set(0, 0, 0); f.root.visible = false; f.labels.update(); assert.equal(label.hidden, true)
    f.root.visible = true; f.labels.update(); assert.equal(label.hidden, false)
  } finally { f.dispose() }
})

test('authored names are plain text; visibility, rebind and dispose leave no stale labels', () => {
  const f = fixture()
  try {
    f.model.userData.label = '<b>藏经阁</b>'; f.show()
    assert.equal(f.layer.children[0].textContent, '<b>藏经阁</b>'); assert.equal(f.layer.children[0].innerHTML, undefined)
    f.labels.setVisible(false); assert.equal(f.layer.hidden, true)
    f.model.position.x = 2; f.labels.setVisible(true); close(parseFloat(f.layer.children[0].style.left), 480)
    f.labels.bind(f.root, 'main'); f.labels.setVisible(true); assert.equal(f.layer.children.length, 1)
    f.labels.clear(); assert.equal(f.layer.children.length, 0); assert.equal(f.layer.hidden, true)
    f.show(); f.labels.dispose(); f.labels.dispose(); f.labels.update(); f.labels.bind(f.root, 'main'); f.labels.setVisible(true)
    assert.equal(f.container.children.length, 0); assert.equal(f.labels.getStats().count, 0); assert.equal(f.labels.getStats().disposed, true)
  } finally { f.dispose() }
})

const pavilionRoof = new THREE.Vector3(19.8, 10.08, -15.8)
const gateRoof = new THREE.Vector3(0, 13.054235, 13.1)
function meshFromBounds(name, min, max) {
  const box = new THREE.Box3(new THREE.Vector3().fromArray(min), new THREE.Vector3().fromArray(max)), size = box.getSize(new THREE.Vector3())
  const geometry = new THREE.BoxGeometry(size.x, size.y, size.z), center = box.getCenter(new THREE.Vector3())
  geometry.translate(center.x, center.y, center.z)
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()); mesh.name = name
  return mesh
}
function initialMapCamera(width, height) {
  const aspect = width / height, span = 40 * Math.max(1, 1.36 / aspect), offset = aspect > 1 ? -1.2 : 0
  const camera = new THREE.OrthographicCamera(-span * aspect / 2, span * aspect / 2, span / 2 + offset, -span / 2 + offset, .1, 420)
  camera.position.set(10.39, 44.82, 53.63); camera.zoom = 1.24
  camera.lookAt(-.19, 10.49, -4.74); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true)
  return camera
}

for (const [id, roof, min, max] of [
  ['back_mountain', pavilionRoof, [9.7, -20, -42], [43, 18.2656, -3]],
  ['gate', gateRoof, [-6.7736, -21.339, 11.23235], [6.7736, 13.054326, 45.83255]],
]) test(`${id} roof follows root, location and matte transforms, never a screen clamp`, () => {
  const camera = initialMapCamera(800, 600), container = dom(), root = new THREE.Group(), mountain = new THREE.Group()
  camera.zoom = .7; camera.updateProjectionMatrix()
  mountain.userData = { category: 'location', interactionId: id }
  const matte = meshFromBounds(`${id}_matte`, min, max)
  mountain.add(matte); root.add(mountain)
  const labels = createLocationLabels({ THREE, container, camera })
  try {
    labels.bind(root, 'main'); labels.setVisible(true)
    let label = container.children[0].children[0]
    const assertPosition = () => {
      const p = roof.clone().applyMatrix4(matte.matrixWorld).project(camera)
      assert.equal(label.hidden, false)
      close(parseFloat(label.style.left), (p.x + 1) * container.clientWidth / 2)
      close(parseFloat(label.style.top), (1 - p.y) * container.clientHeight / 2)
    }
    assertPosition()
    root.position.set(-1, 2, 1); root.rotation.y = .12; root.scale.set(.9, 1.1, .95)
    mountain.position.set(-2, 0, 1); labels.update(); assertPosition()
    matte.position.set(1, 2, -1); matte.rotation.y = -.08; matte.scale.set(.95, 1.1, .9)
    labels.update(); assertPosition()
    // Rebinding under existing transforms must retain the same local landmark.
    labels.bind(root, 'main'); labels.setVisible(true)
    label = container.children[0].children[0]; assertPosition()
    root.position.x = 500; labels.update(); assert.equal(label.hidden, true, 'off-frustum marker must not clamp to viewport')
    root.position.x = -1; root.visible = false; labels.update(); assert.equal(label.hidden, true)
    root.visible = true; labels.update(); assertPosition()
  } finally { labels.dispose(); root.traverse(n => { n.geometry?.dispose(); n.material?.dispose() }) }
})

for (const id of ['gate', 'back_mountain']) test(`small replacement ${id} uses own bounds instead of an absent roof`, () => {
  const f = fixture()
  try {
    f.model.userData.interactionId = id; f.model.children[0].name = `${id}_matte`
    f.show(); const label = f.layer.children[0]
    const p = new THREE.Vector3(0, 1, 0).project(f.camera)
    assert.equal(label.hidden, false); close(parseFloat(label.style.left), (p.x + 1) * 400); close(parseFloat(label.style.top), (1 - p.y) * 300)
  } finally { f.dispose() }
})

test('real GLB arch roof and east pavilion finial validate landmarks, not stairs/bridge/terrain', async t => {
  const base = new URL('../../assets/sect3d/integration-013/', import.meta.url)
  const bytes = await readFile(new URL('sect_diorama.glb', base))
  const length = bytes.readUInt32LE(12), gltf = JSON.parse(bytes.toString('utf8', 20, 20 + length)), binary = bytes.subarray(28 + length)
  const authored = gltf.nodes.find(n => n.extras?.interactionId === 'back_mountain')
  assert.deepEqual(authored.children.map(i => gltf.nodes[i].name).sort(), ['back_mountain_foliage', 'back_mountain_matte'])
  const factory = require(fileURLToPath(new URL('draco/draco_wasm_wrapper.js', base)))
  const draco = await factory({ wasmBinary: await readFile(new URL('draco/draco_decoder.wasm', base)) })
  const root = new THREE.Group()
  try {
    for (const id of ['gate', 'back_mountain']) {
      const matte = gltf.nodes.find(n => n.name === `${id}_matte`), primitive = gltf.meshes[matte.mesh].primitives[0]
      const compressed = primitive.extensions.KHR_draco_mesh_compression, view = gltf.bufferViews[compressed.bufferView]
      const decoder = new draco.Decoder(), buffer = new draco.DecoderBuffer(), mesh = new draco.Mesh()
      const values = new draco.DracoFloat32Array(), colors = new draco.DracoFloat32Array()
      try {
        const chunk = binary.subarray(view.byteOffset, view.byteOffset + view.byteLength)
        buffer.Init(chunk, chunk.length)
        const status = decoder.DecodeBufferToMesh(buffer, mesh); assert.ok(status.ok(), status.error_msg())
        decoder.GetAttributeFloatForAllPoints(mesh, decoder.GetAttributeByUniqueId(mesh, compressed.attributes.POSITION), values)
        const color = decoder.GetAttributeByUniqueId(mesh, compressed.attributes.COLOR_0)
        decoder.GetAttributeFloatForAllPoints(mesh, color, colors)
        const positions = new Float32Array(mesh.num_points() * 3), tops = new Map(), finial = new THREE.Box3(), trim = new THREE.Box3()
        let finialCount = 0
        for (let i = 0; i < mesh.num_points(); i++) {
          const p = new THREE.Vector3(values.GetValue(i * 3), values.GetValue(i * 3 + 1), values.GetValue(i * 3 + 2))
          p.toArray(positions, i * 3)
          if (id === 'gate' && p.y > 13.05) tops.set(p.toArray().join(','), p)
          const rgb = [0, 1, 2].map(k => colors.GetValue(i * color.num_components() + k).toFixed(2)).join(',')
          if (id === 'back_mountain' && p.y > 9) {
            if (rgb === '0.62,0.41,0.12') { finial.expandByPoint(p); finialCount++ }
            if (rgb === '0.35,0.32,0.23') trim.expandByPoint(p)
          }
        }
        if (id === 'gate') {
          assert.equal(tops.size, 4, 'Symmetric highest arch roof ornaments, not staircase bounds')
          const midpoint = [...tops.values()].reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(tops.size)
          assert.ok(midpoint.distanceTo(gateRoof) < .001)
          t.diagnostic(JSON.stringify({ gateRoofMidpoint: midpoint.toArray(), anchor: gateRoof.toArray() }))
        } else {
          assert.equal(finialCount, 36, 'Actual pavilion gold finial vertices')
          const top = finial.getCenter(new THREE.Vector3()); top.y = finial.max.y
          assert.ok(top.distanceTo(pavilionRoof) < .001)
          assert.ok(Math.abs(trim.min.x - 18.151636) < .001 && Math.abs(trim.max.x - 21.448502) < .001)
          assert.ok(Math.abs(trim.min.z + 17.267567) < .001 && Math.abs(trim.max.z + 14.332525) < .001)
          assert.ok(Math.abs(trim.max.y - 10.059189) < .001 && top.y > trim.max.y)
          assert.ok(pavilionRoof.distanceTo(new THREE.Vector3(12.05, 7.77, -7.4)) > 10, 'Not the old bridge entrance')
          t.diagnostic(JSON.stringify({ pavilionFinialTop: top.toArray(), anchor: pavilionRoof.toArray(), roofTrim: [trim.min.toArray(), trim.max.toArray()] }))
        }
        const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        const model = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()); model.name = `${id}_matte`
        const group = new THREE.Group(); group.userData = { category: 'location', interactionId: id }; group.add(model); root.add(group)
      } finally { for (const resource of [colors, values, mesh, buffer, decoder]) draco.destroy(resource) }
    }
    for (const [width, height] of [[1272, 810], [388, 240]]) {
      const container = dom(); container.clientWidth = width; container.clientHeight = height
      const camera = initialMapCamera(width, height), labels = createLocationLabels({ THREE, container, camera })
      try {
        labels.bind(root, 'main'); labels.setVisible(true)
        assert.equal(labels.getStats().count, 2)
        for (const [id, roof] of [['gate', gateRoof], ['back_mountain', pavilionRoof]]) {
          const label = container.children[0].children.find(l => l.dataset.sceneId === id)
          const p = roof.clone().project(camera)
          const inside = Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && Math.abs(p.z) <= 1
          assert.equal(label.hidden, !inside, 'Actual roof can leave the frustum; never substitute bridge or clamp')
          if (inside) {
            close(parseFloat(label.style.left), (p.x + 1) * width / 2)
            close(parseFloat(label.style.top), (1 - p.y) * height / 2)
          } else assert.equal(label.style.left, undefined, 'No screen-edge substitute')
          t.diagnostic(JSON.stringify({ viewport: [width, height], id, roofNdc: p.toArray(), visible: inside }))
        }
      } finally { labels.dispose() }
    }
  } finally { root.traverse(n => { n.geometry?.dispose(); n.material?.dispose() }) }
})
