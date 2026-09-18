// Instance-independent visual defaults. Quality selection stays with the host:
// these values never enable postprocessing, shadows or a new quality tier.
export const DEFAULT_MSAA = 2
export const DEFAULT_PAPER_COLOR = '#f6f0e0'
export const NIGHT_PAPER_COLOR = '#101c32'
export const SUBSCENE_TILT_SHIFT = 1.5
export const RENDER_DEFAULTS = Object.freeze({
  tiltShift: 2,
  dofSharp: 4.5,
  dofBlur: 1.5,
  bloom: 1,
  shaftStrength: 0.85,
  saturation: 1.4,
  contrast: 1.4,
  gamma: 0.88,
  warmth: 0.38,
  vignette: 0.85,
  hazeStrength: 0.6,
})

export function calculateDofRanges(sharp, zoom, sceneScale = 1) {
  if (!Number.isFinite(sharp) || sharp < 0 || !Number.isFinite(zoom) || !Number.isFinite(sceneScale) || sceneScale <= 0) {
    throw new TypeError('DOF requires finite sharp/zoom and a positive scene scale')
  }
  const scale = sceneScale / Math.sqrt(Math.max(0.1, zoom))
  return { sharpRange: sharp * scale, falloff: 22 * scale }
}
