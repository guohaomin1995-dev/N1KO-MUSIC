/**
 * 老 WebView（电视盒子的 Android WebView 83）上的两处布局兜底，新内核上什么都不做。
 * 构建时那一半见 postcss/legacy-css.mjs。
 *
 * 1. flex 布局里的 gap：84 才支持（grid 里的 gap 老内核本来就认）。不补的话按钮、图标、标签全挤成一团。
 *    办法：样式表里带 row-gap / column-gap 的规则收集起来，命中的元素如果是 flex，就按方向给子元素补外边距；
 *    会换行的，每项都补左、上间距，容器往左上缩回同样的距离（见 planContainer）。
 *    子元素自己的外边距在上面累加；写成 auto 的那一边不动（靠它推到另一头的照旧）。
 * 2. aspect-ratio：88 才支持。构建插件把比例抄进了 --legacy-ar，这里按宽度算出高度写进行内样式。
 *
 * DOM 一变（增删节点、改 class）就在下一帧之前重排一遍，不会先闪一下挤在一起的样子。
 * 调试：localStorage['msp-legacy-layout'] = 'force' 后刷新，新内核上也走这套（先把原生 gap / 比例关掉再补），
 * 用来对照兜底排出来的样子和原生是否一致。
 */

const LEGACY_AR = '--legacy-ar'
const FORCE_KEY = 'msp-legacy-layout'

type Side = 'margin-left' | 'margin-right' | 'margin-top' | 'margin-bottom'
const SIDES: Side[] = ['margin-left', 'margin-right', 'margin-top', 'margin-bottom']
type Extra = Partial<Record<Side, number>>

export function supportsFlexGap(): boolean {
  const box = document.createElement('div')
  box.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden;pointer-events:none'
  box.appendChild(document.createElement('div'))
  box.appendChild(document.createElement('div'))
  document.body.appendChild(box)
  const ok = box.scrollHeight === 1
  box.remove()
  return ok
}

export function supportsAspectRatio(): boolean {
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('aspect-ratio', '1 / 1')
}

/** 样式表里写了 gap / --legacy-ar 的规则的选择器 */
function collectSelectors(): { gap: string; ratio: string } {
  const gap = new Set<string>(['[style*="gap"]'])
  const ratio = new Set<string>()
  const walk = (rules: CSSRuleList) => {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]
      if (rule.type === 1) {
        const { style, selectorText } = rule as CSSStyleRule
        if (style.getPropertyValue('row-gap') || style.getPropertyValue('column-gap')) gap.add(selectorText)
        if (style.getPropertyValue(LEGACY_AR)) ratio.add(selectorText)
      } else if ('cssRules' in rule) {
        try {
          walk((rule as CSSGroupingRule).cssRules)
        } catch {
          // 读不了的（跨域）跳过
        }
      }
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules)
    } catch {
      // 同上
    }
  }
  return { gap: [...gap].join(','), ratio: [...ratio].join(',') }
}

function queryAll(selector: string): HTMLElement[] {
  if (!selector) return []
  try {
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
  } catch {
    return []
  }
}

type TypedStyle = { get(p: string): { value?: unknown; toString(): string } | null | undefined }
const typedStyle = (el: HTMLElement): TypedStyle | undefined =>
  (el as HTMLElement & { computedStyleMap?: () => TypedStyle }).computedStyleMap?.()

/** 第一次动某一边之前它原来的外边距（px，或 auto） */
function originalMargin(el: HTMLElement, side: Side): number | 'auto' {
  if (typedStyle(el)?.get(side)?.value === 'auto') return 'auto'
  return parseFloat(getComputedStyle(el).getPropertyValue(side)) || 0
}

/** 第一次动宽度之前写的宽度（auto 返回 null；读不到也当 auto） */
function originalWidth(el: HTMLElement): string | null {
  const width = typedStyle(el)?.get('width')?.toString()
  // fit-content 之类的关键字没法再加一截，和 auto 一样只靠负外边距
  return width && /^(?:-?[\d.]+[a-z%]+|calc\()/.test(width) ? width : null
}

/** 这一遍要给某个元素加的东西：几条边的外边距（px，累加），以及要不要把宽度加宽 */
interface Want extends Extra {
  widen?: number
}

interface Touched {
  base: Partial<Record<Side, number | 'auto'>>
  set: Partial<Record<Side, number>>
  baseWidth?: string | null
  width?: string
}

export function installLegacyLayout(): void {
  if (typeof document === 'undefined' || !document.body || typeof getComputedStyle !== 'function') return
  let force = false
  try {
    force = localStorage.getItem(FORCE_KEY) === 'force'
  } catch {
    // 隐私模式等读不了就当没开
  }
  const fixGap = force || !supportsFlexGap()
  const fixRatio = force || !supportsAspectRatio()
  if (!fixGap && !fixRatio) return
  document.documentElement.setAttribute('data-legacy-layout', force ? 'force' : '')

  let selectors = collectSelectors()
  let sheetCount = document.styleSheets.length
  const touched = new Map<HTMLElement, Touched>()
  const ratioOf = new Map<HTMLElement, number>()

  const apply = (el: HTMLElement, want: Want) => {
    let t = touched.get(el)
    if (!t) {
      if (!SIDES.some(side => want[side]) && !want.widen) return
      touched.set(el, (t = { base: {}, set: {} }))
    }
    for (const side of SIDES) {
      const add = want[side] ?? 0
      if (!add) {
        if (t.set[side] !== undefined) {
          el.style.removeProperty(side)
          delete t.set[side]
        }
        delete t.base[side]
        continue
      }
      if (t.base[side] === undefined) t.base[side] = originalMargin(el, side)
      const base = t.base[side]
      if (base === 'auto' || base === undefined) continue
      const value = Math.round((base + add) * 100) / 100
      if (t.set[side] !== value) {
        el.style.setProperty(side, `${value}px`)
        t.set[side] = value
      }
    }
    if (!want.widen) {
      if (t.width !== undefined) el.style.removeProperty('width')
      t.width = undefined
      t.baseWidth = undefined
    } else {
      if (t.baseWidth === undefined) t.baseWidth = originalWidth(el)
      // 宽度是 auto 的，负的外边距自己就把它撑宽了
      const width = t.baseWidth === null ? undefined : `calc(${t.baseWidth} + ${want.widen}px)`
      if (width !== t.width) {
        if (width) el.style.setProperty('width', width)
        else el.style.removeProperty('width')
        t.width = width
      }
    }
  }

  /** 读这个容器的 gap；force 模式下先读样式表给的值，再把原生 gap 关掉 */
  const readGap = (el: HTMLElement): [number, number] => {
    if (force) {
      el.style.removeProperty('row-gap')
      el.style.removeProperty('column-gap')
    }
    const cs = getComputedStyle(el)
    const gaps: [number, number] = [parseFloat(cs.rowGap) || 0, parseFloat(cs.columnGap) || 0]
    if (force) {
      el.style.setProperty('row-gap', '0px')
      el.style.setProperty('column-gap', '0px')
    }
    return gaps
  }

  /** 一个写了 gap 的容器：是 flex 的话，把要补的外边距记进 wants（同一个元素可能既是子项又是容器，累加） */
  const planContainer = (el: HTMLElement, wants: Map<HTMLElement, Want>) => {
    const cs = getComputedStyle(el)
    if (cs.display !== 'flex' && cs.display !== 'inline-flex') return
    const [row, col] = readGap(el)
    if (!row && !col) return
    const add = (k: HTMLElement, key: keyof Want, v: number) => {
      const w = wants.get(k) ?? {}
      w[key] = (w[key] ?? 0) + v
      wants.set(k, w)
    }
    // flex 项：可见、不脱离文档流的子元素，加上直接写在容器里的文字（连着的几段文字算一项，比如按钮里「图标 + 文字」）
    const items: (HTMLElement | null)[] = []
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent?.trim() && items[items.length - 1] !== null) items.push(null)
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const s = getComputedStyle(node as Element)
        if (s.display !== 'none' && s.position !== 'absolute' && s.position !== 'fixed') items.push(node as HTMLElement)
      }
    }
    if (items.length < 2) return
    const vertical = cs.flexDirection.startsWith('column')
    const reverse = cs.flexDirection.endsWith('reverse')
    const main: Side = vertical ? (reverse ? 'margin-bottom' : 'margin-top') : reverse ? 'margin-right' : 'margin-left'
    const back: Side = vertical ? (reverse ? 'margin-top' : 'margin-bottom') : reverse ? 'margin-left' : 'margin-right'
    const mainGap = vertical ? row : col
    if (!vertical && cs.flexWrap !== 'nowrap') {
      /*
       * 会换行的一排：每一项都补左边和上边的间距，容器自己往左上缩回同样的距离（宽度不是 auto 的再加宽这么多）。
       * 和原生 gap 完全等价——行首那一项多出来的左间距正好落在容器缩回去的那一截里，第一行的上间距同理，
       * 换行位置、居中、两端对齐都和原生一样，不用去量哪一项折到了下一行
       */
      const cross: Side = cs.flexWrap === 'wrap-reverse' ? 'margin-bottom' : 'margin-top'
      for (const k of items) {
        if (!k) continue
        if (mainGap) add(k, main, mainGap)
        if (row) add(k, cross, row)
      }
      if (mainGap) {
        add(el, main, -mainGap)
        add(el, 'widen', mainGap)
      }
      if (row) add(el, cross, -row)
      return
    }
    // 一行（一列）：间距记在后一项的前侧；后一项是文字（加不了外边距）就记在前一项的后侧
    if (!mainGap) return
    items.forEach((k, i) => {
      if (i === 0) return
      const prev = items[i - 1]
      if (k) add(k, main, mainGap)
      else if (prev) add(prev, back, mainGap)
    })
  }

  const sizeByRatio = (el: HTMLElement) => {
    const ratio = ratioOf.get(el)
    if (!ratio) return
    const height = `${Math.round((el.offsetWidth / ratio) * 100) / 100}px`
    if (el.style.height !== height) el.style.setProperty('height', height)
  }

  const ro =
    fixRatio && typeof ResizeObserver === 'function'
      ? new ResizeObserver(entries => {
          for (const entry of entries) sizeByRatio(entry.target as HTMLElement)
        })
      : null

  const run = () => {
    if (document.styleSheets.length !== sheetCount) {
      sheetCount = document.styleSheets.length
      selectors = collectSelectors()
    }
    if (fixGap) {
      // 先全部量完、再统一写：读写交替会让浏览器每个容器重算一次样式
      const wants = new Map<HTMLElement, Want>()
      for (const el of queryAll(selectors.gap)) planContainer(el, wants)
      for (const [el, want] of wants) apply(el, want)
      for (const el of Array.from(touched.keys())) {
        if (!el.isConnected) touched.delete(el)
        else if (!wants.has(el)) {
          apply(el, {})
          touched.delete(el)
        }
      }
    }
    if (ro) {
      for (const el of Array.from(ratioOf.keys())) {
        if (!el.isConnected) {
          ro.unobserve(el)
          ratioOf.delete(el)
        }
      }
      for (const el of queryAll(selectors.ratio)) {
        if (ratioOf.has(el)) continue
        const [a, b = '1'] = getComputedStyle(el).getPropertyValue(LEGACY_AR).split('/')
        const ratio = parseFloat(a) / parseFloat(b)
        if (!(ratio > 0)) continue
        if (force) el.style.setProperty('aspect-ratio', 'auto')
        ratioOf.set(el, ratio)
        ro.observe(el)
        sizeByRatio(el)
      }
    }
  }

  let queued = false
  const fire = () => {
    if (!queued) return
    queued = false
    run()
  }
  // 正常在下一帧之前排；页面在后台、不出帧时 requestAnimationFrame 不回调，定时器保底
  const schedule = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(fire)
    setTimeout(fire, 120)
  }

  run()
  // 自己写的是 style，不在监听范围里，不会自己触发自己
  new MutationObserver(schedule).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'hidden'],
  })
  new MutationObserver(schedule).observe(document.head, { childList: true })
  window.addEventListener('resize', schedule)
  document.fonts?.ready.then(schedule).catch(() => {})
}
