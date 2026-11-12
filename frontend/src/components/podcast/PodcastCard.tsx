/**
 * 播客封面卡（订阅、推荐、搜索结果共用）：方封面 + 名字 + 主播 / 期数。
 * 点开进播客详情；外壳用 CoverCard，和专辑墙、歌单墙一个手感。
 */
import { useNavigate } from 'react-router-dom'
import { CoverCard } from '@/components/common/CoverCard'
import { ImageWithFallback } from '@/components/common/ImageWithFallback'
import { SourceBadge } from '@/components/sources/SourceBadge'
import { findAdapterFor } from '@/api'
import type { Podcast } from '@/api/types'
import { spaceCJK } from '@/utils/cjkTypography'
import { useT } from '@/i18n'

export function podcastPath(podcast: Pick<Podcast, 'serverId' | 'id'>): string {
  return `/podcasts/${encodeURIComponent(podcast.serverId)}/${encodeURIComponent(podcast.id)}`
}

export function podcastCoverUrl(podcast: Pick<Podcast, 'serverId' | 'coverArt'>, size: number): string | undefined {
  if (!podcast.coverArt) return undefined
  return findAdapterFor(podcast.serverId)?.getCoverUrl(podcast.coverArt, size) ?? podcast.coverArt
}

export function PodcastCard({ podcast, showSource = false }: { podcast: Podcast; showSource?: boolean }) {
  const { t } = useT()
  const navigate = useNavigate()
  const meta = [
    podcast.author,
    podcast.episodeCount ? t('podcast.episodes', { count: podcast.episodeCount }) : undefined,
  ].filter(Boolean).join(' · ')
  return (
    <CoverCard
      aria-label={podcast.name}
      onClick={() => navigate(podcastPath(podcast), { state: { name: podcast.name } })}
      tile={
        <ImageWithFallback
          src={podcastCoverUrl(podcast, 300)}
          alt={podcast.name}
          fallbackType="album"
          className="h-full w-full object-cover"
        />
      }
      overlay={
        showSource || podcast.paid ? (
          <span className="absolute left-2 top-2 flex items-center gap-1">
            {showSource && (
              <span className="flex items-center rounded-pill bg-surface px-2 py-1 shadow-sm">
                <SourceBadge serverId={podcast.serverId} />
              </span>
            )}
            {podcast.paid && (
              <span className="rounded-pill bg-surface px-2 py-0.5 text-[11.5px] font-semibold text-ink-2 shadow-sm">
                {t('podcast.paid')}
              </span>
            )}
          </span>
        ) : undefined
      }
      title={spaceCJK(podcast.name)}
      meta={meta ? spaceCJK(meta) : undefined}
    />
  )
}
