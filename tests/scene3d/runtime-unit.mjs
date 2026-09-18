import test from 'node:test'
import assert from 'node:assert/strict'
import { mount } from '../../scene3d/src/runtime.js'
import { normalizeSnapshot, normalizeAssetBase, semanticLocation, clientAnchor, LOCATION_TO_SCENE } from '../../scene3d/src/protocol.js'
import { createNavigation } from '../../scene3d/src/navigation.js'
import { createResourceRegistry, createListenerRegistry } from '../../scene3d/src/resources.js'

const snapshot = (patch = {}) => ({ protocol: 1, sessionEpoch: 1, revision: 1, mode: 0, logicalPage: 'map', gameLocationId: 'tianshanpai', sceneId: 'main', environment: { season: 'winter', hour: 12 }, residents: [], renderedNpcs: [], visible: true, renderEnabled: true, interactive: true, blockReasons: [], ...patch })
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const turn = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const record = id => ({ id, root: {}, roots: [] })
function fixture() {
  const pending = [], released = [], attached = [], detached = [], errors = []
  const navigation = createNavigation({ load(id, signal) { const d = defer(); pending.push({ id, signal, ...d }); return d.promise },
    activate(value) { attached.push(value.id) }, deactivate(value) { detached.push(value.id) }, release(value) { released.push(value.id) }, onError(error) { errors.push(error) } })
  return { navigation, pending, released, attached, detached, errors }
}

test('import is inert; synchronous unique mount does not touch DOM or GPU', async () => {
  let creates = 0
  const container = { ownerDocument: { defaultView: {}, createElement() { creates++; throw Error('must not create') } }, appendChild() {} }
  const view = mount(container, { protocol: 1, assetBaseUrl: 'https://example.test/assets/v1/', debug: true })
  assert.equal(typeof view.applyState, 'function'); assert.equal(creates, 0)
  assert.equal(view.debug.renderers, 0); assert.equal(view.debug.listeners, 0)
  assert.throws(() => mount(container, { assetBaseUrl: 'https://example.test/v1/' }), /already owns/)
  assert.throws(() => { view.debug.frames = 99 }, TypeError)
  assert.equal(await view.destroy(), undefined)
  await view.destroy()
  assert.equal(view.debug.renderers, 0); assert.equal(view.debug.raf, 0)
  assert.equal((await view.applyState(snapshot())).status, 'destroyed')
  const next = mount(container, { assetBaseUrl: 'https://example.test/v1/' })
  assert.equal(next.debug, undefined)
  assert.equal(next.getDiagnostics().renderers, 0)
  assert.deepEqual(next.getDebugState(), next.getDiagnostics())
  assert.throws(() => { next.getDiagnostics().frames = 99 }, TypeError)
  await next.destroy()
  assert.equal(next.getDiagnostics().destroyed, true)
})

test('non-cultivation first apply does not initialize and old versions are rejected', async () => {
  const container = { ownerDocument: { defaultView: {} }, appendChild() {} }
  const view = mount(container, { assetBaseUrl: 'https://example.test/v1/', debug: true })
  const hidden = snapshot({ mode: 1, sceneId: null, visible: false })
  assert.equal((await view.applyState(hidden)).status, 'superseded')
  assert.equal(view.debug.renderers, 0); assert.equal(view.debug.modelRequests, 0)
  assert.equal((await view.applyState({ ...hidden, sessionEpoch: 0 })).status, 'superseded')
  await view.destroy()
})

test('NPC lifecycle invalidates on hide and retry, and diagnostics are plain immutable snapshots', async () => {
  const container = { ownerDocument: { defaultView: {} }, appendChild() {} }
  const view = mount(container, { assetBaseUrl: 'https://example.test/v1/' })
  const calls = [], source = { disposed: false, cards: 2, residents: [{ gameNpcId: 'A', foot: [1, 2, 3] }], liveObject: new EventTarget() }
  view.setNpcController({ bind(...args) { calls.push(args); return Promise.resolve() }, getStats() { return source }, dispose() { source.disposed = true; source.cards = 0 } })
  const stats = view.getDiagnostics().npc
  assert.equal(stats.liveObject, null)
  assert.throws(() => { stats.residents[0].foot[0] = 9 }, TypeError)
  source.residents[0].foot[0] = 7; assert.equal(stats.residents[0].foot[0], 1)
  await view.applyState(snapshot({ visible: false, renderEnabled: false, interactive: false }))
  const beforeHide = calls.length; view.setVisible(false); assert.equal(calls.length, beforeHide + 1)
  assert.equal(calls.at(-1)[0], null); assert.equal(calls.at(-1)[1], null)
  const beforeRetry = calls.length; await view.retry(); assert.ok(calls.length > beforeRetry)
  await view.destroy(); assert.equal(view.getDiagnostics().npc.disposed, true); assert.equal(view.getDiagnostics().npc.cards, 0)
})

test('snapshot is deeply immutable, cloned and whitelist-only', () => {
  const input = snapshot({ residents: [{ gameNpcId: 'F', displayName: '施延年' }], renderedNpcs: [{ gameNpcId: 'F', visualKind: 'static', visualKey: 'portrait:F' }], apiKey: 'never-copy' })
  const view = normalizeSnapshot(input)
  input.environment.hour = 3; input.residents[0].displayName = 'changed'
  assert.equal(view.environment.hour, 12); assert.equal(view.residents[0].displayName, '施延年'); assert.equal(view.apiKey, undefined)
  assert.equal(view.renderedNpcs[0].displayName, '施延年')
  assert.throws(() => view.renderedNpcs.push({}), TypeError)
  assert.equal(normalizeSnapshot(snapshot({ environment: { season: '<bad>', hour: NaN } })).environment.hour, 12)
})

test('protocol rejects malformed routes, NPCs, versions and guest business access', () => {
  for (const patch of [{ protocol: 2 }, { revision: -1 }, { mode: 1 }, { sceneId: 'guest_quarters' }, { logicalPage: 'cangjingge' }, { residents: [{ gameNpcId: 'Z' }] }, { renderedNpcs: [{ gameNpcId: 'F', visualKind: 'static' }] }]) {
    assert.throws(() => normalizeSnapshot(snapshot(patch)), TypeError)
  }
  assert.equal(Object.keys(LOCATION_TO_SCENE).length, 13)
})

test('all version-local asset paths require an explicit absolute base', () => {
  assert.equal(normalizeAssetBase('https://example.test/sub/assets/v1'), 'https://example.test/sub/assets/v1/')
  for (const value of ['', './assets/', 'javascript:alert(1)', 'https://example.test/?v=1']) assert.throws(() => normalizeAssetBase(value), TypeError)
})

test('semantic picking only returns game IDs and respects the nearest occluder', () => {
  const parent = { userData: { interactionId: 'library', clickable: true } }
  assert.equal(semanticLocation({ parent }), 'cangjingge')
  assert.equal(semanticLocation({ userData: { interactionId: 'environment' }, parent }), null)
  assert.equal(semanticLocation({ userData: { interactionId: 'guest_quarters', clickable: true } }), null)
  assert.equal(semanticLocation({ userData: { interactionId: '__proto__', clickable: true } }), null)
})

test('anchors are client CSS pixels including container offsets, never DPR', () => {
  assert.deepEqual(clientAnchor({ x: 0, y: .5, z: 0 }, { left: 80, top: 120, width: 400, height: 200 }), { space: 'client-css-px', left: 280, top: 170, width: 0, height: 0 })
  assert.equal(clientAnchor({ x: 2, y: 0, z: 0 }, { width: 400, height: 200 }), null)
})

test('navigation dedupes same target while loading and retains main plus one room', async () => {
  const f = fixture(), n = f.navigation
  const one = n.navigate('library', 1), two = n.navigate('library', 1)
  assert.equal(one, two); assert.equal(f.pending.length, 1)
  f.pending[0].resolve(record('main')); await turn()
  assert.equal(f.pending[1].id, 'library'); f.pending[1].resolve(record('library'))
  assert.equal(await one, 'applied'); const generation = n.generation
  assert.equal(await n.navigate('library', 1), 'applied'); assert.equal(n.generation, generation)
  assert.equal(await n.navigate('main', 1), 'applied')
  assert.equal(n.snapshot().cachedRooms, 1)
  const next = n.navigate('kitchen', 1); await turn()
  assert.deepEqual(f.released, ['library']); f.pending[2].resolve(record('kitchen'))
  assert.equal(await next, 'applied'); assert.equal(n.snapshot().cachedRooms, 1)
  n.dispose(); n.dispose(); assert.deepEqual(f.released, ['library', 'kitchen', 'main'])
})

test('arbitrary A to B latest-wins: late A release never detaches B', async () => {
  const f = fixture(), n = f.navigation
  const a = n.navigate('library', 1); f.pending[0].resolve(record('main')); await turn()
  const b = n.navigate('kitchen', 1); await turn()
  assert.equal(await a, 'superseded')
  assert.equal(f.pending[1].signal.aborted, true)
  f.pending[2].resolve(record('kitchen')); assert.equal(await b, 'applied')
  const before = [...f.detached]; f.pending[1].resolve(record('library')); await turn()
  assert.deepEqual(f.detached, before); assert.equal(n.active.id, 'kitchen'); assert.deepEqual(f.released, ['library'])
  n.dispose()
})

test('hide/cancel invalidates in-flight compile; same revision resume recompiles', async () => {
  const compile = defer(); let activations = 0
  const n = createNavigation({ load: async id => record(id), activate: () => ++activations === 1 ? compile.promise : undefined, deactivate() {}, release() {} })
  const a = n.navigate('main', 1); await turn(); n.cancel()
  assert.equal(await a, 'superseded')
  assert.equal(await n.navigate('main', 1), 'applied'); assert.equal(activations, 2)
  compile.resolve(); await turn(); assert.equal(n.active.id, 'main'); n.dispose()
})

test('hide of a completed scene repeats first-frame activation without reloading its model', async () => {
  let loads = 0, activations = 0
  const n = createNavigation({ load: async id => { loads++; return record(id) }, activate: () => { activations++ }, deactivate() {}, release() {} })
  assert.equal(await n.navigate('main', 1), 'applied')
  n.cancel()
  assert.equal(await n.navigate('main', 1), 'applied')
  assert.equal(loads, 1); assert.equal(activations, 2)
  n.dispose()
})

test('destroy resolves pending navigation immediately and late parse is released', async () => {
  const f = fixture(); const promise = f.navigation.navigate('main', 1)
  f.navigation.dispose(); assert.equal(await promise, 'destroyed')
  f.pending[0].resolve(record('main')); await turn()
  assert.deepEqual(f.released, ['main']); assert.equal(f.attached.length, 0)
})

test('failed target does not infinitely reload; explicit retry uses same epoch', async () => {
  const f = fixture(), n = f.navigation
  const first = n.navigate('library', 3); f.pending[0].resolve(record('main')); await turn()
  f.pending[1].reject(Error('404')); assert.equal(await first, 'degraded')
  assert.equal(await n.navigate('library', 3), 'degraded'); assert.equal(f.pending.length, 2)
  const retry = n.navigate('library', 3, { force: true }); await turn(); f.pending[2].resolve(record('library'))
  assert.equal(await retry, 'applied'); assert.equal(n.active.epoch, 3); n.dispose()
})

test('new epoch invalidates old same-room parse without unbinding newer instance', async () => {
  const f = fixture(), n = f.navigation
  const old = n.navigate('library', 1); f.pending[0].resolve(record('main')); await turn()
  const current = n.navigate('library', 2); await turn(); f.pending[2].resolve(record('library'))
  assert.equal(await current, 'applied'); assert.equal(await old, 'superseded')
  f.pending[1].resolve(record('library')); await turn(); assert.equal(n.active.epoch, 2); n.dispose()
})

test('resource ownership is refcounted and disposal is idempotent', () => {
  let disposals = 0, closes = 0
  const texture = { isTexture: true, source: { data: { close() { closes++ } } }, dispose() { disposals++ } }
  const material = { isMaterial: true, map: texture, dispose() { disposals++ } }, geometry = { isBufferGeometry: true, dispose() { disposals++ } }
  const root = () => ({ traverse(fn) { fn({ material, geometry }) }, removeFromParent() {} })
  const a = root(), b = root(), registry = createResourceRegistry()
  registry.track(a); registry.track(b); registry.track(a)
  assert.equal(registry.snapshot().resources, 4); registry.release(a); assert.equal(disposals, 0)
  registry.release(b); registry.release(b); registry.dispose()
  assert.equal(disposals, 3); assert.equal(closes, 1); assert.equal(registry.snapshot().resources, 0)
})

test('registered listeners are all removed exactly once', () => {
  const target = new EventTarget(), registry = createListenerRegistry(); let count = 0
  registry.listen(target, 'ping', () => count++); target.dispatchEvent(new Event('ping'))
  assert.equal(count, 1); assert.equal(registry.size, 1)
  registry.dispose(); registry.dispose(); target.dispatchEvent(new Event('ping'))
  assert.equal(count, 1); assert.equal(registry.size, 0)
})
