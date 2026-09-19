export const PROTOCOL = 1
export const LOCATION_TO_SCENE = Object.freeze({ tianshanpai: 'main', map: 'main', yanwuchang: 'training', cangjingge: 'library', huofang: 'kitchen', houshan: 'back_mountain', yishiting: 'council', tiejiangpu: 'forge', nandizi: 'male_quarters', nvdizi: 'female_quarters', shanmen: 'gate', gongtian: 'fields', danfang: 'alchemy' })
export const SCENE_TO_LOCATION = Object.freeze(Object.fromEntries(Object.entries(LOCATION_TO_SCENE).filter(([id]) => id !== 'map').map(([id, scene]) => [scene, id])))
const own = (object, key) => Object.hasOwn(object, key)
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
function invalid(message) { const error = new TypeError(message); error.code = 'PROTOCOL_INVALID'; throw error }
export function normalizeSnapshot(input) {
  if (!input || input.protocol !== PROTOCOL) invalid('Unsupported Scene3D protocol')
  for (const key of ['sessionEpoch', 'revision']) if (!Number.isSafeInteger(input[key]) || input[key] < 0) invalid(`Invalid ${key}`)
  if (!Number.isSafeInteger(input.mode)) invalid('Invalid mode')
  const sceneId = input.sceneId ?? null
  if (sceneId !== null && !own(SCENE_TO_LOCATION, sceneId)) invalid('Unknown or unavailable scene')
  if (sceneId && (input.mode !== 0 || LOCATION_TO_SCENE[input.logicalPage] !== sceneId || LOCATION_TO_SCENE[input.gameLocationId] !== sceneId)) invalid('Inconsistent route')
  for (const key of ['visible', 'renderEnabled', 'interactive']) if (typeof input[key] !== 'boolean') invalid(`Invalid ${key}`)
  if (!Array.isArray(input.residents ?? []) || !Array.isArray(input.renderedNpcs ?? [])) invalid('Invalid NPC roster')
  const residents = (input.residents ?? []).map(item => {
    if (!item || typeof item.gameNpcId !== 'string' || !/^[A-O]$/.test(item.gameNpcId) || item.visible === false) invalid('Inconsistent resident')
    return { gameNpcId: item.gameNpcId, displayName: String(item.displayName ?? '') }
  })
  const ids = new Set(residents.map(item => item.gameNpcId))
  if (ids.size !== residents.length) invalid('Duplicate residents')
  const renderedNpcs = (input.renderedNpcs ?? []).map(item => {
    if (!item || !ids.has(item.gameNpcId) || !['static', 'animated', 'atlas'].includes(item.visualKind)) invalid('Inconsistent rendered NPC')
    // Missing height is authored, not a 1.5m override: NPCs resolve manifest CSV defaults.
    // Explicit heights retain their effective world-space meaning for older hosts.
    return { gameNpcId: item.gameNpcId, displayName: String(item.displayName ?? residents.find(resident => resident.gameNpcId === item.gameNpcId)?.displayName ?? item.gameNpcId), visualKind: item.visualKind, visualKey: String(item.visualKey ?? ''), portraitUrl: String(item.portraitUrl ?? ''), heightMeters: Number.isFinite(item.heightMeters) && item.heightMeters > 0 && item.heightMeters < 10 ? item.heightMeters : undefined }
  })
  if (renderedNpcs.length > 15 || new Set(renderedNpcs.map(item => item.gameNpcId)).size !== renderedNpcs.length) invalid('Invalid rendered subset')
  // Optional for older protocol-1 hosts. These are host-map counts, not roster
  // lengths: hidden/legacy entries can count too, including a sixteenth Z entry.
  // Bound DOM-dot allocation to that legal host roster, never arbitrary integers.
  const locationNpcCounts = Object.fromEntries(Object.keys(LOCATION_TO_SCENE).filter(id => !['map', 'tianshanpai'].includes(id)).map(id => [id, 0]))
  if (input.locationNpcCounts !== undefined) {
    const counts = input.locationNpcCounts
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) invalid('Invalid location NPC counts')
    for (const key of Reflect.ownKeys(counts)) {
      if (!own(locationNpcCounts, key) || !Number.isSafeInteger(counts[key]) || counts[key] < 0 || counts[key] > 16) invalid('Invalid location NPC count')
      locationNpcCounts[key] = counts[key]
    }
  }
  const env = input.environment ?? {}
  return freeze({ protocol: PROTOCOL, sessionEpoch: input.sessionEpoch, revision: input.revision, mode: input.mode, logicalPage: String(input.logicalPage ?? 'other'), gameLocationId: String(input.gameLocationId ?? ''), sceneId,
    environment: { season: ['spring', 'summer', 'autumn', 'winter'].includes(env.season) ? env.season : 'winter', hour: Number.isFinite(env.hour) && env.hour >= 0 && env.hour < 24 ? env.hour : 12, timeSource: String(env.timeSource ?? 'dayNightFallback') },
    residents, renderedNpcs, locationNpcCounts, layoutKey: String(input.layoutKey ?? `${input.sessionEpoch}:${sceneId}:${renderedNpcs.map(n => n.gameNpcId).join(',')}`), visible: input.visible, renderEnabled: input.renderEnabled, interactive: input.interactive, blockReasons: (input.blockReasons ?? []).map(String) })
}
export function applyResult(status, snapshot) { return Object.freeze({ status, epoch: snapshot?.sessionEpoch ?? null, revision: snapshot?.revision ?? null, sceneId: snapshot?.sceneId ?? null }) }
export function compareVersion(a, b) { return a.sessionEpoch === b.sessionEpoch ? Math.sign(a.revision - b.revision) : Math.sign(a.sessionEpoch - b.sessionEpoch) }
export function normalizeAssetBase(value) {
  if (typeof value !== 'string' || !value) invalid('assetBaseUrl must be explicit and absolute')
  let url
  try { url = new URL(value) } catch { invalid('assetBaseUrl must be absolute') }
  if (!['http:', 'https:', 'file:', 'capacitor:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) invalid('Invalid asset base URL')
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.href
}
export function semanticLocation(object) {
  for (let node = object; node; node = node.parent) {
    const id = node.userData?.interactionId
    if (id) return node.userData.clickable === true && own(SCENE_TO_LOCATION, id) && id !== 'main' ? SCENE_TO_LOCATION[id] : null
  }
  return null
}
export function clientAnchor(point, rect) {
  if (!rect.width || !rect.height || point.z < -1 || point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1) return null
  return Object.freeze({ space: 'client-css-px', left: rect.left + (point.x + 1) * rect.width / 2, top: rect.top + (1 - point.y) * rect.height / 2, width: 0, height: 0 })
}
