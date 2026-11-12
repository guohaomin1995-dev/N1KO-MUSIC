/**
 * oklch 兜底的运行时一半（构建时那一半见 postcss/oklch-fallback.mjs）。
 *
 * 跟着封面变的颜色（--wash、全屏播放器里的 --ground / --ink …）写的是
 * `var(--wash-l) min(var(--art-c), var(--wash-cap)) var(--art-h)` 这种表达式，构建时算不出 rgb。
 * 构建插件把它们登记成 `:root { --oklch-fb-n: N; --oklch-fb-K-src: <表达式> }`，
 * 并且只放在 `@supports not (color: oklch(0% 0 0))` 里——所以读得到 --oklch-fb-n 就说明当前内核不认识 oklch()，
 * 这里把每个表达式（浏览器已经代换掉 var()，剩下数字和 min()/max()/clamp()/calc()）算成 r g b，
 * 写到 <html> 的 --oklch-fb-K 上；换歌（artLight 改 --art-*）、换主题（data-theme）时重算。
 * 新内核上读不到 --oklch-fb-n，什么都不做。
 */
import { oklchToRgb } from './oklch'

const FB = '--oklch-fb'

// ---------------------------------------------------------------- 表达式求值

type Tok = { kind: 'num'; value: number; pct: boolean } | { kind: 'fn'; name: string } | { kind: 'sym'; value: string }

function tokenize(src: string): Tok[] | null {
  const toks: Tok[] = []
  const re = /\s*(?:(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg)?|([a-z-]+)\(|([()+\-*/,]))/giy
  let i = 0
  const text = src.trim()
  while (i < text.length) {
    re.lastIndex = i
    const m = re.exec(text)
    if (!m) return null
    if (m[1] !== undefined) toks.push({ kind: 'num', value: Number(m[1]), pct: m[2] === '%' })
    else if (m[3] !== undefined) toks.push({ kind: 'fn', name: m[3].toLowerCase() })
    else toks.push({ kind: 'sym', value: m[4] })
    i = re.lastIndex
    while (i < text.length && /\s/.test(text[i])) i++
  }
  return toks
}

/** 一个通道：数字、百分比（按 pctScale 换算）、min/max/clamp/calc 和四则运算 */
export function evalChannel(src: string, pctScale: number): number | null {
  const toks = tokenize(src)
  if (!toks || toks.length === 0) return null
  let pos = 0
  const peek = () => toks[pos]
  const isSym = (v: string) => {
    const t = peek()
    return t?.kind === 'sym' && t.value === v
  }
  const expect = (v: string) => {
    if (!isSym(v)) throw new Error(`expected ${v}`)
    pos++
  }
  const args = (): number[] => {
    const list = [expr()]
    while (isSym(',')) {
      pos++
      list.push(expr())
    }
    expect(')')
    return list
  }
  const factor = (): number => {
    const t = toks[pos++]
    if (!t) throw new Error('unexpected end')
    if (t.kind === 'num') return t.pct ? (t.value / 100) * pctScale : t.value
    if (t.kind === 'sym' && t.value === '-') return -factor()
    if (t.kind === 'sym' && t.value === '(') {
      const v = expr()
      expect(')')
      return v
    }
    if (t.kind === 'fn') {
      const list = args()
      switch (t.name) {
        case 'calc':
          if (list.length === 1) return list[0]
          break
        case 'min':
          return Math.min(...list)
        case 'max':
          return Math.max(...list)
        case 'clamp':
          if (list.length === 3) return Math.min(Math.max(list[1], list[0]), list[2])
          break
      }
    }
    throw new Error('unsupported')
  }
  const term = (): number => {
    let v = factor()
    while (isSym('*') || isSym('/')) {
      const op = toks[pos++] as { value: string }
      const rhs = factor()
      v = op.value === '*' ? v * rhs : v / rhs
    }
    return v
  }
  const expr = (): number => {
    let v = term()
    while (isSym('+') || isSym('-')) {
      const op = toks[pos++] as { value: string }
      const rhs = term()
      v = op.value === '+' ? v + rhs : v - rhs
    }
    return v
  }
  try {
    const v = expr()
    return pos === toks.length && Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/** 按顶层空白切成三段 */
function splitChannels(src: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of src.trim()) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (depth === 0 && /\s/.test(ch)) {
      if (cur) parts.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur) parts.push(cur)
  return parts
}

/** 「L C H」（var() 已代换）→ "r g b"（0–255）；算不出来回 null */
export function channelsToRgb(src: string): string | null {
  const parts = splitChannels(src)
  if (parts.length !== 3) return null
  const L = evalChannel(parts[0], 1)
  const C = evalChannel(parts[1], 0.4)
  const H = parts[2] === 'none' ? 0 : evalChannel(parts[2].replace(/deg/gi, ''), 1)
  if (L === null || C === null || H === null) return null
  return oklchToRgb(L, C, H).map(v => Math.round(v * 255)).join(' ')
}

// ---------------------------------------------------------------- 安装

/** 把登记的表达式算一遍写上去；返回 false 表示这个内核认识 oklch（或样式表还没加载） */
export function updateOklchFallback(root: HTMLElement = document.documentElement): boolean {
  const style = getComputedStyle(root)
  const n = Number.parseInt(style.getPropertyValue(`${FB}-n`), 10)
  if (!Number.isFinite(n) || n <= 0) return false
  for (let k = 0; k < n; k++) {
    const rgb = channelsToRgb(style.getPropertyValue(`${FB}-${k}-src`))
    if (rgb === null) continue
    if (root.style.getPropertyValue(`${FB}-${k}`) !== rgb) root.style.setProperty(`${FB}-${k}`, rgb)
  }
  return true
}

let installed = false

export function installOklchFallback(root: HTMLElement = document.documentElement): void {
  if (installed || typeof window === 'undefined' || typeof getComputedStyle !== 'function') return
  const start = () => {
    if (installed || !updateOklchFallback(root)) return
    installed = true
    // 换歌改 --art-*（<html> 的 style）、换主题改 data-theme：重算。自己写回 style 也会触发一次，值没变就不再写，不会打转
    new MutationObserver(() => updateOklchFallback(root))
      .observe(root, { attributes: true, attributeFilter: ['style', 'data-theme', 'class'] })
  }
  start()
  // 开发模式下样式表由脚本插入，可能比这里晚到
  if (!installed) window.addEventListener('load', start, { once: true })
}
