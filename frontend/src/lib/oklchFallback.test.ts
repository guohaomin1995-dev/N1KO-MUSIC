// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { channelsToRgb, evalChannel, updateOklchFallback } from './oklchFallback'
import { oklchToRgb } from './oklch'

const rgb = (L: number, C: number, H: number) => oklchToRgb(L, C, H).map(v => Math.round(v * 255)).join(' ')

describe('oklch 兜底的运行时', () => {
  it('通道表达式：百分比、min/max/clamp/calc、四则', () => {
    expect(evalChannel('92%', 1)).toBeCloseTo(0.92)
    expect(evalChannel('50%', 0.4)).toBeCloseTo(0.2)
    expect(evalChannel('min(0.12, 0.1)', 0.4)).toBeCloseTo(0.1)
    expect(evalChannel('max(0.02,0.1)', 0.4)).toBeCloseTo(0.1)
    expect(evalChannel('clamp(0.05, 0.3, 0.2)', 0.4)).toBeCloseTo(0.2)
    expect(evalChannel('calc(120 + 7 * 2)', 1)).toBe(134)
    expect(evalChannel('calc((1 - 0.25) / 3)', 1)).toBeCloseTo(0.25)
    expect(evalChannel('', 1)).toBeNull()
    expect(evalChannel('var(--x)', 1)).toBeNull()
    expect(evalChannel('0.1 0.2', 1)).toBeNull()
  })

  it('「L C H」→ r g b，和 oklchToRgb 一致；算不出来回 null', () => {
    expect(channelsToRgb(' 92% min(0.12, 0.1) 127')).toBe(rgb(0.92, 0.1, 127))
    expect(channelsToRgb('30% min(0.3, 0.1) 18deg')).toBe(rgb(0.3, 0.1, 18))
    expect(channelsToRgb('97% 0.006 none')).toBe(rgb(0.97, 0.006, 0))
    expect(channelsToRgb('92% 0.1')).toBeNull()
    expect(channelsToRgb('92% var(--x) 127')).toBeNull()
  })

  it('读得到 --oklch-fb-n 才干活：把每个表达式算好写到 <html> 上', () => {
    const root = document.createElement('div')
    document.body.append(root)
    expect(updateOklchFallback(root)).toBe(false)
    root.style.setProperty('--oklch-fb-n', '2')
    root.style.setProperty('--oklch-fb-0-src', '92% min(0.12, 0.1) 127')
    root.style.setProperty('--oklch-fb-1-src', '21% 0.03 40')
    expect(updateOklchFallback(root)).toBe(true)
    expect(root.style.getPropertyValue('--oklch-fb-0')).toBe(rgb(0.92, 0.1, 127))
    expect(root.style.getPropertyValue('--oklch-fb-1')).toBe(rgb(0.21, 0.03, 40))
  })
})
