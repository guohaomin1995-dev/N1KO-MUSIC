/**
 * 一首歌是不是已收藏。
 *
 * NAS 类服务器（Subsonic / Jellyfin …）的歌曲自带 starred；插件音源（网易云 / QQ）的歌曲不带——
 * 插件协议里没有这个字段，于是网易云的歌在播放条、列表里永远是空心，连收藏页里那几百首也是。
 * 这里补上：歌曲自己带了布尔值就听它的（乐观更新、点完之后都会写这个字段），
 * 没带就按它所属音源的收藏列表查。
 *
 * 收藏列表与收藏页共用同一份查询缓存（[serverId, 'starred']）。
 * 当前播放的那首会在需要时主动拉一次；歌曲列表只读已有缓存，不为每个列表多发请求。
 */
import { useCallback, useMemo, useRef } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { getAdapterFor, hasAdapterFor } from '@/api'
import { usePlayerStore } from '@/store/playerStore'
import { useServerStore } from '@/store/serverStore'
import { useToggleStar } from '@/hooks/useServerQueries'
import type { Album, Artist, Song } from '@/api/types'

type StarredData = { songs: Song[]; albums: Album[]; artists: Artist[] }

/** 与 useSourceStarred 一致：收藏页那份缓存就是这一份 */
const STARRED_STALE_MS = 3 * 60 * 1000

const toIdSet = (data: StarredData): Set<string> => new Set(data.songs.map(s => s.id))

function starredQuery(serverId: string, enabled: boolean) {
  return {
    queryKey: [serverId, 'starred'] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => getAdapterFor(serverId).getStarred(signal),
    staleTime: STARRED_STALE_MS,
    enabled,
    select: toIdSet,
  }
}

/** 只有插件音源需要补：NAS 的歌曲本身就带 starred */
function isPluginSource(serverId: string | undefined): serverId is string {
  if (!serverId) return false
  return useServerStore.getState().servers.some(s => s.id === serverId && s.type === 'plugin')
}

/** 某个插件音源收藏了哪些歌（id 集合）；fetch=false 时只读缓存，不发请求 */
export function useFavoriteIds(serverId: string | undefined, options: { fetch?: boolean } = {}): Set<string> | undefined {
  const plugin = isPluginSource(serverId)
  const { data } = useQuery(starredQuery(serverId ?? '', !!options.fetch && plugin && hasAdapterFor(serverId ?? '')))
  return plugin ? data : undefined
}

/**
 * 一个列表里涉及的各个插件音源的收藏集合；只读缓存。
 * 返回值只在收藏数据真的变了时才换引用：列表行是 memo 的，每次渲染换一个新对象会让整列重算。
 */
export function useFavoriteIdsBySource(serverIds: string[]): Record<string, Set<string> | undefined> {
  const key = [...new Set(serverIds)].filter(isPluginSource).sort().join('|')
  const plugins = useMemo(() => (key ? key.split('|') : []), [key])
  const results = useQueries({ queries: plugins.map(id => starredQuery(id, false)) })
  const stamp = results.map(r => r.dataUpdatedAt).join(',')
  const resultsRef = useRef(results)
  resultsRef.current = results
  return useMemo(
    () => Object.fromEntries(plugins.map((id, i) => [id, resultsRef.current[i]?.data])),
    // stamp 是故意的：数据在 ref 里，只有某个源的收藏真的刷新了才重建这个对象
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plugins, stamp]
  )
}

export function songIsStarred(song: Pick<Song, 'id' | 'starred'> | null | undefined, ids: Set<string> | undefined): boolean {
  if (!song) return false
  if (typeof song.starred === 'boolean') return song.starred
  return !!ids?.has(song.id)
}

/** 当前播放这首的收藏状态与切换（播放条、全屏、正在播放面板、车载模式共用） */
export function useCurrentSongFavorite(): { starred: boolean; toggle: () => void; pending: boolean } {
  const currentSong = usePlayerStore(s => s.currentSong)
  const updateCurrentSong = usePlayerStore(s => s.updateCurrentSong)
  const toggleStar = useToggleStar()
  const ids = useFavoriteIds(currentSong?.serverId, { fetch: true })
  const starred = songIsStarred(currentSong, ids)
  const mutate = toggleStar.mutate
  const toggle = useCallback(() => {
    if (!currentSong) return
    mutate(
      { id: currentSong.id, type: 'song', isStarred: starred, song: currentSong },
      { onSuccess: () => updateCurrentSong({ starred: !starred }) }
    )
  }, [currentSong, starred, mutate, updateCurrentSong])
  return { starred, toggle, pending: toggleStar.isPending }
}
