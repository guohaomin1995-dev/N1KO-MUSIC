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
 * DOM 一变（增删节点、改 class）就在下一帧之前把动过的那一块重排一遍（不是整页，见 run 上面的说明），
 * 不会先闪一下挤在一起的样子。
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
  const touched = new WeakMap<HTMLElement, Touched>()
  const ratioOf = new Map<HTMLElement, number>()

  /** 父容器给它补的间距 / 它自己作为换行容器要往回缩的那一截；一个元素最后写上去的是两者之和 */
  const fromParent = new WeakMap<HTMLElement, Want>()
  const fromSelf = new WeakMap<HTMLElement, Want>()
  /** 这份间距是哪个容器给的（元素换了父容器时，旧容器别把新容器给的清掉） */
  const giver = new WeakMap<HTMLElement, HTMLElement>()
  /** 上一遍给出过间距的容器 → 给了哪些子元素。强引用，容器被卸载后要清（见 run） */
  const planned = new Map<HTMLElement, HTMLElement[]>()

  /** 读：第一次动某一边 / 宽度之前记下原值。必须排在这一遍所有写入之前，不然读一次浏览器就重算一次样式 */
  const prepare = (el: HTMLElement, want: Want) => {
    let t = touched.get(el)
    if (!t) {
      if (!SIDES.some(side => want[side]) && !want.widen) return
      touched.set(el, (t = { base: {}, set: {} }))
    }
    for (const side of SIDES) {
      if (want[side] && t.base[side] === undefined) t.base[side] = originalMargin(el, side)
    }
    if (want.widen && t.baseWidth === undefined) t.baseWidth = originalWidth(el)
  }

  /** 写：把外边距 / 宽度落到行内样式上；不再需要的收回 */
  const write = (el: HTMLElement, want: Want) => {
    const t = touched.get(el)
    if (!t) return
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
      // 宽度是 auto 的，负的外边距自己就把它撑宽了
      const width = t.baseWidth ? `calc(${t.baseWidth} + ${want.widen}px)` : undefined
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

  /** 一个写了 gap 的容器：是 flex 的话，算出要给每个子项补什么、它自己要不要往回缩。只读不写 */
  const planContainer = (el: HTMLElement): { items: Map<HTMLElement, Want>; self: Want | null } | null => {
    const cs = getComputedStyle(el)
    if (cs.display !== 'flex' && cs.display !== 'inline-flex') return null
    const [row, col] = readGap(el)
    if (!row && !col) return null
    const out = new Map<HTMLElement, Want>()
    let self: Want | null = null
    const add = (k: HTMLElement, key: keyof Want, v: number) => {
      const w = out.get(k) ?? {}
      w[key] = (w[key] ?? 0) + v
      out.set(k, w)
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
    if (items.length < 2) return null
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
      self = {}
      if (mainGap) {
        self[main] = -mainGap
        self.widen = mainGap
      }
      if (row) self[cross] = (self[cross] ?? 0) - row
      return { items: out, self }
    }
    // 一行（一列）：间距记在后一项的前侧；后一项是文字（加不了外边距）就记在前一项的后侧
    if (!mainGap) return null
    items.forEach((k, i) => {
      if (i === 0) return
      const prev = items[i - 1]
      if (k) add(k, main, mainGap)
      else if (prev) add(prev, back, mainGap)
    })
    return { items: out, self }
  }

  /** 把这些容器重排一遍：先收回它们上一遍给出去的，再量、最后统一写（读写不交替） */
  const replan = (containers: Iterable<HTMLElement>) => {
    const list = Array.from(containers)
    if (!list.length) return
    const affected = new Set<HTMLElement>()
    for (const c of list) {
      const prev = planned.get(c)
      if (prev) {
        for (const k of prev) {
          if (giver.get(k) === c) {
            fromParent.delete(k)
            giver.delete(k)
          }
          affected.add(k)
        }
        planned.delete(c)
      }
      if (fromSelf.has(c)) {
        fromSelf.delete(c)
        affected.add(c)
      }
    }
    for (const c of list) {
      if (!c.isConnected) continue
      const plan = planContainer(c)
      if (!plan) continue
      const kids: HTMLElement[] = []
      for (const [k, want] of plan.items) {
        fromParent.set(k, want)
        giver.set(k, c)
        kids.push(k)
        affected.add(k)
      }
      if (plan.self) {
        fromSelf.set(c, plan.self)
        affected.add(c)
      }
      planned.set(c, kids)
    }
    const totals: [HTMLElement, Want][] = []
    for (const el of affected) {
      if (!el.isConnected) continue
      const a = fromParent.get(el)
      const b = fromSelf.get(el)
      const want: Want = { ...a }
      if (b) for (const key of Object.keys(b) as (keyof Want)[]) want[key] = (want[key] ?? 0) + (b[key] ?? 0)
      prepare(el, want)
      totals.push([el, want])
    }
    for (const [el, want] of totals) write(el, want)
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

  const watchRatio = (el: HTMLElement) => {
    if (!ro || ratioOf.has(el)) return
    const [a, b = '1'] = getComputedStyle(el).getPropertyValue(LEGACY_AR).split('/')
    const ratio = parseFloat(a) / parseFloat(b)
    if (!(ratio > 0)) return
    if (force) el.style.setProperty('aspect-ratio', 'auto')
    ratioOf.set(el, ratio)
    ro.observe(el)
    sizeByRatio(el)
  }

  const matches = (el: HTMLElement, selector: string): boolean => {
    if (!selector) return false
    try {
      return el.matches(selector)
    } catch {
      return false
    }
  }
  const within = (root: ParentNode, selector: string): HTMLElement[] => {
    if (!selector) return []
    try {
      return Array.from(root.querySelectorAll<HTMLElement>(selector))
    } catch {
      return []
    }
  }

  /*
   * 只重排动过的地方。整页重排一遍要给几百个元素各读一次样式，电视盒子上一遍就是一百多毫秒——
   * 而页面上每加载出一张封面（图片换 class 淡入）都算一次变动，换页时一连几十遍，遥控器就跟不上手了。
   *   dirty    子节点变了的元素、换了 class 的元素和它的父元素：它们自己（作为容器）要重排
   *   subtrees 新加进来的、换了 class 的元素：里面的容器也要看一遍
   *   full     第一次、窗口尺寸变了、样式表多了：整页来一遍
   */
  let full = true
  let removedSome = false
  const dirty = new Set<HTMLElement>()
  const subtrees = new Set<HTMLElement>()

  const run = () => {
    if (document.styleSheets.length !== sheetCount) {
      sheetCount = document.styleSheets.length
      selectors = collectSelectors()
      full = true
    }
    if (removedSome || full) {
      for (const c of Array.from(planned.keys())) if (!c.isConnected) planned.delete(c)
      if (ro) {
        for (const el of Array.from(ratioOf.keys())) {
          if (!el.isConnected) {
            ro.unobserve(el)
            ratioOf.delete(el)
          }
        }
      }
    }
    const containers = new Set<HTMLElement>()
    const ratios: HTMLElement[] = []
    if (full) {
      if (fixGap) {
        for (const el of within(document, selectors.gap)) containers.add(el)
        for (const el of planned.keys()) containers.add(el)
      }
      ratios.push(...within(document, selectors.ratio))
    } else {
      const consider = (el: HTMLElement) => {
        if (!el.isConnected) return
        if (fixGap && (planned.has(el) || matches(el, selectors.gap))) containers.add(el)
      }
      dirty.forEach(consider)
      // 祖先也在这一批里的，祖先那一遍已经把它里面的都找过了
      const covered = (el: HTMLElement): boolean => {
        for (let p = el.parentElement; p; p = p.parentElement) if (subtrees.has(p)) return true
        return false
      }
      for (const root of subtrees) {
        if (!root.isConnected) continue
        consider(root)
        if (matches(root, selectors.ratio)) ratios.push(root)
        if (!root.firstElementChild || covered(root)) continue
        if (fixGap) for (const el of within(root, selectors.gap)) containers.add(el)
        ratios.push(...within(root, selectors.ratio))
      }
    }
    full = false
    removedSome = false
    dirty.clear()
    subtrees.clear()
    replan(containers)
    for (const el of ratios) watchRatio(el)
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
  const scheduleFull = () => {
    full = true
    schedule()
  }

  run()
  // 自己写的是 style，不在监听范围里，不会自己触发自己
  new MutationObserver(records => {
    // 一下子变了太多（整页换掉）：逐条记不如整页来一遍
    if (records.length > 400) full = true
    for (const record of records) {
      if (full) break
      const target = record.target as HTMLElement
      if (target.nodeType !== Node.ELEMENT_NODE) continue
      if (record.type === 'childList') {
        dirty.add(target)
        record.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) subtrees.add(node as HTMLElement)
        })
        if (record.removedNodes.length) removedSome = true
      } else {
        dirty.add(target)
        if (target.parentElement) dirty.add(target.parentElement)
        subtrees.add(target)
      }
    }
    schedule()
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'hidden'],
  })
  new MutationObserver(scheduleFull).observe(document.head, { childList: true })
  window.addEventListener('resize', scheduleFull)
  document.fonts?.ready.then(scheduleFull).catch(() => {})
}
