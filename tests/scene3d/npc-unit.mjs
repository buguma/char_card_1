import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import http from 'node:http'
import { launchBrowser } from '../../scene3d/scripts/test-support.mjs'
import { currentRelease } from './current-release.mjs'
import { createNpcController, alphaBounds, frameAt } from '../../scene3d/src/npcs.js'
import { createFloorSampler, findNpcFloor, seededRandom, layoutSeed, placeNpcs, cardSize, minimumSeparation, cardsOverlap } from '../../scene3d/src/npc-spawn.js'
import { npcHeight, createNpcSizing } from '../../scene3d/src/npc-sizing.js'

// Resolve test Three through the isolated scene3d package, never root dependencies.
const require = createRequire(new URL('../../scene3d/package.json', import.meta.url))
const THREE = await import(pathToFileURL(path.join(path.dirname(require.resolve('three')), 'three.module.js')).href)
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
class Element {
  constructor(doc, tag = 'div') { this.ownerDocument = doc; this.tagName = tag; this.children = []; this.style = {}; this.dataset = {}; this.listeners = new Map(); this.hidden = false }
  appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null }
  setAttribute() {}
  addEventListener(type, fn) { this.listeners.set(type, fn) }
  removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type) }
  click() { this.listeners.get('click')?.({ stopPropagation() {} }) }
  getBoundingClientRect() { return { left: 80, top: 100, width: 200, height: 32 } }
}
function image(width = 8, height = 8, alpha = null) {
  const data = { image: { close() { data.closed++ } }, width, height, alpha: alpha || new Uint8Array(width * height).fill(255), alphaWidth: width, alphaHeight: height,
    closed: 0, releasedCount: 0, dispose() { data.releasedCount++ } }
  return data
}
const visual = (id, extra = {}) => ({ gameNpcId: id, visualKind: 'static', visualKey: `portrait:${id}`, portraitUrl: `https://fixture.test/${id}.png`, heightMeters: 1.5, ...extra })
function snapshot(npcs = [visual('A')], patch = {}) {
  return { sessionEpoch: 1, revision: 1, sceneId: 'library', layoutKey: `library:${npcs.map(n => n.gameNpcId).join(',')}`,
    renderedNpcs: npcs, residents: npcs.map(n => ({ gameNpcId: n.gameNpcId, displayName: `名字${n.gameNpcId}` })),
    environment: { hour: 12 }, visible: true, interactive: true, renderEnabled: true, blockReasons: [], ...patch }
}
function room(size = 20) {
  const root = new THREE.Group(), floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial())
  floor.name = 'floor'; floor.userData.npcSpawn = { authored: true }; floor.visible = false; root.add(floor)
  return root
}
function fixture(options = {}) {
  const doc = { defaultView: {}, createElement(tag) { return new Element(doc, tag) } }
  const container = new Element(doc), canvas = new Element(doc, 'canvas')
  canvas.getBoundingClientRect = () => ({ left: 40, top: 60, width: 400, height: 300 })
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-5, 5, 3.75, -3.75, .1, 100)
  camera.position.set(0, 8, 8); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true)
  const renderer = { domElement: canvas, capabilities: { maxTextureSize: 2048 } }, images = [], intents = []
  const controller = createNpcController({ scene, camera, renderer, container, assetBaseUrl: 'https://fixture.test/assets/v1/',
    emitNpcIntent: event => intents.push(event), loadImage: async () => { const value = image(); images.push(value); return value },
    placement: (_floor, npcs) => npcs.map((npc, i) => ({ npc, point: new THREE.Vector3((i - (npcs.length - 1) / 2) * 3, 0, 0) })), ...options })
  const root = room(); scene.add(root)
  return { controller, scene, camera, renderer, container, root, images, intents }
}
function cleanup(f) { f.controller.dispose(); f.scene.traverse(o => { o.geometry?.dispose(); o.material?.dispose() }) }
const atlas = (id = 'dongting', extra = {}) => ({ id, height: 1.3, frameCount: 2, delays: [100, 200], durationMs: 300, bounds: [0, 0, 2, 4],
  width: 2, heightPixels: 4, cellWidth: 2, cellHeight: 4, columns: 2, padding: 0,
  sheets: [{ file: `npc/generated/${id}-0.png`, first: 0, count: 2, width: 4, height: 4 }], ...extra })

test('NPC modules import without DOM lookup or event binding', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, get() { throw Error('Unexpected DOM access') } })
  try { assert.equal(typeof (await import('../../scene3d/src/npcs.js?inert')).createNpcController, 'function') }
  finally { if (saved) Object.defineProperty(globalThis, 'document', saved); else delete globalThis.document }
})

test('seeded placement never consults global random and is stable for a layoutKey', () => {
  const root = room(), camera = new THREE.OrthographicCamera(-10, 10, 10, -10, .1, 100)
  camera.position.set(0, 10, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true)
  const npcs = [{ height: 1.5, bounds: [0, 0, 2, 4] }, { height: 1.5, bounds: [0, 0, 2, 4] }]
  const old = Math.random
  try {
    Math.random = () => { throw Error('Business random must not be consumed') }
    const first = placeNpcs(findNpcFloor(root), npcs, camera, seededRandom(layoutSeed('epoch:library:A,D')))
    const second = placeNpcs(findNpcFloor(root), npcs, camera, seededRandom(layoutSeed('epoch:library:A,D')))
    assert.deepEqual(first.map(p => p.point.toArray()), second.map(p => p.point.toArray()))
    assert.notEqual(layoutSeed('epoch:library:A,D'), layoutSeed('next:library:A,D'))
  } finally { Math.random = old; root.children[0].geometry.dispose(); root.children[0].material.dispose() }
})

test('one to three residents preserve the exact legacy seed stream and feet', () => {
  const root = room(10), floor = findNpcFloor(root), camera = new THREE.OrthographicCamera(-10, 10, 10, -10, .1, 100)
  camera.position.set(0, 10, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true)
  function legacy(npcs, random) {
    const sampler = createFloorSampler(floor)
    for (let attempt = 0; attempt < 40; attempt++) {
      const placed = []
      for (const npc of npcs) {
        let found = false
        for (let trial = 0; trial < 600; trial++) {
          const point = sampler.sample(random)
          if (placed.every(other => Math.hypot(point.x - other.point.x, point.z - other.point.z) >= minimumSeparation(npc, other.npc, camera) && !cardsOverlap(npc, point, other.npc, other.point, camera))) {
            placed.push({ npc, point }); found = true; break
          }
        }
        if (!found) break
      }
      if (placed.length === npcs.length) return placed
    }
    throw Error('NPC_FLOOR_CROWDED')
  }
  try {
    for (const count of [1, 2, 3]) for (let seed = 0; seed < 20; seed++) {
      const npcs = Array.from({ length: count }, (_, i) => ({ height: 1.5 + i * .4, bounds: [0, 0, 1, 2] }))
      const a = seededRandom(seed), b = seededRandom(seed)
      const actual = placeNpcs(floor, npcs, camera, a), expected = legacy(npcs, b)
      assert.deepEqual(actual.map(n => n.point.toArray()), expected.map(n => n.point.toArray()))
      assert.equal(a(), b(), 'Consumes exactly the legacy number of random values')
      assert.ok(actual.every(n => n.scale === undefined), 'No density branch for legacy rosters')
    }
  } finally { floor.geometry.dispose(); floor.material.dispose() }
})

test('only authored upward floor meshes are sampled, including world transforms', () => {
  const root = room(); root.position.set(3, 2, -4)
  const floor = findNpcFloor(root), sampler = createFloorSampler(floor)
  const point = sampler.sample(seededRandom(1)); assert.ok(Math.abs(point.y - 2) < 1e-5)
  assert.throws(() => sampler.sample(), /explicit private/)
  floor.userData.npcSpawn = false; assert.equal(findNpcFloor(root), null)
  assert.throws(() => createFloorSampler(floor), /FLOOR_MISSING/)
  floor.geometry.dispose(); floor.material.dispose()
})

test('crowding is bounded and failure does not redraw the host NPC subset', () => {
  const root = room(.1), floor = findNpcFloor(root), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10)
  camera.position.set(0, 2, 2); camera.lookAt(0, 0, 0)
  let draws = 0; const random = () => { draws++; return .5 }
  const npcs = [0, 1].map(id => ({ id, height: 1.5, bounds: [0, 0, 1, 2] }))
  assert.throws(() => placeNpcs(floor, npcs, camera, random, { attempts: 2, trials: 3 }), /CROWDED/)
  assert.ok(draws <= 2 * 2 * 3 * 3); assert.deepEqual(npcs.map(n => n.id), [0, 1])
  floor.geometry.dispose(); floor.material.dispose()
})

test('dense candidate placement is bounded and does not relax overlap on impossible authored floors', () => {
  const root = room(.1), floor = findNpcFloor(root), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10)
  camera.position.set(0, 2, 2); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true)
  let draws = 0; const random = () => { draws++; return .5 }
  try {
    assert.throws(() => placeNpcs(floor, Array.from({ length: 15 }, () => ({ height: 2.4, bounds: [0, 0, 1, 2] })), camera, random, { attempts: 4, trials: 12 }), /CROWDED/)
    assert.equal(draws, 12 * 3, 'Fixed floor pool, no unbounded random retry or fabricated points')
  } finally { floor.geometry.dispose(); floor.material.dispose() }
})

test('sizing and alpha bounds are pure, validated, and use image aspect not atlas assumptions', () => {
  assert.equal(npcHeight(NaN), 1.5); assert.equal(npcHeight(1.7), 1.7)
  const sizing = createNpcSizing([{ id: 'A', height: 1.5 }], ['library'])
  assert.equal(sizing.setHeight('A', 1.8), true); assert.equal(sizing.effectiveHeight('A', 'library'), 1.8)
  assert.equal(sizing.setHeight('Z', 1.5), false)
  const alpha = new Uint8Array(4 * 8); for (let y = 1; y < 7; y++) { alpha[y * 4 + 1] = alpha[y * 4 + 2] = 255 }
  assert.deepEqual(alphaBounds(alpha, 4, 8), [1, 1, 3, 7])
  assert.throws(() => alphaBounds(new Uint8Array(16), 4, 4), /EMPTY/)
  const camera = new THREE.OrthographicCamera(); const size = cardSize({ bounds: [1, 1, 3, 7], height: 1.5 }, camera)
  assert.equal(size.width, .5); assert.equal(frameAt({ kind: 'static' }, 99999), 0)
})

test('main map never loads or paints NPCs; static cards honor host subset and measured alpha', async () => {
  const f = fixture()
  try {
    await f.controller.bind(f.root, 'main', snapshot([visual('A')], { sceneId: 'main' }))
    assert.equal(f.controller.getStats().loads, 0); assert.equal(f.controller.getStats().cards, 0)
    const input = snapshot([visual('A'), visual('D')]); input.residents.push({ gameNpcId: 'E', displayName: '未选中' })
    assert.equal((await f.controller.bind(f.root, 'library', input)).cards, 2)
    assert.deepEqual(f.controller.getStats().residents.map(n => n.gameNpcId), ['A', 'D'])
    const feet = f.controller.getStats().residents.map(n => n.foot)
    await f.controller.update({ ...input, revision: 2, environment: { hour: 23 } })
    assert.deepEqual(f.controller.getStats().residents.map(n => n.foot), feet); assert.equal(f.controller.getStats().loads, 2)
    input.renderedNpcs[0].gameNpcId = 'E'; assert.equal(f.controller.getStats().residents[0].gameNpcId, 'A')
  } finally { cleanup(f) }
})

test('three original animated identities resolve local manifest and atlas frames', async () => {
  const requested = [], images = []
  const f = fixture({ fetch: async url => { requested.push(url); return { ok: true, json: async () => ({ version: 1, npcs: ['dongting', 'qiantang', 'anmu'].map(id => atlas(id)) }) } },
    loadImage: async url => { requested.push(url); const value = image(4, 4); images.push(value); return value } })
  try {
    const npcs = [['B', 'dongting'], ['C', 'qiantang'], ['I', 'anmu']].map(([id, key]) => visual(id, { visualKind: 'animated', visualKey: key }))
    assert.equal((await f.controller.bind(f.root, 'library', snapshot(npcs))).cards, 3)
    assert.equal(requested.filter(url => url.endsWith('manifest.json')).length, 1)
    for (const id of ['dongting', 'qiantang', 'anmu']) assert.ok(requested.includes(`https://fixture.test/assets/v1/npc/generated/${id}-0.png`))
    f.controller.tick(100, .1); assert.deepEqual(f.controller.getStats().residents.map(n => n.frame), [1, 1, 1])
    f.controller.tick(200, .1); f.controller.tick(300, .1); assert.equal(f.controller.getStats().residents[0].frame, 0)
  } finally { cleanup(f) }
  for (const img of images) { assert.equal(img.releasedCount, 1); assert.equal(img.closed, 1); assert.equal(img.alpha, null) }
})

test('alpha picking returns client CSS anchor, never emits or hits transparent gaps', async () => {
  const alpha = new Uint8Array(8 * 8).fill(255); for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) alpha[y * 8 + x] = 0
  const f = fixture({ loadImage: async () => image(8, 8, alpha) })
  try {
    await f.controller.bind(f.root, 'library', snapshot())
    const card = f.root.getObjectByName('Scene3D_NPC_A')
    function client(x, y) { const p = new THREE.Vector3(x, y, 0).applyMatrix4(card.matrixWorld).project(f.camera); return [40 + (p.x + 1) * 200, 60 + (1 - p.y) * 150] }
    assert.equal(f.controller.pick(...client(0, .5)), null)
    const hit = f.controller.pick(...client(-.4, .5))
    assert.equal(hit.gameNpcId, 'A'); assert.equal(hit.anchor.space, 'client-css-px'); assert.ok(hit.anchor.left >= 40); assert.ok(hit.anchor.top >= 60); assert.ok(hit.anchor.width > 0)
    assert.equal(f.intents.length, 0)
    await f.controller.update(snapshot(undefined, { interactive: false })); assert.equal(f.controller.pick(...client(-.4, .5)), null)
  } finally { cleanup(f) }
})

test('resident diagnostic anchors are immutable projections, not alpha hits or scene mutations', async () => {
  const alpha = new Uint8Array(64).fill(255)
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) alpha[y * 8 + x] = 0
  const f = fixture({ loadImage: async () => image(8, 8, alpha) })
  try {
    const input = snapshot(); input.residents.push({ gameNpcId: 'D', displayName: 'Not selected' })
    await f.controller.bind(f.root, 'library', input)
    const card = f.root.getObjectByName('Scene3D_NPC_A'), before = f.controller.getStats()
    const matrix = [...card.matrixWorld.elements], cameraMatrix = [...f.camera.matrixWorld.elements]
    const random = Math.random, updateCard = card.updateWorldMatrix, updateCamera = f.camera.updateMatrixWorld
    let sampled
    try {
      Math.random = () => { throw Error('Diagnostic sampling must not draw random') }
      card.updateWorldMatrix = f.camera.updateMatrixWorld = () => { throw Error('Diagnostic sampling must not update the scene') }
      sampled = f.controller.getStats()
    } finally { Math.random = random; card.updateWorldMatrix = updateCard; f.camera.updateMatrixWorld = updateCamera }
    assert.deepEqual(sampled, before); assert.deepEqual(sampled.residents.map(n => n.gameNpcId), ['A'])
    assert.deepEqual(card.matrixWorld.elements, matrix); assert.deepEqual(f.camera.matrixWorld.elements, cameraMatrix)
    const bounds = sampled.residents[0].anchor
    assert.ok(Object.isFrozen(bounds)); assert.equal(bounds.space, 'client-css-px')
    assert.ok(bounds.left >= 40 && bounds.top >= 60 && bounds.width > 0 && bounds.height > 0)
    assert.throws(() => { bounds.left = 0 }, TypeError)
    assert.equal(f.controller.pick(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2), null, 'Transparent center inside bounds must still miss')
    const rect = f.renderer.domElement.getBoundingClientRect
    f.renderer.domElement.getBoundingClientRect = () => ({ left: 40, top: 60, width: 0, height: 0 })
    assert.equal(f.controller.getStats().residents[0].anchor, null)
    f.renderer.domElement.getBoundingClientRect = rect
    assert.equal(f.intents.length, 0)
  } finally { cleanup(f) }
})

test('same-role fallback stays accessible but never offers unselected residents', async () => {
  const f = fixture({ loadImage: async () => { throw Error('404') } })
  try {
    const input = snapshot(); input.residents.push({ gameNpcId: 'D', displayName: '未选中D' })
    await f.controller.bind(f.root, 'library', input)
    const stats = f.controller.getStats(); assert.equal(stats.cards, 0); assert.deepEqual(stats.fallbacks.map(n => n.gameNpcId), ['A'])
    assert.equal(f.container.children.length, 1); const button = f.container.children[0].children[0]
    assert.equal(button.textContent, '名字A · 人物信息'); button.click(); assert.equal(f.intents[0].gameNpcId, 'A')
    assert.deepEqual(f.intents[0].anchor, { space: 'client-css-px', left: 80, top: 100, width: 200, height: 32 })
    await f.controller.update({ ...input, interactive: false }); button.click(); assert.equal(f.intents.length, 1); assert.equal(button.disabled, true)
    f.controller.dispose(); assert.equal(button.listeners.size, 0); assert.equal(f.container.children.length, 0)
  } finally { cleanup(f) }
})

test('missing floor or oversized/empty static image becomes same-NPC fallback', async () => {
  const f = fixture(); f.root.children[0].name = 'not_floor'
  try { assert.equal((await f.controller.bind(f.root, 'library', snapshot())).fallbacks, 1); assert.equal(f.controller.getStats().cards, 0) } finally { cleanup(f) }
  for (const data of [image(4096, 1), image(8, 8, new Uint8Array(64))]) {
    const next = fixture({ loadImage: async () => data })
    try { assert.equal((await next.controller.bind(next.root, 'library', snapshot())).fallbacks, 1); assert.equal(data.releasedCount, 1) } finally { cleanup(next) }
  }
})

test('latest bind wins immediately and late A decode never clears B', async () => {
  const pending = defer(), late = image()
  const f = fixture({ loadImage: async url => url.endsWith('/A.png') ? pending.promise : image() })
  try {
    const a = f.controller.bind(f.root, 'library', snapshot()); await flush()
    const rootB = room(); f.scene.add(rootB)
    const b = await f.controller.bind(rootB, 'kitchen', snapshot([visual('D')], { sceneId: 'kitchen' }))
    assert.equal(b.cards, 1); assert.equal((await a).status, 'superseded')
    pending.resolve(late); await flush()
    assert.equal(f.controller.getStats().sceneId, 'kitchen'); assert.deepEqual(f.controller.getStats().residents.map(n => n.gameNpcId), ['D'])
    assert.equal(late.releasedCount, 1); assert.equal(f.root.getObjectByName('Scene3D_NPCs'), undefined)
  } finally { pending.resolve(late); cleanup(f) }
})

test('partial atlas failure disposes successful sheets; no unhandled pending work', async () => {
  const first = image(2, 4)
  const f = fixture({ fetch: async () => ({ ok: true, json: async () => ({ version: 1, npcs: [atlas('dongting', { columns: 1,
    sheets: [{ file: 'npc/generated/dongting-0.png', first: 0, count: 1, width: 2, height: 4 }, { file: 'npc/generated/dongting-1.png', first: 1, count: 1, width: 2, height: 4 }] })] }) }),
    loadImage: async url => { if (url.endsWith('-1.png')) throw Error('second sheet failed'); return first } })
  try {
    await f.controller.bind(f.root, 'library', snapshot([visual('B', { visualKind: 'animated' })]))
    assert.equal(f.controller.getStats().cards, 0); assert.equal(f.controller.getStats().fallbacks[0].gameNpcId, 'B')
    assert.equal(first.releasedCount, 1); assert.equal(first.alpha, null)
    assert.equal(f.controller.getStats().texturesCreated, f.controller.getStats().texturesDisposed)
  } finally { cleanup(f) }
})

test('shared texture views have independent geometry UVs and remain unchanged by animation', async () => {
  const f = fixture()
  try {
    await f.controller.bind(f.root, 'library', snapshot(['A', 'D'].map(id => visual(id, { visualKey: 'shared', portraitUrl: 'https://fixture.test/shared.png' }))))
    const a = f.root.getObjectByName('Scene3D_NPC_A'), d = f.root.getObjectByName('Scene3D_NPC_D')
    assert.equal(a.material.map, d.material.map); assert.notEqual(a.geometry, d.geometry); assert.notEqual(a.material, d.material)
    const before = d.geometry.attributes.uv.array.slice(); a.geometry.attributes.uv.setX(0, .37)
    assert.deepEqual(d.geometry.attributes.uv.array, before); assert.deepEqual(a.material.map.offset.toArray(), [0, 0]); assert.deepEqual(a.material.map.repeat.toArray(), [1, 1])
    assert.equal(f.controller.getStats().cachedAssets, 1); assert.equal(f.controller.getStats().loads, 1)
  } finally { cleanup(f) }
})

test('LRU retains the current and previous small subsets within its resident-safe budget, then destroys resources', async () => {
  const f = fixture()
  for (const ids of [['A', 'D', 'E'], ['F', 'G', 'H'], ['J', 'K', 'L']]) {
    await f.controller.bind(f.root, 'library', snapshot(ids.map(id => visual(id))))
    assert.ok(f.controller.getStats().cachedAssets <= f.controller.getStats().cacheBudget)
  }
  assert.equal(f.controller.getStats().cachedAssets, 6); assert.equal(f.controller.getStats().pinnedAssets, 3)
  assert.equal(f.controller.getStats().imagesDisposed, 3)
  f.controller.dispose(); f.controller.dispose(); await flush()
  const stats = f.controller.getStats()
  assert.equal(stats.cards, 0); assert.equal(stats.cachedAssets, 0); assert.equal(stats.alphaBytes, 0); assert.equal(stats.pendingLoads, 0)
  assert.equal(stats.texturesCreated, stats.texturesDisposed); assert.equal(stats.fallbackListeners, 0)
  for (const img of f.images) { assert.equal(img.releasedCount, 1); assert.equal(img.closed, 1) }
  assert.equal((await f.controller.bind(f.root, 'library', snapshot())).status, 'destroyed'); cleanup(f)
})

test('destroy and timeout settle even when an image decoder ignores abort', async () => {
  const pending = defer(), late = image(), f = fixture({ loadImage: async () => pending.promise })
  const loading = f.controller.bind(f.root, 'library', snapshot()); await flush(); f.controller.dispose()
  assert.equal((await loading).status, 'destroyed'); pending.resolve(late); await flush(); assert.equal(late.releasedCount, 1); cleanup(f)
  const timeout = defer(), lateTimeout = image(), g = fixture({ timeoutMs: 10, loadImage: async () => timeout.promise })
  try {
    assert.equal((await g.controller.bind(g.root, 'library', snapshot())).fallbacks, 1)
    timeout.resolve(lateTimeout); await flush(); assert.equal(lateTimeout.releasedCount, 1)
  } finally { timeout.resolve(lateTimeout); cleanup(g) }
})

test('default browser decoder closes bitmaps and releases full/alpha canvases on success or CORS failure', async () => {
  for (const corsFailure of [false, true]) {
    let closes = 0; const canvases = []
    const f = fixture({ loadImage: undefined, fetch: async () => ({ ok: true, blob: async () => ({}) }) })
    const doc = f.container.ownerDocument
    doc.defaultView.createImageBitmap = async () => ({ width: 8, height: 16, close() { closes++ } })
    doc.createElement = tag => {
      const element = new Element(doc, tag)
      if (tag === 'canvas') {
        canvases.push(element)
        element.getContext = () => ({ drawImage() {}, getImageData() {
          if (corsFailure) throw Error('SecurityError: tainted canvas')
          const data = new Uint8ClampedArray(element.width * element.height * 4)
          for (let i = 3; i < data.length; i += 4) data[i] = 255
          return { data }
        } })
      }
      return element
    }
    try {
      const result = await f.controller.bind(f.root, 'library', snapshot())
      assert.equal(closes, 1)
      assert.equal(result.cards, corsFailure ? 0 : 1)
      assert.equal(result.fallbacks, corsFailure ? 1 : 0)
      f.controller.dispose()
      assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0))
      assert.equal(f.controller.getStats().alphaBytes, 0)
    } finally { cleanup(f) }
  }
})

test('opaque scene props occlude NPC picking, and height-only changes do not reload or relocate', async () => {
  const f = fixture()
  try {
    await f.controller.bind(f.root, 'library', snapshot())
    const card = f.root.getObjectByName('Scene3D_NPC_A')
    const client = () => {
      const p = new THREE.Vector3(0, .5, 0).applyMatrix4(card.matrixWorld).project(f.camera)
      return [40 + (p.x + 1) * 200, 60 + (1 - p.y) * 150]
    }
    assert.equal(f.controller.pick(...client()).gameNpcId, 'A')
    const wall = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 1), new THREE.MeshBasicMaterial())
    wall.position.set(0, 1, 1); f.root.add(wall); wall.updateMatrixWorld(true)
    assert.equal(f.controller.pick(...client()), null)
    wall.removeFromParent(); wall.geometry.dispose(); wall.material.dispose()
    const foot = f.controller.getStats().residents[0].foot
    await f.controller.update(snapshot([visual('A', { heightMeters: 1.9 })], { revision: 2 }))
    assert.equal(f.controller.getStats().loads, 1); assert.equal(f.controller.getStats().residents[0].height, 1.9)
    assert.deepEqual(f.controller.getStats().residents[0].foot, foot)
  } finally { cleanup(f) }
})

test('real library/atlas/portrait failing seeds have reachable pixels and deliver canvas intents', { timeout: 90000 }, async t => {
  const workspace = fileURLToPath(new URL('../../', import.meta.url))
  const { pointer } = await currentRelease(workspace)
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      if (pathname === '/') {
        response.setHeader('Content-Type', 'text/html')
        response.end('<!doctype html><link rel="stylesheet" href="/scene3d/src/scene3d.css"><script type="importmap">{"imports":{"three":"/scene3d/node_modules/three/build/three.module.js","three/addons/":"/scene3d/node_modules/three/examples/jsm/"}}</script>')
        return
      }
      const filename = path.resolve(workspace, `.${pathname}`)
      assert.ok(filename.startsWith(path.resolve(workspace) + path.sep))
      response.setHeader('Content-Type', /\.(m?js)$/.test(pathname) ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream')
      response.end(await fs.readFile(filename))
    } catch { response.statusCode = 404; response.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser, context
  t.after(async () => {
    try { await context?.close(); await browser?.close() }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  })
  browser = await launchBrowser(); context = await browser.createBrowserContext()
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.exposeFunction('__npcNativeClickForTest', (x, y) => page.mouse.click(x, y))
  const results = await page.evaluate(async buildId => {
    const THREE = await import('three')
    const { mount } = await import('/scene3d/src/runtime.js')
    const { createNpcController } = await import('/scene3d/src/npcs.js')
    const host = document.createElement('div')
    Object.assign(host.style, { position: 'relative', width: '382px', height: '259px' })
    host.className = 'scene3d-root'; document.body.appendChild(host)
    const results = []
    for (const [id, epoch, name, kind, visualKey] of [['C', 4, '钱塘君', 'animated', 'qiantang'], ['A', 3, '破阵子', 'static', 'portrait:A']]) {
      let npc, ctx; const events = []
      const view = mount(host, { assetBaseUrl: new URL(`/assets/sect3d/${buildId}/`, location.href).href, quality: 'low', debug: true, reducedMotion: true,
        npcFactory(value) { ctx = value; npc = createNpcController(value); return npc }, onEvent: event => events.push(event) })
      try {
        await view.applyState({ protocol: 1, sessionEpoch: epoch, revision: 1, mode: 0, logicalPage: 'cangjingge', gameLocationId: 'cangjingge', sceneId: 'library',
          layoutKey: `${epoch}:cangjingge:${id}`, residents: [{ gameNpcId: id, displayName: name }],
          renderedNpcs: [{ gameNpcId: id, visualKind: kind, visualKey, portraitUrl: new URL(`/img/NPC/${name}.webp`, location.href).href, heightMeters: 1.5 }],
          environment: { season: 'winter', hour: 14 }, visible: true, interactive: true, renderEnabled: true, blockReasons: [] })
        const stats = npc.getStats(), card = ctx.scene.getObjectByName(`Scene3D_NPC_${id}`), canvas = ctx.renderer.domElement, rect = canvas.getBoundingClientRect()
        const waitForFocus = async () => {
          for (let i = 0; i < 120 && view.getDiagnostics().focusingNpc; i++) await new Promise(requestAnimationFrame)
          if (view.getDiagnostics().focusingNpc) throw new Error('NPC focus did not settle')
        }
        let hitCount = 0
        const firstPoint = []
        for (let y = .05; y < 1; y += .1) for (let x = -.45; x < .5; x += .1) {
          const p = new THREE.Vector3(x, y, 0).applyMatrix4(card.matrixWorld).project(ctx.camera)
          const clientX = rect.left + (p.x + 1) * rect.width / 2, clientY = rect.top + (1 - p.y) * rect.height / 2
          if (!npc.pick(clientX, clientY)) continue
          hitCount++; if (!firstPoint.length) firstPoint.push(clientX, clientY)
          canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX, clientY, button: 0, bubbles: true }))
          canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX, clientY, button: 0, bubbles: true }))
          await waitForFocus()
          view.resetView() // Next test pixel belongs to the original camera, not the focused one.
        }
        const syntheticIntents = events.filter(event => event.type === 'npcIntent' && event.gameNpcId === id).length
        await window.__npcNativeClickForTest(...firstPoint)
        await waitForFocus()
        const nativeIntents = events.filter(event => event.type === 'npcIntent' && event.gameNpcId === id).length - syntheticIntents
        const beforeCancel = events.filter(event => event.type === 'npcIntent').length
        for (const lock of ['setInteractionEnabled', 'setRenderEnabled']) {
          view.resetView()
          const [clientX, clientY] = firstPoint
          canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX, clientY, button: 0, bubbles: true }))
          canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX, clientY, button: 0, bubbles: true }))
          if (!view.getDiagnostics().focusingNpc) throw new Error('Cancellation probe must start a real focus')
          view[lock](false)
          if (view.getDiagnostics().focusingNpc) throw new Error(`${lock} must cancel pending focus`)
          view[lock](true)
          await new Promise(requestAnimationFrame)
        }
        const cancelledIntents = events.filter(event => event.type === 'npcIntent').length - beforeCancel
        results.push({ id, foot: stats.residents[0].foot, anchor: stats.residents[0].anchor, hitCount, firstPoint, nativeIntents, cancelledIntents,
          intents: syntheticIntents, topIsCanvas: document.elementFromPoint(...firstPoint) === canvas })
      } finally { await view.destroy() }
    }
    return results
  }, pointer.buildId)
  t.diagnostic(JSON.stringify({ realAssets: pointer.buildId, results }))
  for (const value of results) {
    assert.ok(value.hitCount > 0); assert.equal(value.intents, value.hitCount); assert.equal(value.topIsCanvas, true); assert.equal(value.nativeIntents, 1)
    assert.equal(value.cancelledIntents, 0, 'Interrupted focus must never reopen a menu after unlock')
    assert.equal(value.anchor.space, 'client-css-px')
    assert.ok(value.firstPoint[0] >= value.anchor.left && value.firstPoint[0] <= value.anchor.left + value.anchor.width)
    assert.ok(value.firstPoint[1] >= value.anchor.top && value.firstPoint[1] <= value.anchor.top + value.anchor.height)
  }
  // Preserve the original sampler and exact reported seed feet; diagnostic
  // bounds cannot replace the real picker/native input assertions above.
  assert.deepEqual(results[0].foot, [3.2168689709817215, .6330000162124634, -.44248869838728744])
  assert.deepEqual(results[1].foot, [1.5756034315270186, .1679999977350235, -1.0414971152761794])
  assert.deepEqual(errors, [])
})

test('invalid host subsets are rejected instead of drawing a new roster', async () => {
  const f = fixture()
  try {
    for (const npcs of [Array.from({ length: 16 }, (_, i) => visual(String.fromCharCode(65 + i))), [visual('A'), visual('A')], [visual('Z')]]) {
      const result = await f.controller.bind(f.root, 'library', snapshot(npcs))
      assert.equal(result.status, 'degraded'); assert.equal(result.code, 'NPC_SUBSET_INVALID'); assert.equal(f.controller.getStats().cards, 0)
    }
  } finally { cleanup(f) }
})
