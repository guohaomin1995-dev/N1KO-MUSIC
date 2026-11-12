/**
 * 插件音源的播客：capability 与方法挂载、播客 / 节目的映射（ext.podcast）、原项回传。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { PluginAdapter, type PluginHostLike } from './plugin'
import type { MusicItem, PluginManifest, PodcastItem } from '@/plugins/types'
import { PluginCallError } from '@/plugins/host/PluginHost'
import { resetRawCacheForTests } from '@/plugins/mapping'

function manifest(capabilities: string[]): PluginManifest {
  return {
    id: 'netease', name: '网易云音乐', version: '0.1.17', protocol: 1, platform: 'netease',
    entry: 'index.js', auth: { kind: 'qr' }, hosts: ['*.music.126.net'], capabilities, disclaimer: 'x',
  }
}

function fakeHost(handlers: Record<string, (...args: unknown[]) => unknown>): PluginHostLike & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = []
  return {
    calls,
    hasMethod: m => m in handlers,
    call: async <T>(m: string, ...args: unknown[]) => {
      calls.push([m, args])
      const fn = handlers[m]
      if (!fn) throw new PluginCallError('not-found', m)
      return fn(...args) as T
    },
  }
}

const radio: PodcastItem = {
  platform: 'netease', id: '42', title: '你，静不下来', artwork: 'https://p1.music.126.net/a.jpg',
  description: '简介', author: '李静', category: '情感', episodes: 76, subscribers: 12369, subscribed: false, paid: false,
}
const episode = (n: number): MusicItem => ({
  platform: 'netease', id: String(9000 + n), title: `第 ${n} 期`, artist: '李静', album: '你，静不下来',
  artwork: 'https://p1.music.126.net/c.jpg', duration: 3600,
  podcast: { id: '42', title: '你，静不下来', publishedAt: 1700000000000, description: '本期', episode: n },
})

beforeEach(() => resetRawCacheForTests())

describe('播客能力', () => {
  it('声明 podcasts 且有 n1ko.podcast.getEpisodes 才算有；只声明不实现按没有处理', () => {
    const full = new PluginAdapter({
      serverId: 'wy', manifest: manifest(['podcasts']),
      host: fakeHost({ 'n1ko.podcast.getEpisodes': () => ({ data: [], isEnd: true }) }),
    })
    expect(full.getSourceCapabilities().podcasts).toBe(true)
    expect(typeof full.getPodcastEpisodes).toBe('function')
    // 只有节目列表时其余方法不挂
    expect(full.getSubscribedPodcasts).toBeUndefined()
    expect(full.setPodcastSubscribed).toBeUndefined()

    const declaredOnly = new PluginAdapter({ serverId: 'wy', manifest: manifest(['podcasts']), host: fakeHost({}) })
    expect(declaredOnly.getSourceCapabilities().podcasts).toBe(false)
    expect(declaredOnly.getPodcastEpisodes).toBeUndefined()

    const undeclared = new PluginAdapter({
      serverId: 'wy', manifest: manifest([]),
      host: fakeHost({ 'n1ko.podcast.getEpisodes': () => ({ data: [], isEnd: true }) }),
    })
    expect(undeclared.getSourceCapabilities().podcasts).toBe(false)
    expect(undeclared.getPodcastEpisodes).toBeUndefined()
  })
})

describe('播客映射', () => {
  it('列表 → Podcast：封面过白名单，订阅数、期数、订阅状态照搬；坏条目丢掉', async () => {
    const adapter = new PluginAdapter({
      serverId: 'wy', manifest: manifest(['podcasts']),
      host: fakeHost({
        'n1ko.podcast.getEpisodes': () => ({ data: [], isEnd: true }),
        'n1ko.podcast.getRecommended': () => ({
          data: [radio, { ...radio, id: '43', artwork: 'https://evil.test/x.jpg', subscribed: undefined }, null, { title: '没有 id' }],
          isEnd: true,
        }),
      }),
    })
    const list = await adapter.getRecommendedPodcasts!()
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({
      id: '42', name: '你，静不下来', author: '李静', category: '情感',
      episodeCount: 76, subscriberCount: 12369, subscribed: false, serverId: 'wy',
    })
    expect(list[0].coverArt).toBe('https://p1.music.126.net/a.jpg')
    expect(list[1].coverArt).toBeUndefined()
    expect(list[1].subscribed).toBeUndefined()
  })

  it('节目 → Song，ext.podcast 带所属播客、期数、发布时间', async () => {
    const adapter = new PluginAdapter({
      serverId: 'wy', manifest: manifest(['podcasts']),
      host: fakeHost({ 'n1ko.podcast.getEpisodes': () => ({ data: [episode(76), episode(75)], isEnd: false, total: 76 }) }),
    })
    const page = await adapter.getPodcastEpisodes!('42', 1, 'newest')
    expect(page.isEnd).toBe(false)
    expect(page.total).toBe(76)
    expect(page.episodes[0]).toMatchObject({ id: '9076', title: '第 76 期', serverId: 'wy', duration: 3600 })
    expect(page.episodes[0].ext?.podcast).toEqual({
      podcastId: '42', podcastName: '你，静不下来', publishedAt: 1700000000000, description: '本期', episode: 76,
    })
  })

  it('详情和订阅开关回传缓存的原项（插件要的私有字段不丢）', async () => {
    const host = fakeHost({
      'n1ko.podcast.getEpisodes': () => ({ data: [], isEnd: true }),
      'n1ko.podcast.search': () => ({ data: [{ ...radio, secret: 'keep-me' }], isEnd: true }),
      'n1ko.podcast.getDetail': (item: unknown) => ({ ...(item as PodcastItem), subscribed: true }),
      'n1ko.podcast.setSubscribed': () => undefined,
    })
    const adapter = new PluginAdapter({ serverId: 'wy', manifest: manifest(['podcasts']), host })
    await adapter.searchPodcasts!('静', 1)
    const detail = await adapter.getPodcast!('42')
    expect(detail.subscribed).toBe(true)
    await adapter.setPodcastSubscribed!('42', false)
    const detailCall = host.calls.find(([m]) => m === 'n1ko.podcast.getDetail')!
    expect((detailCall[1][0] as Record<string, unknown>).secret).toBe('keep-me')
    const subCall = host.calls.find(([m]) => m === 'n1ko.podcast.setSubscribed')!
    expect(subCall[1][1]).toBe(false)
  })

  it('详情回空 → not-found', async () => {
    const adapter = new PluginAdapter({
      serverId: 'wy', manifest: manifest(['podcasts']),
      host: fakeHost({ 'n1ko.podcast.getEpisodes': () => ({ data: [], isEnd: true }), 'n1ko.podcast.getDetail': () => null }),
    })
    await expect(adapter.getPodcast!('42')).rejects.toMatchObject({ code: 'not-found' })
  })
})
