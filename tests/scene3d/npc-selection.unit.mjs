import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import { advanceNpcCameraTween } from '../../scene3d/src/runtime.js'
import { frameNpcCamera, clearNpcCameraDamping, restoreNpcRoomCamera } from '../../scene3d/src/npc-focus.js'
import { createNpcController } from '../../scene3d/src/npcs.js'
import { installNpcOutline, NPC_OUTLINE_COLOR, npcOutlineCssWidth } from '../../scene3d/src/npc-outline.js'

const require = createRequire(new URL('../../scene3d/package.json', import.meta.url))
const THREE = await import(pathToFileURL(path.join(path.dirname(require.resolve('three')), 'three.module.js')).href)
const { OrbitControls } = await import(pathToFileURL(path.join(path.dirname(require.resolve('three')), '../examples/jsm/controls/OrbitControls.js')).href)
const { parse } = require('acorn')
const source = await readFile(new URL('../../scene3d/src/runtime.js', import.meta.url), 'utf8')
const mount = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.find(node => node.declaration?.id?.name === 'mount').declaration
const functions = new Map(mount.body.body.filter(node => node.type === 'FunctionDeclaration').map(node => [node.id.name, source.slice(node.start, node.end)]))
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`)
const view = c => ({ position: c.camera.position.toArray(), target: c.controls.target.toArray(), zoom: c.camera.zoom })
function sameView(actual, expected) {
  actual.position.forEach((n, i) => close(n, expected.position[i]))
  actual.target.forEach((n, i) => close(n, expected.target[i]))
  close(actual.zoom, expected.zoom)
}

// Exercise the runtime's actual nested lifecycle functions without importing a
// WebGL mock or starting a browser. Acorn extracts complete function declarations;
// the context supplies only scheduling/host I/O, with real Three/OrbitControls.
function runtimeFixture({ reducedMotion = false } = {}) {
  const camera = new THREE.OrthographicCamera(-30, 30, 20, -20, .1, 420)
  const controls = new OrbitControls(camera)
  const events = [], selections = [], postSelections = []
  const context = {
    camera, controls, motionReduced: reducedMotion, npcFocus: null, npcViewReturn: null, selectedNpcId: null, lastNpcAnchor: '', selectionObjects: [],
    destroyed: false, visible: true, renderEnabled: true, interactive: true, ready: true, drawable: true, appliedVersion: null, initializeFailure: null,
    width: 800, height: 600, pointers: new Set(), activeRecord: { id: 'library', size: new THREE.Vector3(25, 10, 20), position: new THREE.Vector3(20, 35, 40), target: new THREE.Vector3(1, 3, -2) },
    latest: { sessionEpoch: 1, revision: 1, sceneId: 'library', mode: 0, renderedNpcs: [{ gameNpcId: 'A' }, { gameNpcId: 'B' }], blockReasons: [], visible: true, renderEnabled: true, interactive: true },
    npc: { setSelection(id) { selections.push(id) }, tick() {}, getFocusGeometry() { return { center: new THREE.Vector3(-8, 4, 6), projectedHeight: .04 * camera.zoom } }, getAnchor() { return { space: 'client-css-px', left: 1, top: 2, width: 3, height: 4 } } },
    cinematic: { setSelection(objects) { postSelections.push(objects) }, resize() {} },
    navigation: { busy: false, cancel() {}, async navigate() { return 'applied' } },
    container: { clientWidth: 800, clientHeight: 600 }, renderer: { setPixelRatio() {}, setSize() {} },
    eligible() { return !context.destroyed && context.visible && context.width > 0 && context.height > 0 },
    canDraw() { return context.eligible() && context.renderEnabled && context.drawable },
    syncInput() { controls.enabled = context.canInteract() && !context.npcViewReturn },
    schedule() { context.syncInput() }, wakeWaiters() {}, invalidateNpc() {}, projectEnvironment() {}, async initialize() {},
    normalizeSnapshot: value => value, compareVersion: (a, b) => a.sessionEpoch - b.sessionEpoch || a.revision - b.revision, applyResult: status => ({ status }),
    pixelRatio: () => 1, emit(type, detail) { events.push({ type, ...detail }) }, emitError(error) { throw error },
    frameNpcCamera, advanceNpcCameraTween, clearNpcCameraDamping, restoreNpcRoomCamera,
    locationLabels: null,
  }
  vm.createContext(context)
  const names = ['npcMenuOnlyLock', 'awaitingNpcMenuUnlock', 'clearSelection', 'advanceNpcViewReturn', 'advanceNpcFocus', 'emitNpcIntent', 'positionCamera', 'fit', 'resize', 'canInteract', 'cancelNavigation', 'setVisible', 'setRenderEnabled', 'setInteractionEnabled', 'applyState']
  vm.runInContext(names.map(name => functions.get(name)).join('\n'), context)
  context.positionCamera(context.activeRecord); context.fit()
  const canonical = view(context)
  // Return restores initial target/zoom, NOT the initial camera direction.
  const offset = new THREE.Vector3().setFromSphericalCoords(camera.position.distanceTo(controls.target), Math.PI / 3, -1.7)
  controls.target.set(-3, 1, 8); camera.position.copy(controls.target).add(offset); camera.zoom = 2.8
  canonical.position = new THREE.Vector3(...canonical.target).add(offset).toArray()
  camera.lookAt(controls.target); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true)
  const anchor = { space: 'client-css-px', left: 1, top: 2, width: 30, height: 40 }
  const focus = (id = 'A') => {
    assert.equal(context.emitNpcIntent(id, anchor), true)
    context.advanceNpcFocus(0); context.advanceNpcFocus(420)
  }
  return { c: context, canonical, focus, anchor, selections, postSelections, events }
}

test('NPC dismissal removes contour and returns initial room target/zoom preserving current orbit', () => {
  const f = runtimeFixture(); f.focus()
  const focused = view(f.c)
  assert.equal(f.selections.at(-1), 'A')
  assert.equal(f.events.filter(e => e.type === 'npcIntent').length, 1)
  f.c.clearSelection({ restoreView: true })
  assert.equal(f.selections.at(-1), null); assert.equal(f.c.selectedNpcId, null)
  assert.ok(f.c.npcViewReturn); sameView(view(f.c), focused)
  assert.equal(f.c.controls.enabled, false)
  assert.ok(f.postSelections.every(objects => objects.length === 0), 'NPC quad never goes to OutlinePass')
  f.c.advanceNpcViewReturn(1000); sameView(view(f.c), focused)
  f.c.advanceNpcViewReturn(1210)
  const middle = view(f.c)
  middle.position.forEach((n, i) => close(n, (focused.position[i] + f.canonical.position[i]) / 2))
  middle.target.forEach((n, i) => close(n, (focused.target[i] + f.canonical.target[i]) / 2))
  close(middle.zoom, (focused.zoom + f.canonical.zoom) / 2)
  const tween = f.c.npcViewReturn
  f.c.clearSelection({ restoreView: true }); assert.equal(f.c.npcViewReturn, tween, 'duplicate dismissal does not restart')
  f.c.advanceNpcViewReturn(1420)
  sameView(view(f.c), f.canonical); assert.equal(f.c.npcViewReturn, null); assert.equal(f.c.controls.enabled, true)
  assert.equal(f.c.controls.maxZoom, 5)
  assert.equal(f.events.filter(e => e.type === 'npcIntent').length, 1, 'return must not reopen the NPC menu')
})

test('return survives portrait resize without reframing the deselected NPC or restoring stale projection', () => {
  const f = runtimeFixture(); f.focus(); f.c.clearSelection({ restoreView: true })
  f.c.advanceNpcViewReturn(100); f.c.advanceNpcViewReturn(250)
  f.c.npc.getFocusGeometry = () => { throw Error('dismissed NPC must not be reframed') }
  f.c.container.clientWidth = 320; f.c.container.clientHeight = 900; f.c.resize()
  const projection = [f.c.camera.left, f.c.camera.right, f.c.camera.top, f.c.camera.bottom]
  f.c.advanceNpcViewReturn(520)
  sameView(view(f.c), f.canonical)
  assert.deepEqual([f.c.camera.left, f.c.camera.right, f.c.camera.top, f.c.camera.bottom], projection)
})

test('default clear never restores; reduced-motion opt-in return is synchronous, including mid-focus dismissal', () => {
  for (const reducedMotion of [false, true]) {
    const f = runtimeFixture({ reducedMotion }); f.focus()
    const focused = view(f.c); f.c.clearSelection(); sameView(view(f.c), focused); assert.equal(f.c.npcViewReturn, null)
  }
  const f = runtimeFixture({ reducedMotion: true })
  f.c.emitNpcIntent('A', f.anchor)
  f.c.clearSelection({ restoreView: true })
  sameView(view(f.c), f.canonical); assert.equal(f.c.npcFocus, null); assert.equal(f.c.npcViewReturn, null)
  assert.equal(f.events.length, 0, 'dismissed pending focus cannot emit a late menu intent')
})

test('return is cancelled by hide, render/interaction locks, default clear, disposal invalidation, route and epoch changes', async () => {
  const cancel = [c => c.setVisible(false), c => c.setRenderEnabled(false), c => c.setInteractionEnabled(false), c => c.clearSelection(),
    c => { c.destroyed = true; c.cancelNavigation() }, 
    c => c.applyState({ ...c.latest, revision: 2, blockReasons: ['modal'] }),
    c => c.applyState({ ...c.latest, revision: 2, sceneId: 'kitchen' }),
    c => c.applyState({ ...c.latest, sessionEpoch: 2 })]
  for (const action of cancel) {
    const f = runtimeFixture(); f.focus(); f.c.clearSelection({ restoreView: true }); f.c.advanceNpcViewReturn(0); f.c.advanceNpcViewReturn(100)
    const interrupted = view(f.c)
    await action(f.c)
    assert.equal(f.c.npcViewReturn, null)
    f.c.advanceNpcViewReturn(900); sameView(view(f.c), interrupted)
  }
})

test('actual bridge menu-close ordering arms under scene-menu-only lock and awaits canonical unlock', async () => {
  for (const reducedMotion of [false, true]) {
    const f = runtimeFixture({ reducedMotion }); f.focus()
    const focused = view(f.c)
    await f.c.applyState({ ...f.c.latest, revision: 2, interactive: false, blockReasons: ['scene-menu'] })
    f.c.setInteractionEnabled(false)
    assert.equal(f.c.selectedNpcId, 'A', 'completed menu selection survives its own lock')
    f.c.clearSelection({ restoreView: true })
    assert.equal(f.selections.at(-1), null); assert.equal(f.c.selectedNpcId, null)
    assert.ok(f.c.npcViewReturn); sameView(view(f.c), focused)
    // Even a RAF or duplicate menu-blocked sync before the close notification
    // must neither cancel nor start time/motion (including reduced motion).
    f.c.advanceNpcViewReturn(100)
    await f.c.applyState({ ...f.c.latest, revision: 3 })
    f.c.setInteractionEnabled(false)
    f.c.advanceNpcViewReturn(1000)
    assert.ok(f.c.npcViewReturn); assert.equal(f.c.npcViewReturn.start, undefined)
    sameView(view(f.c), focused)
    await f.c.applyState({ ...f.c.latest, revision: 4, interactive: true, blockReasons: [] })
    f.c.advanceNpcViewReturn(1500)
    if (!reducedMotion) { sameView(view(f.c), focused); assert.ok(f.c.npcViewReturn) }
    f.c.advanceNpcViewReturn(1920)
    sameView(view(f.c), f.canonical); assert.equal(f.c.npcViewReturn, null)
    assert.equal(f.events.filter(e => e.type === 'npcIntent').length, 1)
  }
})

test('business locks prevent return arming and cancel a pending scene-menu unlock', async () => {
  for (const blockReasons of [['modal'], ['scene-menu', 'modal'], ['scene-menu', 'battle']]) {
    const f = runtimeFixture(); f.focus()
    const focused = view(f.c)
    await f.c.applyState({ ...f.c.latest, revision: 2, interactive: false, blockReasons })
    f.c.clearSelection({ restoreView: true })
    assert.equal(f.c.npcViewReturn, null); sameView(view(f.c), focused)
    const waiting = runtimeFixture(); waiting.focus()
    await waiting.c.applyState({ ...waiting.c.latest, revision: 2, interactive: false, blockReasons: ['scene-menu'] })
    waiting.c.clearSelection({ restoreView: true }); assert.ok(waiting.c.npcViewReturn)
    await waiting.c.applyState({ ...waiting.c.latest, revision: 3, blockReasons })
    assert.equal(waiting.c.npcViewReturn, null)
    await waiting.c.applyState({ ...waiting.c.latest, revision: 4, interactive: true, blockReasons: [] })
    waiting.c.advanceNpcViewReturn(1000)
    sameView(view(waiting.c), focused)
  }
})

test('a new NPC focus supersedes camera return and owns the only selected contour', () => {
  const f = runtimeFixture(); f.focus(); f.c.clearSelection({ restoreView: true }); f.c.advanceNpcViewReturn(0); f.c.advanceNpcViewReturn(100)
  assert.equal(f.c.emitNpcIntent('B', f.anchor), true)
  assert.equal(f.c.npcViewReturn, null); assert.equal(f.c.selectedNpcId, 'B'); assert.equal(f.selections.at(-1), 'B')
  f.c.advanceNpcFocus(200); f.c.advanceNpcFocus(620)
  assert.equal(f.events.at(-1).gameNpcId, 'B')
})

test('host counts apply synchronously even while main-map menu rendering is paused', async () => {
  const f = runtimeFixture(), counts = []
  f.c.locationLabels = { setCounts(value) { counts.push(value) } }
  f.c.activeRecord.id = 'main'; f.c.latest.sceneId = 'main'
  const locationNpcCounts = { huofang: 4, cangjingge: 15 }
  const applied = f.c.applyState({ ...f.c.latest, revision: 2, renderEnabled: false, interactive: false, blockReasons: ['scene-menu'], locationNpcCounts })
  assert.equal(counts.length, 1); assert.equal(counts[0], locationNpcCounts)
  await applied
})

test('noncanonical focus, resize and return preserve the entire viewing offset at every tween sample', () => {
  const f = runtimeFixture(), c = f.c
  const offset = c.camera.position.clone().sub(c.controls.target)
  const sameOffset = () => c.camera.position.clone().sub(c.controls.target).toArray().forEach((n, i) => close(n, offset.getComponent(i)))
  c.emitNpcIntent('A', f.anchor); sameOffset()
  c.advanceNpcFocus(0); c.advanceNpcFocus(210); sameOffset()
  c.container.clientWidth = 375; c.container.clientHeight = 812; c.resize(); sameOffset()
  c.advanceNpcFocus(420); sameOffset()
  c.resize(); sameOffset()
  c.clearSelection({ restoreView: true }); sameOffset()
  c.advanceNpcViewReturn(500); c.advanceNpcViewReturn(710); sameOffset()
  c.container.clientWidth = 1200; c.container.clientHeight = 800; c.resize(); sameOffset()
  c.advanceNpcViewReturn(920); sameOffset(); sameView(view(c), f.canonical)
  c.controls.update(); sameOffset()
})

test('dismissal preserves the direction at dismissal, not an earlier focus direction', () => {
  const f = runtimeFixture(); f.focus()
  const c = f.c, offset = new THREE.Vector3().setFromSphericalCoords(c.camera.position.distanceTo(c.controls.target), Math.PI / 3, .83)
  c.camera.position.copy(c.controls.target).add(offset); c.camera.lookAt(c.controls.target); c.camera.updateMatrixWorld(true)
  c.clearSelection({ restoreView: true })
  for (const now of [0, 210, 420]) {
    c.advanceNpcViewReturn(now)
    c.camera.position.clone().sub(c.controls.target).toArray().forEach((n, i) => close(n, offset.getComponent(i)))
  }
  c.controls.target.toArray().forEach((n, i) => close(n, f.canonical.target[i])); close(c.camera.zoom, 1.55)
})

test('clearing pending OrbitControls damping retains the exact current pose and consumes residual rotation', () => {
  const f = runtimeFixture(), { camera, controls } = f.c
  controls._sphericalDelta.theta = .4
  controls._panOffset.set(1, 2, 3)
  const before = view(f.c)
  clearNpcCameraDamping(camera, controls)
  sameView(view(f.c), before)
  controls.update(); sameView(view(f.c), before)
})

test('adaptive gold contour is thin on mobile and DPR/downsampling correct without breakpoint jumps', () => {
  const material = new THREE.MeshBasicMaterial(), outline = installNpcOutline(material)
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.basic.fragmentShader }; material.onBeforeCompile(shader)
  for (const [width, height] of [[320, 700], [375, 812], [430, 932], [812, 375], [1280, 900]]) {
    const css = npcOutlineCssWidth(height * .29, width, height)
    assert.ok(css >= .6 && css <= 1.5)
    if (Math.min(width, height) <= 430) assert.ok(css <= .9)
    for (const ratio of [.5, 1, 1.25, 2, 3]) {
      outline.setViewport(height * .29, width, height); outline.setPixelRatio(ratio)
      close(shader.uniforms.npcOutlineWidth.value / ratio, css)
    }
    assert.ok(Math.abs(npcOutlineCssWidth(height * .29, width + 1, height + 1) - css) < .01)
  }
  close(npcOutlineCssWidth(300, 1440, 900), 1.5)
  close(npcOutlineCssWidth(20, 1440, 900), .6)
  material.dispose()
})

test('gold contour shader preserves original alpha/depth and samples only the current atlas frame', () => {
  const material = new THREE.MeshBasicMaterial({ alphaTest: .35, depthTest: true, depthWrite: true })
  const outline = installNpcOutline(material)
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.basic.fragmentShader }
  material.onBeforeCompile(shader)
  assert.equal(shader.uniforms.npcOutlineSelected.value, 0)
  outline.setSelected(true); outline.setPixelRatio(1.25)
  outline.setFrame({ x: 12, y: 20, width: 24, height: 40, sheet: { width: 128, height: 256 } })
  assert.equal(shader.uniforms.npcOutlineSelected.value, 1); assert.equal(shader.uniforms.npcOutlineWidth.value, 1.875)
  assert.deepEqual(shader.uniforms.npcOutlineFrame.value.toArray(), [12 / 128, 1 - 60 / 256, 36 / 128, 1 - 20 / 256])
  assert.equal(shader.uniforms.npcOutlineColor.value.getHexString(), NPC_OUTLINE_COLOR.slice(1))
  assert.match(shader.fragmentShader, /lessThan\(uv, npcOutlineFrame.xy\)/)
  assert.match(shader.fragmentShader, /greaterThan\(uv, npcOutlineFrame.zw\)/)
  assert.match(shader.fragmentShader, /texture2D\(map, uv\).a/)
  assert.equal((shader.fragmentShader.match(/inside = min/g) || []).length, 7)
  assert.match(shader.fragmentShader, /dFdx\(vMapUv\)/); assert.match(shader.fragmentShader, /dFdy\(vMapUv\)/)
  assert.match(shader.fragmentShader, /#include <alphatest_fragment>/)
  assert.doesNotMatch(shader.fragmentShader, /diffuseColor\.a\s*=/)
  assert.equal(material.alphaTest, .35); assert.equal(material.depthTest, true); assert.equal(material.depthWrite, true)
  outline.setSelected(false); assert.equal(shader.uniforms.npcOutlineSelected.value, 0)
  material.dispose()
})

async function npcFixture({ animated = false } = {}) {
  const scene = new THREE.Scene(), root = new THREE.Group(), camera = new THREE.OrthographicCamera(-5, 5, 5, -5, .1, 100)
  scene.add(root); camera.position.set(0, 5, 10); camera.lookAt(0, 1, 0); camera.updateMatrixWorld(true)
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial())
  floor.name = 'floor'; floor.visible = false; floor.userData.npcSpawn = { authored: true }; root.add(floor)
  const alpha = new Uint8Array(16 * 8)
  // Two atlas cells, with opaque corners but a transparent central hole. Cropping
  // retains the hole; selecting must not make it pickable or add geometry.
  alpha.fill(255); for (let y = 2; y < 6; y++) for (let x = 3; x < 5; x++) alpha[y * 16 + x] = 0
  const renderer = { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 500 }) }, getPixelRatio: () => .75 }
  const entry = { id: 'pozhenzi', height: 1.5, frameCount: 2, delays: [100, 100], bounds: [0, 0, 8, 8], width: 8, heightPixels: 8,
    cellWidth: 8, cellHeight: 8, columns: 2, padding: 0, sheets: [{ file: 'npc/generated/pozhenzi-0.png', first: 0, count: 2, width: 16, height: 8 }] }
  const controller = createNpcController({ scene, camera, renderer, assetBaseUrl: 'https://fixture.test/assets/', npcShadows: false,
    loadImage: async () => ({ image: {}, width: 16, height: 8, alpha, alphaWidth: 16, alphaHeight: 8 }),
    fetch: async () => ({ ok: true, json: async () => ({ version: 1, npcs: [entry] }) }), placement: () => [{ point: new THREE.Vector3(0, 0, 0) }] })
  const snapshot = { sessionEpoch: 1, sceneId: 'library', renderedNpcs: [{ gameNpcId: 'A', visualKind: animated ? 'animated' : 'static', portraitUrl: 'https://fixture.test/a.png', heightMeters: 2 }], environment: { hour: 12 } }
  await controller.bind(root, 'library', snapshot)
  const card = root.getObjectByName('Scene3D_NPC_A')
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.basic.fragmentShader }; card.material.onBeforeCompile(shader)
  return { controller, card, shader, snapshot, root, scene, camera, cleanup() { controller.dispose(); floor.geometry.dispose(); floor.material.dispose() } }
}

test('controller outline tracks animated UVs, is instance-local, clears on rebind/dispose, and allocates no extra meshes', async () => {
  const f = await npcFixture({ animated: true }), other = await npcFixture()
  try {
    const children = f.root.getObjectByName('Scene3D_NPCs').children.length
    assert.equal(f.controller.setSelection('A'), true)
    assert.equal(f.controller.getStats().outline.count, 1); assert.equal(other.controller.getStats().outline.count, 0)
    assert.equal(f.shader.uniforms.npcOutlineSelected.value, 1)
    assert.deepEqual(f.shader.uniforms.npcOutlineFrame.value.toArray(), [0, 0, .5, 1])
    f.controller.tick(100, .1)
    assert.deepEqual(f.shader.uniforms.npcOutlineFrame.value.toArray(), [.5, 0, 1, 1])
    const outlineStats = f.controller.getStats().residents[0].outline
    close(f.shader.uniforms.npcOutlineWidth.value, outlineStats.cssWidth * .75)
    assert.ok(outlineStats.cssWidth < 1)
    assert.equal(f.root.getObjectByName('Scene3D_NPCs').children.length, children)
    assert.equal(f.controller.setSelection('Z'), false); assert.equal(f.shader.uniforms.npcOutlineSelected.value, 0)
    f.controller.setSelection('A'); await f.controller.bind(null, null, f.snapshot)
    assert.equal(f.controller.getStats().outline.count, 0)
    f.controller.dispose(); assert.equal(f.controller.getStats().outline.selectedNpcId, null)
  } finally { f.cleanup(); other.cleanup() }
})

test('selected static sprite keeps the original alpha-aware raycast, including transparent holes', async () => {
  const f = await npcFixture()
  try {
    const hit = (x, y) => {
      const world = new THREE.Vector3(x, y, 0).applyMatrix4(f.card.matrixWorld)
      const raycaster = new THREE.Raycaster(f.camera.position.clone(), world.sub(f.camera.position).normalize())
      return raycaster.intersectObject(f.card).length > 0
    }
    for (const selected of [false, true, false]) {
      f.controller.setSelection(selected ? 'A' : null)
      assert.equal(hit(-.25, .5), false, 'transparent hole stays unpickable')
      assert.equal(hit(.25, .5), true, 'opaque body stays pickable')
    }
  } finally { f.cleanup() }
})
