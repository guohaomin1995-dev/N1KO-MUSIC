/**
 * 外壳的导航表：侧栏（宽）、侧边导航条（中）、底部标签栏（窄）共用这一份。
 *
 * 三档里都在的只有四个一级入口；侧栏有地方，再把音乐库的分类和「本期」「播客」摊开。
 * 中档的竖导航条把每个页面入口都摆出来（RAIL_NAV_GROUPS，分组同侧栏），不往菜单里藏；
 * 音乐库的分类（专辑、歌手、歌单）在「音乐库」页里有分段导航。
 * 窄档底部标签栏只有四格，放不下的进工具栏的「更多」菜单（moreNavFor），一个都不丢。
 */
import type { Icon } from '@phosphor-icons/react'
import type { WindowClass } from '@/lib/platform'
import {
  House, Sparkle, Books, MagnifyingGlass, Newspaper, MusicNotes, VinylRecord,
  UsersThree, Playlist, Heart, ClockCounterClockwise, ChartBar, Microphone,
} from '@phosphor-icons/react'

export interface NavItem {
  to: string
  labelKey: string
  icon: Icon
  /** 当前路径属于这个入口吗；缺省按前缀匹配 */
  match?: (pathname: string) => boolean
}

/** 音乐库下的所有路由：在中、窄两档里都算「音乐库」这一格 */
const LIBRARY_PATHS = /^\/(library|albums|artists|playlists|favorites|history|stats|songs|toplists)(\/|$)/

export const PRIMARY_NAV: NavItem[] = [
  { to: '/', labelKey: 'nav.home', icon: House, match: p => p === '/' },
  { to: '/recommendations', labelKey: 'nav.recommendations', icon: Sparkle },
  { to: '/library', labelKey: 'nav.library', icon: Books, match: p => LIBRARY_PATHS.test(p) },
  { to: '/search', labelKey: 'nav.search', icon: MagnifyingGlass },
]

/** 侧栏第一组：发现 */
export const SIDEBAR_DISCOVER: NavItem[] = [
  { to: '/', labelKey: 'nav.home', icon: House, match: p => p === '/' },
  { to: '/recommendations', labelKey: 'nav.recommendations', icon: Sparkle },
  { to: '/issue', labelKey: 'nav.issue', icon: Newspaper },
  { to: '/podcasts', labelKey: 'nav.podcasts', icon: Microphone },
  { to: '/search', labelKey: 'nav.search', icon: MagnifyingGlass },
]

/** 侧栏第二组：音乐库的分类 */
export const SIDEBAR_LIBRARY: NavItem[] = [
  { to: '/library', labelKey: 'library.allSongs', icon: MusicNotes, match: p => p === '/library' || p.startsWith('/songs/') },
  { to: '/albums', labelKey: 'nav.albums', icon: VinylRecord },
  { to: '/artists', labelKey: 'nav.artists', icon: UsersThree },
  { to: '/playlists', labelKey: 'nav.playlists', icon: Playlist },
  { to: '/favorites', labelKey: 'nav.favorites', icon: Heart },
  { to: '/history', labelKey: 'nav.history', icon: ClockCounterClockwise },
  { to: '/stats', labelKey: 'nav.stats', icon: ChartBar },
]

/** 中档导航条上的「音乐库」一格：收藏、最近播放、统计自己有格，不归它亮 */
const RAIL_LIBRARY_PATHS = /^\/(library|albums|artists|playlists|songs|toplists)(\/|$)/

/**
 * 中档（竖屏平板、分屏）的竖导航条：每个页面入口都摆出来，分两组，同侧栏——
 * 发现（首页、推荐、本期、播客、搜索）/ 音乐库（音乐库、收藏、最近播放、统计）。
 * 九格加设置约 770px 高，竖屏平板放得下；更矮的窗口导航条自己滚。
 */
export const RAIL_NAV_GROUPS: NavItem[][] = [
  SIDEBAR_DISCOVER,
  [
    { to: '/library', labelKey: 'nav.library', icon: Books, match: p => RAIL_LIBRARY_PATHS.test(p) },
    { to: '/favorites', labelKey: 'nav.favorites', icon: Heart },
    { to: '/history', labelKey: 'nav.history', icon: ClockCounterClockwise },
    { to: '/stats', labelKey: 'nav.stats', icon: ChartBar },
  ],
]

export const RAIL_NAV: NavItem[] = RAIL_NAV_GROUPS.flat()

/** 中、窄两档放不进导航的入口：工具栏「更多」菜单（按档位用 moreNavFor 取） */
export const MORE_NAV: NavItem[] = [
  { to: '/issue', labelKey: 'nav.issue', icon: Newspaper },
  { to: '/podcasts', labelKey: 'nav.podcasts', icon: Microphone },
  { to: '/favorites', labelKey: 'nav.favorites', icon: Heart },
  { to: '/history', labelKey: 'nav.history', icon: ClockCounterClockwise },
  { to: '/stats', labelKey: 'nav.stats', icon: ChartBar },
]

/** 「更多」菜单：中档导航条上已经有的不再重复列 */
export function moreNavFor(wc: WindowClass): NavItem[] {
  if (wc !== 'regular') return MORE_NAV
  const onRail = new Set(RAIL_NAV.map(item => item.to))
  return MORE_NAV.filter(item => !onRail.has(item.to))
}

export function isNavActive(item: NavItem, pathname: string): boolean {
  if (item.match) return item.match(pathname)
  return pathname === item.to || pathname.startsWith(item.to + '/')
}
