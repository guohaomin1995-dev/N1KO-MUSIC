/**
 * 老内核兜底插件：选择器展开逐条核对，再拿真的 index.css（走完整个 postcss 配置）整体核对——
 * 兜底规则里不能再出现老内核不认识的选择器，否则整条作废。
 */
import { describe, expect, it } from 'vitest'
import postcss from 'postcss'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import legacyCss, { LEGACY_AR, LEGACY_SUPPORTS, lowerComplex, lowerSelectorList, splitList } from './legacy-css.mjs'
import config from '../postcss.config.js'

const run = async css => (await postcss([legacyCss()]).process(css, { from: undefined })).root

describe('选择器展开', () => {
  it('切列表不切括号、属性值和转义里的逗号', () => {
    expect(splitList(`a, :is(b, c), [x='1,2'], .w-\\[1\\,2\\]`)).toEqual(['a', ':is(b, c)', "[x='1,2']", '.w-\\[1\\,2\\]'])
  })

  it(':is() 展开成笛卡尔积，类型选择器挪到复合选择器最前面', () => {
    expect(lowerComplex('html[data-tv] :is(button, a[href]):focus')).toEqual([
      'html[data-tv] button:focus',
      'html[data-tv] a[href]:focus',
    ])
    expect(lowerComplex('.x:is(button)')).toEqual(['button.x'])
    expect(lowerComplex(':is(.a, .b) > :is(.c, .d)')).toEqual(['.a > .c', '.a > .d', '.b > .c', '.b > .d'])
  })

  it('两个不同的类型选择器互斥，那一支丢掉', () => {
    expect(lowerComplex('a:is(button, .x)')).toEqual(['a.x'])
  })

  it('列表 :not(a, b) 拆成 :not(a):not(b)；单个的原样', () => {
    expect(lowerComplex(".r:not([data-a], .b, [c='1'])")).toEqual([".r:not([data-a]):not(.b):not([c='1'])"])
    expect(lowerComplex('.r:not(.b)')).toEqual(['.r:not(.b)'])
  })

  it(':not() 里有组合符，老内核表达不了', () => {
    expect(lowerComplex('.r:not(.a .b)')).toBeNull()
  })

  it('Tailwind 暗色变体 :is(.dark *)：转义的冒号不当伪类，祖先挪到前面', () => {
    expect(lowerComplex('.dark\\:bg-ink:is(.dark *)')).toEqual(['.dark .dark\\:bg-ink'])
  })

  it(':is(A B) 不在最前面时没法表达，那一支丢掉', () => {
    expect(lowerComplex('.p .x:is(.dark *)')).toBeNull()
  })

  it('十六进制转义后面的空格不是组合符', () => {
    expect(lowerComplex('.\\32xl\\:p-4:is(.a)')).toEqual(['.\\32xl\\:p-4.a'])
    expect(lowerComplex('.\\31 0 :is(.a)')).toEqual(['.\\31 0 .a'])
  })

  it('整条包在 :where() 里（特异性 0）的不展开；不需要展开的返回 null', () => {
    expect(lowerSelectorList(':where(html[data-tv]) :where(button, a)')).toBeNull()
    expect(lowerSelectorList('button, input:where([type=button])')).toBe('button,input[type=button]')
    expect(lowerSelectorList('.a:not(.b), .c')).toBeNull()
    expect(lowerSelectorList('.a:hover')).toBeNull()
  })

  it('列表里不需要展开的选择器也要带上（原规则在老内核上整条作废了）；展开后仍不认识的丢掉', () => {
    expect(lowerSelectorList('.a, :is(.b, .c), .d:has(.e), .f:focus-visible')).toBe('.a,.b,.c')
  })

  it('列表里混着 :focus-visible / :has()：留下老内核认识的那一半；整条都不认识的不出兜底', () => {
    expect(lowerSelectorList('html[data-tv] :focus, html[data-tv] :focus-visible')).toBe('html[data-tv] :focus')
    expect(lowerSelectorList('.a, .b:has(.c)')).toBe('.a')
    expect(lowerSelectorList('.play-key:focus-visible')).toBeNull()
    expect(lowerSelectorList(':focus-visible, .x:has(.y)')).toBeNull()
  })
})

describe('插件', () => {
  it('展开的规则整条复制、紧跟原规则，包在老内核才进得去的 @supports 里', async () => {
    const root = await run(`.x:is(.a, .b) { color: red; scale: 1.1 } .y { color: blue }`)
    const nodes = root.nodes
    expect(nodes.map(n => n.type)).toEqual(['rule', 'atrule', 'rule'])
    expect(nodes[1].params).toBe(LEGACY_SUPPORTS)
    expect(nodes[1].first.selector).toBe('.x.a,.x.b')
    expect(nodes[1].first.toString()).toContain('scale: 1.1')
  })

  it('dvh 前面补 vh；已经手写了的不重复', async () => {
    const root = await run(`.a { max-height: 88dvh } .b { height: 100vh; height: 100dvh } .c { width: min(86vw, calc((100svh - 160px) * 1.07)) }`)
    expect(root.nodes[0].toString()).toMatch(/max-height: 88vh;\s*max-height: 88dvh/)
    expect(root.nodes[1].nodes.map(d => d.value)).toEqual(['100vh', '100dvh'])
    expect(root.nodes[2].nodes[0].value).toBe('min(86vw, calc((100vh - 160px) * 1.07))')
  })

  it('overflow: clip 前面补 hidden；逻辑简写补物理写法；inset 换成四边', async () => {
    const root = await run(`.a { overflow: clip } .b { margin-inline: -10px; padding-inline: 4px 8px } .c { inset: 0 auto 0 0 } .d { inset: var(--i) }`)
    expect(root.nodes[0].nodes.map(d => `${d.prop}:${d.value}`)).toEqual(['overflow:hidden', 'overflow:clip'])
    expect(root.nodes[1].nodes.map(d => `${d.prop}:${d.value}`)).toEqual([
      'margin-left:-10px', 'margin-right:-10px', 'margin-inline:-10px',
      'padding-left:4px', 'padding-right:8px', 'padding-inline:4px 8px',
    ])
    expect(root.nodes[2].nodes.map(d => `${d.prop}:${d.value}`)).toEqual(['top:0', 'right:auto', 'bottom:0', 'left:0'])
    expect(root.nodes[3].nodes.map(d => d.prop)).toEqual(['inset'])
  })

  it('aspect-ratio 抄一份给运行时', async () => {
    const root = await run(`.a { aspect-ratio: 1 / 1 } .b { aspect-ratio: auto 1.6 }`)
    expect(root.nodes[0].nodes.map(d => `${d.prop}:${d.value}`)).toEqual(['aspect-ratio:1 / 1', `${LEGACY_AR}:1 / 1`])
    expect(root.nodes[1].nodes[1].value).toBe('1.6')
  })

  it('真的 index.css：兜底规则里没有老内核不认识的选择器，电视焦点样式和 preflight 都有兜底', async () => {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const from = path.join(dir, '../src/index.css')
    const cwd = process.cwd()
    process.chdir(path.join(dir, '..'))
    let out
    try {
      out = await postcss(config.plugins).process(fs.readFileSync(from, 'utf8'), { from })
    } finally {
      process.chdir(cwd)
    }
    const legacy = []
    out.root.walkAtRules('supports', at => {
      if (at.params === LEGACY_SUPPORTS) at.walkRules(r => legacy.push(r.selector))
    })
    expect(legacy.length).toBeGreaterThan(10)
    for (const sel of legacy) expect(sel).not.toMatch(/:(?:is|where|has)\(|:focus-visible/)
    expect(legacy.some(s => /input\[type=['"]?button/.test(s))).toBe(true)
    expect(legacy.some(s => s.startsWith('html[data-tv] button:focus:not('))).toBe(true)
    // 电视上去掉系统焦点框的那条（原规则和 :focus-visible 写在一起，老内核上整条作废）
    expect(legacy).toContain('html[data-tv] :focus')
    out.root.walkDecls(d => {
      if (!d.prop.startsWith('--') && /\d(?:d|s|l)vh\b/.test(d.value)) expect(d.prev()?.value).toBe(d.value.replace(/(\d)(?:d|s|l)vh\b/g, '$1vh'))
    })
  })
})
