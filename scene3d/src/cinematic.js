// Cinematic HDR postprocessing for the Yunxiu diorama viewer.
//
// Adapted from E:\JJBurst\ts3d\src\cinematic.js (云阙山门) with three differences:
//   1. atmosphere is optional and unused in stage 1 — leave the slot for stage 4.
//   2. Resize honours the host's pixel budget. Only the balanced path constructs
//      this module's composer; the low path remains free of postprocessing.
//   3. setTime derives golden/night from a single hour value passed in by
//      viewer-environment.js, identical semantics to the original.
//
// Beauty render target ships a HalfFloat MSAA buffer with a depthTexture so DOF
// and (future) atmosphere can sample opaque depth without a second render.

import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js'
import { RENDER_DEFAULTS, DEFAULT_MSAA, DEFAULT_PAPER_COLOR, SUBSCENE_TILT_SHIFT, calculateDofRanges } from './render-defaults.js'

const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const depthGLSL = /* glsl */`
  uniform sampler2D tDepth;
  uniform mat4 inverseProjection;
  vec3 viewPosition(vec2 uv) {
    float depth = textureLod(tDepth, uv, 0.0).r;
    vec4 position = inverseProjection * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    return position.xyz / position.w;
  }
`

// Paper and scene share the same falloff, without applying scene grading to paper.
const vignetteGLSL = /* glsl */`
  float vignetteFactor(vec2 uv, float strength) {
    vec2 edge = (uv - 0.5) * 2.0;
    return 1.0 - strength * smoothstep(0.30, 1.6, dot(edge, edge));
  }
`

function screenMaterial(name, uniforms, fragmentShader) {
  return new THREE.ShaderMaterial({
    name, uniforms, vertexShader, fragmentShader,
    depthTest: false, depthWrite: false, toneMapped: false,
    blending: THREE.NoBlending,
  })
}

/** Opaque beauty and AO, then transparency on the SAME untouched depth buffer. */
class DioramaPass extends RenderPass {
  constructor(scene, camera, samples) {
    super(scene, camera)
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
      stencilBuffer: false,
      resolveDepthBuffer: true,
    })
    this.target.texture.name = 'Cinematic.beauty'
    this.target.depthTexture.name = 'Cinematic.depth'
    this.aoTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false,
    })
    this.aoTarget.texture.name = 'Cinematic.ao-depth'
    this.transparentPass = new RenderPass(scene, camera)
    this.transparentPass.clear = false
    this.materials = new Set()
    this.hidden = []
    this.quad = new FullScreenQuad(null)

    this.aoMaterial = screenMaterial('Cinematic.ContactAO', {
      tDepth: { value: this.target.depthTexture },
      inverseProjection: { value: camera.projectionMatrixInverse },
      projection: { value: camera.projectionMatrix },
      texel: { value: new THREE.Vector2(1, 1) },
      radius: { value: 0.85 },
      intensity: { value: 1.25 },
    }, /* glsl */`
      varying vec2 vUv;
      uniform mat4 projection;
      uniform vec2 texel;
      uniform float radius;
      uniform float intensity;
      ${depthGLSL}
      void main() {
        vec3 p = viewPosition(vUv);
        if (texture2D(tDepth, vUv).r >= 0.999999) {
          gl_FragColor = vec4(1.0, -p.z, 0.0, 1.0);
          return;
        }
        vec3 left = p - viewPosition(vUv - vec2(texel.x, 0.0));
        vec3 right = viewPosition(vUv + vec2(texel.x, 0.0)) - p;
        vec3 down = p - viewPosition(vUv - vec2(0.0, texel.y));
        vec3 up = viewPosition(vUv + vec2(0.0, texel.y)) - p;
        vec3 dx = abs(left.z) < abs(right.z) ? left : right;
        vec3 dy = abs(down.z) < abs(up.z) ? down : up;
        vec3 n = cross(dx, dy);
        n /= max(length(n), 0.00001);
        vec4 clip = projection * vec4(p, 1.0);
        vec2 spread = 0.5 * radius * vec2(projection[0][0], projection[1][1]) / clip.w;
        float occlusion = 0.0;
        for (int i = 0; i < 8; i++) {
          float f = float(i);
          float angle = f * 2.39996323;
          vec2 uv = vUv + vec2(cos(angle), sin(angle)) * spread * sqrt((f + 0.5) / 8.0);
          if (any(lessThan(uv, texel)) || any(greaterThan(uv, 1.0 - texel))) continue;
          if (texture2D(tDepth, uv).r >= 0.999999) continue;
          vec3 offset = viewPosition(uv) - p;
          float distance = length(offset);
          float horizon = max(dot(n, offset) / max(distance, 0.0001) - 0.09, 0.0);
          float falloff = 1.0 - smoothstep(radius * 0.15, radius, distance);
          occlusion += horizon * falloff;
        }
        float ao = 1.0 - clamp(occlusion * intensity / 4.0, 0.0, 0.38);
        gl_FragColor = vec4(ao, -p.z, 0.0, 1.0);
      }
    `)

    this.aoBlendMaterial = screenMaterial('Cinematic.AOBilateralBlend', {
      tAO: { value: this.aoTarget.texture },
      texel: { value: new THREE.Vector2(1, 1) },
    }, /* glsl */`
      varying vec2 vUv;
      uniform sampler2D tAO;
      uniform vec2 texel;
      void main() {
        vec2 center = texture2D(tAO, vUv).rg;
        float sum = center.r * 2.0;
        float weights = 2.0;
        for (int i = 0; i < 4; i++) {
          float angle = float(i) * 1.57079633;
          vec2 tap = texture2D(tAO, vUv + vec2(cos(angle), sin(angle)) * texel).rg;
          float weight = exp(-abs(tap.g - center.g) * 12.0);
          sum += tap.r * weight;
          weights += weight;
        }
        float ao = sum / weights;
        gl_FragColor = vec4(ao, mix(ao, 1.0, 0.06), mix(ao, 1.0, 0.14), 1.0);
      }
    `)
    Object.assign(this.aoBlendMaterial, {
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    })
    this.copyMaterial = screenMaterial('Cinematic.BeautyCopy', {
      tDiffuse: { value: this.target.texture },
    }, /* glsl */`
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      void main() { gl_FragColor = texture2D(tDiffuse, vUv); }
    `)
  }

  render(renderer, writeBuffer, readBuffer) {
    const background = this.scene.background
    const autoClear = renderer.autoClear
    const shadowAutoUpdate = renderer.shadowMap.autoUpdate
    this.materials.clear()
    this.scene.traverseVisible(object => {
      if (Array.isArray(object.material)) {
        for (const material of object.material) this.materials.add(material)
      } else if (object.material) this.materials.add(object.material)
    })

    try {
      for (const material of this.materials) {
        if (material.visible && material.transparent) {
          material.visible = false
          this.hidden.push(material)
        }
      }
      super.render(renderer, writeBuffer, this.target)
      for (const material of this.hidden) material.visible = true
      this.hidden.length = 0

      renderer.autoClear = false
      renderer.setRenderTarget(this.aoTarget)
      this.quad.material = this.aoMaterial
      this.quad.render(renderer)
      renderer.setRenderTarget(this.target)
      this.quad.material = this.aoBlendMaterial
      this.quad.render(renderer)

      for (const material of this.materials) {
        if (material.visible && !material.transparent) {
          material.visible = false
          this.hidden.push(material)
        }
      }
      this.scene.background = null
      renderer.shadowMap.autoUpdate = false
      this.transparentPass.render(renderer, writeBuffer, this.target)
      for (const material of this.hidden) material.visible = true
      this.hidden.length = 0

      renderer.setRenderTarget(readBuffer)
      this.quad.material = this.copyMaterial
      this.quad.render(renderer)
    } finally {
      for (const material of this.hidden) material.visible = true
      this.hidden.length = 0
      this.materials.clear()
      this.scene.background = background
      renderer.shadowMap.autoUpdate = shadowAutoUpdate
      renderer.autoClear = autoClear
    }
  }

  setSize(width, height) {
    width = Math.max(1, Math.floor(width))
    height = Math.max(1, Math.floor(height))
    this.target.setSize(width, height)
    const aoWidth = Math.max(1, Math.floor(width / 2))
    const aoHeight = Math.max(1, Math.floor(height / 2))
    this.aoTarget.setSize(aoWidth, aoHeight)
    this.aoMaterial.uniforms.texel.value.set(1 / aoWidth, 1 / aoHeight)
    this.aoBlendMaterial.uniforms.texel.value.set(1 / aoWidth, 1 / aoHeight)
  }

  dispose() {
    this.target.dispose()
    this.aoTarget.dispose()
    this.aoMaterial.dispose()
    this.aoBlendMaterial.dispose()
    this.copyMaterial.dispose()
    this.transparentPass.dispose()
    this.quad.dispose()
    this.materials.clear()
  }
}

export function createCinematic(renderer, scene, camera, { compact = false, atmosphere = null, msaa = DEFAULT_MSAA, paperColor = DEFAULT_PAPER_COLOR } = {}) {
  if (renderer.capabilities.logarithmicDepthBuffer || renderer.capabilities.reversedDepthBuffer) {
    throw new Error('Cinematic requires the standard WebGL depth buffer')
  }

  const samples = Math.min([2, 4].includes(msaa) ? msaa : DEFAULT_MSAA, renderer.capabilities.maxSamples)
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType, depthBuffer: false,
  }))
  composer.setPixelRatio(1)
  const beauty = new DioramaPass(scene, camera, samples)
  if (atmosphere?.setDepthTexture) atmosphere.setDepthTexture(beauty.target.depthTexture)

  const dof = new ShaderPass(screenMaterial('Cinematic.DepthOfField', {
    tDiffuse: { value: null },
    tDepth: { value: beauty.target.depthTexture },
    inverseProjection: { value: new THREE.Matrix4() },
    resolution: { value: new THREE.Vector2(1, 1) },
    focusDistance: { value: 60 },
    sharpRange: { value: RENDER_DEFAULTS.dofSharp },
    falloff: { value: 22 },
    maxBlur: { value: RENDER_DEFAULTS.dofBlur },
    tiltShift: { value: RENDER_DEFAULTS.tiltShift },
  }, /* glsl */`
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float focusDistance;
    uniform float sharpRange;
    uniform float falloff;
    uniform float maxBlur;
    uniform float tiltShift;
    ${depthGLSL}
    float coc(float depth) {
      float difference = depth - focusDistance;
      return sign(difference) * smoothstep(sharpRange, sharpRange + falloff, abs(difference));
    }
    float tiltBlur(vec2 uv) {
      return tiltShift * smoothstep(0.30, 0.72, abs(uv.y - 0.5) * 2.0);
    }
    void main() {
      vec4 center = textureLod(tDiffuse, vUv, 0.0);
      float depth = -viewPosition(vUv).z;
      // HD-2D tilt-shift: a horizontal band stays sharp while top/bottom blur out,
      // selling the miniature-diorama read of the scene.
      float blur = max(abs(coc(depth)), tiltBlur(vUv));
      if (blur < 0.025) { gl_FragColor = center; return; }
      vec2 radius = vec2(maxBlur * blur) / resolution;
      vec3 sum = center.rgb;
      float weights = 1.0;
      for (int i = 0; i < ${compact ? 12 : 20}; i++) {
        float f = float(i) + 0.5;
        float angle = f * 2.39996323;
        vec2 offset = vec2(cos(angle), sin(angle)) * sqrt(f / ${compact ? '12.0' : '20.0'});
        vec2 uv = clamp(vUv + offset * radius, 0.5 / resolution, 1.0 - 0.5 / resolution);
        float tapDepth = -viewPosition(uv).z;
        float weight = 1.0 - smoothstep(0.8, 3.5, abs(tapDepth - depth));
        // Depth-sharp taps still contribute to screen-space tilt blur.
        weight *= smoothstep(0.0, 0.2, max(abs(coc(tapDepth)), tiltBlur(uv)));
        sum += textureLod(tDiffuse, uv, 0.0).rgb * weight;
        weights += weight;
      }
      gl_FragColor = vec4(mix(center.rgb, sum / weights, smoothstep(0.025, 0.15, blur)), center.a);
    }
  `))

  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.12, 0.25, 0.98)
  bloom.highPassUniforms.smoothWidth.value = 0.28
  bloom.highPassUniforms.tDepth = { value: beauty.target.depthTexture }
  bloom.highPassUniforms.indoor = { value: 0 }
  // Exclude the subscene paper backdrop before the bloom mip blurs.
  // Exterior extraction is unchanged.
  bloom.materialHighPassFilter.fragmentShader = `uniform sampler2D tDepth;
    uniform float indoor;
    ${bloom.materialHighPassFilter.fragmentShader}`.replace('void main() {', `void main() {
      if (indoor > 0.5 && texture2D(tDepth, vUv).r >= 0.999999) {
        gl_FragColor = vec4(0.0);
        return;
      }
    `)
  for (const tint of bloom.bloomTintColors) tint.set(1, 0.85, 0.66)
  const bloomSetSize = bloom.setSize.bind(bloom)
  bloom.setSize = (width, height) => bloomSetSize(
    Math.max(32, Math.floor(width * (compact ? 0.5 : 1))),
    Math.max(32, Math.floor(height * (compact ? 0.5 : 1))),
  )
  for (const target of [bloom.renderTargetBright, ...bloom.renderTargetsHorizontal, ...bloom.renderTargetsVertical]) {
    target.depthBuffer = false
  }

  const grade = new ShaderPass(screenMaterial('Cinematic.FilmGrade', {
    tDiffuse: { value: null },
    golden: { value: 0.7 },
    night: { value: 0 },
    grainFrame: { value: 0 },
    gradeSat: { value: RENDER_DEFAULTS.saturation },
    gradeContrast: { value: RENDER_DEFAULTS.contrast },
    gradeGamma: { value: RENDER_DEFAULTS.gamma },
    gradeWarm: { value: RENDER_DEFAULTS.warmth },
    gradeVignette: { value: RENDER_DEFAULTS.vignette },
  }, /* glsl */`
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float golden;
    uniform float night;
    uniform float grainFrame;
    uniform float gradeSat;
    uniform float gradeContrast;
    uniform float gradeGamma;
    uniform float gradeWarm;
    uniform float gradeVignette;
    ${vignetteGLSL}
    float noise(vec2 p) {
      return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
    }
    void main() {
      vec4 source = texture2D(tDiffuse, vUv);
      vec3 color = max(source.rgb, 0.0);
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      float shade = 1.0 - smoothstep(0.04, 0.62, luma);
      float light = smoothstep(0.26, 1.8, luma) * (1.0 - night * 0.75);
      color *= mix(vec3(1.0), vec3(0.88, 0.96, 1.07), shade * 0.82);
      color *= mix(vec3(1.0), vec3(1.16, 1.02, 0.82), light * (0.42 + golden * 0.58));
      // HD-2D: push saturation hard (ACES desaturates highlights, so pre-compensate),
      // deepen blacks and pivot contrast around 18% gray.
      color = mix(vec3(dot(color, vec3(0.2126, 0.7152, 0.0722))), color, gradeSat);
      vec3 contrasted = 0.18 + (color - 0.18) * gradeContrast;
      // A gentle night toe preserves deep-blue sky/window detail below the old
      // hard 0.0235 linear cutoff. Midtones/daytime keep the authored contrast.
      vec3 toe = max(color, 0.0) * pow(clamp(max(color, 0.0) / 0.18, 0.00001, 1.0), vec3(max(gradeContrast - 1.0, 0.0)));
      color = mix(contrasted, max(contrasted, toe), night * (1.0 - smoothstep(0.025, 0.10, luma)));
      color = 0.18 * pow(max(color, 0.0) / 0.18, vec3(gradeGamma));
      color *= mix(vec3(1.0), vec3(1.06, 1.0, 0.86), (1.0 - night) * gradeWarm);
      color *= vignetteFactor(vUv, gradeVignette);

      luma = max(dot(color, vec3(0.2126, 0.7152, 0.0722)), 0.00001);
      float dither = noise(gl_FragCoord.xy);
      float quantized = floor(sqrt(luma) * 96.0 + dither) / 96.0;
      color *= mix(1.0, quantized * quantized / luma, 0.16);
      float grain = noise(gl_FragCoord.xy + grainFrame * vec2(17.0, 29.0)) - 0.5;
      color += grain * 0.004 * sqrt(luma);
      gl_FragColor = vec4(max(color, 0.0), source.a);
    }
  `))
  const output = new OutputPass()
  // Backdrop = far depth AND opaque alpha. Depth alone would erase transparent
  // cloth/water over the backdrop, and zero-alpha alone is lost on some mobile
  // HalfFloat/MSAA resolves — so both are required. Paper keeps its authored
  // palette but must NOT bypass the frame's vignette; grade/bloom/exposure/grain
  // leave it untouched.
  output.uniforms.paperBackground = { value: 0 }
  output.uniforms.paperVignette = grade.uniforms.gradeVignette
  output.uniforms.tCoverage = { value: beauty.target.texture }
  output.uniforms.tDepth = { value: beauty.target.depthTexture }
  output.uniforms.paperColor = { value: new THREE.Color(paperColor) }
  output.material.fragmentShader = output.material.fragmentShader
    .replace('uniform sampler2D tDiffuse;', 'uniform sampler2D tDiffuse, tCoverage, tDepth;\nuniform float paperBackground, paperVignette;\nuniform vec3 paperColor;')
    .replace('void main() {', `${vignetteGLSL}\nvoid main() {
      // Backdrop = far depth AND opaque alpha. The sky quad now writes alpha 1,
      // a marker that survives mobile HalfFloat/MSAA resolves (the old zero-alpha
      // coverage was lost there). Transparent cloth/water over the backdrop keep
      // alpha < 1 and pass through untouched.
      if (paperBackground > 0.5 && texture2D(tDepth, vUv).r >= 0.999999 && texture2D(tCoverage, vUv).a >= 0.999999) {
        gl_FragColor = vec4(paperColor * vignetteFactor(vUv, paperVignette), 1.0);
        #ifdef SRGB_TRANSFER
          gl_FragColor = sRGBTransferOETF(gl_FragColor);
        #endif
        return;
      }
    `)
  // Screen-space golden silhouette (Pro parity). Disabled until a location is
  // selected; the ordinary render path is untouched otherwise.
  const selectionOutline = new OutlinePass(new THREE.Vector2(1, 1), scene, camera)
  selectionOutline.visibleEdgeColor.set('#dba23c')
  selectionOutline.hiddenEdgeColor.set('#000000')
  selectionOutline.edgeStrength = 1.8
  selectionOutline.edgeGlow = 0.15
  selectionOutline.edgeThickness = 1.5
  selectionOutline.pulsePeriod = 0
  selectionOutline.enabled = false
  for (const pass of [beauty, atmosphere, dof, bloom, grade, selectionOutline, output].filter(Boolean)) composer.addPass(pass)

  let disposed = false
  let focusTarget = new THREE.Vector3(0, 2.4, 0)
  const viewTarget = new THREE.Vector3()
  const size = renderer.getSize(new THREE.Vector2())
  const viewport = new THREE.Vector4()
  const scissor = new THREE.Vector4()
  const clearColor = new THREE.Color()
  let elapsed = 0
  let hour = 16.5
  let pixelRatio = 1
  let daylight = 1
  let golden = 0
  let dofSharpBase = RENDER_DEFAULTS.dofSharp
  let dofSceneScale = 1
  let dofMaxBlurBase = RENDER_DEFAULTS.dofBlur
  let bloomScale = RENDER_DEFAULTS.bloom
  // Stable projection inverse for the raymarched cloud sea and tilt-shift DOF.
  const stableInvProj = new THREE.Matrix4()
  const stats = { calls: 0, triangles: 0, points: 0, lines: 0, cpuMs: 0, frames: 0 }

  // Cloud raymarch and tilt-shift DOF unproject through this stable inverse.
  atmosphere?.setProjectionInverse?.(stableInvProj)

  function resize(width, height) {
    if (disposed || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
    width = Math.max(1, Math.floor(width))
    height = Math.max(1, Math.floor(height))
    // Honour the renderer's DPR (driven by the viewer's quality cap) — do not clamp it here.
    pixelRatio = renderer.getPixelRatio()
    if (renderer.getSize(size).x !== width || renderer.getSize(size).y !== height) renderer.setSize(width, height, false)
    size.set(width, height)
    const physicalWidth = Math.max(1, Math.floor(width * pixelRatio))
    const physicalHeight = Math.max(1, Math.floor(height * pixelRatio))
    composer.setSize(physicalWidth, physicalHeight)
    dof.uniforms.resolution.value.set(physicalWidth, physicalHeight)
    dof.uniforms.maxBlur.value = dofMaxBlurBase * pixelRatio * THREE.MathUtils.clamp(height / 900, 0.65, 1.2)
  }

  // Bloom keeps its day/night and golden-hour curve; the slider scales it.
  function applyBloom() {
    bloom.strength = (THREE.MathUtils.lerp(0.24, 0.16, daylight) + golden * 0.07) * bloomScale
  }

  function setTime(value) {
    if (disposed || !Number.isFinite(value)) return
    hour = THREE.MathUtils.clamp(value, 0, 24)
    const altitude = Math.sin((hour - 6) * Math.PI / 12)
    daylight = THREE.MathUtils.smoothstep(altitude, -0.14, 0.4)
    golden = daylight * (1 - THREE.MathUtils.smoothstep(altitude, 0.25, 0.85))
    grade.uniforms.golden.value = golden
    grade.uniforms.night.value = 1 - daylight
    atmosphere?.setTime?.(hour)
    applyBloom()
  }

  function applyDofRanges() {
    const ranges = calculateDofRanges(dofSharpBase, camera.zoom, dofSceneScale)
    dof.uniforms.sharpRange.value = ranges.sharpRange
    dof.uniforms.falloff.value = ranges.falloff
  }
  // Unzoomed geometry reference framing height / 40, independent of aspect/DPR.
  function setSceneScale(value) {
    if (disposed || !Number.isFinite(value) || value <= 0) return false
    dofSceneScale = value
    applyDofRanges()
    return true
  }
  function setPaperColor(value) {
    if (disposed) return false
    const valid = value?.isColor ? [value.r, value.g, value.b].every(Number.isFinite)
      : (typeof value === 'string' && value.trim().length > 0) || (typeof value === 'number' && Number.isFinite(value))
    if (!valid) return false
    // Color inputs are already linear; strings/hex receive Three's sRGB conversion.
    output.uniforms.paperColor.value.set(value)
    return true
  }

  // Instance-local visual controls; no viewer UI or business clock ownership.
  function set(name, value) {
    if (disposed || !Number.isFinite(value)) return false
    switch (name) {
      case 'interior':
        bloom.highPassUniforms.indoor.value = value > 0.5 ? 1 : 0
        output.uniforms.paperBackground.value = value > 0.5 ? 1 : 0
        dof.uniforms.tiltShift.value = value > 0.5 ? SUBSCENE_TILT_SHIFT : RENDER_DEFAULTS.tiltShift
        if (value <= 0.5) setSceneScale(1)
        return true
      case 'tiltShift': dof.uniforms.tiltShift.value = value; return true
      case 'dofSceneScale': return setSceneScale(value)
      case 'dofSharp': if (value < 0) return false; dofSharpBase = value; applyDofRanges(); return true
      case 'dofBlur': dofMaxBlurBase = value; resize(size.x, size.y); return true
      case 'bloom': bloomScale = value; applyBloom(); return true
      case 'saturation': grade.uniforms.gradeSat.value = value; return true
      case 'contrast': grade.uniforms.gradeContrast.value = value; return true
      case 'gamma': grade.uniforms.gradeGamma.value = value; return true
      case 'warmth': grade.uniforms.gradeWarm.value = value; return true
      case 'vignette': grade.uniforms.gradeVignette.value = value; return true
      default: return false
    }
  }

  function setFocus(target) {
    if (!disposed && target?.isVector3 && [target.x, target.y, target.z].every(Number.isFinite)) focusTarget = target
  }

  function setSelection(objects = []) {
    if (disposed) return false
    selectionOutline.selectedObjects = objects.filter(object => object?.isObject3D)
    selectionOutline.enabled = selectionOutline.selectedObjects.length > 0
    return true
  }

  function render(delta = 0) {
    if (disposed) return
    const start = performance.now()
    const dt = Number.isFinite(delta) ? THREE.MathUtils.clamp(delta, 0, 0.1) : 0
    elapsed = (elapsed + dt) % 4096
    camera.updateProjectionMatrix()
    // Snapshot the projection inverse for the cloud raymarch and tilt-shift DOF.
    stableInvProj.copy(camera.projectionMatrix).invert()
    dof.uniforms.inverseProjection.value.copy(stableInvProj)
    camera.updateWorldMatrix(true, false)
    viewTarget.copy(focusTarget).applyMatrix4(camera.matrixWorldInverse)
    dof.uniforms.focusDistance.value = THREE.MathUtils.clamp(-viewTarget.z, camera.near, camera.far)
    applyDofRanges()
    grade.uniforms.grainFrame.value = Math.floor(elapsed * 12)

    const target = renderer.getRenderTarget()
    const cubeFace = renderer.getActiveCubeFace()
    const mipLevel = renderer.getActiveMipmapLevel()
    const autoClear = renderer.autoClear
    const scissorTest = renderer.getScissorTest()
    const clearAlpha = renderer.getClearAlpha()
    const infoAutoReset = renderer.info.autoReset
    renderer.getViewport(viewport)
    renderer.getScissor(scissor)
    renderer.getClearColor(clearColor)
    const before = { ...renderer.info.render }
    renderer.info.autoReset = false
    if (infoAutoReset) renderer.info.reset()
    try {
      renderer.autoClear = false
      renderer.setScissorTest(false)
      renderer.setViewport(0, 0, size.x, size.y)
      composer.render(dt)
      for (const key of ['calls', 'triangles', 'points', 'lines']) {
        stats[key] = renderer.info.render[key] - (infoAutoReset ? 0 : before[key])
      }
      stats.frames++
    } finally {
      renderer.setRenderTarget(target, cubeFace, mipLevel)
      renderer.setViewport(viewport)
      renderer.setScissor(scissor)
      renderer.setScissorTest(scissorTest)
      renderer.setClearColor(clearColor, clearAlpha)
      renderer.autoClear = autoClear
      renderer.info.autoReset = infoAutoReset
      stats.cpuMs = performance.now() - start
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const pass of composer.passes) {
      // The atmosphere pass is borrowed from runtime.js and outlives any single
      // cinematic instance (setMsaa rebuilds the composer in place). Disposing it
      // here would leave a dead pass behind: its render() becomes a no-op while
      // needsSwap stays true, which misaligns the composer's read/write buffers
      // and feeds a stale buffer back into the chain (brightness feedback).
      if (pass !== atmosphere) pass.dispose()
    }
    bloom.materialHighPassFilter.dispose()
    composer.dispose()
    composer.timer.dispose()
    composer.passes.length = 0
  }

  function getStats() {
    return {
      ...stats, disposed, compact, hour, pixelRatio, samples,
      width: beauty.target.width, height: beauty.target.height,
      focusDistance: dof.uniforms.focusDistance.value,
      dofSceneScale, sharpRange: dof.uniforms.sharpRange.value, falloff: dof.uniforms.falloff.value,
      maxBlur: dof.uniforms.maxBlur.value,
      paperColor: `#${output.uniforms.paperColor.value.getHexString()}`,
      aoWidth: beauty.aoTarget.width, aoHeight: beauty.aoTarget.height,
      aoSamples: 8, dofSamples: compact ? 12 : 20,
      bloomStrength: bloom.strength,
      interior: bloom.highPassUniforms.indoor.value > 0.5,
      selection: selectionOutline.enabled ? selectionOutline.selectedObjects.length : 0,
      tuning: {
        tiltShift: dof.uniforms.tiltShift.value,
        dofSharp: dofSharpBase,
        dofBlur: dofMaxBlurBase,
        bloom: bloomScale,
        saturation: grade.uniforms.gradeSat.value,
        contrast: grade.uniforms.gradeContrast.value,
        gamma: grade.uniforms.gradeGamma.value,
        warmth: grade.uniforms.gradeWarm.value,
        vignette: grade.uniforms.gradeVignette.value,
      },
      overBudget: stats.calls >= 600,
    }
  }

  resize(size.x, size.y)
  applyDofRanges()
  setTime(hour)
  return { render, resize, setTime, setFocus, setSceneScale, setPaperColor, setSelection, set, dispose, getStats }
}
