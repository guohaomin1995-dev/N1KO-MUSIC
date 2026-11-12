import { describe, expect, it } from 'vitest'
import {
  GHOST_SCALE,
  SIDE_BOX,
  frequentTokens,
  ghostOffsets,
  lineProgress,
  mixRgb,
  lineSideTokens,
  progressPoint,
  progressSlots,
  sparkAlpha,
  spawnSpark,
  stepSpark,
  sideSlots,
  skyColorFloats,
  sideTokens,
  skyColors,
  splitChars,
} from './skyline'
import type { ArtPalette } from '@/services/artLight'

const lines = [
  { time: 1000, text: '我爱你们' },
  { time: 5000, text: '想 拉你' },
  { time: 9000, text: 'last line' },
]

const channels = (s: string) => s.match(/\d+/g)!.map(Number)

describe('进度：这句开始到下一句开始，按字数平均推进', () => {
  it('空格不占进度', () => {
    expect(progressSlots(splitChars('想 拉你'))).toEqual([0, 2, 3])
  })

  it('还没开唱是 -1；唱到一半落在第几个字、这个字唱了多少；唱完是 length', () => {
    const chars = splitChars('我爱你们')
    expect(lineProgress(lines, 0, 900, chars)).toEqual({ head: -1, frac: 0, pos: 0 })
    // 4 秒 4 个字：1.5 秒时第 0 个字唱了一半
    expect(lineProgress(lines, 0, 1500, chars)).toEqual({ head: 0, frac: 0.5, pos: 0.5 })
    expect(lineProgress(lines, 0, 3000, chars)).toEqual({ head: 2, frac: 0, pos: 2 })
    expect(lineProgress(lines, 0, 5000, chars)).toMatchObject({ head: 4, pos: 4 })
  })

  it('有空格的句子：进度头跳过空格', () => {
    const chars = splitChars('想 拉你')
    // 4 秒 3 个字，2 秒时在第二个字（下标 2）；pos 以字为单位，不算空格
    expect(lineProgress(lines, 1, 7000, chars)).toMatchObject({ head: 2, pos: 1.5 })
  })

  it('最后一句没有下一句：按 5 秒算，歌更早结束就按歌的结尾', () => {
    const chars = splitChars('last line')
    expect(lineProgress(lines, 2, 9000 + 4999, chars).head).toBeLessThan(chars.length)
    expect(lineProgress(lines, 2, 9000 + 2500, chars, 11000).head).toBe(chars.length)
  })
})

describe('颜色跟着封面', () => {
  const warm: ArtPalette = { h: 40, c: 0.12, l: 0.6, h2: 90, c2: 0.08, swatches: [], neutral: false }

  it('暖色封面：起点偏暖（红通道 > 蓝通道）', () => {
    const [r, , b] = channels(skyColors(warm).a)
    expect(r).toBeGreaterThan(b)
  })

  it('近乎黑白的封面：退回蓝 → 紫，进度看得出来', () => {
    const colors = skyColors({ ...warm, neutral: true })
    const [r, , b] = channels(colors.a)
    expect(b).toBeGreaterThan(r)
    expect(colors.a).not.toBe(colors.b)
  })

  it('主副色相挨得太近：拉开，渐变才看得出来', () => {
    const colors = skyColors({ ...warm, h2: 45 })
    expect(colors.a).not.toBe(colors.b)
  })

  it('head / glow / side 是三个通道，CSS 里自己加透明度', () => {
    expect(skyColors(warm).glow).toMatch(/^\d+ \d+ \d+$/)
    expect(skyColors(warm).head).toMatch(/^\d+ \d+ \d+$/)
    expect(skyColors(warm).side).toMatch(/^\d+ \d+ \d+$/)
  })

  it('两侧的字比当前句灰：饱和度（通道的极差）明显更低', () => {
    const spread = (s: string) => { const c = channels(s); return Math.max(...c) - Math.min(...c) }
    expect(spread(skyColors(warm).side)).toBeLessThan(spread(skyColors(warm).a) / 2)
  })

  it('玻璃字着色器用的浮点颜色和 CSS 那套一致', () => {
    const floats = skyColorFloats(warm)
    expect(floats.sungA.map(v => Math.round(v * 255))).toEqual(channels(skyColors(warm).a))
  })

  it('唱过的字在 a、b 之间插值', () => {
    expect(mixRgb('rgb(0 0 0)', 'rgb(200 100 50)', 0.5)).toBe('rgb(100 50 25)')
  })
})

describe('两侧散落的字', () => {
  it('中文按单字、英文按词（3 个字母以上）', () => {
    expect(sideTokens('想拉你的手 hold me tight')).toEqual(['想', '拉', '你', '的', '手', 'hold', 'tight'])
  })

  it('初始一批按出现次数排', () => {
    expect(frequentTokens([{ time: 0, text: '你你我' }, { time: 1, text: '你他' }], 2)).toEqual(['你', '我'])
  })

  it('同一首歌的槽位固定；横着排开，上下只错一点（和歌词大致在一条水平线上）', () => {
    expect(sideSlots(42, 4)).toEqual(sideSlots(42, 4))
    const slots = sideSlots(42, 4)
    for (const s of slots) {
      expect(s.x).toBeGreaterThan(0)
      expect(s.x).toBeLessThan(1)
      expect(s.y).toBeGreaterThanOrEqual(0.4)
      expect(s.y).toBeLessThanOrEqual(0.7)
    }
    const left = slots.filter(s => s.side === 0).map(s => s.x)
    expect(left).toEqual([...left].sort((a, b) => a - b))
  })

  it('跟着歌词一起换：先取这一句的字，不够再拿下一句，不重复', () => {
    const tokens = lineSideTokens(lines, 0, 6, 7)
    expect(tokens.slice(0, 4).sort()).toEqual(['们', '你', '我', '爱'].sort())
    expect(tokens).toHaveLength(6)
    expect(new Set(tokens).size).toBe(6)
    expect(lineSideTokens(lines, 0, 6, 7)).toEqual(tokens)
    expect(lineSideTokens(lines, 1, 6, 8)).not.toEqual(tokens)
  })
})

describe('进度头的位置：连续地扫过整句', () => {
  const cells = [
    { x0: 0, x1: 40, top: 10, bottom: 60 },
    { x0: 40, x1: 80, top: 10, bottom: 60 },
    { x0: 0, x1: 40, top: 60, bottom: 110 },
  ]

  it('唱到第几个字的几成，就在这个字的几成处；跨字时位置是连着的', () => {
    expect(progressPoint(cells, 0.5)?.x).toBe(20)
    expect(progressPoint(cells, 0.999)?.x).toBeCloseTo(40, 0)
    expect(progressPoint(cells, 1)?.x).toBe(40)
    expect(progressPoint(cells, 1.25)?.x).toBe(50)
  })

  it('换行跟着走到下一行；开唱前在第一个字的左边，唱完在最后一个字的右边', () => {
    expect(progressPoint(cells, 2.5)).toMatchObject({ x: 20, top: 60 })
    expect(progressPoint(cells, 0)).toMatchObject({ x: 0, singing: false })
    expect(progressPoint(cells, 3)).toMatchObject({ x: 40, top: 60, singing: false })
    expect(progressPoint([], 1)).toBeNull()
  })
})

describe('光斑', () => {
  const head = { x: 200, y: 100, w: 50, h: 60 }

  it('从进度头前后一两个字的范围、字顶到字的上半截冒出来，往上飘', () => {
    let seed = 0.1
    const rand = () => { seed = (seed * 9301 + 0.4927) % 1; return seed }
    for (let i = 0; i < 200; i++) {
      const p = spawnSpark(head, rand)
      expect(Math.abs(p.x - head.x)).toBeLessThanOrEqual(head.w * 1.8 + 1e-9)
      expect(p.y).toBeGreaterThanOrEqual(head.y)
      expect(p.y).toBeLessThanOrEqual(head.y + head.h * 0.5)
      expect(p.vy).toBeLessThan(0)
    }
  })

  it('一下子亮起来、慢慢淡掉；寿命到了就是 0，位置一直往上', () => {
    const p = spawnSpark(head, () => 0.5)
    const y0 = p.y
    stepSpark(p, p.life * 0.1)
    expect(sparkAlpha(p)).toBeGreaterThan(0.5)
    stepSpark(p, p.life * 0.5)
    expect(sparkAlpha(p)).toBeLessThan(1)
    expect(p.y).toBeLessThan(y0)
    stepSpark(p, p.life)
    expect(sparkAlpha(p)).toBe(0)
  })
})

describe('投影散在字周围的空处', () => {
  for (const [name, box, perSide] of [['横屏两翼', SIDE_BOX.wide, 4], ['竖屏一行', SIDE_BOX.narrow, 2]] as const) {
    it(`${name}：不压任何一个字，方向不全一样，同一组槽位结果固定`, () => {
      for (const seed of [1, 7, 42, 2026, 31337]) {
        const slots = sideSlots(seed, perSide)
        const ghosts = ghostOffsets(slots, box)
        expect(ghostOffsets(slots, box)).toEqual(ghosts)
        const at = (i: number) => ({ x: slots[i].x * box.w, y: slots[i].y * box.h })
        ghosts.forEach((g, i) => {
          const c = at(i)
          const gx = c.x + g.gx * slots[i].scale
          const gy = c.y + g.gy * slots[i].scale
          const rg = 0.5 * slots[i].scale * GHOST_SCALE
          slots.forEach((f, j) => {
            if (f.side !== slots[i].side) return
            const d = Math.hypot(gx - at(j).x, gy - at(j).y)
            // 投影（约八成半径）和字的圆不相交
            expect(d, `seed ${seed} ghost ${i} vs face ${j}`).toBeGreaterThan(rg * 0.85 + 0.5 * f.scale - 0.05)
          })
        })
        if (perSide >= 3) {
          const angles = new Set(ghosts.map(g => Math.round(Math.atan2(g.gy, g.gx) / (Math.PI / 4))))
          expect(angles.size).toBeGreaterThan(1)
        }
      }
    })
  }
})
