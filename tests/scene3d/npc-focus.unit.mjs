import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { frameNpcCamera, npcFocusZoom } from '../../scene3d/src/npc-focus.js'

const require = createRequire(new URL('../../scene3d/package.json', import.meta.url))
const THREE = await import(pathToFileURL(path.join(path.dirname(require.resolve('three')), 'three.module.js')).href)
const close = (actual, expected, label = '') => assert.ok(Math.abs(actual - expected) < 1e-8, `${label}: ${actual} != ${expected}`)
const vectorClose = (actual, expected, label) => actual.toArray().forEach((value, index) => close(value, expected.getComponent(index), `${label}[${index}]`))

function fixture({ zoom = 1.55, height = 2.4, azimuth = 0, polar = Math.PI / 3, span = 48, aspect = 4 / 3 } = {}) {
  const camera = new THREE.OrthographicCamera(-span * aspect / 2, span * aspect / 2, span / 2, -span / 2, .1, 420)
  const controls = { target: new THREE.Vector3(-2, 3, 4), minZoom: .5, maxZoom: 5 }
  camera.position.copy(controls.target).add(new THREE.Vector3().setFromSphericalCoords(80, polar, azimuth))
  camera.zoom = zoom
  camera.lookAt(controls.target)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  // Deliberately off-center and potentially outside the current view. Framing must
  // use un-clipped world endpoints, not the screen-clipped click rectangle.
  const foot = new THREE.Vector3(23, 1.7, -19)
  const head = foot.clone().add(new THREE.Vector3(0, height, 0))
  const center = foot.clone().lerp(head, .5)
  const geometry = () => ({ center: center.clone(), projectedHeight: Math.abs(head.clone().project(camera).y - foot.clone().project(camera).y) / 2 })
  return { camera, controls, foot, head, center, geometry }
}

function assertFramed(f, fraction) {
  const center = f.center.clone().project(f.camera)
  close(center.x, 0, 'center x'); close(center.y, 0, 'center y')
  close(f.geometry().projectedHeight, fraction, 'viewport height fraction')
  vectorClose(f.controls.target, f.center, 'target')
  assert.ok(f.controls.minZoom <= f.camera.zoom && f.camera.zoom <= f.controls.maxZoom)
}

test('npcFocusZoom scales the current zoom, including non-default and above-manual-cap zoom', () => {
  for (const zoom of [.17, .5, 1, 1.55, 4.7, 18]) {
    for (const projectedHeight of [.005, .075, .29, .8, 3]) {
      for (const fraction of [.18, .29, .45]) {
        close(npcFocusZoom({ zoom }, projectedHeight, fraction), zoom * fraction / projectedHeight)
      }
    }
  }
  close(npcFocusZoom({ zoom: 2 }, .29), 2, 'default fraction')
})

test('framing reaches exact screen height across zoom, character heights, azimuth and pitch', () => {
  for (const zoom of [.23, 1.55, 4.9, 17]) {
    for (const height of [.4, 1.49, 2.235, 3.3, 9.5]) {
      for (const azimuth of [-Math.PI, -.73, 0, 1.25, Math.PI / 2]) {
        for (const polar of [Math.PI / 4, Math.PI / 3, 5 * Math.PI / 12]) {
          const f = fixture({ zoom, height, azimuth, polar })
          const direction = f.camera.position.clone().sub(f.controls.target)
          const source = f.geometry(), centerBefore = source.center.clone()
          assert.equal(frameNpcCamera(f.camera, f.controls, source), true)
          assertFramed(f, .29)
          vectorClose(f.camera.position.clone().sub(f.controls.target), direction, 'preserve viewing vector')
          vectorClose(source.center, centerBefore, 'do not mutate geometry')
          const zoomAfter = f.camera.zoom, positionAfter = f.camera.position.clone()
          assert.equal(frameNpcCamera(f.camera, f.controls, f.geometry()), true)
          close(f.camera.zoom, zoomAfter, 'idempotent zoom')
          vectorClose(f.camera.position, positionAfter, 'idempotent position')
        }
      }
    }
  }
})

test('resize refits from fresh projection rather than compounding the previous zoom', () => {
  const f = fixture({ zoom: 3.7, height: 1.49, azimuth: 2.13 })
  assert.equal(frameNpcCamera(f.camera, f.controls, f.geometry()), true)
  for (const [width, height, span] of [[1920, 1080, 35], [360, 800, 100], [800, 360, 25], [640, 480, 48]]) {
    f.camera.left = -span * width / height / 2; f.camera.right = -f.camera.left
    f.camera.top = span / 2; f.camera.bottom = -span / 2
    f.camera.updateProjectionMatrix()
    assert.equal(frameNpcCamera(f.camera, f.controls, f.geometry()), true)
    assertFramed(f, .29)
    close(f.geometry().projectedHeight * height, .29 * height, 'resized CSS pixel height')
  }
})

test('framing supports custom fractions and expands manual zoom bounds for small cards', () => {
  const f = fixture({ height: .4, span: 180, zoom: .5 })
  for (const fraction of [.18, .29, .45]) {
    assert.equal(frameNpcCamera(f.camera, f.controls, f.geometry(), fraction), true)
    assertFramed(f, fraction)
    assert.ok(f.camera.zoom > 5)
    close(f.controls.maxZoom, f.camera.zoom * 1.25, 'manual headroom')
  }
})

test('invalid projected heights reject without mutating camera or controls', () => {
  for (const projectedHeight of [0, -1, NaN, Infinity, -Infinity, undefined, null, '0.2']) {
    const f = fixture(), position = f.camera.position.clone(), target = f.controls.target.clone()
    const projection = f.camera.projectionMatrix.clone()
    assert.equal(npcFocusZoom(f.camera, projectedHeight), null)
    assert.equal(frameNpcCamera(f.camera, f.controls, { center: f.center, projectedHeight }), false)
    vectorClose(f.camera.position, position, 'position unchanged')
    vectorClose(f.controls.target, target, 'target unchanged')
    assert.equal(f.camera.zoom, 1.55)
    assert.deepEqual(f.camera.projectionMatrix.elements, projection.elements)
    assert.equal(f.controls.minZoom, .5); assert.equal(f.controls.maxZoom, 5)
  }
})
