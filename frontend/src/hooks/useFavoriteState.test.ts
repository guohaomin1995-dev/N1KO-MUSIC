import { describe, expect, it } from 'vitest'
import { songIsStarred } from './useFavoriteState'

describe('songIsStarred', () => {
  const ids = new Set(['a'])

  it('歌曲自己带了布尔值就听它的（乐观更新、取消收藏之后）', () => {
    expect(songIsStarred({ id: 'a', starred: false }, ids)).toBe(false)
    expect(songIsStarred({ id: 'b', starred: true }, ids)).toBe(true)
  })

  it('没带（插件音源的歌）就按收藏列表查', () => {
    expect(songIsStarred({ id: 'a' }, ids)).toBe(true)
    expect(songIsStarred({ id: 'b' }, ids)).toBe(false)
    expect(songIsStarred({ id: 'a', starred: null as unknown as undefined }, ids)).toBe(true)
  })

  it('收藏列表还没拿到、或者没有歌时是空心', () => {
    expect(songIsStarred({ id: 'a' }, undefined)).toBe(false)
    expect(songIsStarred(null, ids)).toBe(false)
  })
})
