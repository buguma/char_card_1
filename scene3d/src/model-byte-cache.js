// Encoded GLB bytes only. No module-level cache, parsing, GPU objects or scheduling.
export const MODEL_BYTE_CACHE_MAX_ENTRIES = 3
export const MODEL_BYTE_CACHE_MAX_BYTES = 32 * 1024 * 1024
export const MODEL_PREFETCH_GAP_MS = 350

export function createModelByteCache({ version = '', maxEntries = MODEL_BYTE_CACHE_MAX_ENTRIES, maxBytes = MODEL_BYTE_CACHE_MAX_BYTES } = {}) {
  if (typeof version !== 'string') throw new TypeError('Cache version must be a string')
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MODEL_BYTE_CACHE_MAX_ENTRIES) throw new RangeError('Cache supports at most 3 entries')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MODEL_BYTE_CACHE_MAX_BYTES) throw new RangeError('Cache supports at most 32 MiB')
  const entries = new Map()
  let bytes = 0
  const stats = { hits: 0, misses: 0, puts: 0, rejected: 0, evictions: 0, clears: 0 }
  const checkKey = key => { if (typeof key !== 'string' || !key.length) throw new TypeError('Cache key must be a nonempty string') }
  function remove(key) {
    const entry = entries.get(key)
    if (!entry) return
    bytes -= entry.size
    entries.delete(key)
  }
  return Object.freeze({
    get(key) {
      checkKey(key)
      const entry = entries.get(key)
      // A transferred/detached buffer cannot serve a later loader. Do not retain
      // its original byte accounting if a consumer violated the borrowing rule.
      if (!entry || entry.buffer.byteLength !== entry.size) {
        if (entry) remove(key)
        stats.misses++
        return null
      }
      entries.delete(key); entries.set(key, entry)
      stats.hits++
      return entry.buffer
    },
    put(key, buffer) {
      checkKey(key)
      if (!(buffer instanceof ArrayBuffer)) throw new TypeError('Only encoded ArrayBuffer values may be cached')
      const size = buffer.byteLength
      if (!size || size > maxBytes) { stats.rejected++; return false }
      remove(key)
      while (entries.size >= maxEntries || bytes + size > maxBytes) {
        remove(entries.keys().next().value); stats.evictions++
      }
      // Borrowed immutable bytes: callers must not mutate or transfer/detach.
      // Avoid a defensive copy that doubles the transient encoded byte budget.
      entries.set(key, { buffer, size }); bytes += size; stats.puts++
      return true
    },
    clear() { entries.clear(); bytes = 0; stats.clears++ },
    getStats() { return Object.freeze({ version, entries: entries.size, bytes, maxEntries, maxBytes, ...stats }) },
  })
}

/** Optional one-pass prefetcher, explicitly started only after main readiness.
 * Each item is { key, url }; use immutable versioned absolute URLs as keys.
 * Its AbortController belongs ONLY to prefetch, never to a foreground route.
 * pause() aborts and removes the timer; resume() cannot start before start().
 * A fetch ignoring abort holds the sole slot until it settles, preventing overlap.
 * dispose() invalidates late completion but does not own/clear the caller's cache.
 */
export function createModelBytePrefetcher({ cache, items, fetch, AbortController: Controller, clock, shouldRun }) {
  if (!cache || typeof cache.get !== 'function' || typeof cache.put !== 'function') throw new TypeError('A byte cache is required')
  if (!Array.isArray(items) || items.some(item => !item || typeof item.key !== 'string' || !item.key || typeof item.url !== 'string' || !item.url)) throw new TypeError('Prefetch items require key/url strings')
  if (typeof fetch !== 'function' || typeof Controller !== 'function' || typeof shouldRun !== 'function' || typeof clock?.setTimeout !== 'function' || typeof clock?.clearTimeout !== 'function') throw new TypeError('Inject fetch, AbortController, clock and shouldRun')
  // Copy the bounded work description, not bytes; callers cannot retarget a run.
  const queue = [...new Map(items.map(item => [item.key, Object.freeze({ key: item.key, url: item.url })])).values()]
  let started = false, paused = true, disposed = false, generation = 0, cursor = 0, timer = null, active = null
  const stats = { requested: 0, stored: 0, skipped: 0, rejected: 0, failed: 0, aborted: 0 }
  function allowed() { try { return Boolean(shouldRun()) } catch { return false } }
  function clearTimer() { if (timer !== null) clock.clearTimeout(timer); timer = null }
  function schedule(delay = MODEL_PREFETCH_GAP_MS) {
    if (!started || paused || disposed || active || timer !== null || cursor >= queue.length) return
    timer = clock.setTimeout(pump, delay)
  }
  function pump() {
    timer = null
    if (!started || paused || disposed || active || cursor >= queue.length) return
    if (!allowed()) { schedule(); return }
    // Host eligibility callbacks can synchronously pause/dispose this instance.
    if (paused || disposed) return
    const item = queue[cursor]
    if (cache.get(item.key)) { stats.skipped++; cursor++; schedule(); return }
    const run = { controller: new Controller(), token: generation }
    active = run
    const valid = () => !disposed && !paused && run.token === generation && !run.controller.signal.aborted
    stats.requested++
    // All rejections are consumed here; background failure never degrades a route.
    void (async () => {
      try {
        const response = await fetch(item.url, { signal: run.controller.signal })
        if (!valid()) return
        if (!response?.ok) throw new Error('Prefetch HTTP failure')
        const buffer = await response.arrayBuffer()
        if (!valid() || !allowed() || !valid()) return
        if (cache.put(item.key, buffer)) stats.stored++
        else stats.rejected++
        cursor++
      } catch {
        if (valid()) { stats.failed++; cursor++ }
      } finally {
        if (active === run) active = null
        schedule()
      }
    })()
  }
  function pause() {
    if (disposed) return false
    paused = true; generation++; clearTimer()
    if (active && !active.controller.signal.aborted) { stats.aborted++; active.controller.abort() }
    return true
  }
  return Object.freeze({
    start() {
      if (disposed || started) return false
      started = true; paused = false; schedule(0); return true
    },
    pause,
    resume() {
      if (disposed || !started) return false
      paused = false; schedule(); return true
    },
    dispose() {
      if (disposed) return
      pause(); disposed = true
    },
    getStats() { return Object.freeze({ started, paused, disposed, pending: Number(Boolean(active)), timers: Number(timer !== null), cursor, total: queue.length, complete: cursor >= queue.length, ...stats }) },
  })
}
