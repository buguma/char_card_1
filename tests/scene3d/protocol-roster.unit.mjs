import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSnapshot } from '../../scene3d/src/protocol.js'

const snapshot = (patch = {}) => ({ protocol: 1, sessionEpoch: 1, revision: 1, mode: 0, logicalPage: 'cangjingge', gameLocationId: 'cangjingge', sceneId: 'library', visible: true, renderEnabled: true, interactive: true, residents: [], renderedNpcs: [], ...patch })
const resident = gameNpcId => ({ gameNpcId, displayName: gameNpcId })
const visual = gameNpcId => ({ gameNpcId, visualKind: 'animated', visualKey: gameNpcId })
const roster = [...'ABCDEFGHIJKLMNO']
const locationIds = ['yanwuchang', 'cangjingge', 'huofang', 'houshan', 'yishiting', 'tiejiangpu', 'nandizi', 'nvdizi', 'shanmen', 'gongtian', 'danfang']

test('protocol supports zero through fifteen unique legitimate renderables without changing identity/order', () => {
  for (const count of [0, 1, 3, 4, 15]) {
    const ids = roster.slice(0, count)
    const result = normalizeSnapshot(snapshot({ residents: ids.map(resident), renderedNpcs: ids.map(visual) }))
    assert.deepEqual(result.renderedNpcs.map(n => n.gameNpcId), ids)
    assert.ok(Object.isFrozen(result.renderedNpcs))
  }
})

test('protocol still fails closed for duplicate, hidden, nonresident and invalid NPC IDs', () => {
  const full = { residents: roster.map(resident), renderedNpcs: roster.map(visual) }
  for (const patch of [
    { residents: [...full.residents, resident('A')] },
    { residents: [...full.residents, resident('Z')] },
    { residents: [{ ...resident('A'), visible: false }] },
    { residents: [{ gameNpcId: ['A'] }] },
    { residents: [null] },
    { residents: {} },
    { renderedNpcs: [...full.renderedNpcs, visual('A')] },
    { renderedNpcs: [visual('Z')] },
    { renderedNpcs: [visual('__proto__')] },
    { renderedNpcs: [null] },
    { residents: [resident('A')], renderedNpcs: [visual('B')] },
  ]) assert.throws(() => normalizeSnapshot(snapshot({ ...full, ...patch })), { code: 'PROTOCOL_INVALID' })
})

test('optional counts default every known logical ID to zero, clone and freeze supplied counts', () => {
  const zero = Object.fromEntries(locationIds.map(id => [id, 0]))
  assert.deepEqual(normalizeSnapshot(snapshot()).locationNpcCounts, zero)
  for (const count of [0, 1, 4, 15, 16]) {
    const input = { cangjingge: count }
    const output = normalizeSnapshot(snapshot({ locationNpcCounts: input })).locationNpcCounts
    input.cangjingge = 99
    assert.deepEqual(output, { ...zero, cangjingge: count })
    assert.ok(Object.isFrozen(output))
    assert.throws(() => { output.cangjingge = 5 }, TypeError)
  }
  const main = normalizeSnapshot(snapshot({ logicalPage: 'map', gameLocationId: 'tianshanpai', sceneId: 'main', locationNpcCounts: { shanmen: 4 } }))
  assert.equal(main.residents.length, 0); assert.equal(main.locationNpcCounts.shanmen, 4)
})

test('counts reject nonmaps, unknown/renderer-only keys, negative, fractional, coerced and unsafe values', () => {
  for (const counts of [null, [], '4', 4, { main: 1 }, { library: 1 }, { map: 1 }, { tianshanpai: 1 }, { unknown: 0 },
    { cangjingge: -1 }, { cangjingge: 1.5 }, { cangjingge: '4' }, { cangjingge: null }, { cangjingge: NaN },
    { cangjingge: 17 }, { cangjingge: Number.MAX_SAFE_INTEGER }, { cangjingge: Infinity }, { cangjingge: Number.MAX_SAFE_INTEGER + 1 }, JSON.parse('{"__proto__":1}'), { [Symbol('count')]: 1 }]) {
    assert.throws(() => normalizeSnapshot(snapshot({ locationNpcCounts: counts })), { code: 'PROTOCOL_INVALID' })
  }
})
