import { describe, expect, it } from 'vitest'
import { glassHue, layoutCells, tokenize, wrapLines } from './lyricGlass'

/** 每个字 10 像素宽，空格也算 */
const measure = (s: string) => s.length * 10

describe('玻璃歌词的断行', () => {
  it('中文逐字可断，英文按词断', () => {
    expect(tokenize('里面是你')).toEqual(['里', '面', '是', '你'])
    expect(tokenize('hello big world')).toEqual(['hello ', 'big ', 'world'])
  })

  it('超过行宽就换行，不把英文单词拆开', () => {
    expect(wrapLines('hello big world', 100, measure)).toEqual(['hello big', 'world'])
    expect(wrapLines('里面是你的朋友', 50, measure)).toEqual(['里面是你的', '朋友'])
  })
})

describe('玻璃的颜色', () => {
  it('往副色相那边偏 25–35°，是相近色', () => {
    expect(glassHue(280, 300)).toBe(305)
    expect(glassHue(280, 250)).toBe(250)
    expect(glassHue(10, 340)).toBe(340)
  })

  it('副色相离得太远（像补色）时不跟过去，固定偏 28°', () => {
    expect(glassHue(100, 280)).toBe(128)
  })
})

describe('颜色进度的字位', () => {
  it('每个字一格，按行居中；空格不占格子，顺序就是唱的顺序', () => {
    // 行宽 100，每字 10：第一行「ab c」宽 40，从 30 开始
    const cells = layoutCells(['ab c', 'de'], measure, 100, 5, 20)
    expect(cells.map(c => c.slot)).toEqual([0, 1, 2, 3, 4])
    expect(cells[0]).toMatchObject({ line: 0, x0: 30, x1: 40, top: 5, bottom: 25 })
    // 空格跳过：第三格是 c，在 60–70
    expect(cells[2]).toMatchObject({ x0: 60, x1: 70 })
    // 第二行「de」宽 20，从 40 开始
    expect(cells[3]).toMatchObject({ line: 1, x0: 40, top: 25 })
  })
})
