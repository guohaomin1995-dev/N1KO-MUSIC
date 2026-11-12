/**
 * 外壳的导航高亮：三档导航各有一张表，哪一格亮由 isNavActive 决定。
 *
 * 窄档（手机）底部四格是首页、推荐、收藏、搜索；音乐库进了「更多」菜单，
 * 专辑、歌手等页面在标签栏里不点亮任何一格。宽档侧栏精确到分类。
 */
import { describe, expect, it } from 'vitest'
import { TAB_NAV, RAIL_NAV, SIDEBAR_DISCOVER, SIDEBAR_LIBRARY, MORE_NAV, isNavActive, moreNavFor } from './navItems'

const active = (items: typeof TAB_NAV, path: string) =>
  items.filter(item => isNavActive(item, path)).map(item => item.to)

describe('TAB_NAV（手机底部的四格）', () => {
  it('首页、推荐、收藏、搜索；首页只在根路径亮', () => {
    expect(TAB_NAV.map(i => i.to)).toEqual(['/', '/recommendations', '/favorites', '/search'])
    expect(active(TAB_NAV, '/')).toEqual(['/'])
    expect(active(TAB_NAV, '/recommendations')).toEqual(['/recommendations'])
  })

  it('收藏只在收藏页亮；音乐库的页面不点亮任何一格（音乐库在「更多」里）', () => {
    expect(active(TAB_NAV, '/favorites')).toEqual(['/favorites'])
    for (const path of ['/library', '/albums/al-1', '/artists', '/playlists/pl-1', '/history', '/stats', '/settings', '/issue']) {
      expect(active(TAB_NAV, path), path).toEqual([])
    }
  })

  it('前缀相同但不是子路径的不误亮（/albums 不点亮 /albumsx）', () => {
    expect(active(SIDEBAR_LIBRARY, '/albumsx')).toEqual([])
  })
})

describe('侧栏（宽档）精确到分类', () => {
  it('专辑详情点亮「专辑」，不点亮「全部歌曲」', () => {
    expect(active(SIDEBAR_LIBRARY, '/albums/al-1')).toEqual(['/albums'])
  })

  it('单曲详情归「全部歌曲」', () => {
    expect(active(SIDEBAR_LIBRARY, '/songs/sg-1')).toEqual(['/library'])
  })

  it('本期在侧栏的发现组里', () => {
    expect(active(SIDEBAR_DISCOVER, '/issue')).toEqual(['/issue'])
  })
})

describe('手机上放不下的入口一个都不丢', () => {
  it('「更多」菜单是本期、播客、音乐库、最近播放、统计', () => {
    expect(moreNavFor('compact').map(i => i.to)).toEqual(['/issue', '/podcasts', '/library', '/history', '/stats'])
  })

  it('侧栏的每个独立入口，不在四格里就在「更多」里', () => {
    const reachable = new Set([...TAB_NAV, ...moreNavFor('compact')].map(i => i.to))
    const sidebar = [...SIDEBAR_DISCOVER, ...SIDEBAR_LIBRARY]
      .map(i => i.to)
      // 专辑、歌手、歌单在「音乐库」页内有分段导航；这里只核对跨页面的独立入口
      .filter(to => !['/albums', '/artists', '/playlists'].includes(to))
    expect(sidebar.filter(to => !reachable.has(to))).toEqual([])
  })
})

describe('中档竖导航条（竖屏平板、分屏）', () => {
  it('每个页面入口都摆在导航条上，分组、顺序同侧栏', () => {
    expect(RAIL_NAV.map(i => i.to)).toEqual([
      '/', '/recommendations', '/issue', '/podcasts', '/search',
      '/library', '/favorites', '/history', '/stats',
    ])
    expect(active(RAIL_NAV, '/podcasts/wy/42')).toEqual(['/podcasts'])
    expect(active(RAIL_NAV, '/albums/al-1')).toEqual(['/library'])
  })

  it('收藏、最近播放、统计只亮自己那格，不连带「音乐库」一起亮', () => {
    expect(active(RAIL_NAV, '/favorites')).toEqual(['/favorites'])
    expect(active(RAIL_NAV, '/history')).toEqual(['/history'])
    expect(active(RAIL_NAV, '/stats')).toEqual(['/stats'])
  })

  it('中档、宽档「更多」菜单里没有页面入口；窄档全列', () => {
    expect(moreNavFor('regular')).toEqual([])
    expect(moreNavFor('wide')).toEqual([])
    expect(moreNavFor('compact')).toEqual(MORE_NAV)
  })

  it('中档里侧栏的每个独立入口，不在导航条上就在「更多」里', () => {
    const reachable = new Set([...RAIL_NAV, ...moreNavFor('regular')].map(i => i.to))
    const sidebar = [...SIDEBAR_DISCOVER, ...SIDEBAR_LIBRARY]
      .map(i => i.to)
      .filter(to => !['/library', '/albums', '/artists', '/playlists'].includes(to))
    expect(sidebar.filter(to => !reachable.has(to))).toEqual([])
  })
})
