/**
 * 播客：/podcasts
 *
 * 从上往下：搜索框 → 继续收听（听了一半的节目）→ 我的订阅 → 为你推荐。
 * 搜索框里有字并按了搜索时，下面整块换成搜索结果；清空就回来。
 *
 * 目前只有网易云提供播客（它叫「电台」）。订阅列表要登录：没登录的音源不去请求，
 * 直接给一句「登录后这里会列出你订阅的播客」和去登录的按钮。
 */

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { MagnifyingGlass, Play, X } from '@phosphor-icons/react'
import { CoverGrid } from '@/components/common/CoverCard'
import { EmptyState } from '@/components/common/EmptyState'
import { ImageWithFallback } from '@/components/common/ImageWithFallback'
import { PodcastCard } from '@/components/podcast/PodcastCard'
import { formatEpisodeLength } from '@/components/podcast/podcastFormat'
import { SourceBadge } from '@/components/sources/SourceBadge'
import { SourceGroupState, groupStateStatus } from '@/components/sources/SourceGroupState'
import { findAdapterFor } from '@/api'
import type { Podcast } from '@/api/types'
import type { SourceQueryGroup } from '@/hooks/useSourceQueries'
import {
  type PodcastSource,
  usePodcastSearch,
  usePodcastSources,
  useRecommendedPodcasts,
  useSubscribedPodcasts,
} from '@/hooks/usePodcastQueries'
import { continueListening, type EpisodeProgress, usePodcastProgressStore } from '@/store/podcastProgressStore'
import { usePlayerStore } from '@/store/playerStore'
import { useServerStore } from '@/store/serverStore'
import { playAllInOrder } from '@/utils/playActions'
import { spaceCJK } from '@/utils/cjkTypography'
import { useT } from '@/i18n'

/** 封面网格的骨架：形状和真卡一样，加载完不跳 */
function GridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <CoverGrid>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} aria-hidden="true">
          <div className="skeleton mb-2.5 aspect-square rounded-md" />
          <div className="skeleton h-3.5 w-3/4 rounded-sm" />
          <div className="skeleton mt-2 h-3 w-1/2 rounded-sm" />
        </div>
      ))}
    </CoverGrid>
  )
}

/**
 * 一节封面网格（多个音源的结果合在一起）。加载中给骨架，失败 / 登录过期给状态行，
 * 全都成功但一个都没有时给 empty。
 */
function PodcastGroups({
  groups,
  empty,
  showSource,
  retryKey,
}: {
  groups: SourceQueryGroup<Podcast[]>[]
  empty?: React.ReactNode
  showSource: boolean
  retryKey: string
}) {
  const queryClient = useQueryClient()
  const items = useMemo(() => {
    const seen = new Set<string>()
    const out: Podcast[] = []
    for (const g of groups) {
      if (g.status !== 'success') continue
      for (const p of g.data ?? []) {
        const key = `${p.serverId}|${p.id}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(p)
      }
    }
    return out
  }, [groups])
  const loading = groups.some(g => g.status === 'loading')
  const problems = groups.filter(g => g.status === 'error')

  return (
    <>
      {items.length > 0 ? (
        <CoverGrid>
          {items.map(p => <PodcastCard key={`${p.serverId}|${p.id}`} podcast={p} showSource={showSource} />)}
        </CoverGrid>
      ) : loading ? (
        <GridSkeleton />
      ) : problems.length === 0 ? (
        empty ?? null
      ) : null}
      {problems.length > 0 && (
        <div className="sheet mt-4 px-4 py-1">
          {problems.map(g => (
            <SourceGroupState
              key={g.serverId}
              serverId={g.serverId}
              status={groupStateStatus(g)}
              error={g.error}
              onRetry={() => { void queryClient.invalidateQueries({ queryKey: [g.serverId, 'podcasts', retryKey] }) }}
            />
          ))}
        </div>
      )}
    </>
  )
}

/** 「继续收听」的一行：封面、节目名、所属播客、细进度、还剩多久 */
function ContinueRow({ entry }: { entry: EpisodeProgress }) {
  const { t } = useT()
  const song = entry.song
  const duration = song.duration || entry.duration
  const ratio = duration > 0 ? Math.min(1, entry.position / duration) : 0
  const cover = song.coverArt ? (findAdapterFor(song.serverId)?.getCoverUrl(song.coverArt, 120) ?? song.coverArt) : undefined
  return (
    <button
      type="button"
      // 只放这一期：续到哪儿由播放器按记下的位置接上
      onClick={() => playAllInOrder([song], 0)}
      className="group flex w-full items-center gap-3.5 rounded-md px-3 py-2.5 text-left transition-colors duration-2 active:bg-ink/[0.08] [@media(hover:hover)]:hover:bg-ink/[0.05]"
    >
      <span className="cover-frame relative h-14 w-14 flex-none rounded-[10px] shadow-sm">
        <ImageWithFallback src={cover} alt="" fallbackType="album" className="h-full w-full object-cover" />
        <span className="absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true">
          <Play size={18} weight="fill" className="text-white" />
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold text-ink">{spaceCJK(song.title)}</span>
        <span className="mt-0.5 block truncate text-[13px] text-ink-3">
          {spaceCJK(song.ext?.podcast?.podcastName || song.album || song.artist)}
        </span>
        <span className="mt-2 flex items-center gap-2.5">
          <span className="block h-1 w-20 overflow-hidden rounded-pill bg-ink/[0.12]" aria-hidden="true">
            <span className="block h-full origin-left rounded-pill bg-leaf" style={{ transform: `scaleX(${ratio})` }} />
          </span>
          {duration > 0 && (
            <span className="num text-[12.5px] text-ink-3">
              {t('podcast.remaining', { time: formatEpisodeLength(duration - entry.position, t) })}
            </span>
          )}
        </span>
      </span>
    </button>
  )
}

/**
 * 只认分享链接的音源（免登录的小宇宙）：搜不到、没订阅时，告诉人链接从哪来。
 * 一个音源一行，前面挂音源名，和「去登录」那一排同一个样子。
 */
function LinkSourceHint({ sources, textKey }: { sources: PodcastSource[]; textKey: 'podcast.linkSearchHint' | 'podcast.linkSubsHint' }) {
  const { t } = useT()
  if (!sources.length) return null
  return (
    <div className="sheet mb-5 px-4 py-1">
      {sources.map(s => (
        <div key={s.serverId} className="flex min-h-[52px] flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
          <SourceBadge serverId={s.serverId} withName />
          <span className="text-[14px] leading-relaxed text-ink-2">{t(textKey)}</span>
        </div>
      ))}
    </div>
  )
}

/** 这些音源里，这一组查完了、一条都没有的 */
function emptyIn(groups: SourceQueryGroup<Podcast[]>[], sources: PodcastSource[]): PodcastSource[] {
  return sources.filter(s => {
    const g = groups.find(x => x.serverId === s.serverId)
    return !!g && g.status === 'success' && !(g.data?.length)
  })
}

function LoginHint({ sources }: { sources: PodcastSource[] }) {
  const { t } = useT()
  const navigate = useNavigate()
  const servers = useServerStore(s => s.servers)
  return (
    <div className="sheet mb-5 px-4 py-1">
      {sources.map(s => {
        const pluginId = servers.find(x => x.id === s.serverId)?.pluginId
        return (
          <div key={s.serverId} className="flex min-h-[52px] flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
            <SourceBadge serverId={s.serverId} withName />
            <span className="text-[14px] text-ink-2">{t('podcast.loginForSubs')}</span>
            <button
              type="button"
              className="-my-3 py-3 text-[14px] font-semibold text-leaf hover:underline hover:underline-offset-4"
              onClick={() => navigate(pluginId ? `/login?plugin=${encodeURIComponent(pluginId)}&relogin=1` : '/login')}
            >
              {t('podcast.login')}
            </button>
          </div>
        )
      })}
    </div>
  )
}

export default function PodcastsPage() {
  const { t } = useT()
  const navigate = useNavigate()
  const sources = usePodcastSources()
  const showSource = sources.length > 1

  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const searching = query.trim().length > 0

  const subscribed = useSubscribedPodcasts(sources)
  const recommended = useRecommendedPodcasts(searching ? [] : sources)
  const results = usePodcastSearch(sources, query)

  const entries = usePodcastProgressStore(s => s.entries)
  // 只列还连着的音源里的节目：音源删掉了，那些节目点了也放不出来
  const sourceIds = useMemo(() => new Set(sources.map(s => s.serverId)), [sources])
  const resumable = useMemo(
    () => continueListening(entries, 6).filter(e => sourceIds.has(e.song.serverId)),
    [entries, sourceIds]
  )
  const currentSongKey = usePlayerStore(s => (s.currentSong ? `${s.currentSong.serverId}|${s.currentSong.id}` : ''))
  // 正在放的那一期不必再提示「继续收听」
  const continueItems = resumable.filter(e => `${e.song.serverId}|${e.song.id}` !== currentSongKey).slice(0, 4)

  const loggedOut = sources.filter(s => !s.loggedIn)
  const linkOnly = sources.filter(s => s.linkSearchOnly)
  const allLinkOnly = linkOnly.length === sources.length
  const linkOnlyNoResults = emptyIn(results, linkOnly)
  const linkOnlyNoSubs = emptyIn(subscribed, linkOnly)
  const placeholder = allLinkOnly
    ? t('podcast.searchPlaceholderLinkOnly')
    : linkOnly.length ? t('podcast.searchPlaceholderLink') : t('podcast.searchPlaceholder')

  const heading = (
    <h1 className="font-display text-[34px] font-bold leading-[1.05] tracking-[-0.03em] text-ink regular:text-[44px]">
      {t('podcast.title')}
    </h1>
  )

  if (!sources.length) {
    return (
      <div className="pt-2 regular:pt-4">
        {heading}
        <EmptyState
          mascot="nuomi-sleep"
          className="mt-8"
          title={t('podcast.noSource')}
          description={t('podcast.noSourceDesc')}
          action={{ label: t('podcast.addSource'), onClick: () => navigate('/login') }}
        />
      </div>
    )
  }

  return (
    <div className="pt-2 regular:pt-4">
      {heading}

      <form
        role="search"
        className="relative mt-5 max-w-xl"
        onSubmit={e => {
          e.preventDefault()
          setQuery(input.trim())
          ;(document.activeElement as HTMLElement | null)?.blur()
        }}
      >
        <MagnifyingGlass size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
        <input
          type="search"
          enterKeyHint="search"
          value={input}
          onChange={e => {
            setInput(e.target.value)
            if (!e.target.value.trim()) setQuery('')
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          className="flex h-11 w-full rounded-pill border border-edge/80 bg-surface pl-10 pr-10 text-base text-ink transition-colors duration-2 placeholder:text-ink-3 hover:border-edge regular:text-[15px] [&::-webkit-search-cancel-button]:hidden"
        />
        {input && (
          <button
            type="button"
            onClick={() => { setInput(''); setQuery('') }}
            className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-pill text-ink-3 hover:bg-ink/[0.06] hover:text-ink"
            aria-label={t('action.clear')}
          >
            <X size={16} weight="bold" />
          </button>
        )}
      </form>

      {searching ? (
        <section aria-labelledby="podcast-results">
          <div className="section-head">
            <h2 id="podcast-results">{t('podcast.searchResults')}</h2>
          </div>
          <LinkSourceHint sources={linkOnlyNoResults} textKey="podcast.linkSearchHint" />
          <PodcastGroups
            groups={results}
            showSource={showSource}
            retryKey="search"
            // 只有认链接的音源时，上面那行说明已经够了
            empty={allLinkOnly ? null : <p className="py-6 text-[14.5px] text-ink-3">{t('podcast.searchEmpty')}</p>}
          />
        </section>
      ) : (
        <>
          {continueItems.length > 0 && (
            <section aria-labelledby="podcast-continue">
              <div className="section-head">
                <h2 id="podcast-continue">{t('podcast.continue')}</h2>
              </div>
              <div className="grid gap-1 regular:grid-cols-2">
                {continueItems.map(e => <ContinueRow key={`${e.song.serverId}|${e.song.id}`} entry={e} />)}
              </div>
            </section>
          )}

          <section aria-labelledby="podcast-subscribed">
            <div className="section-head">
              <h2 id="podcast-subscribed">{t('podcast.subscribed')}</h2>
            </div>
            {loggedOut.length > 0 && <LoginHint sources={loggedOut} />}
            <LinkSourceHint sources={linkOnlyNoSubs} textKey="podcast.linkSubsHint" />
            {subscribed.length > 0 && (
              <PodcastGroups
                groups={subscribed}
                showSource={showSource}
                retryKey="subscribed"
                empty={allLinkOnly ? null : <p className="py-2 text-[14.5px] leading-relaxed text-ink-3">{t('podcast.subsEmpty')}</p>}
              />
            )}
          </section>

          {/* 只有不给推荐的音源（小宇宙免登录）时，不留一个空的「为你推荐」 */}
          {recommended.length > 0 && (
            <section aria-labelledby="podcast-recommended">
              <div className="section-head">
                <h2 id="podcast-recommended">{t('podcast.recommended')}</h2>
              </div>
              <PodcastGroups groups={recommended} showSource={showSource} retryKey="recommended" />
            </section>
          )}
        </>
      )}
    </div>
  )
}
