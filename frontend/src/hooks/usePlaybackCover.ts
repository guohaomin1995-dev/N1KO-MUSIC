/**
 * 正在播放这首歌，屏幕上实际那张封面。
 *
 * 和播放条用的是同一套顺序：钉住的本地图、服务器封面、自定义封面接口。
 * 服务器没给 coverArt 时，播放条已经改显示自定义接口拉回来的图，
 * 取色和歌词底如果还去要那张不存在的服务器图，房间就会停在默认的青柠上。
 */
import type { Song } from '@/api/types'
import { useCustomCoverUrl } from '@/hooks/useServerQueries'
import { useCoverUrl, usePinnedCover } from '@/hooks/useCoverUrl'
import { useSettingsStore } from '@/store/settingsStore'

export function usePlaybackCover(song: Song | null | undefined, options: { size?: number } = {}): {
  /** 按展示顺序排，前面的失败了再用后面的 */
  urls: string[]
  /** 自定义封面还在下载，先别改成默认色 */
  pending: boolean
} {
  const { primary } = useCoverUrl(song ?? undefined, { size: options.size ?? 128 })
  const pinned = usePinnedCover(song?.id)
  const template = useSettingsStore(s => s.coverRemoteTemplate)
  const coverSource = useSettingsStore(s => s.coverSource)
  const params = song
    ? { type: 'song' as const, title: song.title, artist: song.artist, album: song.album, path: song.path }
    : null
  const custom = useCustomCoverUrl(template && params ? params : null)
  const customSrc = typeof custom.data === 'string' && custom.data ? custom.data : undefined

  const urls: string[] = []
  if (pinned) urls.push(pinned)
  if (coverSource === 'remote_only') {
    if (customSrc) urls.push(customSrc)
  } else if (coverSource === 'remote_first') {
    if (customSrc) urls.push(customSrc)
    if (primary) urls.push(primary)
  } else if (coverSource === 'server_only') {
    if (primary) urls.push(primary)
  } else {
    if (primary) urls.push(primary)
    if (customSrc) urls.push(customSrc)
  }

  const pending = !!song && !!template && !customSrc && !pinned && !primary
    && (custom.isLoading || custom.isFetching)

  return { urls, pending }
}
