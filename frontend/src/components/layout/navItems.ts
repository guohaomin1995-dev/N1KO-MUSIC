/**
 * 外壳的导航表：侧栏（宽）、侧边导航条（中）、底部标签栏（窄）共用这一份。
 *
 * 宽档侧栏把音乐库的分类和「本期」「播客」都摊开。
 * 中档的竖导航条把每个页面入口都摆出来（RAIL_NAV_GROUPS，分组同侧栏），不往菜单里藏；
 * 音乐库的分类（专辑、歌手、歌单）在「音乐库」页里有分段导航。
 * 窄档（手机）底部标签栏四格：首页、推荐、收藏、搜索（TAB_NAV）——收藏比音乐库用得勤；
 * 放不下的（含音乐库）进工具栏的「更多」菜单（moreNavFor），一个都不丢。
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

/** 窄档（手机）底部标签栏的四格 */
export const TAB_NAV: NavItem[] = [
  { to: '/', labelKey: 'nav.home', icon: House, match: p => p === '/' },
  { to: '/recommendations', labelKey: 'nav.recommendations', icon: Sparkle },
  { to: '/favorites', labelKey: 'nav.favorites', icon: Heart },
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

/** 窄档标签栏放不下的入口：工具栏「更多」菜单 */
export const MORE_NAV: NavItem[] = [
  { to: '/issue', labelKey: 'nav.issue', icon: Newspaper },
  { to: '/podcasts', labelKey: 'nav.podcasts', icon: Microphone },
  { to: '/library', labelKey: 'nav.library', icon: Books },
  { to: '/history', labelKey: 'nav.history', icon: ClockCounterClockwise },
  { to: '/stats', labelKey: 'nav.stats', icon: ChartBar },
]

/** 「更多」菜单里的页面入口：只有窄档有；中档导航条上全都有，宽档有侧栏 */
export function moreNavFor(wc: WindowClass): NavItem[] {
  return wc === 'compact' ? MORE_NAV : []
}

export function isNavActive(item: NavItem, pathname: string): boolean {
  if (item.match) return item.match(pathname)
  return pathname === item.to || pathname.startsWith(item.to + '/')
}
