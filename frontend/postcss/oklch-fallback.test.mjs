/**
 * oklch 兜底插件：小例子逐条核对，再拿真的 index.css（过一遍 Tailwind）整体核对——
 * 每条用到 oklch() 的规则后面都紧跟一份 rgb 版，里面引用的每个 --x-rgb 都有定义。
 */
import { describe, expect, it } from 'vitest'
import postcss from 'postcss'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import oklchFallback, { oklchToRgb255, SUPPORTS_PARAMS } from './oklch-fallback.mjs'
import config from '../postcss.config.js'
import { LEGACY_SUPPORTS } from './legacy-css.mjs'
import { oklchToRgb } from '../src/lib/oklch'

const run = async css => (await postcss([oklchFallback()]).process(css, { from: undefined })).root

describe('oklch 兜底插件', () => {
  it('换算和 src/lib/oklch.ts 一致', () => {
    for (const [L, C, H] of [[0.984, 0.004, 255], [0.895, 0.2, 127], [0.19, 0.016, 262], [0.53, 0.2, 18]]) {
      expect(oklchToRgb255(L, C, H)).toEqual(oklchToRgb(L, C, H).map(v => Math.round(v * 255)))
    }
  })

  it('通道 token 旁边补 --x-rgb：写死的直接算好、别名指向别名的 -rgb、跟着变的交给运行时', async () => {
    const root = await run(`
      :root { --ink: 19% 0.016 262; --fg: var(--ink); --wash: var(--wash-l) min(var(--art-c), 0.1) var(--art-h); --wash-l: 92%; }
      .a { color: oklch(var(--fg)); background: oklch(var(--wash) / 0.4); }
    `)
    const decls = {}
    root.first.walkDecls(d => { decls[d.prop] = d.value })
    expect(decls['--ink-rgb']).toBe(oklchToRgb255(0.19, 0.016, 262).join(' '))
    expect(decls['--fg-rgb']).toBe('var(--ink-rgb)')
    expect(decls['--wash-rgb']).toBe('var(--oklch-fb-0)')
    // 不是通道 token 的不动
    expect(decls['--wash-l-rgb']).toBeUndefined()
    const registry = root.last
    expect(registry.params).toBe(SUPPORTS_PARAMS)
    expect(registry.first.selector).toBe(':root')
    expect(registry.first.nodes.map(d => `${d.prop}: ${d.value}`)).toEqual([
      '--oklch-fb-n: 1',
      '--oklch-fb-0-src: var(--wash-l) min(var(--art-c), 0.1) var(--art-h)',
    ])
  })

  it('用到 oklch() 的规则紧跟一份完整的 rgb 版（同一条里后写的照样覆盖先写的），在 @media 里也一样', async () => {
    const root = await run(`
      :root { --x: 50% 0.1 200; }
      @media (min-width: 600px) { .b { background: oklch(var(--x) / var(--tw-bg-opacity, 1)); background-color: transparent; } }
      .c { color: red; }
    `)
    const media = root.nodes[1]
    expect(media.nodes.map(n => n.type === 'atrule' ? `@${n.name}` : n.selector)).toEqual(['.b', '@supports'])
    const copy = media.nodes[1]
    expect(copy.params).toBe(SUPPORTS_PARAMS)
    expect(copy.first.nodes.map(d => `${d.prop}: ${d.value}`)).toEqual([
      'background: rgb(var(--x-rgb) / var(--tw-bg-opacity, 1))',
      'background-color: transparent',
    ])
    // 原规则不动
    expect(media.first.first.value).toBe('oklch(var(--x) / var(--tw-bg-opacity, 1))')
    expect(root.nodes[2].selector).toBe('.c')
  })

  it('写死的 oklch() 字面量直接换成 rgb，带 var() 的交给运行时；var() 的后备值里的也换', async () => {
    const root = await run(`
      .d { box-shadow: 0 1px 2px oklch(22% 0.02 262 / 0.06); background: oklch(17% 0.03 var(--art-h)); color: var(--chip, oklch(50% 0 0)); }
    `)
    const copy = root.nodes[1].first
    expect(copy.nodes.map(d => d.value)).toEqual([
      `0 1px 2px rgb(${oklchToRgb255(0.22, 0.02, 262).join(' ')} / 0.06)`,
      'rgb(var(--oklch-fb-0))',
      `var(--chip, rgb(${oklchToRgb255(0.5, 0, 0).join(' ')}))`,
    ])
  })

  it('@keyframes 里的：整个 @keyframes 复制一份（后出现的同名动画生效）', async () => {
    const root = await run(`@keyframes glow { from { color: oklch(var(--x)); } to { color: oklch(var(--x) / 0); } } :root { --x: 50% 0.1 200; }`)
    expect(root.nodes[1].type).toBe('atrule')
    expect(root.nodes[1].params).toBe(SUPPORTS_PARAMS)
    expect(root.nodes[1].first.name).toBe('keyframes')
    expect(root.nodes[1].first.last.first.value).toBe('rgb(var(--x-rgb) / 0)')
  })

  it('被当成通道用、值却不是三段的：构建直接报错，不悄悄出错色', async () => {
    await expect(run(':root { --bad: #fff; } .e { color: oklch(var(--bad)); }')).rejects.toThrow(/--bad/)
  })

  it('真实的 index.css：每条 oklch 规则都有 rgb 版，引用到的 --x-rgb 全都有定义', async () => {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const file = path.join(dir, '../src/index.css')
    const { root } = await postcss(config.plugins).process(fs.readFileSync(file, 'utf8'), { from: file })

    const inFallback = node => {
      for (let p = node.parent; p; p = p.parent) if (p.type === 'atrule' && p.params === SUPPORTS_PARAMS) return true
      return false
    }
    const defined = new Set()
    const referenced = new Set()
    let checked = 0
    root.walkDecls(decl => {
      if (decl.prop.startsWith('--')) defined.add(decl.prop)
      for (const m of decl.value.matchAll(/var\((--[\w-]+-rgb)\)/g)) referenced.add(m[1])
      if (!decl.value.includes('oklch(') || inFallback(decl)) return
      // 老内核选择器兜底里的副本：它的 rgb 版在原规则的 rgb 版后面（legacy-css 同样处理过那份）
      if (decl.parent.parent?.type === 'atrule' && decl.parent.parent.params === LEGACY_SUPPORTS) return
      const owner = decl.parent.parent?.type === 'atrule' && /keyframes$/.test(decl.parent.parent.name) ? decl.parent.parent : decl.parent
      // 老内核选择器兜底（legacy-css）也紧跟在原规则后面，跳过它再找
      let next = owner.next()
      while (next?.type === 'atrule' && next.params === LEGACY_SUPPORTS) next = next.next()
      expect(next?.type === 'atrule' && next.params === SUPPORTS_PARAMS, `${decl.parent.selector} { ${decl.prop} } 后面没有 rgb 版`).toBe(true)
      checked++
    })
    root.walkAtRules('supports', at => {
      if (at.params !== SUPPORTS_PARAMS) return
      at.walkDecls(d => {
        if (d.prop.startsWith('--oklch-fb')) return
        expect(d.value.includes('oklch('), `${d.prop}: ${d.value}`).toBe(false)
      })
    })
    expect(checked).toBeGreaterThan(150)
    for (const name of referenced) expect(defined.has(name), `${name} 没有定义`).toBe(true)
    // 运行时要算的表达式都登记了
    const n = Number(root.last.first.nodes.find(d => d.prop === '--oklch-fb-n').value)
    expect(n).toBeGreaterThan(0)
  }, 60_000)
})
