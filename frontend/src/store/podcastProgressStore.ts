/**
 * 播客节目的收听进度（存在本机）。
 *
 * 一期播客动辄一个小时，很少一口气听完。听到哪儿记下来：再点这一期从上次的位置接着放，
 * 节目列表里标出「听到一半」「已听完」，播客页顶上排一行「继续收听」。
 *
 * 网易云不给第三方回写收听进度，所以只存在本机；按「音源 + 节目」记，
 * 同一期在不同账号下互不影响。条目里带一份节目快照（去掉了长简介），
 * 「继续收听」直接拿它播，不必再去网上查一遍。
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createPersistStorage } from '@/store/persistStorage'
import { STORAGE_KEYS } from '@/services/storageKeys'
import type { Song } from '@/api/types'

export interface EpisodeProgress {
  /** 听到哪儿（秒） */
  position: number
  /** 节目总长（秒）；节目信息里没有时取播放器读到的 */
  duration: number
  finished: boolean
  updatedAt: number
  /** 节目快照（不含简介） */
  song: Song
}

/** 听到离结尾这么近就算听完了（片尾一般是感谢收听和下期预告） */
export const NEAR_END_SECONDS = 30
/** 才听了这么一点不算「听过」：点开试听两秒就走的不进「继续收听」 */
export const MIN_RECORD_SECONDS = 10
/** 最多记这么多期，按最近收听留 */
const MAX_ENTRIES = 200

export function episodeKey(song: Pick<Song, 'serverId' | 'id'>): string {
  return `${song.serverId}|${song.id}`
}

export function isPodcastEpisode(song: Song | null | undefined): boolean {
  return !!song?.ext?.podcast
}

export function isNearEnd(position: number, duration: number): boolean {
  if (!(duration > 0)) return false
  return duration - position <= NEAR_END_SECONDS
}

/** 快照：去掉简介这类长字段，两百期也只占几十 KB */
function snapshot(song: Song): Song {
  const podcast = song.ext?.podcast
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    coverArt: song.coverArt,
    duration: song.duration,
    serverId: song.serverId,
    ...(song.vip ? { vip: true } : {}),
    ...(podcast
      ? {
          ext: {
            podcast: {
              podcastId: podcast.podcastId,
              podcastName: podcast.podcastName,
              publishedAt: podcast.publishedAt,
              episode: podcast.episode,
            },
          },
        }
      : {}),
  }
}

function prune(entries: Record<string, EpisodeProgress>): Record<string, EpisodeProgress> {
  const keys = Object.keys(entries)
  if (keys.length <= MAX_ENTRIES) return entries
  const kept = keys
    .sort((a, b) => entries[b].updatedAt - entries[a].updatedAt)
    .slice(0, MAX_ENTRIES)
  const out: Record<string, EpisodeProgress> = {}
  for (const key of kept) out[key] = entries[key]
  return out
}

interface PodcastProgressState {
  entries: Record<string, EpisodeProgress>
  /** 记一次位置（秒）。duration 不传就用节目信息里的 */
  record: (song: Song, position: number, duration?: number) => void
  /** 手动标记听完 / 没听 */
  setFinished: (song: Song, finished: boolean) => void
}

export const usePodcastProgressStore = create<PodcastProgressState>()(
  persist(
    (set) => ({
      entries: {},

      record: (song, position, duration) =>
        set(state => {
          const key = episodeKey(song)
          const existing = state.entries[key]
          if (!existing && position < MIN_RECORD_SECONDS) return state
          const total = song.duration || duration || existing?.duration || 0
          const pos = Math.max(0, Math.round(position))
          const finished = isNearEnd(pos, total)
          if (existing && existing.position === pos && existing.finished === finished) return state
          return {
            entries: prune({
              ...state.entries,
              [key]: { position: pos, duration: total, finished, updatedAt: Date.now(), song: snapshot(song) },
            }),
          }
        }),

      setFinished: (song, finished) =>
        set(state => {
          const key = episodeKey(song)
          const existing = state.entries[key]
          const total = song.duration || existing?.duration || 0
          if (!finished && !existing) return state
          return {
            entries: prune({
              ...state.entries,
              [key]: {
                position: finished ? total : 0,
                duration: total,
                finished,
                updatedAt: Date.now(),
                song: snapshot(song),
              },
            }),
          }
        }),
    }),
    {
      name: STORAGE_KEYS.podcastProgress,
      storage: createPersistStorage({ debounceMs: 1500 }),
      partialize: (state) => ({ entries: state.entries }),
    }
  )
)

/** 这一期该从哪儿接着放（秒）；没听过、已听完、或才听了一点点时返回 null */
export function podcastResumeSeconds(song: Song): number | null {
  if (!isPodcastEpisode(song)) return null
  const entry = usePodcastProgressStore.getState().entries[episodeKey(song)]
  if (!entry || entry.finished || entry.position < MIN_RECORD_SECONDS) return null
  const total = song.duration || entry.duration
  if (isNearEnd(entry.position, total)) return null
  // 往回倒几秒：接着听时先听到上次断开前的半句话，才接得上
  return Math.max(0, entry.position - 3)
}

/** 「继续收听」：听了一部分、还没听完的，最近听的在前 */
export function continueListening(entries: Record<string, EpisodeProgress>, limit = 12): EpisodeProgress[] {
  return Object.values(entries)
    .filter(e => !e.finished && e.position >= MIN_RECORD_SECONDS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
}
