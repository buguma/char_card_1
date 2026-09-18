// Pure coordinator: candidate release MUST NOT unbind the current scene.
// Load may ignore AbortSignal while parsing; validity is checked after every await.
export function createNavigation({ load, activate, deactivate, release, onStart = () => {}, onError = () => {} }) {
  let generation = 0, task = null, main = null, room = null, active = null, destroyed = false
  let failedKey = null, committedKey = null
  const keyOf = (id, epoch) => `${epoch}:${id}`
  function cancel() {
    generation++; committedKey = null
    // Even a completed cached scene needs a new first-frame handshake after hide.
    if (task) { task.controller.abort(); task = null }
  }
  function drop(record) {
    if (!record) return
    if (active === record) { deactivate(record); active = null }
    release(record)
  }
  function navigate(id, epoch, { force = false } = {}) {
    if (destroyed) return Promise.resolve('destroyed')
    const key = keyOf(id, epoch)
    if (!force && task?.key === key) return task.promise
    if (!force && failedKey === key) return Promise.resolve('degraded')
    if (!force && active?.id === id && committedKey === key) return Promise.resolve('applied')
    cancel(); failedKey = null; committedKey = null
    const token = generation, controller = new AbortController()
    const valid = () => !destroyed && token === generation && !controller.signal.aborted
    onStart(id)
    // New room acquisition never retains the old room as an unbounded cache.
    if (room && room.id !== id && id !== 'main') { const old = room; room = null; drop(old) }
    const run = { key, controller, promise: null }
    task = run
    let abortResolve
    const aborted = new Promise(resolve => { abortResolve = resolve })
    controller.signal.addEventListener('abort', () => abortResolve(destroyed ? 'destroyed' : 'superseded'), { once: true })
    const work = (async () => {
      let candidate = null
      try {
        if (!main) {
          candidate = await load('main', controller.signal)
          if (!valid()) return destroyed ? 'destroyed' : 'superseded'
          main = candidate; candidate = null
        }
        if (!valid()) return destroyed ? 'destroyed' : 'superseded'
        let record = main
        if (id !== 'main') {
          if (!room || room.id !== id) {
            candidate = await load(id, controller.signal)
            if (!valid()) return destroyed ? 'destroyed' : 'superseded'
            room = candidate; candidate = null
          }
          record = room
        }
        if (active && active !== record) deactivate(active)
        active = record
        record.epoch = epoch
        await activate(record, valid)
        if (!valid()) return destroyed ? 'destroyed' : 'superseded'
        committedKey = key
        return 'applied'
      } catch (error) {
        if (!valid()) return destroyed ? 'destroyed' : 'superseded'
        failedKey = key
        if (active) { deactivate(active); active = null }
        // A partially patched or failed compile candidate is never treated as ready.
        if (room) { const old = room; room = null; release(old) }
        onError(error, id)
        return 'degraded'
      } finally {
        if (candidate) release(candidate)
        if (task === run) task = null
      }
    })()
    run.promise = Promise.race([work, aborted])
    return run.promise
  }
  return { navigate, cancel, dispose() {
    if (destroyed) return
    destroyed = true; cancel()
    if (active) { deactivate(active); active = null }
    if (room) release(room)
    if (main) release(main)
    main = room = null
  }, get active() { return active }, get busy() { return Boolean(task) }, get generation() { return generation },
  snapshot() { return Object.freeze({ routeGeneration: generation, pending: Number(Boolean(task)), cachedMain: Number(Boolean(main)), cachedRooms: Number(Boolean(room)), activeSceneId: active?.id ?? null }) } }
}
