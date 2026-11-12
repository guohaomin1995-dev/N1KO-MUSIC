import { beforeEach, describe, expect, it } from 'vitest'
import type { Song } from '@/api/types'
import {
  continueListening,
  episodeKey,
  podcastResumeSeconds,
  usePodcastProgressStore,
} from './podcastProgressStore'

const episode = (id: string, duration = 3600): Song => ({
  id, title: `节目 ${id}`, artist: '主播', album: '某播客', duration, serverId: 'wy',
  ext: { podcast: { podcastId: 'p1', podcastName: '某播客', description: '很长的简介'.repeat(50), episode: 3 } },
})
const song: Song = { id: 's1', title: '歌', artist: '歌手', album: '专辑', duration: 3600, serverId: 'wy' }

beforeEach(() => usePodcastProgressStore.setState({ entries: {} }))

describe('收听进度', () => {
  it('才听几秒不记；记下的快照不带长简介', () => {
    const ep = episode('1')
    usePodcastProgressStore.getState().record(ep, 4)
    expect(usePodcastProgressStore.getState().entries).toEqual({})
    usePodcastProgressStore.getState().record(ep, 600)
    const entry = usePodcastProgressStore.getState().entries[episodeKey(ep)]
    expect(entry).toMatchObject({ position: 600, duration: 3600, finished: false })
    expect(entry.song.ext?.podcast?.description).toBeUndefined()
    expect(entry.song.ext?.podcast?.podcastName).toBe('某播客')
  })

  it('离结尾 30 秒以内算听完；听完的不续、从头放', () => {
    const ep = episode('1')
    usePodcastProgressStore.getState().record(ep, 3580)
    expect(usePodcastProgressStore.getState().entries[episodeKey(ep)].finished).toBe(true)
    expect(podcastResumeSeconds(ep)).toBeNull()
  })

  it('听到一半的从记下的位置往回倒 3 秒接着放', () => {
    const ep = episode('1')
    usePodcastProgressStore.getState().record(ep, 1200)
    expect(podcastResumeSeconds(ep)).toBe(1197)
  })

  it('不是节目的歌不走这套（长音轨书签另有服务端那条路）', () => {
    expect(podcastResumeSeconds(song)).toBeNull()
  })

  it('手动标记听完 / 没听', () => {
    const ep = episode('1')
    usePodcastProgressStore.getState().setFinished(ep, true)
    expect(usePodcastProgressStore.getState().entries[episodeKey(ep)]).toMatchObject({ finished: true, position: 3600 })
    usePodcastProgressStore.getState().setFinished(ep, false)
    expect(usePodcastProgressStore.getState().entries[episodeKey(ep)]).toMatchObject({ finished: false, position: 0 })
    expect(podcastResumeSeconds(ep)).toBeNull()
    // 从没听过的标记「没听」不新建条目
    usePodcastProgressStore.getState().setFinished(episode('2'), false)
    expect(usePodcastProgressStore.getState().entries[episodeKey(episode('2'))]).toBeUndefined()
  })

  it('继续收听：只列听了一部分、没听完的，最近听的在前', async () => {
    const { record } = usePodcastProgressStore.getState()
    record(episode('a'), 300)
    await new Promise(r => setTimeout(r, 2))
    record(episode('b'), 3590) // 听完了
    await new Promise(r => setTimeout(r, 2))
    record(episode('c'), 100)
    const list = continueListening(usePodcastProgressStore.getState().entries)
    expect(list.map(e => e.song.id)).toEqual(['c', 'a'])
  })

  it('最多留 200 期，挤掉最久没听的', () => {
    const entries: Record<string, ReturnType<typeof usePodcastProgressStore.getState>['entries'][string]> = {}
    for (let i = 0; i < 200; i++) {
      const ep = episode(`old${i}`)
      entries[episodeKey(ep)] = { position: 100, duration: 3600, finished: false, updatedAt: i, song: ep }
    }
    usePodcastProgressStore.setState({ entries })
    usePodcastProgressStore.getState().record(episode('new'), 500)
    const keys = Object.keys(usePodcastProgressStore.getState().entries)
    expect(keys).toHaveLength(200)
    expect(keys).toContain(episodeKey(episode('new')))
    expect(keys).not.toContain(episodeKey(episode('old0')))
  })
})
