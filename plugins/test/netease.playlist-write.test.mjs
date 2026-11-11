/**
 * 阶段 1.1 回归：网易云「加入/移出歌单」必须经宿主真正调用的路径可达。
 * 用户路径：设置页声明了 playlistWrite → AddToPlaylistDialog 列出该源 →
 * 建/加/删真的发对请求。宿主只调 n1ko.user.*，不遍历导出。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './harness.mjs'

/** 与 sandbox-call.test.mjs / runtime.ts 的 collectMethodPaths 同形（复核 F21） */
function collectMethodPaths(exports) {
  const paths = []
  const walk = (obj, prefix, depth) => {
    for (const key of Object.keys(obj)) {
      if (prefix === '' && (key === 'platform' || key === 'version')) continue
      const value = obj[key]
      const path = prefix ? `${prefix}.${key}` : key
      if (typeof value === 'function') paths.push(path)
      else if (value && typeof value === 'object' && depth < 2) walk(value, path, depth + 1)
    }
  }
  walk(exports, '', 0)
  return paths
}

const cred = JSON.stringify({ MUSIC_U: 'cookie-a' })
const CRED = { credentials: cred }

test('宿主能力探测路径：n1ko.user.createPlaylist 存在且真能调通', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    calls.push({ u, body: init.body })
    if (u.includes('/weapi/playlist/create')) {
      return new Response(JSON.stringify({ code: 200, playlist: { id: 991, name: '新单' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ code: 200 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const { plugin } = await loadPlugin('plugins/netease', CRED)
    /*
     * 按宿主的能力表探测路径（复核 F21：旧写法是 assert.ok(true) 的空断言，
     * 方法挪丢也照样绿）。宿主（plugin.ts）的挂载判定就是
     * hasMethod('n1ko.user.createPlaylist')——三条写方法必须在 n1ko.user 下，
     * 顶层 user.* 不得再出现写方法（宿主唯一调用面）。
     */
    const paths = collectMethodPaths(plugin)
    for (const m of ['n1ko.user.createPlaylist', 'n1ko.user.addToPlaylist', 'n1ko.user.removeFromPlaylist']) {
      assert.ok(paths.includes(m), `方法路径 ${m} 必须存在（宿主只认这条路径）`)
    }
    for (const m of ['user.createPlaylist', 'user.addToPlaylist', 'user.removeFromPlaylist']) {
      assert.ok(!paths.includes(m), `顶层 ${m} 必须不存在（宿主不调用这个面）`)
    }

    const sheet = await plugin.n1ko.user.createPlaylist('新单')
    assert.equal(sheet.id, '991')
    assert.equal(sheet.title, '新单')
    assert.equal(sheet.platform, 'netease', 'SheetItem 必须带 platform，跨源跳转才不回落主库')
    assert.ok(calls.some(c => c.u.includes('/weapi/playlist/create')))
  } finally {
    globalThis.fetch = realFetch
  }
})

test('加歌 / 移歌走 manipulate/tracks，op 正确', async () => {
  const ops = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('/eapi/playlist/manipulate/tracks')) {
      ops.push(init.body)
    }
    return new Response(JSON.stringify({ code: 200 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const { plugin } = await loadPlugin('plugins/netease', CRED)
    // eapi 的 body 是 AES 加密的 params，从外面看不到 op/pid——
    // 这里验证两件事：请求真的打到 manipulate/tracks（不是被能力拦截），
    // 且两种操作都成功返回（宿主把非 200 当失败）。
    const added = await plugin.n1ko.user.addToPlaylist({ id: '77', title: '目标单' }, [{ id: '101' }, { id: '102' }])
    assert.equal(added.status, 200)
    const removed = await plugin.n1ko.user.removeFromPlaylist({ id: '77' }, [{ id: '101' }])
    assert.equal(removed.status, 200)
    assert.equal(ops.length, 2, '加/移各打一次 manipulate/tracks')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('顶层 user: 不再暴露写方法（宿主唯一调用面是 n1ko.user）', async () => {
  const { plugin } = await loadPlugin('plugins/netease', CRED)
  assert.equal(typeof plugin.user.createPlaylist, 'undefined')
  assert.equal(typeof plugin.user.addToPlaylist, 'undefined')
  assert.equal(typeof plugin.user.removeFromPlaylist, 'undefined')
  // 读方法保留（module.exports.requireLogin 那几处还在用）
  assert.equal(typeof plugin.user.getPlaylists, 'function')
})

test('收藏：先走 eapi 的 radio/like；被风控就改走「我喜欢的音乐」歌单，并记住', async () => {
  const hits = []
  let likeCode = 200
  let manipulateCode = 200
  const realFetch = globalThis.fetch
  const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    hits.push({ u, body: String(init && init.body || '') })
    if (u.includes('radio/like')) return json({ code: likeCode })
    if (u.includes('nuser/account/get')) return json({ code: 200, account: { id: 42 }, profile: { userId: 42 } })
    if (u.includes('user/playlist')) {
      return json({ code: 200, playlist: [
        { id: 7001, name: '我喜欢的音乐', specialType: 5, creator: { userId: 42 } },
        { id: 7002, name: '别的歌单', specialType: 0, creator: { userId: 42 } },
      ] })
    }
    if (u.includes('playlist/manipulate/tracks')) return json({ code: manipulateCode, body: { code: manipulateCode } })
    return json({ code: 200 })
  }
  try {
    const { plugin } = await loadPlugin('plugins/netease', CRED)
    const item = { platform: 'netease', id: '3347295437' }

    // 正常账号：红心接口直接成功，走的是 eapi
    await plugin.n1ko.user.setFavorite(item, true)
    const like = hits.filter(h => h.u.includes('radio/like'))
    assert.equal(like.length, 1)
    assert.ok(like[0].u.includes('/eapi/radio/like'), `应走 eapi：${like[0].u}`)
    assert.ok(!hits.some(h => h.u.includes('/weapi/radio/like')), '不能再走 weapi')

    // 红心接口被风控：改走歌单（op=add，pid 是「我喜欢的音乐」）
    hits.length = 0
    likeCode = -460
    await plugin.n1ko.user.setFavorite(item, true)
    const manip = hits.filter(h => h.u.includes('playlist/manipulate/tracks'))
    assert.equal(manip.length, 1, '被拦后应改走歌单')

    // 记住了：下一次直接走歌单，不再去撞红心接口
    hits.length = 0
    await plugin.n1ko.user.setFavorite(item, false)
    assert.equal(hits.filter(h => h.u.includes('radio/like')).length, 0, '记住之后不再请求红心接口')
    assert.equal(hits.filter(h => h.u.includes('playlist/manipulate/tracks')).length, 1)

    // 已在歌单里（502）算成功；其他失败码要报错
    manipulateCode = 502
    await plugin.n1ko.user.setFavorite(item, true)
    manipulateCode = 500
    await assert.rejects(() => plugin.n1ko.user.setFavorite(item, true), /收藏失败/)
  } finally {
    globalThis.fetch = realFetch
  }
})
