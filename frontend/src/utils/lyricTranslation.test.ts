/**
 * 歌词译文的三种配法：按时间（音源自带的译文）、折叠（双语歌词文件）、按原文（别的音源里的同一首歌）。
 */
import { describe, expect, it } from 'vitest'
import { parseLrc } from '@/utils/lrc'
import {
  alignTranslation,
  attachTranslation,
  foldBilingual,
  needsTranslation,
  stripTranslation,
} from '@/utils/lyricTranslation'

const EN = '[00:10.00]Look at the stars\n[00:20.00]Look how they shine for you\n[00:30.00]And everything you do\n[00:40.00]Yeah, they were all yellow'

describe('needsTranslation', () => {
  it('英文、日文、韩文歌要找译文；中文歌、夹几句英文的中文歌不找', () => {
    expect(needsTranslation(parseLrc(EN))).toBe(true)
    expect(needsTranslation(parseLrc('[00:01]夜に駆ける\n[00:02]沈むように\n[00:03]溶けてゆくように\n[00:04]二人だけの空'))).toBe(true)
    expect(needsTranslation(parseLrc('[00:01]밤하늘의 별을\n[00:02]따다가\n[00:03]너에게 줄래\n[00:04]나는 다'))).toBe(true)
    expect(needsTranslation(parseLrc('[00:01]窗外的麻雀\n[00:02]在电线杆上多嘴\n[00:03]你说这一句\n[00:04]很有夏天的感觉'))).toBe(false)
    expect(needsTranslation(parseLrc('[00:01]我爱你\n[00:02]Baby\n[00:03]不要走\n[00:04]留下来'))).toBe(false)
  })

  it('已经有译文的、太短的（纯音乐的一两行说明）不找', () => {
    expect(needsTranslation([{ time: 1, text: 'Hello', translation: '你好' }])).toBe(false)
    expect(needsTranslation(parseLrc('[00:01]Instrumental'))).toBe(false)
  })
})

describe('attachTranslation', () => {
  it('时间戳一样的配上；差几毫秒（两份歌词小数位数不同）也配得上', () => {
    const lines = attachTranslation(parseLrc(EN), parseLrc('[00:10.00]看那星星\n[00:20.01]看它们为你闪耀\n[00:40.00]它们都是黄色的'))
    expect(lines.map(l => l.translation)).toEqual(['看那星星', '看它们为你闪耀', undefined, '它们都是黄色的'])
  })

  it('一句译文只配给一句原文；译文和原文一样的不算译文', () => {
    const lines = attachTranslation(
      parseLrc('[00:10.00]La la la\n[00:10.20]Oh yeah\n[00:20.00]Hello'),
      parseLrc('[00:10.00]La la la\n[00:20.00]你好'),
    )
    expect(lines.map(l => l.translation)).toEqual([undefined, undefined, '你好'])
  })

  it('译文是空的：原样返回同一个数组', () => {
    const origin = parseLrc(EN)
    expect(attachTranslation(origin, parseLrc('[00:10.00]//'))).toBe(origin)
  })
})

describe('foldBilingual', () => {
  it('同一时间戳上的原文和译文折成一行', () => {
    const lines = foldBilingual(parseLrc(
      '[00:10.00]Look at the stars\n[00:10.00]看那星星\n[00:20.00]Look how they shine for you\n[00:20.00]看它们为你闪耀\n[00:30.00]And everything you do\n[00:30.00]你做的每一件事\n[00:40.00]Yeah',
    ))
    expect(lines).toEqual([
      { time: 10_000, text: 'Look at the stars', translation: '看那星星' },
      { time: 20_000, text: 'Look how they shine for you', translation: '看它们为你闪耀' },
      { time: 30_000, text: 'And everything you do', translation: '你做的每一件事' },
      { time: 40_000, text: 'Yeah' },
    ])
  })

  it('译文写在前面的文件：中文那一行是译文', () => {
    const lines = foldBilingual(parseLrc(
      '[00:10.00]看那星星\n[00:10.00]Look at the stars\n[00:20.00]看它们闪耀\n[00:20.00]Look how they shine\n[00:30.00]每一件事\n[00:30.00]And everything',
    ))
    expect(lines.map(l => [l.text, l.translation])).toEqual([
      ['Look at the stars', '看那星星'],
      ['Look how they shine', '看它们闪耀'],
      ['And everything', '每一件事'],
    ])
  })

  it('只有一两处时间戳重了的普通歌词不折', () => {
    const origin = parseLrc(`${EN}\n[00:40.00]Oh`)
    expect(foldBilingual(origin)).toBe(origin)
  })
})

describe('alignTranslation', () => {
  const reference = attachTranslation(
    parseLrc('[00:12.30]Look at the stars,\n[00:22.30]Look how they shine for you\n[00:32.30]And everything you do\n[00:42.30]Yeah they were all yellow\n[01:12.30]Look at the stars'),
    parseLrc('[00:12.30]看那星星\n[00:22.30]看它们为你闪耀\n[00:32.30]你做的每一件事\n[00:42.30]它们都是黄色的\n[01:12.30]再看那星星'),
  )

  it('时间戳对不上（版本不同）也按原文配；标点、大小写不同不要紧；重复的句子取时间最近的', () => {
    const lines = alignTranslation(parseLrc(`${EN}\n[01:10.00]LOOK AT THE STARS`), reference)
    expect(lines?.map(l => l.translation)).toEqual(['看那星星', '看它们为你闪耀', '你做的每一件事', '它们都是黄色的', '再看那星星'])
  })

  it('配上的句子不到一半（搜到的不是同一首歌）：当没找到', () => {
    const other = parseLrc('[00:01]Hello darkness my old friend\n[00:02]Look at the stars\n[00:03]Because a vision softly creeping\n[00:04]Left its seeds while I was sleeping')
    expect(alignTranslation(other, reference)).toBeNull()
  })

  it('断句不一样：参考歌词把一句拆成了连着的两句，译文接起来', () => {
    const split = attachTranslation(
      parseLrc('[00:10.00]Look at the stars\n[00:20.00]You know\n[00:22.00]you know I love you so\n[00:30.00]And everything you do\n[00:40.00]Yeah'),
      parseLrc('[00:10.00]看那星星\n[00:20.00]你知道\n[00:22.00]你知道我多爱你\n[00:30.00]你做的每一件事\n[00:40.00]耶'),
    )
    const lines = alignTranslation(parseLrc('[00:11.00]Look at the stars\n[00:21.00]You know, you know I love you so\n[00:31.00]And everything you do'), split)
    expect(lines?.map(l => l.translation)).toEqual(['看那星星', '你知道 你知道我多爱你', '你做的每一件事'])
  })

  it('参考歌词没有译文：null', () => {
    expect(alignTranslation(parseLrc(EN), parseLrc(EN))).toBeNull()
  })
})

describe('stripTranslation', () => {
  it('去掉译文；本来就没有的原样返回', () => {
    const plain = parseLrc(EN)
    expect(stripTranslation(plain)).toBe(plain)
    expect(stripTranslation([{ time: 1, text: 'Hi', translation: '嗨' }])).toEqual([{ time: 1, text: 'Hi' }])
  })
})
