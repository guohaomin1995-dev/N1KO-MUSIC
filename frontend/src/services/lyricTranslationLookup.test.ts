/**
 * 到流媒体音源里给外语歌词找译文：只问插件音源、跳过歌曲自己的音源、原文对不上的不采用。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerAdapter, unregisterAdapter } from '@/api'
import type { LyricLine, Lyrics, MusicServerAdapter, Song } from '@/api/types'
import { baseTitle, lookupLyricTranslation, matchScore } from '@/services/lyricTranslationLookup'

const LINES: LyricLine[] = [
  { time: 10_000, text: 'Look at the stars' },
  { time: 20_000, text: 'Look how they shine for you' },
  { time: 30_000, text: 'And everything you do' },
  { time: 40_000, text: 'Yeah, they were all yellow' },
]

const TRANSLATED: LyricLine[] = [
  { time: 12_000, text: 'Look at the stars', translation: '看那星星' },
  { time: 22_000, text: 'Look how they shine for you', translation: '看它们为你闪耀' },
  { time: 32_000, text: 'And everything you do', translation: '你做的每一件事' },
  { time: 42_000, text: 'Yeah they were all yellow', translation: '它们都是黄色的' },
]

const song = (id: string, title: string, artist: string) => ({ id, title, artist }) as Song

function fakeSource(type: string, songs: Song[], lyrics: Record<string, LyricLine[] | null>) {
  const searchSongsPage = vi.fn(async () => ({ songs, isEnd: true }))
  const getLyrics = vi.fn(async (id: string): Promise<Lyrics | null> => {
    const lines = lyrics[id]
    return lines ? { songId: id, lines, synced: true } : null
  })
  return { adapter: { type, searchSongsPage, getLyrics } as unknown as MusicServerAdapter, searchSongsPage, getLyrics }
}

const registered: string[] = []
function register(id: string, adapter: MusicServerAdapter) {
  registerAdapter(id, adapter)
  registered.push(id)
}

afterEach(() => {
  registered.splice(0).forEach(unregisterAdapter)
})

describe('matchScore', () => {
  it('歌名里的版本说明不参与比对；歌手对得上分更高；歌名对不上是 0', () => {
    expect(baseTitle('Yellow (Remastered 2011)')).toBe('Yellow')
    expect(baseTitle('Yellow - Live in Madrid')).toBe('Yellow')
    expect(matchScore({ title: 'Yellow', artist: 'Coldplay' }, { title: 'Yellow (Live)', artist: 'Coldplay' })).toBe(3)
    expect(matchScore({ title: 'Yellow', artist: 'Coldplay' }, { title: 'Yellow', artist: 'Someone' })).toBe(2)
    expect(matchScore({ title: 'Yellow', artist: 'Coldplay' }, { title: 'Yellow Submarine', artist: 'The Beatles' })).toBe(1)
    expect(matchScore({ title: 'Yellow', artist: 'Coldplay' }, { title: 'Fix You', artist: 'Coldplay' })).toBe(0)
  })
})

describe('lookupLyricTranslation', () => {
  it('在插件音源里搜到同一首歌：译文按原文配回来，时间戳还是手上这份的', async () => {
    const nas = fakeSource('subsonic', [], {})
    const netease = fakeSource('plugin', [song('n1', 'Yellow', 'Coldplay')], { n1: TRANSLATED })
    register('nas', nas.adapter)
    register('netease', netease.adapter)

    const result = await lookupLyricTranslation(LINES, { title: 'Yellow (Remastered)', artist: 'Coldplay' }, 'nas')
    expect(netease.searchSongsPage).toHaveBeenCalledWith('Yellow Coldplay', 1)
    expect(nas.searchSongsPage).not.toHaveBeenCalled()
    expect(result?.map(l => [l.time, l.translation])).toEqual([
      [10_000, '看那星星'], [20_000, '看它们为你闪耀'], [30_000, '你做的每一件事'], [40_000, '它们都是黄色的'],
    ])
  })

  it('歌曲自己的音源不再问；第一个音源没有译文就问下一个', async () => {
    const own = fakeSource('plugin', [song('o1', 'Yellow', 'Coldplay')], { o1: TRANSLATED })
    const empty = fakeSource('plugin', [song('e1', 'Yellow', 'Coldplay')], { e1: LINES })
    const qq = fakeSource('plugin', [song('q1', 'Yellow', 'Coldplay')], { q1: TRANSLATED })
    register('own', own.adapter)
    register('empty', empty.adapter)
    register('qq', qq.adapter)

    const result = await lookupLyricTranslation(LINES, { title: 'Yellow', artist: 'Coldplay' }, 'own')
    expect(own.searchSongsPage).not.toHaveBeenCalled()
    expect(empty.getLyrics).toHaveBeenCalledTimes(1)
    expect(result?.[0].translation).toBe('看那星星')
  })

  it('搜到的是另一首同名的歌（原文对不上）：不采用；每个音源最多试两首', async () => {
    const other: LyricLine[] = [
      { time: 1000, text: 'We all live in a yellow submarine', translation: '我们都住在黄色潜水艇里' },
      { time: 2000, text: 'Yellow submarine', translation: '黄色潜水艇' },
    ]
    const source = fakeSource(
      'plugin',
      [song('a', 'Yellow', 'X'), song('b', 'Yellow', 'Y'), song('c', 'Yellow', 'Z')],
      { a: other, b: other, c: TRANSLATED },
    )
    register('src', source.adapter)

    expect(await lookupLyricTranslation(LINES, { title: 'Yellow', artist: 'Coldplay' })).toBeNull()
    expect(source.getLyrics).toHaveBeenCalledTimes(2)
  })

  it('音源报错（没登录、限流）：换下一个，不抛出来', async () => {
    const broken = fakeSource('plugin', [], {})
    broken.searchSongsPage.mockRejectedValue(new Error('406'))
    const qq = fakeSource('plugin', [song('q1', 'Yellow', 'Coldplay')], { q1: TRANSLATED })
    register('broken', broken.adapter)
    register('qq', qq.adapter)

    const result = await lookupLyricTranslation(LINES, { title: 'Yellow', artist: 'Coldplay' })
    expect(result?.[3].translation).toBe('它们都是黄色的')
  })
})
