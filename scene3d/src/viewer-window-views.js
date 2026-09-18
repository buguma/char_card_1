import * as THREE from 'three'

// Actual open lattice apertures from tools/build_{room}.py, in Blender Z-up.
// [interactionId, origin XY, rotation, width, bottom, top, outward offset].
// Do not infer a window from "plant_window" or "lantern_window", or use an
// entire semantic group's AABB (the library window also owns a low cabinet).
const apertures = {
  library: [['window', [-3.78, .38], 90, 3.78, .85, 2.55, .03]],
  council: [
    ['window_west_front', [-5.38, -2.73], 90, 1.50, .805, 2.715, -.06],
    ['window_west_back', [-5.38, 2.33], 90, 1.70, .805, 2.715, -.06],
    ['window_east_back', [5.38, 2.45], -90, 1.64, .805, 2.715, -.06],
    ['window_back_west', [-3.82, 3.88], 0, 1.60, .805, 2.715, -.06],
    ['window_back_east', [3.82, 3.88], 0, 1.60, .805, 2.715, -.06],
  ],
  alchemy: [
    ['window_west', [-6.88, -1], 90, 2.70, .82, 2.65, -.04],
    ['window_east', [6.88, 1.74], -90, 2.38, .82, 2.65, -.04],
  ],
  kitchen: [
    ['window_back_left', [-5.83, 3.38], 0, 1.42, .88, 2.68, -.03],
    ['window_back_center', [.55, 3.38], 0, 2.40, .88, 2.68, -.03],
    ['window_right', [6.88, -.5], -90, 2.70, .88, 2.68, -.03],
  ],
  male_quarters: [['window_right', [3.89, -.03], -90, 5.28, 1.27, 2.67, -.08]],
  female_quarters: [['window_right', [3.39, 1], -90, 4.22, 1.24, 2.66, -.08]],
  guest_quarters: [['window', [3.89, 1.78], -90, 3.0, 1.22, 2.66, -.08]],
}

export function applyWindowViewMaterial(material, uniforms) {
  material.userData.viewerHaze = true // Selection clones reinstall the same hook.
  material.customProgramCacheKey = () => 'diorama-window-view-v1'
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float dioramaNight;
        uniform vec3 dioramaSkyColor, dioramaHorizonColor;
        varying vec2 vWindowUV;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // A view outside, not a lamp: neither room-light strength nor reflected
        // warm lantern light can turn the night sky into a glowing white card.
        vec3 day = mix(dioramaHorizonColor, dioramaSkyColor, 0.25 + vWindowUV.y * 0.45);
        vec3 night = mix(vec3(0.0080, 0.0152, 0.0331), vec3(0.0052, 0.0097, 0.0232), vWindowUV.y);
        diffuseColor.rgb = mix(day, night, dioramaNight);`)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWindowUV;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWindowUV = uv;')
  }
  material.needsUpdate = true
}

export function addWindowViews(root, id, uniforms) {
  const views = []
  for (const [interactionId, [ox, oy], degrees, width, bottom, top, offset] of apertures[id] || []) {
    let owner
    root.traverse(node => { if (node.userData.interactionId === interactionId && node.userData.clickable) owner = node })
    if (!owner) continue
    const geometry = new THREE.PlaneGeometry(width, top - bottom)
    const a = degrees * Math.PI / 180, position = geometry.attributes.position
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i), z = position.getY(i) + (bottom + top) / 2
      position.setXYZ(i, ox + x * Math.cos(a) - offset * Math.sin(a), z, -(oy + x * Math.sin(a) + offset * Math.cos(a)))
    }
    geometry.computeVertexNormals()
    const material = new THREE.MeshBasicMaterial({ name: `WindowOutside_${id}_${interactionId}`, side: THREE.DoubleSide, fog: false })
    material.userData.viewerWindowView = true
    applyWindowViewMaterial(material, uniforms)
    const view = new THREE.Mesh(geometry, material)
    view.name = `Viewer_WindowOutside_${interactionId}`
    view.userData.viewerWindowView = true
    // Attach to the existing selectable window, preserving authored coordinates.
    root.add(view)
    root.updateWorldMatrix(true, true)
    owner.attach(view)
    views.push(view)
  }
  return views
}
