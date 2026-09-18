// Resource identity, not mesh count, determines ownership. Retaining a root before
// material patching also retains the exported materials replaced by environment.
export function createResourceRegistry() {
  const roots = new Map(), refs = new Map(), disposed = new WeakSet()
  const totals = { registered: 0, disposed: 0 }
  function resourcesOf(root) {
    const found = new Set()
    const inspect = value => {
      if (value?.isTexture) {
        found.add(value)
        for (const image of [].concat(value.source?.data || value.image || [])) if (typeof image?.close === 'function') found.add(image)
      }
      else if (Array.isArray(value)) value.forEach(inspect)
    }
    root?.traverse?.(object => {
      if (object.geometry) found.add(object.geometry)
      if (object.skeleton) found.add(object.skeleton)
      for (const material of [].concat(object.material || [])) {
        found.add(material)
        Object.values(material).forEach(inspect)
        for (const uniform of Object.values(material.uniforms || {})) inspect(uniform?.value)
      }
    })
    return found
  }
  function track(root) {
    if (!root) return root
    let owned = roots.get(root)
    if (!owned) { owned = new Set(); roots.set(root, owned) }
    for (const resource of resourcesOf(root)) if (!owned.has(resource)) {
      owned.add(resource); refs.set(resource, (refs.get(resource) || 0) + 1); totals.registered++
    }
    return root
  }
  function release(root) {
    if (!roots.has(root)) return
    track(root)
    const owned = roots.get(root)
    roots.delete(root)
    root.removeFromParent?.()
    for (const resource of owned) {
      const count = refs.get(resource) - 1
      if (count > 0) { refs.set(resource, count); continue }
      refs.delete(resource)
      if (disposed.has(resource)) continue
      disposed.add(resource)
      try { resource.dispose?.() } catch { /* Continue releasing independent resources. */ }
      // ImageBitmap identity is refcounted separately from texture identity.
      // Two texture views may share one bitmap across different model roots.
      if (!resource.isTexture) { try { resource.close?.() } catch { /* already closed */ } }
      totals.disposed++
    }
  }
  return { track, release, dispose() { for (const root of [...roots.keys()]) release(root) }, snapshot() {
    let geometries = 0, materials = 0, textures = 0
    for (const resource of refs.keys()) { if (resource.isBufferGeometry) geometries++; if (resource.isMaterial) materials++; if (resource.isTexture) textures++ }
    return Object.freeze({ roots: roots.size, resources: refs.size, geometries, materials, textures, ...totals })
  } }
}

export function createListenerRegistry() {
  const disposers = new Set()
  return { listen(target, type, handler, options) {
    target.addEventListener(type, handler, options)
    const remove = () => { target.removeEventListener(type, handler, options); disposers.delete(remove) }
    disposers.add(remove); return remove
  }, dispose() { for (const remove of [...disposers]) remove() }, get size() { return disposers.size } }
}
