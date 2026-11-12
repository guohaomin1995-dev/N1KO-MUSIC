/**
 * 老内核兜底（以电视盒子的 Android WebView 83 为准）：把它不认识的 CSS 写法补一份它认识的。
 *
 * 新内核的渲染一点不变——补的东西要么包在只有老内核才进得去的 @supports 里，要么是写在新写法前面、被新写法盖掉的旧写法。
 *
 * 1. 选择器 :is() / :where() 和带列表的 :not(a, b)（都是 88 才有）。
 *    老内核遇到选择器列表里有一个不认识，整条规则作废：Tailwind preflight 里
 *    `button, input:where([type=button]) … { background-color: transparent }` 就这么没了，按钮全露出系统的灰底；
 *    电视的焦点样式也全写在 :is() 里。
 *    办法：展开成普通选择器，整条规则复制一份紧跟在原规则后面，包进 `@supports not selector(:is(a))`
 *    （83 认识 selector()，88 起这个条件为假，新内核不进去）。
 *    展开以后特异性会变高；原本特异性为 0 的选择器（整条都包在 :where 里，本意是谁都能盖过它）不展开。
 * 2. dvh / svh / lvh 单位（108）：前面补一行换成 vh 的同名声明。
 * 3. overflow: clip（90）：前面补 overflow: hidden。
 * 4. 逻辑简写（87）：inset 直接换成上右下左四条；margin-inline、padding-inline、margin-block、padding-block 前面补左右 / 上下的写法。
 * 5. aspect-ratio（88）：同一条规则里抄一份 `--legacy-ar`，运行时按宽算高（src/lib/legacyLayout.ts）。
 *
 * flex 布局的 gap（84）在 CSS 里补不了——同一个 gap 写在 grid 上老内核是认的，样式表里分不出来——
 * 也交给 legacyLayout 在运行时给子元素补外边距。
 */

export const LEGACY_SUPPORTS = 'not selector(:is(a))'
export const LEGACY_AR = '--legacy-ar'

/** 一条选择器最多展开成多少条，再多说明写法太复杂，放弃 */
const MAX_EXPANSION = 64

// ---------------------------------------------------------------- 选择器切分

/** s[i] 是反斜杠：返回转义序列之后的下标（十六进制转义后面可以跟一个空白） */
function skipEscape(s, i) {
  let j = i + 1
  let hex = 0
  while (j < s.length && hex < 6 && /[0-9a-fA-F]/.test(s[j])) {
    j++
    hex++
  }
  if (hex > 0) return j < s.length && /\s/.test(s[j]) ? j + 1 : j
  return j + 1
}

/** s[i] 是 ( 或 [ 或引号：返回与之配对的结束符下标 */
function matchClose(s, i) {
  const open = s[i]
  if (open === '"' || open === "'") {
    let j = i + 1
    while (j < s.length && s[j] !== open) j = s[j] === '\\' ? skipEscape(s, j) : j + 1
    return j
  }
  const close = open === '(' ? ')' : ']'
  let depth = 0
  for (let j = i; j < s.length; ) {
    const ch = s[j]
    if (ch === '\\') {
      j = skipEscape(s, j)
      continue
    }
    if (ch === '"' || ch === "'") {
      j = matchClose(s, j) + 1
      continue
    }
    if (ch === open) depth++
    else if (ch === close && --depth === 0) return j
    j++
  }
  return s.length - 1
}

/** 按顶层逗号切开选择器列表 */
export function splitList(s) {
  const out = []
  let start = 0
  for (let i = 0; i < s.length; ) {
    const ch = s[i]
    if (ch === '\\') i = skipEscape(s, i)
    else if (ch === '(' || ch === '[' || ch === '"' || ch === "'") i = matchClose(s, i) + 1
    else {
      if (ch === ',') {
        out.push(s.slice(start, i).trim())
        start = i + 1
      }
      i++
    }
  }
  out.push(s.slice(start).trim())
  return out.filter(Boolean)
}

/** 复合选择器 + 组合符交替的数组：[复合, 组合符, 复合, …]；组合符规整成 ' '、' > '、' + '、' ~ ' */
function parseComplex(sel) {
  const s = sel.trim()
  const parts = []
  let cur = ''
  for (let i = 0; i < s.length; ) {
    const ch = s[i]
    if (ch === '\\') {
      const j = skipEscape(s, i)
      cur += s.slice(i, j)
      i = j
    } else if (ch === '(' || ch === '[' || ch === '"' || ch === "'") {
      const j = matchClose(s, i)
      cur += s.slice(i, j + 1)
      i = j + 1
    } else if (/\s/.test(ch) || ch === '>' || ch === '+' || ch === '~') {
      let comb = ' '
      while (i < s.length && (/\s/.test(s[i]) || '>+~'.includes(s[i]))) {
        if (!/\s/.test(s[i])) comb = ` ${s[i]} `
        i++
      }
      if (cur) parts.push(cur)
      cur = ''
      parts.push(comb)
    } else {
      cur += ch
      i++
    }
  }
  if (cur) parts.push(cur)
  return parts
}

function readIdent(s, i) {
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\\') i = skipEscape(s, i)
    else if (/[\w-]/.test(ch) || ch.charCodeAt(0) > 127) i++
    else break
  }
  return i
}

/** 复合选择器切成简单选择器：类型 / * / .类 / #id / [属性] / :伪类(…) / ::伪元素 */
function tokenizeCompound(c) {
  const toks = []
  for (let i = 0; i < c.length; ) {
    const start = i
    const ch = c[i]
    if (ch === '[') i = matchClose(c, i) + 1
    else if (ch === ':') {
      i += c[i + 1] === ':' ? 2 : 1
      i = readIdent(c, i)
      if (c[i] === '(') i = matchClose(c, i) + 1
    } else if (ch === '.' || ch === '#') i = readIdent(c, i + 1)
    else {
      i = readIdent(c, i)
      if (i === start) i++
    }
    toks.push(c.slice(start, i))
  }
  return toks
}

const LIST_PSEUDOS = new Set(['is', 'where', 'matches', '-webkit-any'])
const isTypeToken = t => /^(?:[a-zA-Z][\w-]*|\*)$/.test(t)

/** 类型选择器放最前、* 去掉、两个不同的类型互斥（永远匹配不上，返回 null） */
function normalizeCompound(tokens) {
  let type = null
  const rest = []
  for (const t of tokens) {
    if (!isTypeToken(t)) rest.push(t)
    else if (t === '*') continue
    else if (type && type.toLowerCase() !== t.toLowerCase()) return null
    else type = t
  }
  return (type ?? '') + rest.join('') || '*'
}

/**
 * 展开一个复合选择器里的 :is / :where / 列表 :not。
 * 返回若干 { prefix, compound }：prefix 来自 :is(A B) 这种带组合符的参数（A 加上组合符），
 * 只有当这个复合选择器在整条选择器最前面时才用得上。展不开返回 null。
 */
function lowerCompound(c) {
  let combos = [{ prefix: '', tokens: [] }]
  for (const tok of tokenizeCompound(c)) {
    const m = /^:([\w-]+)\(([\s\S]*)\)$/.exec(tok)
    const name = m?.[1].toLowerCase()
    let options
    if (m && LIST_PSEUDOS.has(name)) {
      options = []
      for (const arg of splitList(m[2])) {
        // :is() 本身是「宽容」的：某个参数展不开就当它不存在
        for (const alt of lowerComplex(arg) ?? []) {
          const parts = parseComplex(alt)
          options.push({ prefix: parts.slice(0, -1).join(''), tokens: tokenizeCompound(parts[parts.length - 1]) })
        }
      }
      if (!options.length) return null
    } else if (m && name === 'not') {
      const nots = []
      for (const arg of splitList(m[2])) {
        const lowered = lowerComplex(arg)
        if (!lowered) return null
        for (const alt of lowered) {
          // 老内核的 :not() 只收一个复合选择器
          if (parseComplex(alt).length !== 1) return null
          nots.push(`:not(${alt})`)
        }
      }
      options = [{ prefix: '', tokens: nots }]
    } else {
      options = [{ prefix: '', tokens: [tok] }]
    }
    const next = []
    for (const a of combos) {
      for (const o of options) {
        if (a.prefix && o.prefix) continue
        next.push({ prefix: a.prefix || o.prefix, tokens: [...a.tokens, ...o.tokens] })
      }
    }
    combos = next
    if (combos.length > MAX_EXPANSION) return null
  }
  return combos.flatMap(({ prefix, tokens }) => {
    const compound = normalizeCompound(tokens)
    return compound ? [{ prefix, compound }] : []
  })
}

/** 展开一条（不含逗号的）选择器；展不开返回 null */
export function lowerComplex(sel) {
  const parts = parseComplex(sel)
  let results = ['']
  for (let k = 0; k < parts.length; k++) {
    if (k % 2 === 1) {
      results = results.map(r => r + parts[k])
      continue
    }
    const alts = lowerCompound(parts[k])
    if (!alts) return null
    const next = []
    for (const r of results) {
      for (const a of alts) {
        if (!a.prefix) next.push(r + a.compound)
        // :is(A B) 不在最前面时没法用普通选择器表达（祖先要同时满足两头），这一支丢掉
        else if (k === 0) next.push(a.prefix + a.compound)
      }
    }
    results = next
    if (results.length > MAX_EXPANSION) return null
  }
  return results.length ? results : null
}

/** 整条都包在 :where() 里（特异性为 0） */
function zeroSpecificity(sel) {
  return parseComplex(sel).every((part, k) => k % 2 === 1 || tokenizeCompound(part).every(t => t === '*' || /^:where\(/i.test(t)))
}

/** 展开以后老内核仍然不认识的写法：整条规则会作废，这样的选择器不放进兜底规则 */
const STILL_UNSUPPORTED = /:(?:is|where|matches|has)\(|:focus-visible|:-webkit-any\(/i

/** 选择器列表的老内核版本；不需要（或没法）兜底时返回 null */
export function lowerSelectorList(selector) {
  if (!/:(?:is|where|matches|-webkit-any|not)\(/i.test(selector)) return null
  const out = []
  let changed = false
  for (const sel of splitList(selector)) {
    if (zeroSpecificity(sel)) {
      changed = true
      continue
    }
    const lowered = lowerComplex(sel)
    if (!lowered || lowered.length !== 1 || lowered[0] !== sel) changed = true
    for (const l of lowered ?? []) if (!STILL_UNSUPPORTED.test(l) && !out.includes(l)) out.push(l)
  }
  return changed && out.length ? out.join(',') : null
}

// ---------------------------------------------------------------- 声明

/** 按顶层空白切开值 */
function splitValues(v) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of v.trim()) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (depth === 0 && /\s/.test(ch)) {
      if (cur) out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** 简写展开成「上 右 下 左」 */
function boxSides(value) {
  const v = splitValues(value)
  if (v.length < 1 || v.length > 4) return null
  // 只有一个 var()：里面可能是好几个值，没法拆
  if (v.length === 1 && /^var\(/.test(v[0])) return null
  const [t, r = t, b = t, l = r] = v
  return [t, r, b, l]
}

/** 两个值的简写（inline / block）：[起点, 终点] */
function pairSides(value) {
  const v = splitValues(value)
  if (v.length < 1 || v.length > 2) return null
  if (v.length === 1 && /^var\(/.test(v[0])) return null
  return [v[0], v[1] ?? v[0]]
}

/** 这条声明前面要补的旧写法：[[属性, 值], …] */
function fallbacksFor(decl) {
  const { prop, value } = decl
  const lower = prop.toLowerCase()
  if (lower.startsWith('--')) return []
  const out = []
  if (/\d(?:d|s|l)v[hw]\b/.test(value)) out.push([prop, value.replace(/(\d)(?:d|s|l)v([hw])\b/g, '$1v$2')])
  if (/^overflow(-[xy])?$/.test(lower) && value.trim() === 'clip') out.push([prop, 'hidden'])
  const logical = /^(margin|padding)-(inline|block)$/.exec(lower)
  if (logical) {
    const s = pairSides(value)
    const sides = logical[2] === 'inline' ? ['left', 'right'] : ['top', 'bottom']
    if (s) sides.forEach((side, i) => out.push([`${logical[1]}-${side}`, s[i]]))
  }
  return out
}

/** 前面紧挨着的几条声明里已经有这条旧写法了（比如手写的 height: 100vh; height: 100dvh） */
function alreadyThere(decl, prop, value) {
  for (let node = decl.prev(); node && node.type === 'decl'; node = node.prev()) {
    if (node.prop === prop && node.value === value) return true
  }
  return false
}

// ---------------------------------------------------------------- 插件

export default function legacyCss() {
  return {
    postcssPlugin: 'legacy-css',
    OnceExit(root, { AtRule }) {
      root.walkDecls(decl => {
        if (decl.parent?.type !== 'rule') return
        for (const [prop, value] of fallbacksFor(decl)) {
          if (!alreadyThere(decl, prop, value)) decl.cloneBefore({ prop, value })
        }
        // inset 直接换成四边：两种写法完全等价；只在前面补一份的话，esbuild 压缩时会当成被 inset 盖掉的重复声明删掉
        if (decl.prop.toLowerCase() === 'inset') {
          const sides = boxSides(decl.value)
          if (sides) {
            decl.replaceWith(['top', 'right', 'bottom', 'left'].map((prop, i) => decl.clone({ prop, value: sides[i] })))
            return
          }
        }
        if (decl.prop.toLowerCase() === 'aspect-ratio' && decl.value.trim() !== 'auto') {
          const value = decl.value.replace(/\bauto\b/, '').trim()
          if (!decl.parent.some(n => n.type === 'decl' && n.prop === LEGACY_AR)) decl.cloneAfter({ prop: LEGACY_AR, value })
        }
      })

      const pending = []
      root.walkRules(rule => {
        if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return
        const selector = lowerSelectorList(rule.selector)
        if (selector) pending.push([rule, selector])
      })
      for (const [rule, selector] of pending) {
        const wrapper = new AtRule({ name: 'supports', params: LEGACY_SUPPORTS })
        wrapper.append(rule.clone({ selector }))
        rule.after(wrapper)
      }
    },
  }
}
legacyCss.postcss = true
