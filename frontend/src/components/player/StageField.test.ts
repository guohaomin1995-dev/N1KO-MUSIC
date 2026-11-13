/**
 * 舞台光场交给着色器的数必须经得起半精度浮点（电视盒子的显卡）：
 * 相位收在 0–2π 里、灯的位置就在画面附近，不随播放时间越变越大。
 */
import { describe, expect, it } from 'vitest'
import { lightField } from './StageField'

describe('lightField', () => {
  it('开了很久以后，相位仍在 0–2π 里、灯仍在画面附近', () => {
    for (const t of [0, 1, 59.5, 600, 3600, 86400, 1e6]) {
      const { p0, p1, warp } = lightField(t, 16 / 9)
      for (const w of warp) {
        expect(w).toBeGreaterThanOrEqual(0)
        expect(w).toBeLessThan(Math.PI * 2)
      }
      for (const v of [...p0, ...p1]) expect(Math.abs(v)).toBeLessThan(2)
    }
  })

  it('和原来写在着色器里的式子一致', () => {
    const t = 123.4
    const aspect = 1.6
    const { p0, p1, warp } = lightField(t, aspect)
    expect(p0[0]).toBeCloseTo(aspect * (0.22 + 0.10 * Math.sin(t * 0.21)), 10)
    expect(p0[3]).toBeCloseTo(0.72 + 0.10 * Math.sin(t * 0.23), 10)
    expect(p1[2]).toBeCloseTo(aspect * (0.76 + 0.11 * Math.sin(t * 0.11)), 10)
    // sin(y * 3.1 + t * 0.30)、cos(x * 2.7 - t * 0.25)：收进一圈以后三角函数的值不变
    expect(Math.sin(0.7 + warp[0])).toBeCloseTo(Math.sin(0.7 + t * 0.30), 9)
    expect(Math.cos(0.4 + warp[1])).toBeCloseTo(Math.cos(0.4 - t * 0.25), 9)
  })
})
