/**
 * 给没有译文的外语歌词找译文：到已登录的流媒体音源（网易云、QQ 音乐）里按歌名和歌手搜同一首歌，
 * 拿它带译文的歌词，再按原文一句句配到手上这份歌词上（utils/lyricTranslation 的 alignTranslation）。
 *
 * 只用用户自己已经登录的音源，不经过任何别的服务。
 * 搜到的是不是同一首歌，最后由「原文配上了一半以上」把关：歌名撞了、其实是另一首歌时原文对不上，不会被采用。
 */

import { listAdapters } from '@/api'
import type { LyricLine, Song } from '@/api/types'
import { alignTranslation, hasTranslation, normalizeLyricText } from '@/utils/lyricTranslation'

/** 每个音源最多试几首搜索结果（每试一首是一次歌词请求） */
const CANDIDATES_PER_SOURCE = 2

/** 歌名里的版本说明不参与比对：「Yellow (Remastered 2011)」「Yellow - Live」 */
export function baseTitle(title: string): string {
  const stripped = title
    .replace(/[（(［[【][^）)\]］】]*[）)\]］】]/g, ' ')
    .replace(/\s[-–—]\s.*$/, '')
    .trim()
  return stripped || title.trim()
}

function artistNames(artist: string | undefined): string[] {
  if (!artist) return []
  return artist
    .split(/\s*(?:[/,;&、，；]|\bfeat\.?|\bft\.?|\bwith\b)\s*/i)
    .map(normalizeLyricText)
    .filter(Boolean)
}

/** 这首搜索结果像不像要找的歌：歌名对不上是 0（不试），歌名一样比互相包含高，歌手也对得上再加一分 */
export function matchScore(wanted: { title: string; artist?: string }, candidate: { title: string; artist?: string }): number {
  const a = normalizeLyricText(baseTitle(wanted.title))
  const b = normalizeLyricText(baseTitle(candidate.title))
  if (!a || !b) return 0
  const title = a === b ? 2 : a.includes(b) || b.includes(a) ? 1 : 0
  if (!title) return 0
  const want = artistNames(wanted.artist)
  const have = artistNames(candidate.artist)
  const artist = want.some(x => have.some(y => x === y || x.includes(y) || y.includes(x))) ? 1 : 0
  return title + artist
}

function pickCandidates(wanted: { title: string; artist?: string }, songs: Song[]): Song[] {
  return songs
    .map((song, order) => ({ song, order, score: matchScore(wanted, song) }))
    .filter(item => item.score > 0)
    .sort((x, y) => y.score - x.score || x.order - y.order)
    .slice(0, CANDIDATES_PER_SOURCE)
    .map(item => item.song)
}

/**
 * 找到就返回配好译文的歌词行；哪个音源都没有（或都对不上）返回 null。
 * skipServerId：这首歌自己的音源已经问过了，不再问一遍。
 */
export async function lookupLyricTranslation(
  lines: LyricLine[],
  song: { title: string; artist?: string },
  skipServerId?: string,
): Promise<LyricLine[] | null> {
  const title = baseTitle(song.title)
  if (!title) return null
  const query = [title, song.artist?.split(/[/,;&、，；]/)[0]?.trim()].filter(Boolean).join(' ')

  for (const { serverId, adapter } of listAdapters()) {
    if (serverId === skipServerId || adapter.type !== 'plugin' || !adapter.searchSongsPage) continue
    try {
      const { songs } = await adapter.searchSongsPage(query, 1)
      for (const candidate of pickCandidates(song, songs)) {
        const lyrics = await adapter.getLyrics(candidate.id, candidate.title, candidate.artist)
        if (!lyrics || !hasTranslation(lyrics.lines)) continue
        const aligned = alignTranslation(lines, lyrics.lines)
        if (aligned) return aligned
      }
    } catch {
      // 这个音源没登录、被限流或者接口变了：换下一个，找译文不该打断歌词本身
    }
  }
  return null
}
