/**
 * oklch 兜底：给不认识 oklch() 的旧内核补一份 rgb() 写法。
 *
 * 颜色 token 全是 oklch 的三个通道（index.css），处处写成 `oklch(var(--x) / a)`。
 * Chrome / Android WebView 111 以前不认识 oklch()：带 var() 的值在解析时照收，
 * 算值时才发现不合法，于是背景退成透明（露出 WebView 的白底）、文字退成继承色——
 * 车机上暗色模式白底白字、全屏播放器的按钮黑成一片，就是这么来的。
 *
 * 构建时做三件事，新内核的渲染一点不变：
 * 1. 每个通道 token 旁边补一个 `--x-rgb`（sRGB 的 r g b，超出色域的分量截断，和浏览器在 sRGB 屏上的做法一致）：
 *    写死的三个数直接算好；`var(--y)` 别名写成 `var(--y-rgb)`；
 *    带 var() / min() 的（跟着封面变的光）交给运行时，写成 `var(--oklch-fb-N)`，见 src/lib/oklchFallback.ts。
 * 2. 凡是用到 oklch() 的规则，紧跟其后复制一份放进 `@supports not (color: oklch(0% 0 0))`，
 *    里面的 oklch(var(--x) / a) 换成 rgb(var(--x-rgb) / a)。
 *    整条规则照抄（不只抄颜色那几行）、紧贴原规则：层叠顺序、同一条规则里后写的覆盖先写的，都和原来一样。
 * 3. 运行时要算的表达式登记在 `:root` 的 `--oklch-fb-N-src` 里（同样只在旧内核上生效），个数是 `--oklch-fb-n`。
 */

export const SUPPORTS_PARAMS = 'not (color: oklch(0% 0 0))'
const FB = '--oklch-fb'

// ---------------------------------------------------------------- 颜色换算（与 src/lib/oklch.ts 的 oklchToRgb 同一套 OKLab 矩阵）

const toGamma = v => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

/** L 0–1、C、H（度）→ 0–255 的整数 r g b，超出 sRGB 的分量截断 */
export function oklchToRgb255(L, C, H) {
  const h = (H * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  return [r, g, bl].map(v => Math.round(Math.min(1, Math.max(0, toGamma(Math.max(0, v)))) * 255))
}

// ---------------------------------------------------------------- 值的切分

/** 按顶层（括号外）的分隔符切开 */
function splitTop(str, isSep) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && isSep(ch)) {
      parts.push(str.slice(start, i))
      start = i + 1
    }
  }
  parts.push(str.slice(start))
  return parts.map(p => p.trim()).filter(p => p !== '')
}

const VAR_ONLY = /^var\(\s*(--[\w-]+)\s*\)$/

/** 三个通道全是写死的数 → [L, C, H]；否则 null */
function staticChannels(channels) {
  const parts = splitTop(channels, ch => /\s/.test(ch))
  if (parts.length !== 3) return null
  const num = /^(-?(?:\d+\.?\d*|\.\d+))(%|deg)?$/
  const [l, c, h] = parts.map(p => num.exec(p === 'none' ? '0' : p))
  if (!l || !c || !h) return null
  const L = l[2] === '%' ? Number(l[1]) / 100 : Number(l[1])
  const C = c[2] === '%' ? (Number(c[1]) / 100) * 0.4 : Number(c[1])
  return [L, C, Number(h[1])]
}

/** 是不是「三个通道」的形状（写死的或带 var()/min() 的都算） */
function looksLikeChannels(value) {
  return splitTop(value, ch => /\s/.test(ch)).length === 3
}

/** value 里每一个 oklch(...)：回调拿到括号里的内容，返回替换文本 */
function replaceOklch(value, fn) {
  let out = ''
  let i = 0
  for (;;) {
    const j = value.indexOf('oklch(', i)
    if (j < 0) return out + value.slice(i)
    if (j > 0 && /[\w-]/.test(value[j - 1])) {
      out += value.slice(i, j + 6)
      i = j + 6
      continue
    }
    let depth = 0
    let end = -1
    for (let k = j + 5; k < value.length; k++) {
      if (value[k] === '(') depth++
      else if (value[k] === ')' && --depth === 0) {
        end = k
        break
      }
    }
    if (end < 0) throw new Error(`oklch() 括号不配对：${value}`)
    out += value.slice(i, j) + fn(value.slice(j + 6, end))
    i = end + 1
  }
}

const normalize = s => s.replace(/\s+/g, ' ').trim()

// ---------------------------------------------------------------- 插件

/** @type {import('postcss').PluginCreator<void>} */
export default function oklchFallback() {
  return {
    postcssPlugin: 'oklch-fallback',
    OnceExit(root, { AtRule, Rule, Declaration }) {
      // 运行时要算的表达式：同一个表达式只登记一次
      const dynamic = new Map()
      const dynamicVar = expr => {
        const key = normalize(expr)
        if (!dynamic.has(key)) dynamic.set(key, `${FB}-${dynamic.size}`)
        return `var(${dynamic.get(key)})`
      }

      const channelsToRgb = channels => {
        const ch = channels.trim()
        const alias = VAR_ONLY.exec(ch)
        if (alias) return `var(${alias[1]}-rgb)`
        const fixed = staticChannels(ch)
        if (fixed) return oklchToRgb255(...fixed).join(' ')
        return dynamicVar(ch)
      }

      const convertValue = value => replaceOklch(value, inner => {
        const [channels, alpha] = splitTop(inner, ch => ch === '/')
        return `rgb(${channelsToRgb(channels)}${alpha === undefined ? '' : ` / ${alpha}`})`
      })

      const insideFallback = node => {
        for (let p = node.parent; p; p = p.parent) {
          if (p.type === 'atrule' && p.name === 'supports' && p.params === SUPPORTS_PARAMS) return true
        }
        return false
      }

      // 1. 哪些自定义属性是通道 token：以 oklch(var(--x) 的形式用到过的，再顺着别名往上找
      const needed = new Set()
      root.walkDecls(decl => {
        for (const m of decl.value.matchAll(/(?<![\w-])oklch\(\s*var\(\s*(--[\w-]+)\s*\)/g)) needed.add(m[1])
      })
      const tokenDecls = new Map()
      root.walkDecls(/^--/, decl => {
        if (insideFallback(decl)) return
        const list = tokenDecls.get(decl.prop) ?? []
        list.push(decl)
        tokenDecls.set(decl.prop, list)
      })
      for (let grew = true; grew;) {
        grew = false
        for (const name of needed) {
          for (const decl of tokenDecls.get(name) ?? []) {
            const alias = VAR_ONLY.exec(decl.value.trim())
            if (alias && !needed.has(alias[1])) {
              needed.add(alias[1])
              grew = true
            }
          }
        }
      }

      // 2. 每个通道 token 旁边补 --x-rgb
      for (const name of needed) {
        for (const decl of tokenDecls.get(name) ?? []) {
          const value = decl.value.trim()
          if (!VAR_ONLY.test(value) && !looksLikeChannels(value)) {
            throw decl.error(`${name} 被当成 oklch 通道用，但它的值不是「L C H」三段：${value}`)
          }
          const next = decl.next()
          if (next?.type === 'decl' && next.prop === `${name}-rgb`) continue
          decl.after(new Declaration({ prop: `${name}-rgb`, value: channelsToRgb(value) }))
        }
      }

      // 3. 用到 oklch() 的规则：紧跟其后放一份 rgb 版
      const targets = new Set()
      root.walkDecls(decl => {
        if (!decl.value.includes('oklch(') || insideFallback(decl)) return
        const rule = decl.parent
        if (rule.type !== 'rule') throw decl.error('oklch() 只支持写在普通规则里')
        const keyframes = rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name) ? rule.parent : null
        targets.add(keyframes ?? rule)
      })
      for (const node of targets) {
        const copy = node.clone()
        copy.walkDecls(decl => {
          if (decl.value.includes('oklch(')) decl.value = convertValue(decl.value)
        })
        const wrapper = new AtRule({ name: 'supports', params: SUPPORTS_PARAMS })
        wrapper.append(copy)
        node.after(wrapper)
      }

      // 4. 运行时要算的表达式登记在 :root
      if (dynamic.size > 0) {
        const registry = new Rule({ selector: ':root' })
        registry.append(new Declaration({ prop: `${FB}-n`, value: String(dynamic.size) }))
        for (const [expr, name] of dynamic) registry.append(new Declaration({ prop: `${name}-src`, value: expr }))
        const wrapper = new AtRule({ name: 'supports', params: SUPPORTS_PARAMS })
        wrapper.append(registry)
        root.append(wrapper)
      }
    },
  }
}
oklchFallback.postcss = true
