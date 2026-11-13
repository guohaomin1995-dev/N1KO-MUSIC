/**
 * 歌词页的底：一屋子烟，几束从进度点往上打的光。
 *
 * 全部在一张 WebGL 画布里：
 *   烟    两层域扭曲的分形噪声，慢慢往上飘。颜色取当前封面的色相，亮度锁死（底下暗、中间亮）
 *   光    光源是进度条上的白点（[data-beam-origin]）。底下一层宽而淡的锥，上面 2–5 束粗细深浅不一的光，
 *         朝向、张角、亮度来自 lyricBeams 的灯位：换句时整组摆到一套新灯位，没换句就每 4 小节换一次；
 *         每一拍（歌曲有 BPM 标签就按它，没有按 92）光会亮一下、晃一下，小节第一拍更重。
 *         不接 Web Audio 取频谱：那要把 <audio> 接进音频图，无 CORS 的串流会被静音，后台播放也受影响
 *         （useAudioEngine 顶部记录过这个决定），所以「随旋律」用的是拍子和歌词的时间轴。
 *         光不是贴在烟上的一张图：它乘在烟的浓度上，光扫到哪一团，哪一团才亮
 *   封面  灰度后只取亮部，藏在烟里，烟浓、光亮的地方才透出来一点
 *   浮尘  光里的细小颗粒，往上飘、会闪
 *   歌词  当前这一句画成有颜色的毛玻璃字（见下面的 COMPOSITE）
 *
 * 分两遍画：
 *   第一遍  烟、光、封面、浮尘，按 CSS 像素的 0.6 倍画进一张纹理（烟本来就是糊的），alpha 里存「这里有多少光」
 *   第二遍  按屏幕像素铺满：把第一遍放大贴上；歌词所在的那一块画扁平的毛玻璃字——
 *           字里面是糊开、提亮的烟，淡淡染一层玻璃色；字边一圈均匀的细亮边，字底下很淡的投影。
 *           光柱穿过字的地方，那几个字整块亮起来、亮边更亮。不做斜面和镜面反光（太拟物）。
 *
 * 玻璃的颜色每首歌按当前封面重算，取「相近色」：封面主色相往副色相偏 25–35°，比烟亮、饱和度压低（只是淡淡一层色）。
 * 玻璃大部分是透过来的烟，字的轮廓靠细亮边和投影撑住。
 * 不用相反色：烟和藏在烟里的封面已经是这首歌的颜色，补色字会和它们打架，
 * 视频里那种一屋子同一种颜色的氛围也就没了。字的对比交给光——光束打上去的那一下才是最亮的。
 *
 * 玻璃字照着歌词那一栏（data-lyric-stage）的 data-lyric-text 画；那一栏现在是天际屏歌词（SkylineLyric），
 * 它把 data-lyric-text 留空——当前句是 DOM 里的霓虹字，这一遍只剩把烟贴满。
 * 主光束（0 号槽）对准正在唱的那个字（data-beam-head），其余几束照灯位走。
 *
 * 成本：第一遍 0.6 倍、30fps；第二遍只有歌词那一块做玻璃计算，其余只是贴图。页面隐藏就停。
 * 减弱动态效果时烟不飘，只跟着进度点挪光。没有 WebGL 时退回糊开的封面（LyricAtmosphere）。
 */

import { useEffect, useRef, useState } from 'react'
import { oklchToRgb } from '@/lib/oklch'
import { usePlayerStore } from '@/store/playerStore'
import { useArtLightStore } from '@/store/artLightStore'
import { getAudioCurrentTime } from '@/hooks/useAudioEngine'
import type { ArtPalette } from '@/services/artLight'
import { LyricAtmosphere } from './LyricAtmosphere'
import { glassHue, rasterizeLyric, type LyricCell, type LyricFont } from './lyricGlass'
import { progressPoint, skyColorFloats } from './skyline'
import { SLOT_COUNT, STILL_RIG, beatPulse, mixBeamRigs, nextBeamRig, type BeamPose, type BeamRig } from './lyricBeams'

/** 没有 BPM 标签时按这个速度打拍子 */
const DEFAULT_BPM = 92
/** 从一套灯位摆到下一套用多久（秒） */
const RIG_SWING = 1.5

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uOrigin;
uniform float uBeam;
uniform float uPulse;
/* 每束光：x 偏角、y 半张角、z 亮度、w 射程 */
uniform vec4 uBeams[5];
uniform vec3 uSmoke;
uniform vec3 uDeep;
uniform vec3 uShadow;
uniform sampler2D uCover;
uniform float uCoverMix;
varying vec2 vUv;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

/* 2D simplex 噪声（Ashima / Stefan Gustavson）。比格点值噪声圆润，烟不会出现折角 */
vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float noise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 0.5 + 0.5 * (130.0 * dot(m, g));
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

void main() {
  float aspect = uRes.x / uRes.y;
  /* 以屏幕高为单位，y 朝上 */
  vec2 p = vec2(vUv.x * aspect, vUv.y);
  float t = uTime;

  /* 烟：先用一层噪声扭曲坐标，再取一层；第二层更细，是一缕一缕的边 */
  vec2 q = p * 0.95 + vec2(0.0, -t * 0.028);
  vec2 w = vec2(fbm(q + vec2(0.0, t * 0.018)), fbm(q + vec2(5.2, 1.3) - vec2(t * 0.012, 0.0)));
  float big = fbm(q + 0.85 * w + vec2(t * 0.008, -t * 0.022));
  float fine = fbm(p * 2.0 + 0.6 * w - vec2(0.0, t * 0.04));
  float dens = smoothstep(0.22, 0.95, big * 0.85 + fine * 0.2);

  /* 房间本身的光：中上部亮，底下压暗给按键 */
  float y = vUv.y;
  float ambient = smoothstep(0.08, 0.62, y) * (1.0 - 0.4 * smoothstep(0.8, 1.0, y));

  /* 光：从进度点往上。底下一层宽而淡的锥，上面几束各有朝向、粗细、亮度的光 */
  vec2 o = vec2(uOrigin.x * aspect, uOrigin.y);
  vec2 v = p - o;
  float dist = length(v);
  float sang = atan(v.x, max(v.y, 0.0001));
  float up = smoothstep(-0.015, 0.03, v.y);
  float base = 1.0 - smoothstep(0.0, 0.55, abs(sang));
  float beam = base * base * exp(-dist * 2.4) * 0.32;
  for (int i = 0; i < 5; i++) {
    vec4 b = uBeams[i];
    if (b.z < 0.01) continue;
    float da = (sang - b.x) / b.y;
    float ray = exp(-da * da) + exp(-da * da * 9.0) * 0.5;
    beam += ray * b.z * 0.85 * exp(-dist * 1.7 / b.w);
  }
  beam *= up * uBeam * (0.82 + 0.4 * uPulse);
  float hot = exp(-dist * dist / 0.0005) * uBeam * (0.85 + 0.3 * uPulse);
  float halo = exp(-dist * dist / 0.012) * uBeam;

  vec3 col = mix(uShadow, uDeep, smoothstep(0.0, 0.6, y));
  /* 被照到的烟 + 不成形的散射。散射让光柱本身有体积，烟薄的地方也看得见光 */
  float lit = ambient * 0.5 + beam * 1.3;
  col += uSmoke * dens * lit * 0.8;
  col += uSmoke * (ambient * 0.16 + beam * 0.38 + halo * 0.3);
  col += vec3(1.0) * hot * 0.75;

  /* 封面藏在烟里：只取亮部，烟浓、光亮的地方透出来 */
  if (uCoverMix > 0.001) {
    float s = min(aspect * 1.05, 0.66);
    vec2 c = vec2(0.5 * aspect, 0.6);
    vec2 cuv = (p - c) / s + 0.5;
    float inside = 1.0 - smoothstep(0.22, 0.5, length(cuv - 0.5));
    if (inside > 0.0) {
      vec3 art = texture2D(uCover, cuv).rgb;
      float lum = dot(art, vec3(0.299, 0.587, 0.114));
      float ghost = smoothstep(0.42, 0.95, lum) * inside * (0.3 + 0.9 * dens) * (0.35 + 0.65 * ambient + beam);
      col += uSmoke * ghost * 0.11 * uCoverMix;
    }
  }

  /* 浮尘：光里才看得见，往上飘，会闪 */
  vec2 g = p * 22.0 + vec2(0.0, -t * 0.9);
  vec2 cell = floor(g);
  vec2 rnd = vec2(hash(cell), hash(cell + 17.7));
  vec2 dp = fract(g) - rnd;
  float twinkle = 0.5 + 0.5 * sin(t * (1.0 + rnd.x * 2.0) + rnd.y * 6.28);
  float mote = smoothstep(0.09, 0.0, length(dp)) * step(0.72, hash(cell + 3.1)) * twinkle;
  col += vec3(1.0) * mote * (beam * 1.1 + ambient * 0.06);

  /* 四周稍压一点 */
  vec2 vg = vUv - vec2(0.5, 0.55);
  col *= 1.0 - 0.35 * smoothstep(0.35, 0.85, length(vg * vec2(1.1, 0.9)));
  col = col / (1.0 + col * 0.22);
  float n = hash(gl_FragCoord.xy + fract(t));
  col += (n - 0.5) * (2.5 / 255.0);
  gl_FragColor = vec4(col, clamp(beam * 0.6, 0.0, 1.0));
}`

/** 第二遍：放大第一遍的结果，画玻璃字 */
const COMPOSITE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uScene;
uniform sampler2D uTextA;
uniform sampler2D uTextB;
/* 下一句：小号、淡一些的玻璃字（换句时它往上、放大，变成当前句） */
uniform sampler2D uTextN;
uniform vec4 uRectN;
uniform vec4 uLayerN;
uniform vec2 uTexelN;
/* 遮罩在画布上的位置（uv，y 朝上）：x, y, w, h */
uniform vec4 uRectA;
uniform vec4 uRectB;
/* 每层：x 不透明度、y 糊的程度、z 竖向位移（uv）、w 未用 */
uniform vec4 uLayerA;
uniform vec4 uLayerB;
uniform vec2 uTexelA;
uniform vec2 uTexelB;
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform vec3 uGlass;
/* 颜色进度（天际屏歌词）：字序图（R×255 + G = 第几个字 + 字里的位置）、
   进度 x = 唱到第几个字（以字为单位），y = 这句有几个字（0 = 不染色） */
uniform sampler2D uOrderA;
uniform sampler2D uOrderB;
uniform vec2 uProgA;
uniform vec2 uProgB;
uniform vec3 uSungA;
uniform vec3 uSungB;
uniform vec3 uSungHead;
varying vec2 vUv;

vec3 frosted(vec2 uv, vec2 r) {
  vec2 d = vec2(0.011, 0.011 * uRes.x / uRes.y);
  vec3 c = texture2D(uScene, uv + r).rgb * 0.36;
  c += texture2D(uScene, uv + r + vec2(d.x, 0.0)).rgb * 0.16;
  c += texture2D(uScene, uv + r - vec2(d.x, 0.0)).rgb * 0.16;
  c += texture2D(uScene, uv + r + vec2(0.0, d.y)).rgb * 0.16;
  c += texture2D(uScene, uv + r - vec2(0.0, d.y)).rgb * 0.16;
  return c;
}

vec3 glassLayer(vec3 col, sampler2D tex, sampler2D order, vec2 prog, vec4 rect, vec4 layer, vec2 texel, float lit) {
  if (layer.x < 0.003) return col;
  vec2 tuv = (vUv - rect.xy - vec2(0.0, layer.z)) / rect.zw;
  if (tuv.x < 0.0 || tuv.y < 0.0 || tuv.x > 1.0 || tuv.y > 1.0) return col;
  vec4 t = texture2D(tex, tuv);

  /* 颜色进度：比进度小的就是唱过的；唱过的从主色渐变到副色，进度头那个字最亮 */
  float sung = 0.0;
  vec3 sungCol = vec3(1.0);
  if (prog.y > 0.5) {
    vec4 o = texture2D(order, tuv);
    float pos = o.r * 255.0 + o.g;
    sung = 1.0 - smoothstep(prog.x - 0.04, prog.x + 0.04, pos);
    sungCol = mix(uSungA, uSungB, clamp(pos / max(prog.x, 1.0), 0.0, 1.0));
    sungCol = mix(sungCol, uSungHead, smoothstep(prog.x - 1.0, prog.x - 0.15, pos));
  }
  /* 唱过的字外面一圈同色的光（重度糊开的字形） */
  col += sungCol * min(1.0, t.b * 1.6) * sung * layer.x * 0.2;

  /* 扁平毛玻璃：不做斜面、不做镜面反光。一块平的磨砂玻璃 + 一圈均匀的细亮边 + 很淡的投影 */
  float sh = texture2D(tex, tuv + vec2(0.0, texel.y * 3.0)).b;
  col *= 1.0 - 0.22 * sh * layer.x;

  float m = mix(t.r, min(1.0, t.b * 1.8), layer.y) * layer.x;
  if (m < 0.002) return col;

  /* 磨砂：字后面的烟糊开透过来，上面盖一层半透明的「奶白 + 一点玻璃色」 */
  vec3 behind = frosted(vUv, vec2(0.0));
  vec3 milk = mix(vec3(1.0), uGlass, 0.4);
  /* 唱过的玻璃染上进度色，染得更浓：还是透着烟的玻璃，只是换了颜色 */
  milk = mix(milk, sungCol, sung * 0.92);
  vec3 glass = mix(behind, milk, 0.48 + sung * 0.3);
  /* 磨砂颗粒：很细的一层噪点，玻璃才不像一块平涂的颜色 */
  glass += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.04;

  /* 细亮边：清晰字形里、轻微糊开的字形还没到满的那一圈 */
  float edge = t.r * (1.0 - smoothstep(0.5, 0.9, t.g));
  vec3 rim = mix(mix(uGlass, vec3(1.0), 0.9), mix(sungCol, vec3(1.0), 0.45), sung);
  glass = mix(glass, rim, edge * (0.85 + lit * 0.15));

  /* 光柱扫过：整块玻璃被照亮，平平地亮，不出反光点 */
  glass += mix(uGlass, vec3(1.0), 0.6) * lit * 0.28;

  return mix(col, glass, m * (0.85 + sung * 0.1));
}

void main() {
  vec4 scene = texture2D(uScene, vUv);
  vec3 col = scene.rgb;
  float lit = scene.a / 0.6;
  col = glassLayer(col, uTextN, uTextN, vec2(0.0), uRectN, uLayerN, uTexelN, lit);
  col = glassLayer(col, uTextB, uOrderB, uProgB, uRectB, uLayerB, uTexelB, lit);
  col = glassLayer(col, uTextA, uOrderA, uProgA, uRectA, uLayerA, uTexelA, lit);
  gl_FragColor = vec4(col, 1.0);
}`

/** 下一句那层玻璃的不透明度：比当前句淡一截 */
const NEXT_GLASS = 0.6

interface SmokeColors {
  smoke: [number, number, number]
  deep: [number, number, number]
  shadow: [number, number, number]
  glass: [number, number, number]
  /** 颜色进度（和 SkylineLyric 同一套，见 skyline.ts） */
  sungA: [number, number, number]
  sungB: [number, number, number]
  sungHead: [number, number, number]
}

/** 封面的色相 → 三种颜色，亮度锁死。没取到封面时是一点冷灰紫，不用品牌青柠 */
function colorsFor(palette: ArtPalette, hasSource: boolean): SmokeColors {
  const h = hasSource ? palette.h : 280
  const c = hasSource ? (palette.neutral ? Math.min(palette.c, 0.015) : palette.c) : 0.03
  return {
    smoke: oklchToRgb(0.86, Math.min(c * 0.75, 0.085), h),
    deep: oklchToRgb(0.3, Math.min(c * 0.55, 0.06), h),
    shadow: oklchToRgb(0.16, Math.min(c * 0.4, 0.04), h),
    glass: oklchToRgb(0.92, Math.min(c * 0.55 + 0.012, 0.055), hasSource ? glassHue(palette.h, palette.h2) : 300),
    ...skyColorFloats(hasSource ? palette : null),
  }
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

/** 封面缩成一小块灰度够用的图：大图上传纹理太慢，跨域读不到像素时放弃 */
function loadCoverCanvas(url: string): Promise<HTMLCanvasElement | null> {
  return new Promise(resolve => {
    const img = new Image()
    if (!url.startsWith('data:') && !url.startsWith('blob:')) img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => {
      const size = 192
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(null)
      const scale = Math.max(size / img.naturalWidth, size / img.naturalHeight)
      const w = img.naturalWidth * scale
      const h = img.naturalHeight * scale
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
      resolve(canvas)
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

export function LyricSmoke({ coverUrl }: { coverUrl?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)
  const coverRef = useRef<{ upload: (source: HTMLCanvasElement | null) => void } | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const host = canvas?.parentElement
    if (!canvas || !host) return
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'low-power' })
    if (!gl) {
      setFailed(true)
      return
    }
    const link = (fragSrc: string) => {
      const vs = compile(gl, gl.VERTEX_SHADER, VERT)
      const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc)
      const program = gl.createProgram()
      if (!vs || !fs || !program) return null
      gl.attachShader(program, vs)
      gl.attachShader(program, fs)
      gl.bindAttribLocation(program, 0, 'aPos')
      gl.linkProgram(program)
      return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null
    }
    const prog = link(FRAG)
    const glassProg = link(COMPOSITE)
    if (!prog || !glassProg) {
      setFailed(true)
      return
    }
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.useProgram(prog)

    const makeTexture = (unit: number) => {
      const tex = gl.createTexture()
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))
      return tex
    }

    /* 第一遍画进这张纹理（单元 1） */
    const sceneTex = makeTexture(1)
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    let sceneW = 1
    let sceneH = 1

    /* 歌词两层：A 是当前这句，B 是正在散掉的上一句（单元 2、3） */
    interface TextLayer {
      tex: WebGLTexture | null
      unit: number
      /** 字序图（颜色进度），以及每个字的格子（光点、主光束按它定位） */
      order: WebGLTexture | null
      orderUnit: number
      cells: LyricCell[]
      rect: [number, number, number, number]
      texel: [number, number]
      /** 遮罩在宿主里的位置（CSS 像素），宿主尺寸变了要换算 */
      box: { x: number; y: number; width: number; height: number } | null
      at: number
      /** 这一层画的是哪句、多大的字（换句时判断「新的当前句是不是刚才那句下一句」） */
      text: string
      fontSize: number
      /** 从哪儿长过来（下一句的位置与相对字号）；没有就是原地从糊里浮出来 */
      from: { cx: number; cy: number; scale: number } | null
    }
    const newLayer = (unit: number, orderUnit: number, order: WebGLTexture | null): TextLayer => ({
      tex: makeTexture(unit), unit, order, orderUnit, cells: [], rect: [0, 0, 1, 1], texel: [1, 1],
      box: null, at: -1e9, text: '', fontSize: 0, from: null,
    })
    let layerA = newLayer(2, 4, makeTexture(4))
    let layerB = newLayer(3, 5, makeTexture(5))
    /** 下一句：只是一层淡玻璃，不染进度（字序图那个单元随便指一个，着色器不会去读） */
    const layerN = newLayer(6, 6, null)
    let lyricKey = ''

    const gu = (name: string) => gl.getUniformLocation(glassProg, name)
    const glassUniforms = {
      scene: gu('uScene'), textA: gu('uTextA'), textB: gu('uTextB'), rectA: gu('uRectA'), rectB: gu('uRectB'),
      textN: gu('uTextN'), rectN: gu('uRectN'), layerN: gu('uLayerN'), texelN: gu('uTexelN'),
      layerA: gu('uLayerA'), layerB: gu('uLayerB'), texelA: gu('uTexelA'), texelB: gu('uTexelB'),
      res: gu('uRes'), origin: gu('uOrigin'), glass: gu('uGlass'),
      orderA: gu('uOrderA'), orderB: gu('uOrderB'), progA: gu('uProgA'), progB: gu('uProgB'),
      sungA: gu('uSungA'), sungB: gu('uSungB'), sungHead: gu('uSungHead'),
    }

    const u = (name: string) => gl.getUniformLocation(prog, name)
    gl.useProgram(prog)
    const uniforms = {
      res: u('uRes'), time: u('uTime'), origin: u('uOrigin'), beam: u('uBeam'),
      smoke: u('uSmoke'), deep: u('uDeep'), shadow: u('uShadow'), cover: u('uCover'), coverMix: u('uCoverMix'),
      pulse: u('uPulse'), beams: u('uBeams'),
    }

    /* 灯位：from → to 的过渡，换句或者隔几小节换一次 */
    let seed = (Math.random() * 1e9) | 0
    let rigFrom: BeamRig = nextBeamRig(seed++)
    let rigTo: BeamRig = rigFrom
    let rigAt = -1
    let lastLyric: string | null = null
    let lastSwingBeat = 0
    let pulse = 0
    const beamData = new Float32Array(SLOT_COUNT * 4)
    /** 主光束的朝向（平滑跟着进度头走） */
    let aim = 0
    let aimReady = false
    const poseNow = (now: number): BeamPose[] =>
      rigAt < 0 ? rigTo.beams : mixBeamRigs(rigFrom, rigTo, (now - rigAt) / 1000 / RIG_SWING)
    const swingTo = (now: number) => {
      rigFrom = { beams: poseNow(now) }
      rigTo = nextBeamRig(seed++)
      rigAt = now
    }

    const texture = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))
    gl.uniform1i(uniforms.cover, 0)

    /* 换封面：旧的淡出、换图、新的淡入 */
    let coverMix = 0
    let coverTarget = 0
    let pendingCover: HTMLCanvasElement | null | undefined
    coverRef.current = {
      upload: source => {
        pendingCover = source
        coverTarget = 0
      },
    }

    const art = useArtLightStore.getState()
    const target = colorsFor(art.palette, !!art.source)
    const current: SmokeColors = {
      smoke: [...target.smoke], deep: [...target.deep], shadow: [...target.shadow], glass: [...target.glass],
      sungA: [...target.sungA], sungB: [...target.sungB], sungHead: [...target.sungHead],
    }
    const unsubscribePalette = useArtLightStore.subscribe(state => {
      Object.assign(target, colorsFor(state.palette, !!state.source))
    })

    const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const origin = { x: 0.5, y: 0.12, ready: false }
    let beam = 0
    const start = performance.now()
    let frozenAt = 0
    let last = start
    let lastPaint = 0
    let raf = 0

    /** 进度条在画布里的横向范围：按键藏起来后，光还按播放进度在这条线上走 */
    const track = { left: 0.06, width: 0.88 }
    const measureOrigin = (rect: DOMRect) => {
      const dots = document.querySelectorAll<HTMLElement>('[data-beam-origin]')
      for (const dot of dots) {
        const r = dot.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        if (r.top > rect.bottom || r.bottom < rect.top) continue
        const bar = dot.parentElement?.getBoundingClientRect()
        if (bar && bar.width > 1) {
          track.left = (bar.left - rect.left) / rect.width
          track.width = bar.width / rect.width
        }
        return { x: (r.left + r.width / 2 - rect.left) / rect.width, y: 1 - (r.top + r.height / 2 - rect.top) / rect.height }
      }
      return null
    }

    const paint = (now: number) => {
      const rect = host.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) return
      /* 画布按屏幕像素（最多 2 倍），字才清楚；烟那一遍只要 0.6 倍 */
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const fullW = Math.max(1, Math.round(rect.width * dpr))
      const fullH = Math.max(1, Math.round(rect.height * dpr))
      if (canvas.width !== fullW || canvas.height !== fullH) {
        canvas.width = fullW
        canvas.height = fullH
      }
      const w = Math.max(1, Math.round(rect.width * 0.6))
      const h = Math.max(1, Math.round(rect.height * 0.6))
      if (sceneW !== w || sceneH !== h) {
        sceneW = w
        sceneH = h
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, sceneTex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      }
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const reduced = reducedQuery.matches

      /* 光源跟着进度点走；按键藏起来时落到底边中间 */
      const found = measureOrigin(rect)
      const player = usePlayerStore.getState()
      const ratio = player.duration > 0 ? Math.min(1, Math.max(0, player.currentTime / player.duration)) : 0.5
      const tx = found ? found.x : track.left + track.width * ratio
      const ty = found ? found.y : 0.05
      if (!origin.ready) {
        origin.x = tx
        origin.y = ty
        origin.ready = true
      } else {
        const k = Math.min(1, dt * 10)
        origin.x += (tx - origin.x) * k
        origin.y += (ty - origin.y) * k
      }
      /* 拍子：优先读音频元素的实时位置，原生播放器接管时它是 0，退回 store 的进度 */
      const audioTime = getAudioCurrentTime()
      const songTime = Math.abs(audioTime - player.currentTime) < 1.5 ? audioTime : player.currentTime
      const tagged = player.currentSong?.ext?.bpm
      const bpm = tagged && tagged >= 50 && tagged <= 220 ? tagged : DEFAULT_BPM
      const beats = (songTime * bpm) / 60
      const playing = player.isPlaying && !reduced
      const targetPulse = playing ? beatPulse(beats) : 0
      // 起得快、落得慢，像灯被拍子推了一下
      pulse += (targetPulse - pulse) * Math.min(1, dt * (targetPulse > pulse ? 22 : 6))

      /* 换句就换一套灯位；一直没换句（间奏、纯音乐）就每 4 小节换一次 */
      const stage = document.querySelector<HTMLElement>('[data-lyric-stage]')
      const stageRect = stage?.getBoundingClientRect()
      const lyric = stage ? `${stage.dataset.lyricKey ?? ''}:${stage.dataset.lyricText ?? ''}` : null
      if (playing) {
        if (lyric !== lastLyric) {
          if (lastLyric !== null || lyric !== null) swingTo(now)
          lastSwingBeat = beats
        } else if (beats - lastSwingBeat >= 16 || beats < lastSwingBeat) {
          swingTo(now)
          lastSwingBeat = beats
        }
      }
      lastLyric = lyric
      if (rigAt >= 0 && (now - rigAt) / 1000 >= RIG_SWING) {
        rigFrom = rigTo
        rigAt = -1
      }
      const pose = reduced ? STILL_RIG.beams : poseNow(now)
      const swayT = reduced ? 0 : now / 1000
      // 进度点靠边时整组往屏幕中间偏，不让光打到屏幕外面去
      const centerBias = Math.max(-0.5, Math.min(0.5, (0.5 - origin.x) * 1.1))
      for (let i = 0; i < SLOT_COUNT; i++) {
        const b = pose[i]
        // 每束自己慢慢晃，拍子上再被推一下；单双数往两边推，整组像在呼吸
        const sway = Math.sin(swayT * (0.55 + i * 0.13) + i * 1.9) * 0.06 + pulse * 0.045 * (i % 2 ? 1 : -1)
        beamData[i * 4] = b.angle + sway + centerBias
        beamData[i * 4 + 1] = Math.max(0.02, b.spread * (1 + pulse * 0.25))
        beamData[i * 4 + 2] = b.alpha * (0.85 + 0.15 * Math.sin(swayT * (0.8 + i * 0.21) + i))
        beamData[i * 4 + 3] = b.reach
      }

      /* 唱到哪（以字为单位，SkylineLyric 每帧写在那一栏上）。主光束和光斑都跟着「唱到这个字的几成」
         那一点走——连续地扫过整句，不是一个字一个字地跳 */
      const progress = Number.parseFloat(stage?.dataset.lyricProgress ?? '') || 0
      const point = layerA.box ? progressPoint(layerA.cells, progress) : null
      if (point && layerA.box) {
        const aspect = rect.width / rect.height
        const cx = layerA.box.x + point.x
        const cy = layerA.box.y + (point.top + point.bottom) / 2
        const hx = (cx / rect.width - origin.x) * aspect
        const hy = 1 - cy / rect.height - origin.y
        if (hy > 0.02) {
          const want = Math.atan2(hx, hy)
          // 阻尼跟随：平时贴着进度慢慢扫，跨行、换句时缓缓摆过去，不甩
          aim = aimReady ? aim + (want - aim) * (1 - Math.exp(-dt * 3.2)) : want
          aimReady = true
          beamData[0] = aim + (reduced ? 0 : Math.sin(swayT * 0.9) * 0.01)
          beamData[1] = 0.055 * (1 + pulse * 0.3)
          beamData[2] = 0.95
          beamData[3] = Math.max(1, Math.hypot(hx, hy) * 1.6)
        }
      } else {
        aimReady = false
      }
      /* 光斑的发射点写在那一栏上（相对这一栏的 CSS 像素：x, 字顶, 字宽, 字高），SkylineLyric 的粒子层读 */
      if (stage && stageRect) {
        if (point && layerA.box) {
          const sx = rect.left + layerA.box.x + point.x - stageRect.left
          const sy = rect.top + layerA.box.y + point.top - stageRect.top
          stage.dataset.skyHead = `${sx.toFixed(1)},${sy.toFixed(1)},${point.w.toFixed(1)},${point.h.toFixed(1)}`
        } else {
          delete stage.dataset.skyHead
        }
      }

      /* 暂停时光收一半，不灭 */
      const beamTarget = (found ? 1 : 0.8) * (player.isPlaying ? 1 : 0.55)
      beam += (beamTarget - beam) * Math.min(1, dt * 2.5)

      const ck = Math.min(1, dt * 1.5)
      for (const key of ['smoke', 'deep', 'shadow', 'glass', 'sungA', 'sungB', 'sungHead'] as const) {
        for (let i = 0; i < 3; i++) current[key][i] += (target[key][i] - current[key][i]) * ck
      }

      if (pendingCover !== undefined) {
        coverMix = Math.max(0, coverMix - dt * 2)
        if (coverMix <= 0) {
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, texture)
          if (pendingCover) {
            try {
              gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pendingCover)
              coverTarget = 1
            } catch {
              coverTarget = 0
            }
          }
          pendingCover = undefined
        }
      } else {
        coverMix += (coverTarget - coverMix) * Math.min(1, dt * 1.2)
      }

      /* 歌词换了（或者那一栏的尺寸变了）：重画当前句和下一句的遮罩。
         换句时旧的当前句挪到 B 层往上糊开散掉；新的当前句如果就是刚才的下一句，从下一句的位置和字号长过来 */
      const text = stage?.dataset.lyricText ?? ''
      const nextText = stage?.dataset.lyricNext ?? ''
      const key = stage && stageRect
        ? `${lyric}|${nextText}|${Math.round(stageRect.width)}x${Math.round(stageRect.height)}|${Math.round(rect.width)}x${Math.round(rect.height)}`
        : ''
      if (key !== lyricKey) {
        const resized = lyricKey.split('|')[0] === key.split('|')[0]
        lyricKey = key
        const fontOf = (el: HTMLElement): LyricFont => {
          const cs = getComputedStyle(el)
          const size = parseFloat(cs.fontSize) || 40
          return {
            weight: cs.fontWeight,
            family: cs.fontFamily,
            size,
            letterSpacing: parseFloat(cs.letterSpacing) || 0,
            lineHeight: parseFloat(cs.lineHeight) || size * 1.28,
          }
        }
        const sample = stage?.querySelector<HTMLElement>('[data-beam-target]')
        let mask = null
        let font: LyricFont | null = null
        if (stage && stageRect && sample && text) {
          font = fontOf(sample)
          mask = rasterizeLyric(text, font, {
            centerX: stageRect.left - rect.left + stageRect.width / 2,
            centerY: stageRect.top - rect.top + stageRect.height * 0.42,
            maxWidth: stageRect.width * 0.94,
          }, dpr)
        }
        if (!resized) {
          const old = layerB
          layerB = layerA
          layerA = old
          layerA.at = reduced ? -1e9 : now
          // 新的当前句就是刚才的下一句：从下一句那儿长过来
          const n = layerN.box
          layerA.from = !reduced && n && mask && font && layerN.text === text
            ? { cx: n.x + n.width / 2, cy: n.y + n.height / 2, scale: layerN.fontSize / font.size }
            : null
        } else {
          layerA.from = null
        }
        layerA.box = mask
        layerA.text = text
        layerA.fontSize = font?.size ?? 0
        layerA.cells = mask?.order ? mask.cells : []
        if (mask) {
          gl.activeTexture(gl.TEXTURE0 + layerA.unit)
          gl.bindTexture(gl.TEXTURE_2D, layerA.tex)
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask.canvas)
          layerA.texel = [1 / mask.canvas.width, 1 / mask.canvas.height]
          if (mask.order) {
            gl.activeTexture(gl.TEXTURE0 + layerA.orderUnit)
            gl.bindTexture(gl.TEXTURE_2D, layerA.order)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask.order)
          }
        }

        // 下一句：照着那一栏里下一句的位置和字体画（退场中的旧「下一句」也在 DOM 里，按文字找对的那个）
        const nextEl = stage
          ? [...stage.querySelectorAll<HTMLElement>('[data-next-target]')].find(el => el.textContent === nextText) ?? null
          : null
        let nextMask = null
        let nextFont: LyricFont | null = null
        if (stage && stageRect && nextEl && nextText) {
          nextFont = fontOf(nextEl)
          nextMask = rasterizeLyric(nextText, nextFont, {
            centerX: stageRect.left - rect.left + stageRect.width / 2,
            centerY: stageRect.top - rect.top + nextEl.offsetTop + nextEl.offsetHeight / 2,
            maxWidth: stageRect.width * 0.94,
          }, dpr)
        }
        layerN.box = nextMask
        layerN.text = nextText
        layerN.fontSize = nextFont?.size ?? 0
        layerN.at = resized || reduced ? -1e9 : now
        if (nextMask) {
          gl.activeTexture(gl.TEXTURE0 + layerN.unit)
          gl.bindTexture(gl.TEXTURE_2D, layerN.tex)
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, nextMask.canvas)
          layerN.texel = [1 / nextMask.canvas.width, 1 / nextMask.canvas.height]
        }
      }

      const ease = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3
      /** 遮罩在画布上的位置（uv，y 朝上）：可以从 (cx, cy, scale) 长到原位 */
      const placeLayer = (layer: TextLayer, grow: number) => {
        if (!layer.box) return
        const b = layer.box
        let cx = b.x + b.width / 2
        let cy = b.y + b.height / 2
        let s = 1
        if (layer.from && grow < 1) {
          cx = layer.from.cx + (cx - layer.from.cx) * grow
          cy = layer.from.cy + (cy - layer.from.cy) * grow
          s = layer.from.scale + (1 - layer.from.scale) * grow
        }
        const w = b.width * s
        const hgt = b.height * s
        layer.rect = [(cx - w / 2) / rect.width, 1 - (cy + hgt / 2) / rect.height, w / rect.width, hgt / rect.height]
      }

      /* 换句：下一句往上、放大成当前句（不是下一句的话就原地从糊里浮出来）；
         旧的当前句往上飘、糊开、淡掉；再下一句稍后从下面淡进来 */
      const eA = ease((now - layerA.at) / 750)
      const eB = ease((now - layerA.at) / 850)
      const eN = ease((now - layerN.at - 250) / 650)
      placeLayer(layerA, eA)
      placeLayer(layerB, 1)
      placeLayer(layerN, 1)
      const layerAUniform = !layerA.box
        ? [0, 0, 0, 0]
        : layerA.from
          ? [NEXT_GLASS + (1 - NEXT_GLASS) * eA, (1 - eA) * 0.25, 0, 0]
          : [eA, 1 - eA, -(1 - eA) * 0.025, 0]
      const layerBUniform = layerB.box && eB < 1 ? [1 - eB, eB, eB * 0.07, 0] : [0, 0, 0, 0]
      const layerNUniform = layerN.box ? [NEXT_GLASS * eN, (1 - eN) * 0.7, -(1 - eN) * 0.025, 0] : [0, 0, 0, 0]

      if (!reduced) frozenAt = (now - start) / 1000
      gl.useProgram(prog)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.viewport(0, 0, w, h)
      gl.uniform2f(uniforms.res, w, h)
      gl.uniform1f(uniforms.time, frozenAt + 40)
      gl.uniform2f(uniforms.origin, origin.x, origin.y)
      gl.uniform1f(uniforms.beam, beam)
      gl.uniform1f(uniforms.pulse, pulse)
      gl.uniform4fv(uniforms.beams, beamData)
      gl.uniform3fv(uniforms.smoke, current.smoke)
      gl.uniform3fv(uniforms.deep, current.deep)
      gl.uniform3fv(uniforms.shadow, current.shadow)
      gl.uniform1f(uniforms.coverMix, coverMix)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.useProgram(glassProg)
      gl.viewport(0, 0, fullW, fullH)
      gl.uniform1i(glassUniforms.scene, 1)
      gl.uniform1i(glassUniforms.textA, layerA.unit)
      gl.uniform1i(glassUniforms.textB, layerB.unit)
      gl.uniform4fv(glassUniforms.rectA, layerA.rect)
      gl.uniform4fv(glassUniforms.rectB, layerB.rect)
      gl.uniform4fv(glassUniforms.layerA, layerAUniform)
      gl.uniform4fv(glassUniforms.layerB, layerBUniform)
      gl.uniform2fv(glassUniforms.texelA, layerA.texel)
      gl.uniform2fv(glassUniforms.texelB, layerB.texel)
      gl.uniform1i(glassUniforms.textN, layerN.unit)
      gl.uniform4fv(glassUniforms.rectN, layerN.rect)
      gl.uniform4fv(glassUniforms.layerN, layerNUniform)
      gl.uniform2fv(glassUniforms.texelN, layerN.texel)
      gl.uniform2f(glassUniforms.res, fullW, fullH)
      gl.uniform2f(glassUniforms.origin, origin.x, origin.y)
      gl.uniform3fv(glassUniforms.glass, current.glass)
      gl.uniform1i(glassUniforms.orderA, layerA.orderUnit)
      gl.uniform1i(glassUniforms.orderB, layerB.orderUnit)
      // 当前句按进度染；正在散掉的上一句算唱完了
      gl.uniform2f(glassUniforms.progA, progress, layerA.cells.length)
      gl.uniform2f(glassUniforms.progB, 1e4, layerB.cells.length)
      gl.uniform3fv(glassUniforms.sungA, current.sungA)
      gl.uniform3fv(glassUniforms.sungB, current.sungB)
      gl.uniform3fv(glassUniforms.sungHead, current.sungHead)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    document.documentElement.dataset.glassLyrics = ''

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (document.hidden || now - lastPaint < 32) return
      lastPaint = now
      paint(now)
    }
    raf = requestAnimationFrame(loop)

    const onLost = (event: Event) => {
      event.preventDefault()
      delete document.documentElement.dataset.glassLyrics
      cancelAnimationFrame(raf)
      setFailed(true)
    }
    canvas.addEventListener('webglcontextlost', onLost)

    return () => {
      cancelAnimationFrame(raf)
      delete document.documentElement.dataset.glassLyrics
      unsubscribePalette()
      canvas.removeEventListener('webglcontextlost', onLost)
      coverRef.current = null
    }
  }, [])

  useEffect(() => {
    if (failed) return
    if (!coverUrl) {
      coverRef.current?.upload(null)
      return
    }
    let cancelled = false
    void loadCoverCanvas(coverUrl).then(source => {
      if (!cancelled) coverRef.current?.upload(source)
    })
    return () => { cancelled = true }
  }, [coverUrl, failed])

  if (failed) return <LyricAtmosphere coverUrl={coverUrl} />
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  )
}
