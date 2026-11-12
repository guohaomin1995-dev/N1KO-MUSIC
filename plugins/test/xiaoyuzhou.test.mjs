/**
 * 小宇宙（免登录）：读网页 __NEXT_DATA__、分享链接识别、本地订阅、粘贴过的老单集、取流。
 * 全部走假 fetch，页面按真实页面的字段形状造（字段名取自 2026-11 的 xiaoyuzhoufm.com）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './harness.mjs'

const PID = '5e4ee557418a84a0466737b7'
const EID = (n) => `6af2df3ab4a4e20202f7ae${String(n).padStart(2, '0')}`
const IMAGE = {
  picUrl: 'https://image.xyzcdn.net/Fr', largePicUrl: 'https://image.xyzcdn.net/Fr@large', middlePicUrl: 'https://image.xyzcdn.net/Fr@middle',
}
const PODCAST = {
  type: 'PODCAST', pid: PID, title: '忽左忽右', author: 'JustPod', brief: '文化类播客', description: '基于经验视角提供内容的文化类播客',
  subscriptionCount: 1276305, image: IMAGE, episodeCount: 10, payType: 'PAY_EPISODE_PODCAST', latestEpisodePubDate: '2026-11-10T09:21:41.931Z',
}
const episode = (n, extra = {}) => ({
  type: 'EPISODE', eid: EID(n), pid: PID, title: `第 ${n} 期`, description: `本期简介 ${n}`, duration: 4000 + n,
  enclosure: { url: `https://media.xyzcdn.net/${PID}/ep${n}.m4a` },
  media: { source: { mode: 'PUBLIC', url: `https://media.xyzcdn.net/${PID}/ep${n}.m4a` } },
  isPrivateMedia: false, payType: 'FREE', pubDate: `2026-11-${String(n).padStart(2, '0')}T08:00:00.000Z`,
  ...extra,
})

const page = (pageProps) => new Response(
  `<html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps } })}</script></body></html>`,
  { status: 200, headers: { 'content-type': 'text/html' } },
)

/** 节目页给 10、9、8 期（8 期付费）；单集页按 eid 给 */
function site(extra = {}) {
  return (url) => {
    if (url.endsWith(`/podcast/${PID}`)) {
      return page({ podcast: { ...PODCAST, episodes: [episode(10), episode(9), episode(8, { payType: 'PAY_EPISODE', isPrivateMedia: true, media: { source: { mode: 'PRIVATE' } }, enclosure: undefined })] } })
    }
    const m = /\/episode\/([0-9a-f]{24})$/.exec(url)
    if (m) {
      const n = Number(m[1].slice(-2))
      return page({ episode: { ...episode(n), podcast: PODCAST } })
    }
    return extra[url] ?? new Response('not found', { status: 404 })
  }
}

function stubFetch(handler) {
  const realFetch = globalThis.fetch
  const hits = []
  globalThis.fetch = async (url, init) => {
    hits.push({ url: String(url), redirect: init?.redirect })
    return handler(String(url))
  }
  return { hits, restore: () => { globalThis.fetch = realFetch } }
}

test('节目链接 → 节目：标题、主播、期数、订阅数、大图；部分单集收费的节目不标整体付费', async () => {
  const stub = stubFetch(site())
  try {
    const { plugin } = await loadPlugin('plugins/xiaoyuzhou')
    const res = await plugin.n1ko.podcast.search(`【小宇宙】忽左忽右 https://www.xiaoyuzhoufm.com/podcast/${PID}?s=abc`, 1)
    assert.equal(res.isEnd, true)
    assert.equal(res.data.length, 1)
    assert.deepEqual(res.data[0], {
      platform: 'xiaoyuzhou', id: PID, title: '忽左忽右', artwork: 'https://image.xyzcdn.net/Fr@large',
      description: '基于经验视角提供内容的文化类播客', author: 'JustPod', episodes: 10, subscribers: 1276305,
      subscribed: false, lastEpisodeAt: Date.parse('2026-11-10T09:21:41.931Z'), paid: false,
    })
  } finally {
    stub.restore()
  }
})

test('关键词（不是链接）：不发请求、回空', async () => {
  const stub = stubFetch(site())
  try {
    const { plugin } = await loadPlugin('plugins/xiaoyuzhou')
    const res = await plugin.n1ko.podcast.search('忽左忽右', 1)
    assert.deepEqual(res, { data: [], isEnd: true })
    assert.equal(stub.hits.length, 0)
  } finally {
    stub.restore()
  }
})

test('节目列表：最新在前、付费单集标 vip 且没有直链、partial 标出列表不全；最早就是倒过来', async () => {
  const stub = stubFetch(site())
  try {
    const { plugin } = await loadPlugin('plugins/xiaoyuzhou')
    const res = await plugin.n1ko.podcast.getEpisodes({ id: PID }, 1, 'newest')
    assert.equal(res.isEnd, true)
    assert.equal(res.total, 10)
    assert.equal(res.partial, true)
    assert.deepEqual(res.data.map(e => e.id), [EID(10), EID(9), EID(8)])
    const [ep10, , ep8] = res.data
    assert.equal(ep10.artist, 'JustPod')
    assert.equal(ep10.album, '忽左忽右')
    assert.equal(ep10.duration, 4010)
    assert.equal(ep10.vip, false)
    assert.equal(ep10.audioUrl, `https://media.xyzcdn.net/${PID}/ep10.m4a`)
    assert.equal(ep10.artwork, 'https://image.xyzcdn.net/Fr@large')
    assert.deepEqual(ep10.podcast, { id: PID, title: '忽左忽右', publishedAt: Date.parse('2026-11-10T08:00:00.000Z'), description: '本期简介 10' })
    assert.equal(ep8.vip, true)
    assert.equal(ep8.audioUrl, undefined)
    const oldest = await plugin.n1ko.podcast.getEpisodes({ id: PID }, 1, 'oldest')
    assert.deepEqual(oldest.data.map(e => e.id), [EID(8), EID(9), EID(10)])
    assert.deepEqual(await plugin.n1ko.podcast.getEpisodes({ id: PID }, 2, 'newest'), { data: [], isEnd: true })
    // 一分钟内同一节目页只请求一次
    assert.equal(stub.hits.filter(h => h.url.endsWith(`/podcast/${PID}`)).length, 1)
  } finally {
    stub.restore()
  }
})

test('单集链接：找到所属节目，并且这一期（哪怕早于最新那批）以后出现在列表里', async () => {
  const stub = stubFetch(site())
  try {
    const { plugin } = await loadPlugin('plugins/xiaoyuzhou')
    const res = await plugin.n1ko.podcast.search(`https://www.xiaoyuzhoufm.com/episode/${EID(3)}`, 1)
    assert.equal(res.data[0].id, PID)
    const list = await plugin.n1ko.podcast.getEpisodes({ id: PID }, 1, 'newest')
    assert.deepEqual(list.data.map(e => e.id), [EID(10), EID(9), EID(8), EID(3)])
    assert.equal(list.data[3].audioUrl, `https://media.xyzcdn.net/${PID}/ep3.m4a`)
  } finally {
    stub.restore()
  }
})

test('xyzfm.link 短链接：一跳一跳读 Location 找到节目；裸 id 先当节目、不是再当单集', async () => {
  const short = 'https://xyzfm.link/s/AbC123'
  const stub = stubFetch(site({
    [short]: new Response(null, { status: 302, headers: { location: `https://www.xiaoyuzhoufm.com/podcast/${PID}?s=x` } }),
  }))
  try {
    const { plugin } = await loadPlugin('plugins/xiaoyuzhou')
    const res = await plugin.n1ko.podcast.search(`快来听 ${short} 复制打开`, 1)
    assert.equal(res.data[0].id, PID)
    assert.equal(stub.hits.find(h => h.url === short).redirect, 'manual')
    const byEpisodeId = await plugin.n1ko.podcast.search(EID(5), 1)
    assert.equal(byEpisodeId.data[0].id, PID)
  } finally {
    stub.restore()
  }
})

test('订阅存在本地：订阅 / 列表 / 详情带订阅状态 / 取消', async () => {
  const stub = stubFetch(site())
  try {
    const { plugin } = await loadPlugin('plugins/xiaoyuzhou')
    assert.deepEqual(await plugin.n1ko.podcast.getSubscribed(1), { data: [], isEnd: true })
    // 宿主缓存没命中时只回传 id：插件自己读节目页补全
    await plugin.n1ko.podcast.setSubscribed({ platform: 'xiaoyuzhou', id: PID, title: '' }, true)
    const subs = await plugin.n1ko.podcast.getSubscribed(1)
    assert.equal(subs.data.length, 1)
    assert.equal(subs.data[0].title, '忽左忽右')
    assert.equal(subs.data[0].subscribed, true)
    assert.equal(subs.data[0].subscribedAt, undefined)
    const detail = await plugin.n1ko.podcast.getDetail({ id: PID })
    assert.equal(detail.subscribed, true)
    await plugin.n1ko.podcast.setSubscribed(detail, false)
    assert.deepEqual((await plugin.n1ko.podcast.getSubscribed(1)).data, [])
    assert.equal((await plugin.n1ko.podcast.getDetail({ id: PID })).subscribed, false)
  } finally {
    stub.restore()
  }
})

test('取流：有直链直接给；没有就读单集页；付费单集抛 forbidden', async () => {
  const stub = stubFetch(site())
  try {
    const { plugin } = await loadPlugin('plugins/xiaoyuzhou')
    assert.deepEqual(await plugin.getMediaSource({ id: EID(10), audioUrl: 'https://media.xyzcdn.net/x.m4a' }), { url: 'https://media.xyzcdn.net/x.m4a' })
    assert.equal(stub.hits.length, 0)
    assert.deepEqual(await plugin.n1ko.getMediaSource({ platform: 'xiaoyuzhou', id: EID(4) }), { url: `https://media.xyzcdn.net/${PID}/ep4.m4a` })
    const paidSite = (url) => page({ episode: episode(7, { payType: 'PAY_EPISODE', isPrivateMedia: true }) })
    stub.restore()
    const stub2 = stubFetch(paidSite)
    try {
      await assert.rejects(plugin.getMediaSource({ id: EID(7) }), err => err.code === 'forbidden')
    } finally {
      stub2.restore()
    }
  } finally {
    stub.restore()
  }
})

test('找不到 → not-found；页面结构变了 → unknown（不当成空列表）', async () => {
  const stub = stubFetch((url) => url.includes('/podcast/aaaaaaaaaaaaaaaaaaaaaaaa')
    ? new Response('<html>改版了</html>', { status: 200 })
    : new Response('not found', { status: 404 }))
  try {
    const { plugin } = await loadPlugin('plugins/xiaoyuzhou')
    await assert.rejects(plugin.n1ko.podcast.getDetail({ id: 'bbbbbbbbbbbbbbbbbbbbbbbb' }), err => err.code === 'not-found')
    await assert.rejects(plugin.n1ko.podcast.getEpisodes({ id: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, 1, 'newest'), err => err.code === 'unknown')
  } finally {
    stub.restore()
  }
})
