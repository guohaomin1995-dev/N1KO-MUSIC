import { describe, expect, it } from 'vitest'
import { glassHue, tokenize, wrapLines } from './lyricGlass'

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
