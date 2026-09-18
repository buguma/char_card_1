import { Color, Vector4 } from 'three'

// Match the location OutlinePass gold. The contour is painted INSIDE the sprite
// alpha boundary: no expanded pick quad, extra mesh, texture, or postFX pass.
export const NPC_OUTLINE_COLOR = '#dba23c'
export const NPC_OUTLINE_WIDTH = 2

export function installNpcOutline(material) {
  const uniforms = {
    npcOutlineSelected: { value: 0 },
    npcOutlineColor: { value: new Color(NPC_OUTLINE_COLOR) },
    npcOutlineWidth: { value: NPC_OUTLINE_WIDTH },
    npcOutlineFrame: { value: new Vector4(0, 0, 1, 1) },
  }
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms)
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_pars_fragment>', `
#include <map_pars_fragment>
uniform float npcOutlineSelected;
uniform vec3 npcOutlineColor;
uniform float npcOutlineWidth;
uniform vec4 npcOutlineFrame;
#ifdef USE_MAP
float npcOutlineAlpha(vec2 uv) {
  // An adjacent atlas cell (or ClampToEdge at a tightly cropped portrait)
  // must never be mistaken for part of this frame's silhouette.
  if (any(lessThan(uv, npcOutlineFrame.xy)) || any(greaterThan(uv, npcOutlineFrame.zw))) return 0.0;
  return texture2D(map, uv).a;
}
#endif
`).replace('#include <map_fragment>', `
#include <map_fragment>
#ifdef USE_MAP
if (npcOutlineSelected > 0.5) {
  // Derivatives keep the contour two CSS pixels wide across zoom, DPR,
  // downsampled low quality, resizing, and differently sized atlas frames.
  vec2 dx = dFdx(vMapUv) * npcOutlineWidth;
  vec2 dy = dFdy(vMapUv) * npcOutlineWidth;
  float inside = npcOutlineAlpha(vMapUv + dx);
  inside = min(inside, npcOutlineAlpha(vMapUv - dx));
  inside = min(inside, npcOutlineAlpha(vMapUv + dy));
  inside = min(inside, npcOutlineAlpha(vMapUv - dy));
  inside = min(inside, npcOutlineAlpha(vMapUv + (dx + dy) * 0.70710678));
  inside = min(inside, npcOutlineAlpha(vMapUv + (dx - dy) * 0.70710678));
  inside = min(inside, npcOutlineAlpha(vMapUv + (-dx + dy) * 0.70710678));
  inside = min(inside, npcOutlineAlpha(vMapUv - (dx + dy) * 0.70710678));
  diffuseColor.rgb = mix(diffuseColor.rgb, npcOutlineColor, 1.0 - step(0.35, inside));
  // Keep original alpha and the standard alphaTest/depth behavior unchanged.
}
#endif
`)
  }
  material.customProgramCacheKey = () => 'npc-alpha-contour-v1'
  return {
    setSelected(value) { uniforms.npcOutlineSelected.value = value ? 1 : 0 },
    setPixelRatio(value) { uniforms.npcOutlineWidth.value = NPC_OUTLINE_WIDTH * (Number.isFinite(value) && value > 0 ? value : 1) },
    setFrame({ x, y, width, height, sheet }) {
      uniforms.npcOutlineFrame.value.set(x / sheet.width, 1 - (y + height) / sheet.height, (x + width) / sheet.width, 1 - y / sheet.height)
    },
  }
}
