import { INTERIOR_SCENES } from './interior-scenes.js'
import { SCENE_TO_LOCATION } from './protocol.js'

// Mesh-local landmarks verified against Draco-decoded baseline-007c / integration-013.
// gate_matte also contains stairs out to z=45.83255: its box center is NOT the arch.
// The four highest unique roof ornament vertices average (0, 13.054235, 13.100031).
// back_mountain_matte merges terrain/bridge/pavilion. The pavilion's gold finial
// bounds are x=19.754841..19.845295, y=9.640238..10.080019,
// z=-15.838728..-15.760769; its roof trim spans x=18.151636..21.448502,
// z=-17.267567..-14.332525. Neither the bridge posts nor terrain summit is its roof.
const ROOF_LANDMARKS = {
  gate: [0, 13.054235, 13.1],
  back_mountain: [19.8, 10.08, -15.8],
}

// Informational main-map names, separate from the interactive room action buttons.
// The GLB's category/interactionId groups are authoritative: no screen-space map
// coordinates and no fabricated label when the corresponding model is absent.
export function createLocationLabels({ THREE, container, camera }) {
  const doc = container.ownerDocument
  const layer = doc.createElement('div')
  layer.className = 'scene3d-location-labels'
  layer.setAttribute('aria-hidden', 'true')
  layer.style.pointerEvents = 'none'
  layer.hidden = true
  container.appendChild(layer)
  const world = new THREE.Vector3(), view = new THREE.Vector3(), projected = new THREE.Vector3()
  let items = [], sceneId = null, disposed = false, counts = {}

  function applyCount(item) {
    const value = counts[SCENE_TO_LOCATION[item.label.dataset.sceneId]]
    const count = Number.isSafeInteger(value) && value >= 0 && value <= 16 ? value : 0
    if (item.count === count) return
    for (const child of [...item.people.children]) child.remove()
    for (let i = 0; i < count; i++) {
      const dot = doc.createElement('span'); dot.className = 'people-dot'
      item.people.appendChild(dot)
    }
    item.divider.style.opacity = count > 0 ? '1' : '0.35'
    item.label.dataset.npcCount = String(count)
    item.count = count
  }
  function setCounts(value = {}) {
    if (disposed) return
    counts = { ...value }
    for (const item of items) applyCount(item)
  }

  function clear() {
    for (const item of items) item.label.remove()
    items = []; sceneId = null; layer.hidden = true
  }
  function bind(root, id) {
    clear()
    if (disposed || id !== 'main' || !root) return
    sceneId = id
    root.updateWorldMatrix(true, true)
    const seen = new Set()
    root.traverse(node => {
      const data = node.userData || {}, descriptor = INTERIOR_SCENES[data.interactionId]
      // Hide only the guest-room name; never change model visibility or actions.
      if (data.category !== 'location' || !descriptor || data.interactionId === 'guest_quarters' || seen.has(data.interactionId)) return
      // Prefer authored solid geometry, not seasonal foliage/glow whose bounds
      // may extend beyond the actual building. Other models fall back to the group.
      const model = node.getObjectByName(`${data.interactionId}_matte`) || node
      const bounds = new THREE.Box3().setFromObject(model)
      if (bounds.isEmpty()) return
      let point, anchorNode = node
      const landmark = ROOF_LANDMARKS[data.interactionId]
      if (landmark && model.name === `${data.interactionId}_matte` && model.geometry) {
        model.geometry.computeBoundingBox()
        const roof = new THREE.Vector3().fromArray(landmark)
        // Check local geometry, not a rotated world AABB; replacements that do
        // not contain the authored roof retain their ordinary bounds anchor.
        if (model.geometry.boundingBox?.containsPoint(roof)) { point = roof; anchorNode = model }
      }
      if (!point) {
        point = bounds.getCenter(new THREE.Vector3())
        point.y = bounds.max.y
        node.worldToLocal(point)
      }
      const label = doc.createElement('span')
      label.className = 'scene3d-location-label'
      label.textContent = typeof data.label === 'string' && data.label.trim() ? data.label.trim() : descriptor.label
      label.dataset.sceneId = data.interactionId
      label.style.pointerEvents = 'none'
      label.hidden = true
      const divider = doc.createElement('span'); divider.className = 'location-label-divider'
      const people = doc.createElement('span'); people.className = 'location-people'
      label.appendChild(divider); label.appendChild(people)
      layer.appendChild(label)
      const item = { node: anchorNode, point, label, divider, people, count: null }
      items.push(item); applyCount(item)
      seen.add(data.interactionId)
    })
  }
  function nodeVisible(node) {
    for (let current = node; current; current = current.parent) if (!current.visible) return false
    return true
  }
  function setVisible(value) {
    const hidden = disposed || !value || !items.length
    const changed = layer.hidden !== hidden
    layer.hidden = hidden
    // Project before revealing after a paused render or route transition.
    if (changed && !hidden) update()
  }
  function update() {
    if (disposed || layer.hidden) return
    // Renderer and overlay occupy the same shell; layout CSS px remain correct
    // under DPR changes and host CSS transforms (client rect would double-scale).
    const width = container.clientWidth, height = container.clientHeight
    camera.updateWorldMatrix(true, false)
    for (const item of items) {
      if (!width || !height || !nodeVisible(item.node)) { item.label.hidden = true; continue }
      item.node.updateWorldMatrix(true, false)
      world.copy(item.point).applyMatrix4(item.node.matrixWorld)
      view.copy(world).applyMatrix4(camera.matrixWorldInverse)
      projected.copy(world).project(camera)
      // Explicit camera-space test also handles orthographic cameras with a
      // near plane behind the camera. Never clamp a hidden point onto an edge.
      const visible = view.z < 0 && [projected.x, projected.y, projected.z].every(Number.isFinite)
        && projected.z >= -1 && projected.z <= 1 && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1
      item.label.hidden = !visible
      if (!visible) continue
      item.label.style.left = `${(projected.x + 1) * width / 2}px`
      item.label.style.top = `${(1 - projected.y) * height / 2}px`
    }
  }
  return {
    bind, clear, setVisible, setCounts, update,
    dispose() { if (disposed) return; clear(); disposed = true; layer.remove() },
    getStats() { return { sceneId, count: items.length, visible: !layer.hidden, disposed,
      labels: items.map(item => ({ sceneId: item.label.dataset.sceneId, text: item.label.textContent, npcCount: item.count, visible: !layer.hidden && !item.label.hidden })) } },
  }
}
