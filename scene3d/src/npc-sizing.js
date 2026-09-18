// Presentation-only sizing: no storage, DOM, business state or global preferences.
export const DEFAULT_NPC_SCENE_SCALE = 1.5
const valid = (value, min, max) => Number.isFinite(value) && value >= min && value <= max

export function npcHeight(value, authored = 1.5) {
  return valid(value, .5, 3) ? value : valid(authored, .5, 3) ? authored : 1.5
}

/** A supplied height is an effective world-space override, not an authored base.
 * Defaults come from the imported CSV-derived atlas manifest, never a second roster.
 * Apply the scene multiplier AFTER base validation: 2.20m * 1.5 is valid 3.30m.
 */
export function npcEffectiveHeight(value, authored, sceneScale = DEFAULT_NPC_SCENE_SCALE) {
  if (Number.isFinite(value) && value > 0 && value < 10) return value
  return npcHeight(undefined, authored) * (valid(sceneScale, .5, 3) ? sceneScale : DEFAULT_NPC_SCENE_SCALE)
}

/** Legacy instance-local adjustment helper; its neutral scale remains 1 for callers
 * composing their own adjustments. Runtime authored defaults use npcEffectiveHeight.
 * Never persists game data.
 */
export function createNpcSizing(npcs = [], sceneIds = []) {
  const heights = Object.fromEntries(npcs.map(npc => [npc.id, npcHeight(npc.height)]))
  const sceneScales = Object.fromEntries(sceneIds.map(id => [id, 1]))
  return {
    height: id => heights[id] ?? 1.5,
    scale: id => sceneScales[id] ?? 1,
    effectiveHeight: (id, sceneId) => (heights[id] ?? 1.5) * (sceneScales[sceneId] ?? 1),
    setHeight(id, value) {
      if (!Object.hasOwn(heights, id) || !valid(value, .5, 3)) return false
      heights[id] = value
      return true
    },
    setSceneScale(id, value) {
      if (!Object.hasOwn(sceneScales, id) || !valid(value, .5, 3)) return false
      sceneScales[id] = value
      return true
    },
    get snapshot() { return Object.freeze({ heights: Object.freeze({ ...heights }), sceneScales: Object.freeze({ ...sceneScales }) }) },
  }
}
