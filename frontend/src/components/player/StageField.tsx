/**
 * 舞台的光场（全屏播放器的背景）：四盏柔光在暗场里慢慢游走，颜色取自当前封面。
 *
 * 换歌时不是整片换色，而是新颜色从封面所在的位置向外漫开（扩散转场）——
 * 新旧两组光源都在着色器里，用一个半径从 0 长到铺满的圆做分界。
 *
 * 成本控制：画布只有显示尺寸的 1/4（电视上 1/2），CSS 拉伸后本来就是柔的；30fps；
 * 页面隐藏、浮层关掉就停；减弱动态效果时只在换歌时画一帧静止的光。
 * 没有 WebGL（或上下文丢了）时退回 CSS 渐变（.stage-fallback）。
 */
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { cn } from '@/lib/utils'
import { oklchToRgb } from '@/lib/oklch'
import { prefersReducedMotion } from '@/lib/motion'
import { useArtLightStore } from '@/store/artLightStore'
import { isTvModeActive } from '@/lib/tv'
import type { ArtPalette } from '@/services/artLight'

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

/*
 * 着色器里的数都要经得起「半精度」：电视盒子、不少手机的显卡在片元着色器里只有 16 位浮点
 * （mediump 就是它，有的连 highp 都没有），有效数字三位出头。
 * - 时间不能直接传进来算 sin(uv * 3.1 + t * 0.3)：开着播放页几分钟后 t 就是几百，加上去以后
 *   小数部分只剩零点几的精度，一屏的像素只算得出十来个不同的值——背景就成了一格一格的色块，越放越粗。
 *   所以灯的位置、扭动的相位都在 JS 里按双精度算好（相位收进 0–2π）再传进来。
 * - 抖动（消色带用的那点噪声）不能用 fract(sin(…) * 43758.5)：半精度下恒为 0，等于没抖。改成查一张噪声贴图。
 */
const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;
uniform vec4 uP0;
uniform vec4 uP1;
uniform vec2 uWarp;
uniform vec3 uA[5];
uniform vec3 uB[5];
uniform float uReveal;
uniform vec2 uOrigin;
uniform sampler2D uNoise;
varying vec2 vUv;

vec3 field(vec3 base, vec3 c0, vec3 c1, vec3 c2, vec3 c3, vec2 p) {
  vec2 d0 = p - uP0.xy;
  vec2 d1 = p - uP0.zw;
  vec2 d2 = p - uP1.xy;
  vec2 d3 = p - uP1.zw;
  vec3 col = base;
  col += c0 * exp(-dot(d0, d0) / 0.20);
  col += c1 * exp(-dot(d1, d1) / 0.15);
  col += c2 * exp(-dot(d2, d2) / 0.14);
  col += c3 * exp(-dot(d3, d3) / 0.11);
  return col;
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 uv = vUv + 0.03 * vec2(sin(vUv.y * 3.1 + uWarp.x), cos(vUv.x * 2.7 + uWarp.y));
  vec2 p = vec2(uv.x * aspect, uv.y);
  vec3 a = field(uA[0], uA[1], uA[2], uA[3], uA[4], p);
  vec3 b = field(uB[0], uB[1], uB[2], uB[3], uB[4], p);
  vec2 d = vec2((vUv.x - uOrigin.x) * aspect, vUv.y - uOrigin.y);
  float rad = uReveal * length(vec2(aspect, 1.0)) * 1.1;
  float m = 1.0 - smoothstep(rad - 0.22, rad, length(d));
  vec3 col = mix(b, a, m);
  col = col / (1.0 + col * 0.4);
  float n = texture2D(uNoise, gl_FragCoord.xy / 64.0).r;
  col += (n - 0.5) * (2.0 / 255.0);
  gl_FragColor = vec4(col, 1.0);
}`

/** 四盏灯此刻的位置和画面扭动的相位（和以前写在着色器里的是同一套式子），t 是秒 */
export function lightField(t: number, aspect: number): { p0: [number, number, number, number]; p1: [number, number, number, number]; warp: [number, number] } {
  const TAU = Math.PI * 2
  const wrap = (v: number) => ((v % TAU) + TAU) % TAU
  return {
    p0: [aspect * (0.22 + 0.10 * Math.sin(t * 0.21)), 0.80 + 0.08 * Math.cos(t * 0.17), aspect * (0.82 + 0.09 * Math.cos(t * 0.19)), 0.72 + 0.10 * Math.sin(t * 0.23)],
    p1: [aspect * (0.30 + 0.12 * Math.cos(t * 0.13)), 0.16 + 0.09 * Math.sin(t * 0.29), aspect * (0.76 + 0.11 * Math.sin(t * 0.11)), 0.24 + 0.10 * Math.cos(t * 0.15)],
    warp: [wrap(t * 0.30), wrap(-t * 0.25)],
  }
}

/** 64×64 的白噪声（固定种子），给抖动查表用 */
function noiseBytes(): Uint8Array {
  const out = new Uint8Array(64 * 64)
  let seed = 0x2545f491
  for (let i = 0; i < out.length; i++) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    out[i] = (seed >>> 0) & 0xff
  }
  return out
}

/** 调色板 → 5 个 vec3：底色 + 四盏光（亮度压暗、饱和封顶，白字在上面始终读得清）。
 *  光的亮度封在 0.36–0.5：再亮，顶上的分段标签和歌手行就掉到 4.5:1 以下——
 *  要保住对比，降的是光的亮度，不是颜色的饱和 */
function paletteToUniform(p: ArtPalette): Float32Array {
  const out = new Float32Array(15)
  // 底色压到很暗、带一点主色相：光打在上面才通透，不发闷
  const base = oklchToRgb(0.13, Math.min(p.c * 0.4, 0.04), p.h)
  out.set(base, 0)
  const lights = [...p.swatches]
  // 单色封面只有一两个色相：补一盏更亮的同色高光、一盏更深的邻近色，让光有层次
  while (lights.length < 4) {
    const k = lights.length
    lights.push(
      k % 2
        ? { l: 0.58, c: p.c * 0.9, h: (p.h + 18) % 360 }
        : { l: 0.44, c: p.c2 * 0.9, h: (p.h2 + 360 - 14) % 360 }
    )
  }
  const gains = [0.74, 0.58, 0.48, 0.4]
  lights.slice(0, 4).forEach((sw, i) => {
    const rgb = oklchToRgb(Math.min(0.5, Math.max(0.36, sw.l)), Math.min(0.19, sw.c * 1.2), sw.h)
    out.set(rgb.map(v => v * gains[i]), 3 + i * 3)
  })
  return out
}

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh)
    return null
  }
  return sh
}

/**
 * @param active 为 false 时只铺 CSS 渐变（.stage-fallback，同样取当前封面的色相），不建 WebGL。
 *   全屏播放器打开的那半秒里传 false：建上下文、编译着色器、上传第一帧都在主线程上，
 *   正好撞在开场动画里，iPad 上就是掉帧。动画落定再打开，画好第一帧后淡入盖上去。
 */
export function StageField({ className, originRef, active = true }: { className?: string; originRef?: RefObject<HTMLElement>; active?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const palette = useArtLightStore(s => s.palette)
  const [failed, setFailed] = useState(false)
  const [painted, setPainted] = useState(false)
  const stateRef = useRef<{
    gl: WebGLRenderingContext
    uniforms: Record<string, WebGLUniformLocation | null>
    a: Float32Array
    b: Float32Array
    revealFrom: number
    origin: [number, number]
    draw: () => void
  } | null>(null)

  /* 初始化：一次。拿不到 WebGL 就退回 CSS */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!active || !canvas) return
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'low-power' })
    if (!gl) {
      setFailed(true)
      return
    }
    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    const prog = gl.createProgram()
    if (!vs || !fs || !prog) {
      setFailed(true)
      return
    }
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      setFailed(true)
      return
    }
    gl.useProgram(prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'aPos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

    const uniforms = {
      uRes: gl.getUniformLocation(prog, 'uRes'),
      uP0: gl.getUniformLocation(prog, 'uP0'),
      uP1: gl.getUniformLocation(prog, 'uP1'),
      uWarp: gl.getUniformLocation(prog, 'uWarp'),
      uA: gl.getUniformLocation(prog, 'uA'),
      uB: gl.getUniformLocation(prog, 'uB'),
      uReveal: gl.getUniformLocation(prog, 'uReveal'),
      uOrigin: gl.getUniformLocation(prog, 'uOrigin'),
    }
    // 抖动用的噪声贴图：最近点采样、平铺
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture())
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 64, 64, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, noiseBytes())
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
    gl.uniform1i(gl.getUniformLocation(prog, 'uNoise'), 0)

    const initial = paletteToUniform(useArtLightStore.getState().palette)
    const reduce = prefersReducedMotion()
    // 画布按显示尺寸的 1/4 画；电视是几米外的一整面墙，1/4 拉满全屏看得出一格一格，给到 1/2
    const shrink = isTvModeActive() ? 2 : 4
    const start = performance.now()
    let frame = 0
    let timer = 0
    let running = true

    const state = {
      gl,
      uniforms,
      a: initial,
      b: initial,
      revealFrom: -1,
      origin: [0.5, 0.6] as [number, number],
      draw: () => {},
    }

    const draw = (now: number) => {
      const t = reduce ? 0 : (now - start) / 1000
      let reveal = 1
      if (state.revealFrom >= 0) {
        const k = Math.min(1, (now - state.revealFrom) / 1500)
        reveal = 1 - (1 - k) ** 3
        if (k >= 1) state.revealFrom = -1
      }
      const lights = lightField(t, canvas.width / canvas.height)
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.uniform2f(uniforms.uRes, canvas.width, canvas.height)
      gl.uniform4f(uniforms.uP0, ...lights.p0)
      gl.uniform4f(uniforms.uP1, ...lights.p1)
      gl.uniform2f(uniforms.uWarp, ...lights.warp)
      gl.uniform3fv(uniforms.uA, state.a)
      gl.uniform3fv(uniforms.uB, state.b)
      gl.uniform1f(uniforms.uReveal, reveal)
      gl.uniform2f(uniforms.uOrigin, state.origin[0], state.origin[1])
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    state.draw = () => draw(performance.now())

    // 30fps：慢慢游走的光不需要更多帧；扩散中按满帧画，边缘才顺。
    // 平时隔 30ms 才要下一帧，而不是每帧都要、再跳过不画：一直挂着 requestAnimationFrame，
    // WebKit 就每一帧都做一次渲染更新，ProMotion 屏也被拴在最高刷新率上（App 开着 120Hz 时就是 120 次 / 秒）
    const schedule = () => {
      if (!running) return
      if (state.revealFrom >= 0) frame = requestAnimationFrame(loop)
      else timer = window.setTimeout(() => { frame = requestAnimationFrame(loop) }, 30)
    }
    const loop = (now: number) => {
      frame = 0
      if (!running) return
      if (!document.hidden) draw(now)
      schedule()
    }

    const resize = () => {
      const w = Math.max(1, Math.round(canvas.clientWidth / shrink))
      const h = Math.max(1, Math.round(canvas.clientHeight / shrink))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      draw(performance.now())
    }
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    resize()
    // 第一帧画好了才把画布淡入，盖住底下的 CSS 渐变（不会先闪一块黑）
    setPainted(true)

    const onLost = (e: Event) => {
      e.preventDefault()
      running = false
      setFailed(true)
    }
    canvas.addEventListener('webglcontextlost', onLost)
    stateRef.current = state
    if (!reduce) schedule()

    return () => {
      running = false
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      ro.disconnect()
      canvas.removeEventListener('webglcontextlost', onLost)
      stateRef.current = null
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [active])

  /* 换歌：旧颜色留在外面，新颜色从封面的位置向外漫开 */
  useEffect(() => {
    const state = stateRef.current
    if (!state) return
    const next = paletteToUniform(palette)
    state.b = state.a
    state.a = next
    const canvas = canvasRef.current
    const origin = originRef?.current
    if (canvas && origin) {
      const c = canvas.getBoundingClientRect()
      const o = origin.getBoundingClientRect()
      state.origin = [
        (o.left + o.width / 2 - c.left) / Math.max(1, c.width),
        1 - (o.top + o.height / 2 - c.top) / Math.max(1, c.height),
      ]
    }
    if (prefersReducedMotion()) {
      state.b = next
      state.draw()
      return
    }
    state.revealFrom = performance.now()
  }, [palette, originRef])

  return (
    <div aria-hidden="true" className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      {/* 底下一直铺着 CSS 渐变：WebGL 还没开（开场动画期间）或拿不到时就是它 */}
      <div className="stage-fallback absolute inset-0" />
      {!failed && (
        <canvas
          ref={canvasRef}
          className={cn('absolute inset-0 h-full w-full transition-opacity duration-5 ease-out motion-reduce:transition-none', active && painted ? 'opacity-100' : 'opacity-0')}
        />
      )}
      {/* 顶上、底部各压暗一档：分段标签、控制区的白字始终站得住 */}
      <div className="absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-stage-deep/45 to-stage-deep/0" />
      <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-stage-deep/55 to-stage-deep/0" />
    </div>
  )
}
