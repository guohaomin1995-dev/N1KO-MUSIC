/**
 * 从节目列表起播时的队列。
 *
 * 付费没买的节目（vip）放不了：留在队列里，放到它就是一条报错再跳下一期，
 * 整个付费电台连跳几期后播放器干脆停下。所以队列里只留能放的；
 * 用户点的那一期本身照放——放不了会说清原因，也可能这个账号其实能放。
 */
import type { Song } from '@/api/types'
import { isVipSong } from '@/components/sources/VipTag'

export function episodeQueueFrom(list: Song[], index: number): { queue: Song[]; start: number } {
  const picked = list[index]
  const queue = list.filter((song, i) => i === index || !isVipSong(song))
  return { queue, start: Math.max(0, queue.indexOf(picked)) }
}

/** 「播放最新一期 / 从第一期播放」：列表里第一期能放的，全付费时就第一期 */
export function firstPlayableEpisode(list: Song[]): number {
  const i = list.findIndex(song => !isVipSong(song))
  return i >= 0 ? i : 0
}
