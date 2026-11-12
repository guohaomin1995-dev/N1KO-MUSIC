/**
 * 播客的数据查询（声明 podcasts 能力的音源：网易云、免登录的小宇宙）。
 *
 * 订阅列表要登录：没登录的音源不去请求（插件只会回 unauthorized），页面直接给「去登录」。
 * 没有账号这回事的音源（accountless，订阅存在本机）一律算已登录。
 * 订阅开关做成乐观更新：按钮先变，失败了再变回来并提示。
 */

import { useMemo } from 'react'
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { getAdapterFor, hasAdapterFor } from '@/api'
import type { Podcast, PodcastEpisodeOrder } from '@/api/types'
import { useServerStore } from '@/store/serverStore'
import {
  type SourceQueryGroup,
  type SourceRef,
  useConnectedSources,
  useSourceCapabilities,
  zipQueryResults,
} from '@/hooks/useSourceQueries'

/** 订阅列表最多翻这么多页（每页 30 个），够绝大多数人 */
const SUBSCRIBED_MAX_PAGES = 10

export interface PodcastSource extends SourceRef {
  /** 能用订阅：登录了，或者音源本身没有账号（订阅存在本机） */
  loggedIn: boolean
  /** 只能按分享链接查找，没有关键词搜索 */
  linkSearchOnly: boolean
}

/** 能听播客的音源 */
export function usePodcastSources(): PodcastSource[] {
  const sources = useConnectedSources()
  const caps = useSourceCapabilities()
  const servers = useServerStore(s => s.servers)
  return useMemo(
    () => sources
      .filter(s => caps[s.serverId]?.podcasts && hasAdapterFor(s.serverId))
      .map(s => {
        const adapter = getAdapterFor(s.serverId)
        return {
          ...s,
          loggedIn: !!servers.find(x => x.id === s.serverId)?.credentials || adapter.accountless === true,
          linkSearchOnly: adapter.podcastLinkSearchOnly === true,
        }
      }),
    [sources, caps, servers]
  )
}

/** 各源「我订阅的」（只查已登录的源） */
export function useSubscribedPodcasts(sources: PodcastSource[]): SourceQueryGroup<Podcast[]>[] {
  const eligible = useMemo(() => sources.filter(s => s.loggedIn), [sources])
  const results = useQueries({
    queries: eligible.map(s => ({
      queryKey: [s.serverId, 'podcasts', 'subscribed'] as const,
      queryFn: async () => {
        const adapter = getAdapterFor(s.serverId)
        if (!adapter.getSubscribedPodcasts) return []
        const all: Podcast[] = []
        for (let page = 1; page <= SUBSCRIBED_MAX_PAGES; page++) {
          const chunk = await adapter.getSubscribedPodcasts(page)
          all.push(...chunk.items)
          if (chunk.isEnd || !chunk.items.length) break
        }
        return all
      },
      staleTime: 5 * 60 * 1000,
    })),
  })
  return zipQueryResults<Podcast[]>(eligible, results)
}

/** 各源推荐 */
export function useRecommendedPodcasts(sources: PodcastSource[]): SourceQueryGroup<Podcast[]>[] {
  const eligible = useMemo(
    () => sources.filter(s => typeof getAdapterFor(s.serverId).getRecommendedPodcasts === 'function'),
    [sources]
  )
  const results = useQueries({
    queries: eligible.map(s => ({
      // 登录前后推荐的内容不一样（登录后按口味推荐）
      queryKey: [s.serverId, 'podcasts', 'recommended', s.loggedIn] as const,
      queryFn: () => getAdapterFor(s.serverId).getRecommendedPodcasts!(),
      staleTime: 30 * 60 * 1000,
    })),
  })
  return zipQueryResults<Podcast[]>(eligible, results)
}

/** 各源搜索（第一页）；query 为空时不查 */
export function usePodcastSearch(sources: PodcastSource[], query: string): SourceQueryGroup<Podcast[]>[] {
  const queryClient = useQueryClient()
  const q = query.trim()
  // 粘贴的是分享链接：只交给认链接的音源。拿链接文本去别家按关键词搜，只会搜出一堆
  // 名字里带「小宇宙」的电台，把真正要找的那个挤到最后
  const isLink = /https?:\/\/\S+/i.test(q)
  const eligible = useMemo(
    () => (q
      ? sources.filter(s => typeof getAdapterFor(s.serverId).searchPodcasts === 'function' && (!isLink || s.linkSearchOnly))
      : []),
    [sources, q, isLink]
  )
  const results = useQueries({
    queries: eligible.map(s => ({
      queryKey: [s.serverId, 'podcasts', 'search', q] as const,
      queryFn: async () => {
        const items = (await getAdapterFor(s.serverId).searchPodcasts!(q, 1)).items
        // 按单集链接找到的节目：插件记下了这一期（可能早于最新那批），节目列表要重读才看得到
        if (s.linkSearchOnly) {
          for (const p of items) void queryClient.invalidateQueries({ queryKey: [s.serverId, 'podcast', p.id, 'episodes'] })
        }
        return items
      },
      staleTime: 5 * 60 * 1000,
    })),
  })
  return zipQueryResults<Podcast[]>(eligible, results)
}

export function podcastQueryKey(serverId: string, id: string) {
  return [serverId, 'podcast', id] as const
}

export function usePodcast(serverId: string, id: string) {
  return useQuery({
    queryKey: podcastQueryKey(serverId, id),
    queryFn: () => getAdapterFor(serverId).getPodcast!(id),
    enabled: !!serverId && !!id && hasAdapterFor(serverId) && typeof getAdapterFor(serverId).getPodcast === 'function',
    staleTime: 5 * 60 * 1000,
  })
}

export function usePodcastEpisodes(serverId: string, id: string, order: PodcastEpisodeOrder) {
  return useInfiniteQuery({
    queryKey: [serverId, 'podcast', id, 'episodes', order] as const,
    queryFn: ({ pageParam }) => getAdapterFor(serverId).getPodcastEpisodes!(id, pageParam, order),
    initialPageParam: 1,
    getNextPageParam: (last, _all, lastPageParam) => (last.isEnd || !last.episodes.length ? undefined : lastPageParam + 1),
    enabled: !!serverId && !!id && hasAdapterFor(serverId) && typeof getAdapterFor(serverId).getPodcastEpisodes === 'function',
    staleTime: 5 * 60 * 1000,
    /*
     * 切「最新 / 最早」时先留着旧列表（变淡），新顺序到了再换：换成骨架的话页面一下变矮、滚动位置跟着跳。
     * 只在同一个播客里沿用——从 A 播客点进 B 播客时不能先摆出 A 的节目。
     */
    placeholderData: (previous, previousQuery) =>
      previousQuery && previousQuery.queryKey[0] === serverId && previousQuery.queryKey[2] === id ? previous : undefined,
  })
}

/** 订阅 / 取消订阅（乐观更新详情里的 subscribed，成功后刷新订阅列表） */
export function useTogglePodcastSubscription(serverId: string, id: string) {
  const queryClient = useQueryClient()
  const key = podcastQueryKey(serverId, id)
  return useMutation({
    mutationFn: (subscribed: boolean) => getAdapterFor(serverId).setPodcastSubscribed!(id, subscribed),
    onMutate: async (subscribed) => {
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<Podcast>(key)
      if (previous) {
        const delta = subscribed === !!previous.subscribed ? 0 : subscribed ? 1 : -1
        queryClient.setQueryData<Podcast>(key, {
          ...previous,
          subscribed,
          subscriberCount: previous.subscriberCount !== undefined ? Math.max(0, previous.subscriberCount + delta) : undefined,
        })
      }
      return { previous }
    },
    onError: (_err, _subscribed, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: [serverId, 'podcasts', 'subscribed'] })
    },
  })
}
