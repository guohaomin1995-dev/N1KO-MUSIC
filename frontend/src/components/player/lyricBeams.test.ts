import { describe, expect, it } from 'vitest'
import { beatPulse, mixBeamRigs, nextBeamRig, STILL_RIG } from './lyricBeams'

describe('歌词光束的灯位', () => {
  it('同一个种子得到同一套灯位', () => {
    expect(nextBeamRig(7)).toEqual(nextBeamRig(7))
  })

  it('亮着的束数在 2 到 5 之间，粗细不一，而且彼此分开', () => {
    const counts = new Set<number>()
    let thin = 0
    let broad = 0
    for (let seed = 1; seed <= 80; seed++) {
      const live = nextBeamRig(seed).beams.filter(beam => beam.alpha > 0.05)
      expect(live.length).toBeGreaterThanOrEqual(2)
      expect(live.length).toBeLessThanOrEqual(5)
      counts.add(live.length)
      const angles = live.map(beam => beam.angle).sort((a, b) => a - b)
      expect(angles[angles.length - 1] - angles[0]).toBeGreaterThan(0.1)
      for (const beam of live) {
        expect(Math.abs(beam.angle)).toBeLessThanOrEqual(0.95)
        if (beam.spread < 0.12) thin++
        else broad++
      }
    }
    expect(counts).toEqual(new Set([2, 3, 4, 5]))
    expect(thin).toBeGreaterThan(0)
    expect(broad).toBeGreaterThan(0)
  })

  it('不同种子朝不同的方向偏', () => {
    const leans = Array.from({ length: 40 }, (_, i) => {
      const live = nextBeamRig(i + 1).beams.filter(beam => beam.alpha > 0.05)
      return live.reduce((sum, beam) => sum + beam.angle, 0) / live.length
    })
    expect(leans.some(lean => lean < -0.15)).toBe(true)
    expect(leans.some(lean => lean > 0.15)).toBe(true)
  })

  it('过渡两端分别是起点和终点', () => {
    const to = nextBeamRig(3)
    expect(mixBeamRigs(STILL_RIG, to, 0)).toEqual(STILL_RIG.beams)
    expect(mixBeamRigs(STILL_RIG, to, 1)).toEqual(to.beams)
  })

  it('拍子包络在每拍开头最亮，小节第一拍更重', () => {
    expect(beatPulse(4)).toBeCloseTo(1)
    expect(beatPulse(5)).toBeCloseTo(0.55)
    expect(beatPulse(4.9)).toBeLessThan(0.05)
    expect(beatPulse(-1)).toBe(0)
  })
})
