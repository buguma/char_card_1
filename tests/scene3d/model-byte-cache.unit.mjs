import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelByteCache, createModelBytePrefetcher, MODEL_BYTE_CACHE_MAX_BYTES, MODEL_PREFETCH_GAP_MS } from '../../scene3d/src/model-byte-cache.js'

const bytes = length => new ArrayBuffer(length)
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve() }
function fakeClock() {
  let now = 0, serial = 0
  const timers = new Map()
  return {
    setTimeout(fn, delay) { const id = serial++; timers.set(id, { fn, at: now + delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    advance(ms) {
      const end = now + ms
      let limit = 1000
      while (limit--) {
        const next = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!next) { now = end; return }
        now = next[1].at; timers.delete(next[0]); next[1].fn()
      }
      throw new Error('Unbounded fake timer loop')
    },
    get size() { return timers.size },
    get now() { return now },
  }
}
function harness({ cache = createModelByteCache(), shouldRun = () => true, keys = ['a', 'b', 'c'], rejectOnAbort = false } = {}) {
  const clock = fakeClock(), calls = [], controllers = []
  class TrackedController extends AbortController { constructor() { super(); controllers.push(this) } }
  const fetch = (url, options) => {
    const request = deferred(), body = deferred()
    const call = { url, signal: options.signal, request, body, at: clock.now,
      respond(ok = true) { request.resolve({ ok, arrayBuffer: () => body.promise }) },
      finish(length = 8) { this.respond(); body.resolve(bytes(length)) },
    }
    calls.push(call)
    if (rejectOnAbort) options.signal.addEventListener('abort', () => request.reject(new Error('Abort')), { once: true })
    return request.promise
  }
  const prefetch = createModelBytePrefetcher({ cache, clock, fetch, AbortController: TrackedController, shouldRun,
    items: keys.map(key => ({ key, url: `https://assets.test/version/${key}.glb` })) })
  return { cache, clock, calls, controllers, prefetch }
}

test('cache is instance/version scoped, accepts only encoded ArrayBuffers and has hard caps', () => {
  const a = createModelByteCache({ version: 'baseline-a' }), b = createModelByteCache({ version: 'baseline-b' })
  const data = bytes(12)
  assert.equal(a.put('same-model', data), true)
  assert.equal(a.get('same-model'), data)
  assert.equal(b.get('same-model'), null)
  assert.equal(a.getStats().version, 'baseline-a')
  assert.equal(b.getStats().entries, 0)
  for (const value of [new Uint8Array(1), {}, null, { scene: {} }]) assert.throws(() => a.put('bad', value), TypeError)
  if (typeof SharedArrayBuffer !== 'undefined') assert.throws(() => a.put('bad', new SharedArrayBuffer(1)), TypeError)
  for (const options of [{ maxEntries: 4 }, { maxEntries: 0 }, { maxBytes: MODEL_BYTE_CACHE_MAX_BYTES + 1 }, { maxBytes: 0 }, { maxBytes: 1.5 }]) assert.throws(() => createModelByteCache(options), RangeError)
  assert.throws(() => a.get(''), TypeError)
  assert.throws(() => a.put(null, bytes(1)), TypeError)
  assert.ok(Object.isFrozen(a.getStats()))
})

test('LRU enforces at most three entries and get refreshes recency', () => {
  const cache = createModelByteCache()
  for (const key of ['a', 'b', 'c']) cache.put(key, bytes(4))
  cache.get('a')
  cache.put('d', bytes(4))
  assert.equal(cache.get('b'), null)
  for (const key of ['a', 'c', 'd']) assert.equal(cache.get(key).byteLength, 4)
  assert.deepEqual([cache.getStats().entries, cache.getStats().bytes, cache.getStats().evictions], [3, 12, 1])
})

test('byte budget, replacements and oversized refusal never exceed retained budget', () => {
  const cache = createModelByteCache({ maxBytes: 10 })
  cache.put('a', bytes(4)); cache.put('b', bytes(4)); cache.put('c', bytes(5))
  assert.equal(cache.get('a'), null)
  assert.equal(cache.getStats().bytes, 9)
  cache.put('b', bytes(2))
  assert.equal(cache.getStats().bytes, 7)
  assert.equal(cache.put('b', bytes(11)), false)
  assert.equal(cache.get('b').byteLength, 2) // Refusal must not destroy the previous valid entry.
  assert.equal(cache.put('empty', bytes(0)), false)
  assert.equal(cache.getStats().bytes, 7)
  cache.clear()
  assert.equal(cache.getStats().entries, 0)
  assert.equal(cache.getStats().bytes, 0)
  const full = createModelByteCache()
  assert.equal(full.put('max', bytes(MODEL_BYTE_CACHE_MAX_BYTES)), true)
  assert.equal(full.put('too-large', bytes(MODEL_BYTE_CACHE_MAX_BYTES + 1)), false)
  assert.equal(full.getStats().bytes, MODEL_BYTE_CACHE_MAX_BYTES)
  full.clear()
})

test('detached borrowed buffers become misses and release byte accounting', () => {
  const cache = createModelByteCache(), data = bytes(12)
  cache.put('a', data)
  structuredClone(data, { transfer: [data] })
  assert.equal(cache.get('a'), null)
  assert.equal(cache.getStats().bytes, 0)
})

test('construction/resume never starts work before explicit main-ready start', () => {
  const h = harness()
  assert.equal(h.prefetch.resume(), false)
  h.clock.advance(5000)
  assert.equal(h.calls.length, 0)
  assert.equal(h.clock.size, 0)
  assert.equal(h.prefetch.start(), true)
  assert.equal(h.prefetch.start(), false)
  assert.equal(h.calls.length, 0)
  assert.equal(h.prefetch.getStats().timers, 1)
  h.prefetch.dispose()
  assert.equal(h.clock.size, 0) // Includes timer id 0.
})

test('prefetch is serial through body decoding and waits 350ms after settlement', async () => {
  const h = harness({ keys: ['a', 'b'] })
  h.prefetch.start(); h.clock.advance(0)
  assert.equal(h.calls.length, 1)
  h.calls[0].respond(); await settle()
  h.clock.advance(5000)
  assert.equal(h.calls.length, 1)
  h.calls[0].body.resolve(bytes(7)); await settle()
  assert.equal(h.cache.get('a').byteLength, 7)
  h.clock.advance(MODEL_PREFETCH_GAP_MS - 1)
  assert.equal(h.calls.length, 1)
  h.clock.advance(1)
  assert.equal(h.calls.length, 2)
  h.calls[1].finish(); await settle()
  assert.equal(h.prefetch.getStats().complete, true)
  assert.equal(h.clock.size, 0)
  h.prefetch.dispose()
})

test('shouldRun gates both requests and admission, then retries without an independent rAF', async () => {
  let run = false
  const h = harness({ keys: ['a'], shouldRun: () => run })
  h.prefetch.start(); h.clock.advance(0)
  h.clock.advance(700)
  assert.equal(h.calls.length, 0)
  run = true; h.clock.advance(350)
  assert.equal(h.calls.length, 1)
  run = false; h.calls[0].finish(); await settle()
  assert.equal(h.cache.getStats().entries, 0)
  assert.equal(h.prefetch.getStats().cursor, 0)
  run = true; h.clock.advance(350)
  h.calls[1].finish(); await settle()
  assert.equal(h.cache.getStats().entries, 1)
  h.prefetch.dispose()
})

test('pause aborts only prefetch, clears timers and ignored abort cannot insert or overlap', async () => {
  const h = harness({ keys: ['a'] }), route = new AbortController()
  h.prefetch.start(); h.clock.advance(0)
  const first = h.calls[0]
  assert.notEqual(first.signal, route.signal)
  assert.equal(h.prefetch.pause(), true)
  assert.equal(first.signal.aborted, true)
  assert.equal(route.signal.aborted, false)
  assert.equal(h.clock.size, 0)
  h.prefetch.resume(); h.clock.advance(1000)
  assert.equal(h.calls.length, 1) // An abort-ignoring request still owns the serial slot.
  first.finish(); await settle()
  assert.equal(h.cache.getStats().entries, 0)
  h.clock.advance(349); assert.equal(h.calls.length, 1)
  h.clock.advance(1); assert.equal(h.calls.length, 2)
  assert.notEqual(h.calls[1].signal, first.signal)
  route.abort() // Foreground cancellation is independent in the other direction too.
  assert.equal(h.calls[1].signal.aborted, false)
  h.calls[1].finish(); await settle()
  assert.equal(h.cache.getStats().entries, 1)
  assert.equal(h.prefetch.getStats().aborted, 1)
  h.prefetch.dispose()
})

test('pause during arrayBuffer and dispose prohibit late cache admission permanently', async () => {
  const h = harness({ keys: ['a'] })
  h.prefetch.start(); h.clock.advance(0)
  h.calls[0].respond(); await settle()
  h.prefetch.pause(); h.prefetch.dispose(); h.cache.clear()
  h.calls[0].body.resolve(bytes(9)); await settle()
  assert.equal(h.cache.getStats().entries, 0)
  assert.equal(h.prefetch.getStats().pending, 0)
  assert.equal(h.clock.size, 0)
  assert.equal(h.prefetch.resume(), false)
  assert.equal(h.prefetch.start(), false)
  h.clock.advance(10000)
  assert.equal(h.calls.length, 1)
})

test('normal abort rejection is consumed; foreground cache fill lets resume skip download', async () => {
  const h = harness({ keys: ['a', 'b'], rejectOnAbort: true })
  h.prefetch.start(); h.clock.advance(0)
  h.prefetch.pause(); await settle()
  assert.equal(h.prefetch.getStats().failed, 0)
  assert.equal(h.prefetch.getStats().pending, 0)
  h.cache.put('a', bytes(10)) // Parent foreground fetch succeeded independently.
  h.prefetch.resume(); h.clock.advance(350)
  assert.equal(h.calls.length, 1)
  assert.equal(h.prefetch.getStats().skipped, 1)
  h.clock.advance(350)
  assert.equal(h.calls[1].url.endsWith('/b.glb'), true)
  h.calls[1].finish(); await settle()
  assert.equal(h.prefetch.getStats().complete, true)
  h.prefetch.dispose()
})

test('HTTP/body failures are silent and proceed serially; oversized response is not cached', async () => {
  const h = harness({ cache: createModelByteCache({ maxBytes: 5 }), keys: ['http', 'body', 'large', 'ok'] })
  h.prefetch.start(); h.clock.advance(0)
  h.calls[0].respond(false); await settle()
  h.clock.advance(350)
  h.calls[1].respond(); h.calls[1].body.reject(new Error('decode failed')); await settle()
  h.clock.advance(350)
  h.calls[2].finish(6); await settle()
  h.clock.advance(350)
  h.calls[3].finish(4); await settle()
  assert.equal(h.prefetch.getStats().failed, 2)
  assert.equal(h.prefetch.getStats().rejected, 1)
  assert.equal(h.prefetch.getStats().stored, 1)
  assert.equal(h.cache.getStats().bytes, 4)
  assert.equal(h.prefetch.getStats().complete, true)
  assert.equal(h.clock.size, 0)
  h.prefetch.dispose()
})

test('pause clears a waiting eligibility/gap timer and disposal does not clear caller-owned cache', async () => {
  const h = harness({ shouldRun: () => { throw new Error('Host unavailable') } })
  h.cache.put('foreground', bytes(3))
  h.prefetch.start(); h.clock.advance(0)
  assert.equal(h.clock.size, 1)
  h.prefetch.pause()
  assert.equal(h.clock.size, 0)
  h.clock.advance(10000)
  assert.equal(h.calls.length, 0)
  h.prefetch.dispose(); h.prefetch.dispose()
  assert.equal(h.cache.get('foreground').byteLength, 3)
  h.cache.clear()
  assert.equal(h.cache.getStats().bytes, 0)
})

test('reentrant host eligibility disposal cannot admit bytes or start a request', async () => {
  let h, checked = 0
  h = harness({ keys: ['a'], shouldRun: () => { if (++checked === 2) h.prefetch.dispose(); return true } })
  h.prefetch.start(); h.clock.advance(0)
  h.calls[0].finish(); await settle()
  assert.equal(h.cache.getStats().entries, 0)
  assert.equal(h.clock.size, 0)
  let before
  before = harness({ shouldRun: () => { before.prefetch.dispose(); return true } })
  before.prefetch.start(); before.clock.advance(0)
  assert.equal(before.calls.length, 0)
  assert.equal(before.clock.size, 0)
})

test('prefetch validates injected dependencies and copies/deduplicates queue descriptions', async () => {
  assert.throws(() => createModelBytePrefetcher({}), TypeError)
  const cache = createModelByteCache(), clock = fakeClock(), items = [{ key: 'a', url: 'old' }, { key: 'a', url: 'chosen' }], calls = []
  const p = createModelBytePrefetcher({ cache, clock, items, AbortController, shouldRun: () => true,
    fetch: async url => { calls.push(url); return { ok: true, arrayBuffer: async () => bytes(1) } } })
  items[1].url = 'mutated'
  p.start(); clock.advance(0); await settle()
  assert.deepEqual(calls, ['chosen'])
  assert.equal(p.getStats().total, 1)
  assert.equal(p.getStats().complete, true)
  p.dispose()
})
