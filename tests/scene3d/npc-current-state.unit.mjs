import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createNpcController, NPC_ANIMATED_IDS, frameAt } from '../../scene3d/src/npcs.js'
import { npcEffectiveHeight, DEFAULT_NPC_SCENE_SCALE } from '../../scene3d/src/npc-sizing.js'
import { normalizeSnapshot } from '../../scene3d/src/protocol.js'

const require = createRequire(new URL('../../scene3d/package.json', import.meta.url))
const THREE = await import(pathToFileURL(path.join(path.dirname(require.resolve('three')), 'three.module.js')).href)
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`)
const identities = { A: 'pozhenzi', B: 'dongting', C: 'qiantang', D: 'xiaobaihu', E: 'jisi', F: 'shiyannian', G: 'huyanxian', H: 'yuzhu', I: 'anmu', J: 'tangmuli', K: 'luoqianyou', L: 'shenmizayi', M: 'xuantianqing', N: 'luchunruo', O: 'lingxuefei' }
function atlas(id, height = 1.6, extra = {}) {
  return { id, height, bounds: [0, 0, 2, 4], width: 2, heightPixels: 4, cellWidth: 4, cellHeight: 6, columns: 2, padding: 1,
    anchor: [.5, 0], frameCount: 2, delays: [80, 90], durationMs: 170,
    sheets: [{ file: `npc/generated/${id}-0.png`, first: 0, count: 2, width: 8, height: 6 }], ...extra }
}
const visual = (gameNpcId, extra = {}) => ({ gameNpcId, visualKind: 'animated', visualKey: identities[gameNpcId], ...extra })
function snapshot(npcs = [visual('A')], patch = {}) {
  return { protocol: 1, sessionEpoch: 1, revision: 1, mode: 0, logicalPage: 'cangjingge', gameLocationId: 'cangjingge', sceneId: 'library',
    layoutKey: `library:${npcs.map(n => n.gameNpcId).join(',')}`, residents: npcs.map(n => ({ gameNpcId: n.gameNpcId, displayName: `NPC ${n.gameNpcId}` })),
    renderedNpcs: npcs, environment: { hour: 12, season: 'winter' }, visible: true, interactive: true, renderEnabled: true, blockReasons: [], ...patch }
}
function fixture({ data = { version: 1, npcs: Object.values(identities).map(id => atlas(id)) }, ...options } = {}) {
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-8, 8, 6, -6, .1, 100), root = new THREE.Group()
  camera.position.set(0, 8, 12); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true)
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, opacity: 0, alphaTest: .5 }))
  floor.name = 'floor'; floor.userData.npcSpawn = true; floor.userData.navigationOnly = true; floor.visible = false; root.add(floor); scene.add(root)
  const requests = [], images = [], placements = []
  const renderer = { capabilities: { maxTextureSize: 2048 }, shadowMap: { enabled: false }, domElement: { getBoundingClientRect: () => ({ left: 40, top: 60, width: 640, height: 480 }) } }
  function imageFor(url) {
    const sheet = data.npcs.flatMap(n => n.sheets).find(s => url.endsWith(s.file)), width = sheet?.width ?? 8, height = sheet?.height ?? 8
    const scale = Math.min(1, 512 / Math.max(width, height)), alphaWidth = Math.ceil(width * scale), alphaHeight = Math.ceil(height * scale)
    const image = { image: {}, width, height, alpha: new Uint8Array(alphaWidth * alphaHeight).fill(255), alphaWidth, alphaHeight, releases: 0, dispose() { this.releases++ } }
    images.push(image); return image
  }
  const controller = createNpcController({ scene, camera, renderer, assetBaseUrl: 'https://fixture.test/assets/current/',
    fetch: async url => { requests.push(url); return { ok: true, json: async () => structuredClone(data) } },
    loadImage: async url => { requests.push(url); return imageFor(url) },
    placement: (_floor, npcs) => { placements.push(npcs.map(n => n.height)); return npcs.map((npc, i) => ({ npc, point: new THREE.Vector3((i - 1) * 3, 0, 0) })) }, ...options })
  return { controller, scene, camera, renderer, root, floor, requests, images, placements, imageFor, cleanup() { controller.dispose(); floor.geometry.dispose(); floor.material.dispose() } }
}
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { resolve, promise } }

test('all 15 fixed business identities map to atlases without changing the selected subset or cache bounds', async () => {
  assert.deepEqual(NPC_ANIMATED_IDS, identities); assert.ok(Object.isFrozen(NPC_ANIMATED_IDS))
  const f = fixture()
  try {
    const ids = Object.keys(identities)
    for (let start = 0; start < ids.length; start += 3) {
      const selected = ids.slice(start, start + 3), input = snapshot(selected.map(id => visual(id)))
      input.residents = ids.map(gameNpcId => ({ gameNpcId }))
      const result = await f.controller.bind(f.root, 'library', normalizeSnapshot(input))
      assert.equal(result.cards, 3); assert.equal(result.fallbacks, 0)
      const stats = f.controller.getStats()
      assert.deepEqual(stats.residents.map(n => n.gameNpcId), selected)
      assert.deepEqual(stats.npcShadows.residents.map(n => n.gameNpcId), selected)
      assert.equal(stats.pinnedAssets, 3); assert.ok(stats.cachedAssets <= 6); assert.equal(stats.npcShadows.visibleCount, 3)
      for (const id of selected) assert.ok(f.requests.some(url => url.endsWith(`${identities[id]}-0.png`)))
    }
    assert.equal(f.requests.filter(url => url.endsWith('manifest.json')).length, 1)
    f.controller.dispose(); await drain()
    const stats = f.controller.getStats()
    assert.equal(stats.npcShadows.count, 0); assert.equal(stats.pendingLoads, 0); assert.equal(stats.alphaBytes, 0)
    assert.equal(stats.shadowGroupsCreated, 5); assert.equal(stats.shadowGroupsDisposed, 5)
    assert.equal(stats.texturesCreated, stats.texturesDisposed)
    assert.ok(f.images.every(image => image.releases === 1))
  } finally { f.cleanup() }
})

test('protocol leaves omitted or invalid heights authored; explicit effective heights remain compatible', () => {
  assert.equal(DEFAULT_NPC_SCENE_SCALE, 1.5)
  for (const value of [undefined, null, NaN, Infinity, -1, 0, 10, '1.5']) {
    const normalized = normalizeSnapshot(snapshot([visual('A', { heightMeters: value })]))
    assert.equal(normalized.renderedNpcs[0].heightMeters, undefined)
    close(npcEffectiveHeight(normalized.renderedNpcs[0].heightMeters, 2.2), 3.3)
  }
  for (const value of [.4, 1.5, 1.9, 3.3, 9.5]) {
    assert.equal(normalizeSnapshot(snapshot([visual('A', { heightMeters: value })])).renderedNpcs[0].heightMeters, value)
    assert.equal(npcEffectiveHeight(value, 2.2), value)
  }
  close(npcEffectiveHeight(undefined, 1.49), 2.235)
  close(npcEffectiveHeight(undefined, 2.2, 2), 4.4)
})

test('CSV-derived base times 1.5 drives placement, cards and shadows; height-only overrides never reload or relocate', async () => {
  const f = fixture({ data: { version: 1, npcs: [atlas('pozhenzi', 2.2)] } })
  try {
    await f.controller.bind(f.root, 'library', normalizeSnapshot(snapshot()))
    const before = f.controller.getStats(), foot = before.residents[0].foot
    close(before.residents[0].height, 3.3); assert.equal(before.residents[0].baseHeight, 2.2)
    close(f.placements[0][0], 3.3); close(before.npcShadows.residents[0].depth, 3.3 * .23)
    const card = f.root.getObjectByName('Scene3D_NPC_A')
    assert.equal(card.castShadow, false); assert.equal(card.receiveShadow, false)
    await f.controller.update(normalizeSnapshot(snapshot([visual('A', { heightMeters: 1.9 })], { revision: 2 })))
    const after = f.controller.getStats()
    assert.equal(after.residents[0].height, 1.9); close(after.npcShadows.residents[0].depth, 1.9 * .23)
    assert.deepEqual(after.residents[0].foot, foot); assert.equal(after.loads, before.loads); assert.equal(f.placements.length, 1)
    assert.equal(after.npcShadows.raycasts, before.npcShadows.raycasts)
    await f.controller.update(normalizeSnapshot(snapshot()))
    close(f.controller.getStats().residents[0].height, 3.3)
  } finally { f.cleanup() }
})

test('default shadows are independent of shadowMap, instance switches and read-only diagnostics survive lifecycle clearing', async () => {
  const a = fixture(), b = fixture({ npcShadows: false })
  try {
    await a.controller.bind(a.root, 'library', snapshot()); await b.controller.bind(b.root, 'library', snapshot())
    assert.equal(a.renderer.shadowMap.enabled, false); assert.equal(a.controller.getStats().npcShadows.visibleCount, 1)
    assert.equal(b.controller.getStats().npcShadows.visibleCount, 0)
    assert.equal(a.controller.setNpcShadows('false'), false); assert.equal(a.controller.setNpcShadows(false), true)
    assert.equal(b.controller.setNpcShadows(true), true)
    assert.equal(a.controller.getStats().npcShadows.visibleCount, 0); assert.equal(b.controller.getStats().npcShadows.visibleCount, 1)
    const stats = b.controller.getStats(), original = b.root.updateWorldMatrix
    b.root.updateWorldMatrix = () => { throw Error('Stats must not update transforms') }
    try { assert.deepEqual(b.controller.getStats(), stats) } finally { b.root.updateWorldMatrix = original }
    assert.throws(() => { stats.npcShadows.residents[0].foot[0] = 100 }, TypeError)
    await b.controller.update(snapshot(undefined, { visible: false, renderEnabled: false, interactive: false }))
    assert.equal(b.controller.getStats().npcShadows.visibleCount, 0)
    await b.controller.bind(null, null)
    assert.equal(b.controller.getStats().npcShadows.count, 0); assert.equal(b.root.getObjectByName('Scene3D_NPCs'), undefined)
    b.controller.dispose(); b.controller.dispose()
    assert.equal(b.controller.setNpcShadows(true), false)
    assert.equal(b.controller.getStats().shadowGroupsCreated, b.controller.getStats().shadowGroupsDisposed)
  } finally { a.cleanup(); b.cleanup() }
})

test('new multi-page Jisi atlas switches 55/56/62/0 with per-card UVs, and Tangmuli uses 54 frames over 4500ms', async () => {
  const delays = Array.from({ length: 63 }, (_, i) => [80, 90, 80][i % 3])
  const jisi = atlas('jisi', 1.74, { bounds: [0, 0, 407, 455], width: 229, heightPixels: 256, cellWidth: 233, cellHeight: 260,
    columns: 8, padding: 2, frameCount: 63, delays, sheets: [
      { file: 'npc/generated/jisi-0.png', first: 0, count: 56, width: 1864, height: 1820 },
      { file: 'npc/generated/jisi-1.png', first: 56, count: 7, width: 1864, height: 260 },
    ] })
  const tang = atlas('tangmuli', 1.7, { width: 193, heightPixels: 256, cellWidth: 197, cellHeight: 260, columns: 10, padding: 2,
    frameCount: 54, delays: delays.slice(0, 54), sheets: [{ file: 'npc/generated/tangmuli-0.png', first: 0, count: 54, width: 1970, height: 1560 }] })
  const f = fixture({ data: { version: 1, npcs: [jisi, tang] } })
  try {
    await f.controller.bind(f.root, 'library', snapshot([visual('E'), visual('J')]))
    const card = f.root.getObjectByName('Scene3D_NPC_E'), other = f.root.getObjectByName('Scene3D_NPC_J'), sheets = card.userData.asset.sheets
    const advance = ms => { while (ms > 0) { const step = Math.min(ms, 100); f.controller.tick(0, step / 1000); ms -= step } }
    advance(delays.slice(0, 55).reduce((a, b) => a + b, 0)); assert.equal(card.userData.frame, 55)
    assert.equal(card.material.map, sheets[0].texture)
    advance(delays[55]); assert.equal(card.userData.frame, 56); assert.equal(card.material.map, sheets[1].texture)
    close(card.geometry.attributes.uv.getX(0), 2 / 1864); close(card.geometry.attributes.uv.getY(0), 1 - 2 / 260)
    const rect = card.userData.frameRect; assert.equal(rect.sheet.image.alpha.length > 0, true)
    advance(delays.slice(56, 62).reduce((a, b) => a + b, 0)); assert.equal(card.userData.frame, 62)
    advance(delays[62]); assert.equal(card.userData.frame, 0); assert.equal(card.material.map, sheets[0].texture)
    for (const sheet of sheets) { assert.deepEqual(sheet.texture.offset.toArray(), [0, 0]); assert.deepEqual(sheet.texture.repeat.toArray(), [1, 1]) }
    assert.notEqual(card.geometry, other.geometry)
    assert.equal(other.userData.asset.visual.durationMs, 4500)
    assert.equal(frameAt(other.userData.asset.visual, 4420), 53); assert.equal(frameAt(other.userData.asset.visual, 4500), 0)
  } finally { f.cleanup() }
})

test('new atlas validation keeps malformed, escaped and dimension-mismatched assets in same-NPC fallback', async () => {
  for (const patch of [{ height: 8 }, { anchor: [0, 0] }, { delays: [0, 90] }, { frameCount: 3 },
    { sheets: [{ file: '../pozhenzi.png', first: 0, count: 2, width: 8, height: 6 }] }]) {
    const f = fixture({ data: { version: 1, npcs: [atlas('pozhenzi', 2.2, patch)] } })
    try {
      const result = await f.controller.bind(f.root, 'library', snapshot())
      assert.equal(result.cards, 0); assert.equal(result.fallbacks, 1)
      assert.equal(f.controller.getStats().fallbacks[0].gameNpcId, 'A'); assert.equal(f.controller.getStats().npcShadows.count, 0)
    } finally { f.cleanup() }
  }
})

test('atlas dimension mismatch releases its decoded image and never allocates a shadow group', async () => {
  const image = { image: {}, width: 7, height: 6, alpha: new Uint8Array(42).fill(255), alphaWidth: 7, alphaHeight: 6, releases: 0, dispose() { this.releases++ } }
  const f = fixture({ loadImage: async () => image })
  try {
    const result = await f.controller.bind(f.root, 'library', snapshot())
    assert.equal(result.cards, 0); assert.equal(result.fallbacks, 1)
    assert.equal(f.controller.getStats().fallbacks[0].reason, 'NPC_ATLAS_DIMENSIONS')
    assert.equal(image.releases, 1); assert.equal(f.controller.getStats().shadowGroupsCreated, 0)
  } finally { f.cleanup() }
})

test('NPC sizing and shadow switches never touch local storage or Pro legacy records', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('No preference storage is allowed') } })
  let f
  try {
    f = fixture(); await f.controller.bind(f.root, 'library', normalizeSnapshot(snapshot()))
    assert.equal(f.controller.setNpcShadows(false), true); assert.equal(f.controller.setNpcShadows(true), true)
    close(f.controller.getStats().residents[0].height, 2.4)
  } finally {
    f?.cleanup()
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage
  }
})

test('partial second-sheet failure and superseded late decodes cannot attach or leak contact shadows', async () => {
  const data = { version: 1, npcs: [atlas('jisi', 1.74, { columns: 1, sheets: [
    { file: 'npc/generated/jisi-0.png', first: 0, count: 1, width: 4, height: 6 },
    { file: 'npc/generated/jisi-1.png', first: 1, count: 1, width: 4, height: 6 },
  ] }), atlas('tangmuli')] }
  let f
  f = fixture({ data, loadImage: async url => { if (url.endsWith('jisi-1.png')) throw Error('Second sheet unavailable'); return f.imageFor(url) } })
  try {
    await f.controller.bind(f.root, 'library', snapshot([visual('E')]))
    assert.equal(f.controller.getStats().npcShadows.count, 0); assert.equal(f.controller.getStats().shadowGroupsCreated, 0)
    assert.equal(f.images[0].releases, 1); assert.equal(f.controller.getStats().texturesCreated, f.controller.getStats().texturesDisposed)
  } finally { f.cleanup() }
  const delayed = defer(); let g
  g = fixture({ data, loadImage: async url => url.endsWith('jisi-0.png') ? delayed.promise : g.imageFor(url) })
  try {
    const first = g.controller.bind(g.root, 'library', snapshot([visual('E')])); await drain()
    const second = await g.controller.bind(g.root, 'library', snapshot([visual('J')], { sessionEpoch: 2 }))
    assert.equal(second.cards, 1); assert.equal((await first).status, 'superseded')
    const late = g.imageFor('npc/generated/jisi-0.png'); delayed.resolve(late); await drain()
    assert.equal(late.releases, 1)
    assert.deepEqual(g.controller.getStats().npcShadows.residents.map(n => n.gameNpcId), ['J'])
    await g.controller.bind(null, null); assert.equal(g.controller.getStats().npcShadows.count, 0)
    assert.equal(g.controller.getStats().shadowGroupsCreated, g.controller.getStats().shadowGroupsDisposed)
  } finally { g.cleanup(); delayed.resolve(null) }
})

test('classic bridge visual projection maps every ID but does not encode authored heights', async () => {
  const source = await readFile(new URL('../../module/scene3d-bridge.js', import.meta.url), 'utf8')
  const expression = source.match(/const animated = (Object\.freeze\(\{[^\n]+\}\));/)
  assert.ok(expression)
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInNewContext(expression[1]))), identities)
  const projection = source.match(/renderedNpcs\.push\(([^\n]+)\);/)
  assert.ok(projection)
  for (const [id, visualKey] of Object.entries(identities)) {
    const npc = vm.runInNewContext(`(${projection[1]})`, { id, npcs: { [id]: { name: `NPC ${id}` } }, animated: identities })
    assert.equal(npc.gameNpcId, id); assert.equal(npc.visualKind, 'animated'); assert.equal(npc.visualKey, visualKey)
    assert.equal(Object.hasOwn(npc, 'heightMeters'), false)
  }
})

test('frozen CSV and manifest prove the current 15 heights, 659 frames and 16 actual PNG headers', async t => {
  // Optional real provenance gate. Set to a Git-owned freeze of Pro, not a live release
  // or arbitrary synthetic fixtures. This test never generates or modifies assets.
  const root = process.env.SCENE3D_NPC_SOURCE_ROOT
  if (!root) { t.skip('Set SCENE3D_NPC_SOURCE_ROOT to the Git-owned CSV/manifest/atlas source freeze'); return }
  const manifest = JSON.parse(await readFile(path.join(root, 'npc/generated/manifest.json'), 'utf8'))
  const raw = await readFile(path.join(root, 'npc/NPC身高.csv'))
  let csv
  try { csv = new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch { csv = new TextDecoder('gbk', { fatal: true }).decode(raw) }
  const heights = new Map()
  for (const line of csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/)) {
    const [label, text, ...extra] = line.split(',').map(s => s.trim()), cm = Number(text)
    assert.equal(extra.length, 0); assert.ok(label && Number.isFinite(cm) && cm >= 100 && cm <= 250); assert.equal(heights.has(label), false)
    heights.set(label, cm / 100)
  }
  assert.equal(heights.size, 15); assert.equal(manifest.version, 1); assert.equal(manifest.npcs.length, 15)
  assert.deepEqual(manifest.npcs.map(n => n.id).sort(), Object.values(identities).sort())
  assert.equal(manifest.npcs.reduce((sum, n) => sum + n.frameCount, 0), 659)
  const files = new Set()
  for (const npc of manifest.npcs) {
    assert.equal(npc.height, heights.get(npc.label)); assert.deepEqual(npc.anchor, [.5, 0])
    assert.equal(npc.delays.length, npc.frameCount); assert.equal(npc.durationMs, npc.delays.reduce((a, b) => a + b, 0))
    let frames = 0
    for (const sheet of npc.sheets) {
      assert.match(sheet.file, /^npc\/generated\/[a-z0-9_-]+\.png$/); assert.equal(files.has(sheet.file), false); files.add(sheet.file)
      assert.equal(sheet.first, frames); frames += sheet.count
      const png = await readFile(path.join(root, sheet.file))
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
      assert.equal(png.readUInt32BE(16), sheet.width); assert.equal(png.readUInt32BE(20), sheet.height)
      assert.ok(sheet.width <= 2048 && sheet.height <= 2048)
    }
    assert.equal(frames, npc.frameCount)
  }
  assert.equal(files.size, 16)
  const tang = manifest.npcs.find(n => n.id === 'tangmuli')
  assert.equal(tang.frameCount, 54); assert.equal(tang.durationMs, 4500)
  assert.equal(tang.sourceSha256, 'ffb5d6bb22e5c27916bb65b6ce08b5dd254cd50d87d1a5f3dce9ea1f1cd2299b')
  t.diagnostic(JSON.stringify({ sourceRoot: root, csvSha256: createHash('sha256').update(raw).digest('hex'), npcCount: 15, frameCount: 659, sheetCount: files.size }))
})
