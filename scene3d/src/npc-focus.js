// Orthographic framing uses the actual upright card's projected height, not a
// scene-specific magic zoom or the (possibly viewport-clipped) picking rectangle.
export function npcFocusZoom(camera, projectedHeight, fraction = .29) {
  if (!Number.isFinite(projectedHeight) || projectedHeight <= 0) return null
  return camera.zoom * fraction / projectedHeight
}

// OrbitControls has no public damping reset. Consume pending deltas without
// retaining the resulting pose; never reset to the room's canonical orientation.
export function clearNpcCameraDamping(camera, controls) {
  const position = camera.position.clone(), target = controls.target.clone()
  const quaternion = camera.quaternion.clone(), zoom = camera.zoom
  const damping = controls.enableDamping, autoRotate = controls.autoRotate
  controls.enableDamping = false; controls.autoRotate = false
  controls.update()
  camera.position.copy(position); controls.target.copy(target)
  camera.quaternion.copy(quaternion); camera.zoom = zoom
  camera.updateProjectionMatrix(); camera.updateMatrixWorld(true)
  controls.enableDamping = damping; controls.autoRotate = autoRotate
}

// Return the room's initial target/zoom, but preserve the CURRENT full offset
// (yaw, pitch AND distance), so a pan/zoom tween cannot rotate even midway.
export function restoreNpcRoomCamera(camera, controls, target, zoom = 1.55) {
  camera.position.add(target.clone().sub(controls.target))
  controls.target.copy(target)
  controls.minZoom = .5; controls.maxZoom = 5
  camera.zoom = zoom
  camera.lookAt(controls.target); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true)
}

export function frameNpcCamera(camera, controls, geometry, fraction = .29) {
  const zoom = npcFocusZoom(camera, geometry.projectedHeight, fraction)
  if (!Number.isFinite(zoom) || zoom <= 0) return false
  const shift = geometry.center.clone().sub(controls.target)
  camera.position.add(shift)
  controls.target.copy(geometry.center)
  // Small characters in large rooms can legitimately exceed the manual zoom cap.
  controls.maxZoom = Math.max(5, zoom * 1.25)
  controls.minZoom = Math.min(.5, zoom)
  camera.zoom = zoom
  camera.updateProjectionMatrix()
  camera.lookAt(controls.target)
  camera.updateMatrixWorld(true)
  return true
}
