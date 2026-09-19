import * as THREE from 'three'

// Pro's independent Mulberry32 placement stream. There is deliberately no
// drawAssignments export: the host alone chooses which NPCs inhabit each scene.
export function seededRandom(seed) {
  seed = seed >>> 0
  return () => {
    let t = seed += 0x6D2B79F5
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
export function layoutSeed(key) {
  let hash = 2166136261
  for (const char of String(key)) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619) }
  return hash >>> 0
}

export function findNpcFloor(root) {
  let floor = null
  root?.traverse(node => {
    if (!floor && node.isMesh && node.name === 'floor' && node.userData.npcSpawn && node.geometry?.attributes.position) floor = node
  })
  return floor
}

/** Area-weighted barycentric sampling of the authored safe, upward floor faces. */
export function createFloorSampler(floor) {
  if (!floor?.isMesh || floor.name !== 'floor' || !floor.userData.npcSpawn || !floor.geometry?.attributes.position) throw new Error('NPC_FLOOR_MISSING')
  floor.updateWorldMatrix(true, false)
  const { position } = floor.geometry.attributes, index = floor.geometry.index
  const triangles = [], cross = new THREE.Vector3(), edge = new THREE.Vector3()
  let area = 0
  for (let i = 0; i + 2 < (index?.count ?? position.count); i += 3) {
    const vertices = [0, 1, 2].map(j => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(i + j) : i + j).applyMatrix4(floor.matrixWorld))
    if (!vertices.every(v => [v.x, v.y, v.z].every(Number.isFinite))) continue
    cross.subVectors(vertices[1], vertices[0]).cross(edge.subVectors(vertices[2], vertices[0]))
    const weight = cross.length() / 2
    if (weight < 1e-10 || cross.y / (2 * weight) < .5) continue
    area += weight
    triangles.push({ vertices, cumulative: area })
  }
  if (!Number.isFinite(area) || !area) throw new Error('NPC_FLOOR_NO_STANDABLE_TRIANGLES')
  return {
    area,
    sample(random) {
      if (typeof random !== 'function') throw new TypeError('NPC sampling requires an explicit private random source')
      const target = random() * area
      let lo = 0, hi = triangles.length - 1
      while (lo < hi) { const mid = (lo + hi) >> 1; if (triangles[mid].cumulative < target) lo = mid + 1; else hi = mid }
      const [a, b, c] = triangles[lo].vertices, u = Math.sqrt(random()), v = random()
      return a.clone().multiplyScalar(1 - u).addScaledVector(b, u * (1 - v)).addScaledVector(c, u * v)
    },
  }
}

// Upright yaw-facing cards retain the authored ratio at the locked camera pitch.
// The static descriptor supplies its measured alpha bounds, never atlas metadata.
export function cardSize(npc, camera, height = npc.height) {
  if (!Number.isFinite(height) || height <= 0) throw new TypeError('NPC height must be positive')
  const bounds = npc.bounds
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) throw new TypeError('NPC bounds must be nonempty')
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()))
  const screenHeight = height * Math.max(.25, Math.abs(up.y))
  return { width: screenHeight * (bounds[2] - bounds[0]) / (bounds[3] - bounds[1]), height, screenHeight }
}
export function minimumSeparation(a, b, camera) {
  return Math.max(1.8, (cardSize(a, camera).width + cardSize(b, camera).width) / 2 + .6)
}
export function cardsOverlap(a, pa, b, pb, camera) {
  const sa = cardSize(a, camera), sb = cardSize(b, camera)
  const va = pa.clone().applyMatrix4(camera.matrixWorldInverse), vb = pb.clone().applyMatrix4(camera.matrixWorldInverse)
  return Math.abs(va.x - vb.x) < (sa.width + sb.width) / 2 + .15 &&
    Math.min(va.y + sa.screenHeight, vb.y + sb.screenHeight) > Math.max(va.y, vb.y) - .15
}

// Dense rosters use a fixed pool of real floor samples and allocation-free
// projected tests. Sweep packing avoids repeatedly stranding the last resident
// in a random pocket. The legacy <=3 stream below remains byte-for-byte intact.
function placeDenseNpcs(sampler, npcs, camera, random, attempts, trials) {
  const candidates = Array.from({ length: trials }, () => {
    const point = sampler.sample(random), view = point.clone().applyMatrix4(camera.matrixWorldInverse)
    return { point, x: view.x, y: view.y }
  })
  const sizes = npcs.map(npc => cardSize(npc, camera))
  const order = npcs.map((_, i) => i).sort((a, b) => sizes[b].width * sizes[b].screenHeight - sizes[a].width * sizes[a].screenHeight || a - b)
  const sweeps = Array.from({ length: attempts }, (_, i) => {
    const slope = attempts > 1 ? (i / (attempts - 1) - .5) * 2 : 0
    return candidates.slice().sort((a, b) => (a.y + slope * a.x) - (b.y + slope * b.x))
  })
  function pack(scale) {
    for (const sweep of sweeps) {
      const placed = []
      for (const i of order) {
        const size = sizes[i]
        const candidate = sweep.find(point => placed.every(other => {
          const peer = sizes[other.i], separation = Math.max(1.8, (size.width + peer.width) / 2 + .6) * scale
          if (Math.hypot(point.point.x - other.point.point.x, point.point.z - other.point.point.z) < separation) return false
          return Math.abs(point.x - other.point.x) >= (size.width + peer.width) * scale / 2 + .15 ||
            Math.min(point.y + size.screenHeight * scale, other.point.y + peer.screenHeight * scale) <= Math.max(point.y, other.point.y) - .15
        }))
        if (!candidate) break
        placed.push({ i, point: candidate })
      }
      if (placed.length === npcs.length) return placed.sort((a, b) => a.i - b.i).map(({ i, point }) => ({ npc: npcs[i], point: point.point, scale }))
    }
    return null
  }
  const full = pack(1)
  if (full) return full
  // Only dense rosters that failed at authored size may shrink uniformly.
  // Search the largest feasible scale to 1/1024 precision; do not impose a
  // room-specific minimum scale, relax silhouette gaps, or invent floor area.
  // Every trial reuses the same authored sample pool and bounded sweep budget.
  let low = 0, high = 1, best = null
  for (let step = 0; step < 10; step++) {
    const scale = (low + high) / 2, result = pack(scale)
    if (result) { low = scale; best = result } else high = scale
  }
  if (best) return best
  throw new Error('NPC_FLOOR_CROWDED')
}

export function placeNpcs(floor, npcs, camera, random, { attempts = 40, trials = 600 } = {}) {
  if (typeof random !== 'function') throw new TypeError('NPC placement requires an explicit private random source')
  if (!Array.isArray(npcs) || npcs.length > 15) throw new TypeError('NPC placement only accepts the host roster (at most fifteen)')
  if (!npcs.length) return []
  attempts = Math.max(1, Math.min(40, Math.floor(attempts) || 1))
  trials = Math.max(1, Math.min(600, Math.floor(trials) || 1))
  const sampler = createFloorSampler(floor)
  camera.updateMatrixWorld(true)
  if (npcs.length > 3) return placeDenseNpcs(sampler, npcs, camera, random, attempts, trials)
  for (let attempt = 0; attempt < attempts; attempt++) {
    const placed = []
    for (let i = 0; i < npcs.length; i++) {
      const npc = npcs[i]
      for (let trial = 0; trial < trials; trial++) {
        const point = sampler.sample(random)
        if (placed.every(other => Math.hypot(point.x - other.point.x, point.z - other.point.z) >= minimumSeparation(npc, other.npc, camera) &&
          !cardsOverlap(npc, point, other.npc, other.point, camera))) {
          placed.push({ npc, point }); break
        }
      }
      if (placed.length < i + 1) break
    }
    if (placed.length === npcs.length) return placed
  }
  throw new Error('NPC_FLOOR_CROWDED')
}
