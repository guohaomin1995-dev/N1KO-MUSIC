import { describe, expect, it } from 'vitest'
import { defaultTabId, shortSourceName } from './SourceTabs'

describe('shortSourceName', () => {
  it('去掉地址、账号这些后半截', () => {
    expect(shortSourceName('Subsonic - 192.168.1.150')).toBe('Subsonic')
    expect(shortSourceName('网易云音乐 · 鵄人')).toBe('网易云音乐')
    expect(shortSourceName('QQ 音乐 · 热心市民')).toBe('QQ 音乐')
    expect(shortSourceName('Navidrome')).toBe('Navidrome')
  })
})

describe('defaultTabId', () => {
  const items = [
    { id: 'nas', label: 'NAS', count: 0, loading: false },
    { id: 'wy', label: '网易云', count: 115, loading: false },
    { id: 'qq', label: 'QQ', count: 12, loading: false },
  ]

  it('地址栏指定了就听地址栏的（哪怕它是空的）', () => {
    expect(defaultTabId(items, 'nas')).toBe('nas')
    expect(defaultTabId(items, 'qq')).toBe('qq')
  })

  it('没指定：跳过确定为空的，停在第一个有内容的', () => {
    expect(defaultTabId(items)).toBe('wy')
  })

  it('还在加载的不算空，先停在它上面', () => {
    expect(defaultTabId([{ id: 'nas', label: 'NAS', loading: true }, ...items.slice(1)])).toBe('nas')
  })

  it('全都空着就是第一个；指定的源已经不在了也落回默认', () => {
    const empty = items.map(i => ({ ...i, count: 0 }))
    expect(defaultTabId(empty)).toBe('nas')
    expect(defaultTabId(items, 'gone')).toBe('wy')
  })
})
