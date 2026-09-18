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

export function placeNpcs(floor, npcs, camera, random, { attempts = 40, trials = 600 } = {}) {
  if (typeof random !== 'function') throw new TypeError('NPC placement requires an explicit private random source')
  if (!Array.isArray(npcs) || npcs.length > 3) throw new TypeError('NPC placement only accepts the host selected subset (at most three)')
  if (!npcs.length) return []
  attempts = Math.max(1, Math.min(40, Math.floor(attempts) || 1))
  trials = Math.max(1, Math.min(600, Math.floor(trials) || 1))
  const sampler = createFloorSampler(floor)
  camera.updateMatrixWorld(true)
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
