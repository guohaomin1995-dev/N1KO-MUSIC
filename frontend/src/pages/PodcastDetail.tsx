/**
 * 播客详情：/podcasts/:serverId/:podcastId
 *
 * 头部：封面、名字、主播、分类 / 期数 / 订阅人数，主按钮是「继续播放」（这个播客里有听到一半的）
 * 或「播放最新一期」，旁边是订阅开关。下面是简介（三行，可展开）和节目列表。
 * 节目列表默认最新的在前，可以切成从第一期开始；往下滚自动加载下一页。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { motion, useReducedMotion } from 'motion/react'
import { BookmarkSimple, CheckCircle, Play } from '@phosphor-icons/react'
import { DetailHero } from '@/components/common/DetailHero'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { ImageWithFallback } from '@/components/common/ImageWithFallback'
import { SongRowsSkeleton } from '@/components/common/SongRowsSkeleton'
import { EpisodeRow } from '@/components/podcast/EpisodeRow'
import { episodeQueueFrom, firstPlayableEpisode } from '@/components/podcast/episodeQueue'
import { podcastCoverUrl } from '@/components/podcast/PodcastCard'
import { SourceBadge } from '@/components/sources/SourceBadge'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/use-toast'
import { findAdapterFor } from '@/api'
import type { PodcastEpisodeOrder, Song } from '@/api/types'
import { usePodcast, usePodcastEpisodes, useTogglePodcastSubscription } from '@/hooks/usePodcastQueries'
import { pluginErrorCode } from '@/services/errors'
import { episodeKey, usePodcastProgressStore } from '@/store/podcastProgressStore'
import { usePlayerStore } from '@/store/playerStore'
import { useServerStore } from '@/store/serverStore'
import { haptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import { playAllInOrder, playNextInQueue } from '@/utils/playActions'
import { spaceCJK } from '@/utils/cjkTypography'
import { useT } from '@/i18n'

/** 和音源 tab 同一套滑块（motion-prompt #060 的数值） */
const SLIDE = { duration: 0.25, ease: [0.65, 0, 0.35, 1] as const }

function OrderToggle({ value, onChange }: { value: PodcastEpisodeOrder; onChange: (v: PodcastEpisodeOrder) => void }) {
  const { t } = useT()
  const reduce = useReducedMotion()
  const options: Array<{ id: PodcastEpisodeOrder; label: string }> = [
    { id: 'newest', label: t('podcast.newest') },
    { id: 'oldest', label: t('podcast.oldest') },
  ]
  return (
    <div role="radiogroup" aria-label={t('podcast.order')} className="inline-flex flex-none gap-0.5 rounded-[10px] bg-ink/[0.06] p-1">
      {options.map(o => {
        const active = o.id === value
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => { if (!active) { haptic('selection'); onChange(o.id) } }}
            className={cn(
              'relative isolate h-8 rounded-[8px] px-3 text-[13.5px] font-semibold transition-colors duration-[250ms]',
              active ? 'text-lime-ink' : 'text-ink-2 hover:text-ink'
            )}
          >
            {active && (
              <motion.span
                layoutId="podcast-order"
                transition={reduce ? { duration: 0 } : SLIDE}
                aria-hidden="true"
                className="absolute inset-0 -z-10 rounded-[8px] bg-lime shadow-[0_2px_6px_rgb(0_0_0/0.2)]"
              />
            )}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** 简介：默认三行，长了才给「展开」 */
function Description({ text }: { text: string }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const long = text.length > 90 || text.split('\n').length > 3
  return (
    <div className="mt-6 max-w-3xl">
      <p className={cn('whitespace-pre-line text-[14.5px] leading-relaxed text-ink-2', !open && 'line-clamp-3')}>
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="-my-2 py-2 text-[14px] font-semibold text-leaf hover:underline hover:underline-offset-4"
        >
          {open ? t('podcast.showLess') : t('podcast.showMore')}
        </button>
      )}
    </div>
  )
}

export default function PodcastDetailPage() {
  const { t } = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams<{ serverId: string; podcastId: string }>()
  const serverId = decodeURIComponent(params.serverId ?? '')
  const podcastId = decodeURIComponent(params.podcastId ?? '')
  const nameFromState = (location.state as { name?: string } | null)?.name

  const server = useServerStore(s => s.servers.find(x => x.id === serverId))
  const adapter = findAdapterFor(serverId)
  // 没有账号这回事的音源（小宇宙免登录，订阅存在本机）不需要先登录
  const loggedIn = !!server?.credentials || adapter?.accountless === true
  const canSubscribe = typeof adapter?.setPodcastSubscribed === 'function'

  const { data: podcast, isError, error, refetch } = usePodcast(serverId, podcastId)
  const [order, setOrder] = useState<PodcastEpisodeOrder>('newest')
  const episodesQuery = usePodcastEpisodes(serverId, podcastId, order)
  const episodes = useMemo(() => episodesQuery.data?.pages.flatMap(p => p.episodes) ?? [], [episodesQuery.data])
  const total = episodesQuery.data?.pages[0]?.total ?? podcast?.episodeCount
  // 音源只给得出一部分（免登录只有最新一批）：不给「最早」排序，说一句为什么
  const partial = episodesQuery.data?.pages[0]?.partial === true

  const entries = usePodcastProgressStore(s => s.entries)
  const setFinished = usePodcastProgressStore(s => s.setFinished)
  const currentKey = usePlayerStore(s => (s.currentSong ? episodeKey(s.currentSong) : ''))
  const isPlaying = usePlayerStore(s => s.isPlaying)

  /* 这个播客里听到一半、最近听的那一期：主按钮就是「继续播放」它 */
  const resumeEntry = useMemo(() => {
    return Object.values(entries)
      .filter(e => e.song.serverId === serverId && e.song.ext?.podcast?.podcastId === podcastId && !e.finished && e.position > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  }, [entries, serverId, podcastId])

  const toggle = useTogglePodcastSubscription(serverId, podcastId)
  const subscribed = !!podcast?.subscribed
  const onToggleSubscribe = () => {
    if (!loggedIn) {
      const pluginId = server?.pluginId
      navigate(pluginId ? `/login?plugin=${encodeURIComponent(pluginId)}&relogin=1` : '/login')
      return
    }
    haptic('selection')
    const next = !subscribed
    toggle.mutate(next, {
      onError: () => toast({
        title: next ? t('podcast.subscribeFailed') : t('podcast.unsubscribeFailed'),
        description: t('podcast.tryLater'),
      }),
    })
  }

  const playFrom = (list: Song[], index: number) => {
    const { queue, start } = episodeQueueFrom(list, index)
    playAllInOrder(queue, start)
  }

  const playPrimary = () => {
    if (resumeEntry) {
      const i = episodes.findIndex(s => s.id === resumeEntry.song.id)
      if (i >= 0) playFrom(episodes, i)
      else playAllInOrder([resumeEntry.song], 0)
      return
    }
    if (episodes.length) playFrom(episodes, firstPlayableEpisode(episodes))
  }

  /* 滚到列表底部自动加载下一页 */
  const sentinelRef = useRef<HTMLDivElement>(null)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = episodesQuery
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasNextPage || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !isFetchingNextPage) void fetchNextPage()
    }, { rootMargin: '400px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  const title = podcast?.name || nameFromState || t('podcast.title')
  const cover = podcast ? podcastCoverUrl(podcast, 600) : undefined

  if (isError && pluginErrorCode(error) === 'not-found') {
    return (
      <div className="pt-2 regular:pt-4">
        <EmptyState mascot="nuomi-sleep" className="mt-8" title={t('podcast.notFoundTitle')} description={t('podcast.notFoundDesc')} />
      </div>
    )
  }

  const meta = podcast ? (
    <>
      {podcast.category && <span>{podcast.category}</span>}
      {(total ?? 0) > 0 && <span className="num">{t('podcast.episodes', { count: total! })}</span>}
      {(podcast.subscriberCount ?? 0) > 0 && (
        <span className="num">{t('podcast.subscribers', { count: podcast.subscriberCount! })}</span>
      )}
      {podcast.paid && <span>{t('podcast.paid')}</span>}
    </>
  ) : undefined

  const header = (
    <DetailHero
      cover={<ImageWithFallback src={cover} alt={title} fallbackType="album" className="h-full w-full object-cover" />}
      coverUrl={cover}
      title={spaceCJK(title)}
      subtitle={
        <span className="inline-flex min-w-0 items-center gap-2">
          <SourceBadge serverId={serverId} />
          {podcast?.author && <span className="truncate">{spaceCJK(podcast.author)}</span>}
        </span>
      }
      meta={meta}
      actions={
        <>
          <Button onClick={playPrimary} disabled={!resumeEntry && !episodes.length}>
            <Play size={16} weight="fill" />
            {resumeEntry ? t('podcast.resume') : order === 'newest' ? t('podcast.playLatest') : t('podcast.playFirst')}
          </Button>
          {canSubscribe && podcast && (
            <Button variant="secondary" onClick={onToggleSubscribe} aria-pressed={subscribed}>
              {subscribed ? (
                <CheckCircle size={17} weight="fill" className="text-leaf" />
              ) : (
                <BookmarkSimple size={17} weight="bold" />
              )}
              {subscribed ? t('podcast.subscribedBtn') : t('podcast.subscribe')}
            </Button>
          )}
        </>
      }
    />
  )

  return (
    <div className="pt-2 regular:pt-4">
      {header}

      {podcast?.description && <Description text={podcast.description} />}

      <section aria-labelledby="podcast-episodes" className="mt-8">
        <div className="section-head">
          <h2 id="podcast-episodes">{t(partial ? 'podcast.latestEpisodes' : 'podcast.allEpisodes')}</h2>
          {!partial && <OrderToggle value={order} onChange={setOrder} />}
        </div>
        {partial && (
          <p className="-mt-1 mb-4 max-w-3xl text-[13.5px] leading-relaxed text-ink-3">
            {t('podcast.partialHint')}
          </p>
        )}

        {episodesQuery.isLoading ? (
          <SongRowsSkeleton rows={8} />
        ) : episodesQuery.isError ? (
          <ErrorState retry={() => { void episodesQuery.refetch(); if (isError) void refetch() }} />
        ) : !episodes.length ? (
          <EmptyState mascot="nuomi-sleep" title={t('podcast.episodesEmpty')} />
        ) : (
          <div
            className={cn('-mx-3 flex flex-col transition-opacity duration-2', episodesQuery.isPlaceholderData && 'pointer-events-none opacity-50')}
            aria-busy={episodesQuery.isPlaceholderData || undefined}
          >
            {episodes.map((song, i) => {
              const key = episodeKey(song)
              return (
                <EpisodeRow
                  key={key}
                  song={song}
                  progress={entries[key]}
                  isCurrent={currentKey === key}
                  isPlaying={isPlaying}
                  onPlay={() => playFrom(episodes, i)}
                  onPlayNext={() => playNextInQueue([song])}
                  onSetFinished={finished => setFinished(song, finished)}
                />
              )
            })}
          </div>
        )}

        <div ref={sentinelRef} aria-hidden="true" />
        {hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Button variant="secondary" disabled={isFetchingNextPage} onClick={() => { void fetchNextPage() }}>
              {t('podcast.loadMore')}
            </Button>
          </div>
        )}
      </section>
    </div>
  )
}
