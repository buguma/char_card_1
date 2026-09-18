import * as THREE from 'three'

// Adapted from Pro's cheap blob shadows: no extra shadow-map pass or sprite readback.
// One resource set per current NPC group; the NPC controller owns its entire lifetime.
export const NPC_SHADOW_LIFT = .002

export function createNpcContactShadows({ parent, floor }) {
  if (!parent?.isObject3D || !floor?.isMesh || !floor.geometry?.attributes.position) throw new TypeError('NPC contact shadows require a parent and floor mesh')
  const geometry = new THREE.PlaneGeometry(1, 1)
  const resolution = 64, pixels = new Uint8Array(resolution * resolution * 4)
  for (let y = 0; y < resolution; y++) for (let x = 0; x < resolution; x++) {
    const radius = Math.hypot((x + .5) / resolution * 2 - 1, (y + .5) / resolution * 2 - 1)
    const falloff = Math.max(0, 1 - radius * radius)
    pixels[(y * resolution + x) * 4 + 3] = Math.round(255 * falloff * falloff)
  }
  const texture = new THREE.DataTexture(pixels, resolution, resolution)
  texture.minFilter = texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false; texture.needsUpdate = true
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: .44,
    depthTest: true, depthWrite: false, alphaTest: .001, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
  material.name = 'NPC_Soft_Contact_Shadow'
  const entries = new Map(), ray = new THREE.Raycaster()
  const foot = new THREE.Vector3(), axisX = new THREE.Vector3(), axisY = new THREE.Vector3()
  const center = new THREE.Vector3(), size = new THREE.Vector3(), rotation = new THREE.Quaternion()
  const normalMatrix = new THREE.Matrix3(), basis = new THREE.Matrix4(), inverse = new THREE.Matrix4()
  const floorMatrix = new THREE.Matrix4(), down = new THREE.Vector3(0, -1, 0)
  let disposed = false, enabled = true, raycasts = 0
  let floorGeometry, floorPosition, floorIndex, positionVersion, indexVersion

  function add(card) {
    if (disposed || entries.has(card)) return false
    if (!card?.isMesh || typeof card.userData.gameNpcId !== 'string') throw new TypeError('NPC contact shadow requires gameNpcId')
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `NPC_ContactShadow_${card.userData.gameNpcId}`
    mesh.userData.npcContactShadow = true
    mesh.raycast = () => {} // Never steal NPC/prop clicks, including transparent gaps.
    mesh.matrixAutoUpdate = false
    mesh.castShadow = mesh.receiveShadow = false
    mesh.visible = false
    parent.add(mesh)
    entries.set(card, { mesh, foot: new THREE.Vector3(Infinity, Infinity, Infinity), support: null, width: 0, depth: 0 })
    return true
  }

  function update(value = enabled) {
    if (disposed) return
    enabled = Boolean(value)
    parent.updateWorldMatrix(true, true)
    floor.updateWorldMatrix(true, false)
    const position = floor.geometry?.attributes.position, index = floor.geometry?.index
    const floorChanged = !floorMatrix.equals(floor.matrixWorld) || floorGeometry !== floor.geometry ||
      floorPosition !== position || floorIndex !== index || positionVersion !== position?.version || indexVersion !== index?.version
    floorMatrix.copy(floor.matrixWorld)
    floorGeometry = floor.geometry; floorPosition = position; floorIndex = index
    positionVersion = position?.version; indexVersion = index?.version
    normalMatrix.getNormalMatrix(floor.matrixWorld)
    inverse.copy(parent.matrixWorld).invert()
    for (const [card, entry] of entries) {
      const { mesh } = entry
      foot.setFromMatrixPosition(card.matrixWorld)
      if (floorChanged || !entry.foot.equals(foot)) {
        entry.foot.copy(foot)
        // The invisible authored floor is a support mask, not y=0 or bbox.max.y.
        // Close support only: never project from an unsupported foot to a lower stair.
        ray.set(center.copy(foot).addScaledVector(THREE.Object3D.DEFAULT_UP, .06), down)
        ray.near = 0; ray.far = .14
        raycasts++
        const hit = position && ray.intersectObject(floor, false).find(hit => hit.face && hit.face.normal.clone().applyMatrix3(normalMatrix).normalize().y > .5)
        entry.support = hit ? { point: hit.point.clone(), normal: hit.face.normal.clone().applyMatrix3(normalMatrix).normalize() } : null
      }
      mesh.visible = enabled && card.visible && card.material.visible && !!entry.support
      if (!entry.support) continue
      const { point, normal } = entry.support
      axisX.setFromMatrixColumn(card.matrixWorld, 0)
      const width = axisX.length(), height = axisY.setFromMatrixColumn(card.matrixWorld, 1).length()
      entry.width = Math.max(width * .68, height * .26)
      entry.depth = height * .23
      // These are already world sizes, including authored height and scene multiplier.
      axisX.addScaledVector(normal, -axisX.dot(normal)).normalize()
      axisY.crossVectors(normal, axisX).normalize()
      basis.makeBasis(axisX, axisY, normal)
      rotation.setFromRotationMatrix(basis)
      center.copy(point).addScaledVector(normal, NPC_SHADOW_LIFT)
      size.set(entry.width, entry.depth, 1)
      mesh.matrix.compose(center, rotation, size).premultiply(inverse)
      mesh.matrixWorldNeedsUpdate = true
    }
    parent.updateWorldMatrix(true, true)
  }

  function snapshot() {
    // Diagnostics read the last update only; no transform update, raycast or mutation.
    const residents = Object.freeze([...entries].map(([card, entry]) => {
      let visible = entry.mesh.visible
      for (let node = entry.mesh.parent; node; node = node.parent) visible &&= node.visible
      return Object.freeze({ gameNpcId: card.userData.gameNpcId, visible, supported: !!entry.support,
        foot: Object.freeze(entry.foot.toArray()), position: Object.freeze(new THREE.Vector3().setFromMatrixPosition(entry.mesh.matrixWorld).toArray()),
        normal: entry.support ? Object.freeze(entry.support.normal.toArray()) : null, width: entry.width, depth: entry.depth })
    }))
    return Object.freeze({ raycasts, residents })
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const { mesh } of entries.values()) mesh.removeFromParent()
    entries.clear()
    geometry.dispose(); material.dispose(); texture.dispose(); texture.image = null
    floorGeometry = floorPosition = floorIndex = null
  }
  return { add, update, snapshot, dispose }
}
