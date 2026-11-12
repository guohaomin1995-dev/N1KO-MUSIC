/**
 * 天际屏歌词的纯计算部分（不碰 DOM，单测直接验）：
 * - 唱到这一句的第几个字：从这句开始到下一句开始，按字数平均分；
 * - 进度色跟着封面：主色相 → 副色相的渐变，进度头最亮；
 * - 两侧散落的字：从这首歌的歌词里挑，换句时换掉一两个。
 */
import { oklchToRgb } from '@/lib/oklch'
import type { ArtPalette } from '@/services/artLight'
import type { LyricLine } from '@/api/types'

/** 没有下一句（最后一句）时，这一句按多长唱完 */
const LAST_LINE_MS = 5000

const SPACE = /\s/

/** 这一句拆成一个个显示单位（空格保留，用来排版，不占进度） */
export function splitChars(text: string): string[] {
  return Array.from(text)
}

/** 参与进度的字的下标（跳过空格） */
export function progressSlots(chars: string[]): number[] {
  const out: number[] = []
  chars.forEach((ch, i) => { if (!SPACE.test(ch)) out.push(i) })
  return out
}

/**
 * 这一句唱到哪：head 是正在唱的那个字在 chars 里的下标，frac 是这个字唱了多少（0–1），
 * pos 是以字为单位的进度（不算空格，0 到字数），玻璃字的着色器按它染色。
 * 还没开始唱时 head = -1；唱完了 head = chars.length。
 */
export function lineProgress(
  lines: LyricLine[],
  index: number,
  timeMs: number,
  chars: string[],
  songEndMs?: number,
): { head: number; frac: number; pos: number } {
  const line = lines[index]
  if (!line) return { head: -1, frac: 0, pos: 0 }
  const slots = progressSlots(chars)
  if (slots.length === 0) return { head: -1, frac: 0, pos: 0 }
  const start = line.time
  const nextStart = lines[index + 1]?.time
  let end = nextStart !== undefined && nextStart > start ? nextStart : start + LAST_LINE_MS
  if (nextStart === undefined && songEndMs && songEndMs > start) end = Math.min(end, songEndMs)
  const p = (timeMs - start) / (end - start)
  if (p <= 0) return { head: -1, frac: 0, pos: 0 }
  if (p >= 1) return { head: chars.length, frac: 1, pos: slots.length }
  const pos = p * slots.length
  const k = Math.min(slots.length - 1, Math.floor(pos))
  return { head: slots[k], frac: pos - k, pos }
}

/* ---------------------------------------------------------------- 颜色 */

export interface SkyColors {
  /** 进度渐变的起点（这句开头），rgb() */
  a: string
  /** 进度渐变的终点（靠近进度头），rgb() */
  b: string
  /** 正在唱的那个字：「r g b」三个通道，CSS 里按需加透明度 */
  head: string
  /** 字外面的霓虹光：「r g b」三个通道 */
  glow: string
  /** 两侧散落的字（比当前句暗、饱和度低）与它的投影：「r g b」 */
  side: string
  ghost: string
  /** 下一句：带一点点封面色的白，rgb() */
  next: string
}

/** 近乎黑白的封面：退回天际屏本来的蓝 → 紫，否则唱过的和没唱的都是白的，看不出进度 */
const FALLBACK_HUES: [number, number] = [255, 305]

const channels = (l: number, c: number, h: number) => oklchToRgb(l, c, h).map(v => Math.round(v * 255)).join(' ')
const rgb = (l: number, c: number, h: number) => `rgb(${channels(l, c, h)})`
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/** 进度用的两个色相和饱和度：封面主色 → 副色；近乎黑白的封面退回蓝 → 紫 */
function skyHues(palette: ArtPalette | null | undefined) {
  const neutral = !palette || palette.neutral || palette.c < 0.03
  const h1 = neutral ? FALLBACK_HUES[0] : palette.h
  let h2 = neutral ? FALLBACK_HUES[1] : palette.h2
  // 主副色相挨得太近：渐变看不出来，往后拉开一段
  if (hueGap(h1, h2) < 35) h2 = (h1 + 50) % 360
  const c1 = neutral ? 0.15 : clamp(palette.c * 1.6, 0.11, 0.17)
  const c2 = neutral ? 0.15 : clamp(palette.c2 * 1.6, 0.11, 0.17)
  return { h1, h2, c1, c2 }
}

export function skyColors(palette: ArtPalette | null | undefined): SkyColors {
  const { h1, h2, c1, c2 } = skyHues(palette)
  return {
    a: rgb(0.8, c1, h1),
    b: rgb(0.74, c2, h2),
    head: channels(0.86, c2 * 0.85, h2),
    glow: channels(0.62, c1, h1),
    // 两侧的字：比当前句暗、灰一截，只是陪衬
    side: channels(0.68, c1 * 0.3, h1),
    ghost: channels(0.5, c1 * 0.45, h1),
    next: rgb(0.93, Math.min(0.025, c1 * 0.2), h1),
  }
}

/** 同一套颜色给玻璃字的着色器用（0–1 浮点）：唱过的从 a 渐变到 b，进度头 head */
export function skyColorFloats(palette: ArtPalette | null | undefined): {
  sungA: [number, number, number]
  sungB: [number, number, number]
  sungHead: [number, number, number]
} {
  const { h1, h2, c1, c2 } = skyHues(palette)
  return {
    sungA: oklchToRgb(0.8, c1, h1),
    sungB: oklchToRgb(0.74, c2, h2),
    sungHead: oklchToRgb(0.86, c2 * 0.85, h2),
  }
}

/** 两个 rgb() 之间按 t 插值（唱过的字从 a 渐变到 b） */
export function mixRgb(a: string, b: string, t: number): string {
  const pa = a.match(/[\d.]+/g)!.map(Number)
  const pb = b.match(/[\d.]+/g)!.map(Number)
  const k = clamp(t, 0, 1)
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * k)).join(' ')})`
}

/* ---------------------------------------------------------------- 两侧散落的字 */

const HAN = /[㐀-鿿豈-﫿]/

/** 一句歌词里能拿来散落的「字」：中文按单字，英文按词（3 个字母以上） */
export function sideTokens(text: string): string[] {
  const out: string[] = []
  for (const ch of Array.from(text)) if (HAN.test(ch)) out.push(ch)
  for (const word of text.match(/[A-Za-z][A-Za-z']{2,}/g) ?? []) out.push(word.toLowerCase())
  return out
}

/** 整首歌里出现最多的字（散落字的初始一批） */
export function frequentTokens(lines: LyricLine[], limit: number): string[] {
  const count = new Map<string, number>()
  for (const line of lines) for (const t of sideTokens(line.text)) count.set(t, (count.get(t) ?? 0) + 1)
  return [...count.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit).map(([t]) => t)
}

export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashText(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export interface SideSlot {
  /** 0 左 1 右 */
  side: 0 | 1
  /** 在这一侧那条横带里的位置（0–1） */
  x: number
  y: number
  /** 字号倍数 */
  scale: number
  /** 0 清楚，1 最远（字本身也是糊的） */
  depth: number
}

/**
 * 每一侧的槽位：横着排开、上下只错一点（天际屏上散字和歌词大致在一条水平线上，或者略低），
 * 大小、远近错开。同一首歌固定（按种子），不会每次打开都乱跳。
 */
export function sideSlots(seed: number, perSide: number): SideSlot[] {
  const rand = seeded(seed)
  const slots: SideSlot[] = []
  for (const side of [0, 1] as const) {
    for (let i = 0; i < perSide; i++) {
      const x = (i + 0.3 + rand() * 0.4) / perSide
      const y = 0.4 + rand() * 0.3
      const depth = rand() < 0.3 ? 0.6 + rand() * 0.4 : rand() * 0.25
      const scale = depth > 0.5 ? 1.15 + rand() * 0.35 : 0.8 + rand() * 0.4
      slots.push({ side, x, y, scale, depth })
    }
  }
  return slots
}

/**
 * 这一句配哪些散字：跟着歌词一起换——先取这一句里的字（打散顺序），不够再拿下一句、再拿整首歌的高频字。
 */
export function lineSideTokens(lines: LyricLine[], index: number, count: number, seed: number): string[] {
  const rand = seeded(seed)
  const out: string[] = []
  const add = (tokens: string[]) => {
    const pool = [...new Set(tokens)].filter(t => !out.includes(t))
    while (pool.length > 0 && out.length < count) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0])
  }
  if (lines[index]) add(sideTokens(lines[index].text))
  if (lines[index + 1]) add(sideTokens(lines[index + 1].text))
  add(frequentTokens(lines, count * 2))
  return out
}

/* ---------------------------------------------------------------- 进度头的位置、光斑 */

/** 字位（和 lyricGlass 的 LyricCell 同形，这里只用到这几个字段） */
export interface ProgressCell {
  x0: number
  x1: number
  top: number
  bottom: number
}

/**
 * 进度落在哪一点：唱到第 k 个字的几成，就在这个字从左往右的几成处。
 * 主光束和光斑都跟这一点走——连续地扫过整句，不是一个字一个字地跳。
 */
export function progressPoint(
  cells: ProgressCell[],
  progress: number,
): { x: number; top: number; bottom: number; w: number; h: number; singing: boolean } | null {
  const n = cells.length
  if (n === 0) return null
  const k = Math.min(n - 1, Math.max(0, Math.floor(progress)))
  const f = Math.min(1, Math.max(0, progress - k))
  const cell = cells[k]
  return {
    x: cell.x0 + (cell.x1 - cell.x0) * f,
    top: cell.top,
    bottom: cell.bottom,
    w: cell.x1 - cell.x0,
    h: cell.bottom - cell.top,
    singing: progress > 0 && progress < n,
  }
}

/** 一颗往上飘的光斑（坐标是歌词那一栏里的 CSS 像素） */
export interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  /** 半径 */
  r: number
  /** 寿命与已过时间（秒） */
  life: number
  age: number
  /** 左右轻轻晃的相位 */
  phase: number
  /** 这一颗有多亮（0–1）：有亮有暗才像散开的光斑，没有一颗特别刺眼 */
  glow: number
}

/**
 * 从进度头附近冒出一颗：横向以进度头为中心、前后一两个字的范围（越近越多），
 * 纵向在字顶到字的上半截之间（字与字之间的缝里也会冒）。往上飘、慢慢散开。
 */
export function spawnSpark(head: { x: number; y: number; w: number; h: number }, rand: () => number): Spark {
  const spread = (rand() + rand() + rand() - 1.5) / 1.5
  return {
    x: head.x + spread * head.w * 1.8,
    y: head.y + head.h * (0.06 + rand() ** 1.6 * 0.42),
    vx: (rand() - 0.5) * head.w * 0.35,
    vy: -(0.5 + rand() * 0.6) * head.h,
    r: head.h * (0.025 + rand() * 0.04),
    life: 0.8 + rand() * 0.9,
    age: 0,
    phase: rand() * Math.PI * 2,
    glow: 0.4 + rand() * 0.45,
  }
}

/** 往前走 dt 秒：上升略微变慢，左右轻轻晃 */
export function stepSpark(p: Spark, dt: number): void {
  p.age += dt
  p.x += (p.vx + Math.sin(p.phase + p.age * 3) * p.r * 1.5) * dt
  p.y += p.vy * dt
  p.vy *= 1 - Math.min(0.9, dt * 0.35)
}

/** 亮度：一下子亮起来，再慢慢淡掉 */
export function sparkAlpha(p: Spark): number {
  const t = p.age / p.life
  if (t >= 1) return 0
  return t < 0.15 ? t / 0.15 : (1 - (t - 0.15) / 0.85) ** 1.3
}

/* ---------------------------------------------------------------- 投影的位置 */

/** 一侧那块区域有多大（以散字的基准字号为 1 个单位）：横屏两翼约 6.7×5，竖屏那一行约 9×3 */
export const SIDE_BOX = {
  wide: { w: 6.7, h: 5 },
  narrow: { w: 9, h: 3 },
} as const

/** 投影比字大多少（一开始就大一圈，像近处的灯投到远处墙上） */
export const GHOST_SCALE = 1.75

/**
 * 每个字的投影放在哪：不统一往一个方向偏，而是在这个字周围一圈找空处——
 * 不压任何一个字、尽量不和已经放好的投影重叠、越落在字稀疏的地方越好、别跑出这一侧太远。
 * 高处的字投影往往落到下面或旁边的空处，低处的落到上面，两组字的上下左右疏密就均衡了。
 * 返回相对字中心的偏移，单位是这个字自己的字号（CSS 里直接乘 1em）。同一组槽位结果固定。
 */
export function ghostOffsets(slots: SideSlot[], box: { w: number; h: number }): Array<{ gx: number; gy: number }> {
  const out: Array<{ gx: number; gy: number }> = slots.map(() => ({ gx: 0, gy: 0 }))
  for (const side of [0, 1] as const) {
    const idx = slots.map((s, i) => i).filter(i => slots[i].side === side)
    const faces = idx.map(i => ({ x: slots[i].x * box.w, y: slots[i].y * box.h, r: 0.5 * slots[i].scale }))
    const placed: Array<{ x: number; y: number; r: number }> = []
    // 大字先放：它的投影最大、最难安排
    const order = idx.map((i, k) => k).sort((a, b) => slots[idx[b]].scale - slots[idx[a]].scale)
    for (const k of order) {
      const face = faces[k]
      const s = slots[idx[k]].scale
      const rg = 0.5 * s * GHOST_SCALE
      let best = { x: face.x, y: face.y - 1, cost: Infinity }
      for (let a = 0; a < 16; a++) {
        const angle = (a / 16) * Math.PI * 2
        for (const dist of [0.9, 1.2, 1.55]) {
          const d = dist * s * GHOST_SCALE * 0.75
          const x = face.x + Math.cos(angle) * d
          const y = face.y + Math.sin(angle) * d
          let cost = 0
          for (const f of faces) {
            const gap = Math.hypot(x - f.x, y - f.y) - (rg * 0.85 + f.r)
            if (gap < 0) cost += gap * gap * 40
            cost += Math.exp(-((x - f.x) ** 2 + (y - f.y) ** 2) / 2.5)
          }
          for (const g of placed) {
            const gap = Math.hypot(x - g.x, y - g.y) - (rg + g.r) * 0.7
            if (gap < 0) cost += gap * gap * 8
            cost += Math.exp(-((x - g.x) ** 2 + (y - g.y) ** 2) / 2.5) * 0.6
          }
          // 别跑出这一侧太远（上下可以稍微出一点）
          const outX = Math.max(0, -x, x - box.w)
          const outY = Math.max(0, -0.4 * box.h - y, y - 1.3 * box.h)
          cost += (outX * outX + outY * outY) * 6
          // 近一点的位置略优先：投影不至于飘得离自己的字太远
          cost += dist * 0.05
          if (cost < best.cost) best = { x, y, cost }
        }
      }
      placed.push({ x: best.x, y: best.y, r: rg })
      out[idx[k]] = { gx: (best.x - face.x) / s, gy: (best.y - face.y) / s }
    }
  }
  return out
}
