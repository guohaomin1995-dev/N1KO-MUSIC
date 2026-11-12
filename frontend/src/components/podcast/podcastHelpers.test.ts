import { describe, expect, it } from 'vitest'
import type { Song } from '@/api/types'
import { t } from '@/i18n'
import { episodeQueueFrom, firstPlayableEpisode } from './episodeQueue'
import { formatEpisodeLength } from './podcastFormat'

const ep = (id: string, vip = false): Song => ({
  id, title: id, artist: '主播', album: '电台', duration: 600, serverId: 'wy', vip,
  ext: { podcast: { podcastId: 'p', podcastName: '电台' } },
})

describe('节目时长', () => {
  it('先取整到分钟再拆小时：59 分 50 秒是 1 小时，不是 60 分钟', () => {
    expect(formatEpisodeLength(3590, t)).toBe(t('podcast.hours', { h: 1 }))
    expect(formatEpisodeLength(3600 + 5 * 60, t)).toBe(t('podcast.hoursMinutes', { h: 1, m: 5 }))
    expect(formatEpisodeLength(52 * 60 + 10, t)).toBe(t('podcast.minutes', { n: 52 }))
    expect(formatEpisodeLength(20, t)).toBe(t('podcast.minutes', { n: 1 }))
  })
})

describe('从节目列表起播的队列', () => {
  it('付费没买的不进队列，点的那一期照放', () => {
    const list = [ep('a', true), ep('b'), ep('c', true), ep('d')]
    expect(episodeQueueFrom(list, 1)).toEqual({ queue: [list[1], list[3]], start: 0 })
    const fromPaid = episodeQueueFrom(list, 2)
    expect(fromPaid.queue.map(s => s.id)).toEqual(['b', 'c', 'd'])
    expect(fromPaid.start).toBe(1)
  })

  it('主按钮从第一期能放的开始；全是付费的就第一期', () => {
    expect(firstPlayableEpisode([ep('a', true), ep('b'), ep('c')])).toBe(1)
    expect(firstPlayableEpisode([ep('a', true), ep('b', true)])).toBe(0)
  })
})
