import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { createCompileLifecycle } from '../../scene3d/src/runtime.js'
import { createNavigation } from '../../scene3d/src/navigation.js'
import { Material } from '../../scene3d/node_modules/three/build/three.module.js'
import { WebGLProperties } from '../../scene3d/node_modules/three/src/renderers/webgl/WebGLProperties.js'
import { launchBrowser } from '../../scene3d/scripts/test-support.mjs'

function fixture({ parallel = true, timeoutMs = 30 } = {}) {
  let id = 0, ready = false, lost = false, calls = 0
  const timers = new Map(), properties = WebGLProperties(), material = new Material()
  const clock = { setTimeout(fn) { const key = ++id; timers.set(key, fn); return key }, clearTimeout(key) { timers.delete(key) } }
  const program = { program: {}, isReady() { calls++; return ready } }
  const renderer = { properties, getContext: () => ({ isContextLost: () => lost }), extensions: { get: () => parallel ? {} : null },
    compile() { properties.get(material).currentProgram = program; return new Set([material]) },
    compileAsync() { throw Error('Uncancellable Three compileAsync must never be called') } }
  // The real WebGLProperties implementation and Three Material disposal order:
  // renderer disposal listener removes the entry before later listeners run.
  material.addEventListener('dispose', () => properties.remove(material))
  const compiler = createCompileLifecycle(renderer, clock, { timeoutMs })
  return { compiler, renderer, material, program, properties, timers, setReady(value) { ready = value }, lose() { lost = true },
    get calls() { return calls }, runTimer() { const [key, fn] = timers.entries().next().value; timers.delete(key); fn() } }
}
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }

test('parallel compile waits for program readiness, then detaches every owned timer/listener', async () => {
  const f = fixture(), pending = f.compiler.compile({}, {})
  assert.equal(f.compiler.snapshot().pending, 1); assert.equal(f.timers.size, 1)
  f.runTimer(); assert.equal(f.compiler.snapshot().completed, 0)
  f.setReady(true); f.runTimer(); assert.equal(await pending, true)
  assert.equal(f.timers.size, 0); assert.equal(f.compiler.snapshot().materialListeners, 0)
  f.material.dispose(); f.compiler.dispose()
})

test('cancel/hide settles immediately before material disposal and never polls removed properties', async () => {
  const f = fixture(), pending = f.compiler.compile({}, {})
  const calls = f.calls
  f.compiler.cancel(); f.material.dispose()
  assert.equal(await pending, false); assert.equal(f.properties.has(f.material), false)
  assert.equal(f.calls, calls); assert.equal(f.timers.size, 0); assert.equal(f.compiler.snapshot().materialListeners, 0)
  f.compiler.dispose()
})

test('unexpected material disposal itself cancels without recreating its WebGLProperties entry', async () => {
  const f = fixture(), pending = f.compiler.compile({}, {})
  f.material.dispose()
  assert.equal(await pending, false); assert.equal(f.properties.has(f.material), false)
  assert.equal(f.timers.size, 0); assert.equal(f.compiler.snapshot().materialListeners, 0)
})

test('missing/destroyed program is a rejected lifecycle error rather than an uncaught timer exception', async () => {
  for (const missingEntry of [true, false]) {
    const f = fixture(), pending = f.compiler.compile({}, {})
    const rejected = assert.rejects(pending, error => error.code === 'COMPILE_PROGRAM_MISSING')
    if (missingEntry) f.properties.remove(f.material); else f.program.program = undefined
    assert.doesNotThrow(() => f.runTimer()); await rejected
    if (missingEntry) assert.equal(f.properties.has(f.material), false)
    assert.equal(f.timers.size, 0); assert.equal(f.compiler.snapshot().failed, 1)
  }
})

test('KHR exceptions, context loss and never-ready programs settle with no perpetual timer', async () => {
  for (const cause of ['query', 'context', 'timeout']) {
    const f = fixture({ timeoutMs: 20 }), pending = f.compiler.compile({}, {})
    const rejected = assert.rejects(pending)
    if (cause === 'query') f.program.isReady = () => { throw Error('driver query failed') }
    if (cause === 'context') f.lose()
    while (f.timers.size) assert.doesNotThrow(() => f.runTimer())
    await rejected; assert.equal(f.compiler.snapshot().pending, 0); assert.equal(f.compiler.snapshot().materialListeners, 0)
  }
})

test('latest compile wins, disposal is idempotent, and stale callbacks cannot touch replacement state', async () => {
  const f = fixture(), a = f.compiler.compile({}, {}), stale = [...f.timers.values()][0]
  const b = f.compiler.compile({}, {})
  assert.equal(await a, false); const calls = f.calls
  stale(); assert.equal(f.calls, calls)
  assert.equal(f.timers.size, 1); assert.equal(f.compiler.snapshot().pending, 1)
  f.compiler.dispose(); f.compiler.dispose(); f.material.dispose()
  assert.equal(await b, false); assert.equal(f.timers.size, 0)
  assert.equal(await f.compiler.compile({}, {}), false)
})

test('no-KHR submission creates no delayed timer and first rendering remains the ready boundary', async () => {
  const f = fixture({ parallel: false })
  assert.equal(await f.compiler.compile({}, {}), true)
  assert.equal(f.calls, 0); assert.equal(f.timers.size, 0)
  assert.equal(f.compiler.snapshot().materialListeners, 0)
  f.compiler.dispose(); f.material.dispose()
})

test('navigation cancellation/destroy retain latest-wins and never emit ready before compile plus first frame', async () => {
  const f = fixture(), events = []
  let allowFrame
  const firstFrame = new Promise(resolve => { allowFrame = resolve })
  const nav = createNavigation({
    load: async id => ({ id }),
    onStart() { f.compiler.cancel() },
    deactivate(record) { events.push(`deactivate:${record.id}`) },
    release(record) { events.push(`release:${record.id}`); f.material.dispose() },
    async activate(record, valid) {
      if (!await f.compiler.compile({}, {}, valid) || !valid()) return
      events.push(`compiled:${record.id}`)
      await firstFrame
      if (valid()) events.push(`ready:${record.id}`)
    },
  })
  const a = nav.navigate('library', 1); await flush()
  assert.equal(f.timers.size, 1)
  const b = nav.navigate('council', 2); await flush()
  assert.equal(await a, 'superseded'); assert.equal(f.timers.size, 1)
  assert.equal(events.some(event => event.startsWith('ready:')), false)
  f.setReady(true); f.runTimer(); await flush()
  assert.ok(events.includes('compiled:council')); assert.equal(events.includes('ready:council'), false)
  allowFrame(); assert.equal(await b, 'applied'); assert.ok(events.includes('ready:council'))
  const c = nav.navigate('alchemy', 3); f.setReady(false); await flush()
  f.compiler.dispose(); nav.dispose()
  assert.equal(await c, 'destroyed'); assert.equal(f.timers.size, 0)
})

test('real Three/WebGL reproduces the old disposed-program timer bug, while owned compilation cancels safely', { timeout: 90000 }, async t => {
  // Serve native source modules, not a stub renderer or a replacement immutable release.
  const workspace = fileURLToPath(new URL('../../', import.meta.url))
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>compile lifecycle</title>'); return }
      const filename = path.resolve(workspace, `.${pathname}`)
      assert.ok(filename.startsWith(path.join(workspace, 'scene3d') + path.sep))
      response.setHeader('Content-Type', 'text/javascript'); response.end(await fs.readFile(filename))
    } catch { response.statusCode = 404; response.end('not found') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const browser = await launchBrowser()
  let context
  t.after(async () => { try { await context?.close() } finally { await browser.close() } })
  context = await browser.createBrowserContext()
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  const old = await page.evaluate(async () => {
    const THREE = await import('/scene3d/node_modules/three/build/three.module.js')
    const renderer = new THREE.WebGLRenderer(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera()
    const material = new THREE.MeshBasicMaterial(), geometry = new THREE.BoxGeometry()
    scene.add(new THREE.Mesh(geometry, material))
    // A deterministic readiness gate only lengthens genuine Three program polling.
    // It still invokes the real isReady()/KHR query; no properties/removal is mocked.
    const compile = renderer.compile.bind(renderer)
    renderer.compile = (...args) => {
      const materials = compile(...args)
      for (const item of materials) {
        const program = renderer.properties.get(item).currentProgram, query = program.isReady.bind(program)
        program.isReady = () => { query(); return false }
      }
      return materials
    }
    renderer.compileAsync(scene, camera) // Deliberately reproduce the unfixable stock promise.
    const hadProgram = renderer.properties.has(material)
    material.dispose()
    const removed = !renderer.properties.has(material)
    await new Promise(resolve => setTimeout(resolve, 60))
    geometry.dispose(); renderer.dispose(); renderer.forceContextLoss()
    return { hadProgram, removed }
  })
  assert.deepEqual(old, { hadProgram: true, removed: true })
  assert.ok(errors.some(message => /isReady/.test(message)), 'stock Three must reproduce the real observed error')
  errors.length = 0
  const current = await page.evaluate(async () => {
    const THREE = await import('/scene3d/node_modules/three/build/three.module.js')
    const { createCompileLifecycle } = await import('/scene3d/src/runtime.js')
    const renderer = new THREE.WebGLRenderer(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(45, 1, .1, 100)
    camera.position.z = 3; renderer.setSize(32, 32)
    const material = new THREE.MeshBasicMaterial(), geometry = new THREE.BoxGeometry(), mesh = new THREE.Mesh(geometry, material)
    scene.add(mesh)
    const timers = new Set(), clock = {
      setTimeout(fn, ms) { const id = setTimeout(() => { timers.delete(id); fn() }, ms); timers.add(id); return id },
      clearTimeout(id) { timers.delete(id); clearTimeout(id) },
    }
    let hold = true, actualQueries = 0
    const originalCompile = renderer.compile.bind(renderer)
    renderer.compile = (...args) => {
      const materials = originalCompile(...args)
      for (const item of materials) {
        const program = renderer.properties.get(item).currentProgram
        if (!program.testQuery) {
          const query = program.isReady.bind(program)
          program.testQuery = true
          program.isReady = () => { actualQueries++; const ready = query(); return !hold && ready }
        }
      }
      return materials
    }
    const compiler = createCompileLifecycle(renderer, clock)
    const a = compiler.compile(scene, camera)
    compiler.cancel(); material.dispose()
    const cancelled = await a, absentAfterDispose = !renderer.properties.has(material)
    mesh.material = new THREE.MeshBasicMaterial({ color: '#55aa77' })
    hold = false
    const completed = await compiler.compile(scene, camera)
    renderer.render(scene, camera) // First-frame boundary, not just a fake readiness flag.
    const renderedCalls = renderer.info.render.calls
    hold = true
    const c = compiler.compile(scene, camera)
    compiler.dispose(); mesh.material.dispose(); geometry.dispose(); renderer.dispose(); renderer.forceContextLoss()
    const destroyed = await c
    await new Promise(resolve => setTimeout(resolve, 40))
    return { parallel: renderer.extensions.get('KHR_parallel_shader_compile') !== null, cancelled, completed, destroyed, absentAfterDispose,
      renderedCalls, actualQueries, timers: timers.size, stats: compiler.snapshot() }
  })
  t.diagnostic(JSON.stringify({ realWebGL: true, parallel: current.parallel, actualReadinessQueries: current.actualQueries,
    renderedCalls: current.renderedCalls, remainingTimers: current.timers, compilation: current.stats }))
  assert.equal(current.completed, true); assert.equal(current.absentAfterDispose, true)
  assert.ok(current.renderedCalls > 0)
  if (current.parallel) { assert.equal(current.cancelled, false); assert.equal(current.destroyed, false); assert.ok(current.actualQueries > 0) }
  assert.equal(current.timers, 0); assert.equal(current.stats.pending, 0); assert.equal(current.stats.materialListeners, 0)
  assert.deepEqual(errors, [], 'owned compilation must generate no pageerror after real material/renderer disposal')
})
