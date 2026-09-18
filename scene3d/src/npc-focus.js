// Orthographic framing uses the actual upright card's projected height, not a
// scene-specific magic zoom or the (possibly viewport-clipped) picking rectangle.
export function npcFocusZoom(camera, projectedHeight, fraction = .29) {
  if (!Number.isFinite(projectedHeight) || projectedHeight <= 0) return null
  return camera.zoom * fraction / projectedHeight
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
