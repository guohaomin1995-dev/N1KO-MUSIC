/**
 * 节目行：一期播客。
 *
 * 和歌曲行不一样的地方：标题可能很长（两行），要看发布日期和时长，还要看听到哪儿了——
 * 听了一半的显示「剩 23 分钟」和一条细进度，听完的打勾变淡。
 * 点整行从这一期开始放（续听由播放器按记下的位置接上），右边「⋯」里是下一个播放和标记听完。
 */
import { memo } from 'react'
import { Check, DotsThree, Play } from '@phosphor-icons/react'
import type { Song } from '@/api/types'
import { ImageWithFallback } from '@/components/common/ImageWithFallback'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { isVipSong } from '@/components/sources/VipTag'
import { findAdapterFor } from '@/api'
import type { EpisodeProgress } from '@/store/podcastProgressStore'
import { formatEpisodeDate, formatEpisodeLength } from '@/components/podcast/podcastFormat'
import { spaceCJK } from '@/utils/cjkTypography'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'

function episodeCover(song: Song): string | undefined {
  if (!song.coverArt) return undefined
  return findAdapterFor(song.serverId)?.getCoverUrl(song.coverArt, 120) ?? song.coverArt
}

export const EpisodeRow = memo(function EpisodeRow({
  song,
  progress,
  isCurrent,
  isPlaying,
  showCover = true,
  onPlay,
  onPlayNext,
  onSetFinished,
}: {
  song: Song
  progress?: EpisodeProgress
  isCurrent: boolean
  isPlaying: boolean
  showCover?: boolean
  onPlay: () => void
  onPlayNext: () => void
  onSetFinished: (finished: boolean) => void
}) {
  const { t, locale } = useT()
  const info = song.ext?.podcast
  const duration = song.duration || progress?.duration || 0
  const finished = !!progress?.finished
  const started = !finished && !!progress && progress.position > 0
  const ratio = started && duration > 0 ? Math.min(1, progress!.position / duration) : 0

  const meta: string[] = []
  const date = formatEpisodeDate(info?.publishedAt, locale)
  if (date) meta.push(date)
  if (info?.episode) meta.push(t('podcast.episodeNumber', { n: info.episode }))

  return (
    <div
      className={cn(
        'group relative flex items-start gap-3.5 rounded-md px-3 py-3 transition-colors duration-2 active:bg-ink/[0.08] [@media(hover:hover)]:hover:bg-ink/[0.05]',
        finished && !isCurrent && 'opacity-60'
      )}
    >
      {/* 整行可点：按钮铺满，菜单键在它上面单独接点击 */}
      <button
        type="button"
        onClick={onPlay}
        aria-label={`${t('action.play')} ${song.title}`}
        className="absolute inset-0 rounded-md"
      />

      {showCover && (
        <div className="cover-frame pointer-events-none relative mt-0.5 h-14 w-14 flex-none rounded-[10px] shadow-sm">
          <ImageWithFallback src={episodeCover(song)} alt="" fallbackType="album" className="h-full w-full object-cover" />
          {isCurrent && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/35" aria-hidden="true">
              {isPlaying ? (
                <span className="playing-bar text-white"><span /><span /><span /></span>
              ) : (
                <Play size={18} weight="fill" className="text-white" />
              )}
            </span>
          )}
        </div>
      )}

      <div className="pointer-events-none min-w-0 flex-1">
        {meta.length > 0 && (
          <p className="num mb-0.5 truncate text-[12.5px] font-medium text-ink-3">{meta.join(' · ')}</p>
        )}
        <p className={cn('line-clamp-2 text-[15px] font-semibold leading-snug', isCurrent ? 'text-leaf' : 'text-ink')}>
          {spaceCJK(song.title)}
          {isVipSong(song) && (
            // 付费节目要按电台买，和会员曲不是一回事，不借用 VIP 标记
            <span className="ml-1.5 inline-block translate-y-[-1px] rounded-pill bg-ink/[0.06] px-1.5 align-baseline font-sans text-[11px] font-semibold leading-[1.5] text-ink-3">
              {t('podcast.paid')}
            </span>
          )}
        </p>
        {info?.description && (
          <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-3">{info.description}</p>
        )}
        <div className="mt-2 flex items-center gap-2.5 text-[12.5px] text-ink-3">
          {finished ? (
            <span className="inline-flex items-center gap-1 font-medium text-leaf">
              <Check size={13} weight="bold" aria-hidden="true" />
              {t('podcast.finished')}
            </span>
          ) : started ? (
            <>
              {/* 细进度：不可拖，只表示听到哪儿 */}
              <span className="block h-1 w-16 overflow-hidden rounded-pill bg-ink/[0.12]" aria-hidden="true">
                <span className="block h-full origin-left rounded-pill bg-leaf" style={{ transform: `scaleX(${ratio})` }} />
              </span>
              <span className="num">{t('podcast.remaining', { time: formatEpisodeLength(duration - progress!.position, t) })}</span>
            </>
          ) : duration > 0 ? (
            <span className="num">{formatEpisodeLength(duration, t)}</span>
          ) : null}
        </div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="relative -mr-1 -mt-1 flex h-10 w-10 flex-none items-center justify-center rounded-pill text-ink-3 transition-colors hover:bg-ink/[0.06] hover:text-ink"
            aria-label={t('podcast.moreActions')}
          >
            <DotsThree size={22} weight="bold" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onPlayNext}>{t('podcast.playNext')}</DropdownMenuItem>
          {finished ? (
            <DropdownMenuItem onClick={() => onSetFinished(false)}>{t('podcast.markUnplayed')}</DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => onSetFinished(true)}>{t('podcast.markFinished')}</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})
