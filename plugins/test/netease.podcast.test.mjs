/**
 * 网易云播客（电台）：映射形状、排序参数、登录要求、订阅开关、非 200 不当空列表。
 * 全部走假 fetch（eapi 请求体是加密的，按 URL 路径分辨接口）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDecipheriv } from 'node:crypto'
import { loadPlugin } from './harness.mjs'

/** eapi 请求体（params=HEX）解回明文对象：url-36cd479b6b5-{json}-36cd479b6b5-md5 */
function eapiPlain(body) {
  const hex = new URLSearchParams(String(body)).get('params')
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from('e82ckenh8dichen8'), null)
  const text = Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString('utf8')
  return JSON.parse(text.split('-36cd479b6b5-')[1])
}

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

const RADIO = {
  id: 1230174483, name: '你，静不下来', picUrl: 'https://p1.music.126.net/a.jpg', desc: '简介',
  programCount: 76, subCount: 12369, category: '情感', radioFeeType: 0, subed: false,
  lastProgramCreateTime: 1793808378646, dj: { nickname: '李静' },
}
const PROGRAM = (n, extra = {}) => ({
  id: 3000 + n, name: `第 ${n} 期`, serialNum: n, duration: 3651657, createTime: 1700000000000 + n,
  coverUrl: 'https://p1.music.126.net/c.jpg', description: '本期简介', buyed: false, programFeeType: 0,
  mainSong: { id: 9000 + n, name: `song ${n}`, duration: 3651657 },
  radio: { id: 1230174483, name: '你，静不下来', picUrl: 'https://p1.music.126.net/a.jpg' },
  dj: { nickname: '李静' },
  ...extra,
})

/** 记下每次请求打到的 eapi 路径；handler 按路径回响应 */
function stubFetch(handler) {
  const realFetch = globalThis.fetch
  const hits = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    hits.push({ url: u, body: init && init.body })
    const res = handler(u)
    return res ?? json({ code: 200 })
  }
  return { hits, restore: () => { globalThis.fetch = realFetch } }
}

test('节目映射成 MusicItem：id 是 mainSong，podcast 私有字段带电台、期数、发布时间', async () => {
  const stub = stubFetch(u => u.includes('/dj/program/byradio')
    ? json({ code: 200, count: 76, more: true, programs: [PROGRAM(76), PROGRAM(75, { programFeeType: 15 })] })
    : undefined)
  try {
    const { plugin } = await loadPlugin('plugins/netease')
    const page = await plugin.n1ko.podcast.getEpisodes({ id: '1230174483', title: '你，静不下来' }, 1, 'newest')
    assert.equal(page.isEnd, false)
    assert.equal(page.total, 76)
    assert.equal(page.data.length, 2)
    const [ep] = page.data
    assert.equal(ep.id, '9076')
    assert.equal(ep.title, '第 76 期')
    assert.equal(ep.artist, '李静')
    assert.equal(ep.album, '你，静不下来')
    assert.equal(ep.albumId, undefined, '电台不是专辑，不给 albumId')
    assert.equal(ep.duration, 3652)
    assert.equal(ep.vip, false)
    assert.deepEqual(ep.podcast, {
      id: '1230174483', title: '你，静不下来', programId: '3076',
      publishedAt: 1700000000076, description: '本期简介', episode: 76,
    })
    assert.equal(page.data[1].vip, true, '付费节目（programFeeType >= 10 且没买）标 VIP')
  } finally {
    stub.restore()
  }
})

test('节目列表：最新 / 最早对应 asc，第 2 页 offset 50', async () => {
  const stub = stubFetch(u => u.includes('/dj/program/byradio') ? json({ code: 200, count: 76, more: false, programs: [] }) : undefined)
  try {
    const { plugin } = await loadPlugin('plugins/netease')
    await plugin.n1ko.podcast.getEpisodes({ id: '1' }, 2, 'oldest')
    const res = await plugin.n1ko.podcast.getEpisodes({ id: '1' }, 1, 'newest')
    assert.equal(res.isEnd, true)
    const sent = stub.hits.filter(h => h.url.includes('/dj/program/byradio')).map(h => eapiPlain(h.body))
    assert.equal(sent.length, 2)
    assert.equal(sent[0].asc, true)
    assert.equal(sent[0].offset, 50)
    assert.equal(sent[0].radioId, '1')
    assert.equal(sent[1].asc, false)
    assert.equal(sent[1].offset, 0)
  } finally {
    stub.restore()
  }
})

test('详情：subscribed 来自 subed；列表里不给就是 undefined（不知道），不当成没订', async () => {
  const stub = stubFetch(u => {
    if (u.includes('/djradio/v2/get')) return json({ code: 200, data: RADIO })
    if (u.includes('/djradio/recommend/v1')) return json({ code: 200, djRadios: [{ ...RADIO, subed: undefined, radioFeeType: 1 }] })
    return undefined
  })
  try {
    const { plugin } = await loadPlugin('plugins/netease')
    const detail = await plugin.n1ko.podcast.getDetail({ id: '1230174483' })
    assert.equal(detail.title, '你，静不下来')
    assert.equal(detail.author, '李静')
    assert.equal(detail.episodes, 76)
    assert.equal(detail.subscribers, 12369)
    assert.equal(detail.subscribed, false)
    assert.equal(detail.paid, false)
    const rec = await plugin.n1ko.podcast.getRecommended()
    assert.equal(rec.isEnd, true)
    assert.equal(rec.data[0].subscribed, undefined)
    assert.equal(rec.data[0].paid, true)
  } finally {
    stub.restore()
  }
})

test('推荐回空时退到热门电台', async () => {
  const stub = stubFetch(u => {
    if (u.includes('/djradio/recommend/v1')) return json({ code: 200, djRadios: [] })
    if (u.includes('/djradio/hot/v1')) return json({ code: 200, djRadios: [RADIO] })
    return undefined
  })
  try {
    const { plugin } = await loadPlugin('plugins/netease')
    const rec = await plugin.n1ko.podcast.getRecommended()
    assert.equal(rec.data.length, 1)
    assert.ok(stub.hits.some(h => h.url.includes('/djradio/hot/v1')))
  } finally {
    stub.restore()
  }
})

test('订阅列表与订阅开关要登录；未登录直接 unauthorized，不发请求', async () => {
  const stub = stubFetch(() => undefined)
  try {
    const { plugin } = await loadPlugin('plugins/netease')
    await assert.rejects(plugin.n1ko.podcast.getSubscribed(1), err => err.code === 'unauthorized')
    await assert.rejects(plugin.n1ko.podcast.setSubscribed({ id: '1' }, true), err => err.code === 'unauthorized')
    assert.equal(stub.hits.filter(h => h.url.includes('djradio')).length, 0)
  } finally {
    stub.restore()
  }
})

test('已登录：订阅列表全部标 subscribed，hasMore 决定末页；订阅 / 取消走 sub / unsub', async () => {
  const stub = stubFetch(u => {
    if (u.includes('/djradio/get/subed')) return json({ code: 200, hasMore: false, count: 1, djRadios: [{ ...RADIO, subed: undefined }] })
    if (u.includes('/djradio/sub') || u.includes('/djradio/unsub')) return json({ code: 200 })
    return undefined
  })
  try {
    const { plugin } = await loadPlugin('plugins/netease', { credentials: 'MUSIC_U=abc; __csrf=x' })
    const subs = await plugin.n1ko.podcast.getSubscribed(1)
    assert.equal(subs.isEnd, true)
    assert.equal(subs.data[0].subscribed, true)
    await plugin.n1ko.podcast.setSubscribed({ id: '1230174483' }, true)
    await plugin.n1ko.podcast.setSubscribed({ id: '1230174483' }, false)
    assert.ok(stub.hits.some(h => /\/djradio\/sub$/.test(new URL(h.url).pathname)))
    assert.ok(stub.hits.some(h => /\/djradio\/unsub$/.test(new URL(h.url).pathname)))
  } finally {
    stub.restore()
  }
})

test('非 200 不当空列表：406 报 rate-limited，其余报 unknown', async () => {
  let code = 406
  const stub = stubFetch(u => u.includes('/dj/program/byradio') ? json({ code }) : undefined)
  try {
    const { plugin } = await loadPlugin('plugins/netease')
    await assert.rejects(plugin.n1ko.podcast.getEpisodes({ id: '1' }, 1, 'newest'), err => err.code === 'rate-limited')
    code = 400
    await assert.rejects(plugin.n1ko.podcast.getEpisodes({ id: '1' }, 1, 'newest'), err => err.code === 'unknown')
  } finally {
    stub.restore()
  }
})
