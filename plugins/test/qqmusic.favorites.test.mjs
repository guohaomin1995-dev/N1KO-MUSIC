/**
 * QQ 音乐收藏（「我喜欢」歌单）：读走 CgiGetDiss（tid），写走 PlaylistDetailWrite（dirId 201），
 * 歌曲用数字 songId；宿主手里的条目没有 songId 时先按 mid 查。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './harness.mjs'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const CRED = {
  credentials: JSON.stringify({
    musicid: 12345, str_musicid: '12345', musickey: 'KEY', loginType: 2,
    // 远离到期，不触发刷新
    expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
  }),
}

function stub(handlers) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init && init.body || '{}'))
    const req = body.req_0 || {}
    const headers = (init && init.headers) || {}
    calls.push({ module: req.module, method: req.method, param: req.param, comm: body.comm, headers })
    const data = handlers[`${req.module}.${req.method}`]
    const payload = typeof data === 'function' ? data(req.param, body.comm, headers) : data
    return new Response(JSON.stringify({ code: 0, req_0: payload ?? { code: 0, data: {} } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  return calls
}

const PLAYLISTS = { code: 0, data: { v_playlist: [
  { tid: 3837773425, dirId: 201, dirName: '我喜欢', uin: 12345 },
  { tid: 999, dirId: 3, dirName: '睡觉', uin: 12345 },
] } }

test('收藏列表：找到「我喜欢」的 tid，用读歌单接口分页取', async () => {
  const calls = stub({
    'music.musicasset.PlaylistBaseRead.GetPlaylistByUin': PLAYLISTS,
    'music.srfDissInfo.DissInfo.CgiGetDiss': param => ({ code: 0, data: {
      dirinfo: { title: '我喜欢', songnum: 1 },
      songlist: param.disstid === 3837773425
        ? [{ id: 107192078, mid: '003OUlho2HcRHC', title: '告白气球', interval: 215, singer: [{ name: '周杰伦', mid: 'x' }], album: { mid: 'a', title: 'b' } }]
        : [],
    } }),
  })
  const { plugin } = await loadPlugin('plugins/qqmusic', CRED)
  const page = await plugin.n1ko.user.getFavorites(1)
  assert.equal(page.data.length, 1)
  assert.equal(page.data[0].id, '003OUlho2HcRHC')
  assert.equal(page.data[0]._songId, '107192078', '要留着数字 songId 给写接口用')
  assert.equal(page.isEnd, true)
  assert.ok(calls.some(c => c.method === 'CgiGetDiss' && c.param.disstid === 3837773425))
})

test('收藏：带 songId 的条目直接写 dirId 201；取消收藏走 DelSonglist', async () => {
  const calls = stub({})
  const { plugin } = await loadPlugin('plugins/qqmusic', CRED)
  await plugin.n1ko.user.setFavorite({ platform: 'qqmusic', id: '003OUlho2HcRHC', _songId: '107192078', _songType: 0 }, true)
  const add = calls.find(c => c.method === 'AddSonglist')
  assert.ok(add, '应调 AddSonglist')
  assert.equal(add.module, 'music.musicasset.PlaylistDetailWrite')
  assert.deepEqual(add.param, { dirId: 201, tid: 0, bFmtUtf8: true, v_songInfo: [{ songId: 107192078, songType: 0 }] })
  assert.ok(!calls.some(c => c.method === 'CgiGetTrackInfo'), '已有 songId 不该再查')

  await plugin.n1ko.user.setFavorite({ platform: 'qqmusic', id: '003OUlho2HcRHC', _songId: '107192078' }, false)
  assert.ok(calls.some(c => c.method === 'DelSonglist'))
})

test('收藏：只有 mid 时先按 mid 查 songId 再写', async () => {
  const calls = stub({
    'music.trackInfo.UniformRuleCtrl.CgiGetTrackInfo': { code: 0, data: { tracks: [{ id: 107192078, mid: '003OUlho2HcRHC', type: 0 }] } },
  })
  const { plugin } = await loadPlugin('plugins/qqmusic', CRED)
  await plugin.n1ko.user.setFavorite({ platform: 'qqmusic', id: '003OUlho2HcRHC' }, true)
  const lookup = calls.find(c => c.method === 'CgiGetTrackInfo')
  assert.deepEqual(lookup.param.mids, ['003OUlho2HcRHC'])
  const add = calls.find(c => c.method === 'AddSonglist')
  assert.equal(add.param.v_songInfo[0].songId, 107192078)
})

test('收藏：服务端业务码非 0 要报错，不能当成功', async () => {
  stub({ 'music.musicasset.PlaylistDetailWrite.AddSonglist': { code: 2001 } })
  const { plugin } = await loadPlugin('plugins/qqmusic', CRED)
  await assert.rejects(
    () => plugin.n1ko.user.setFavorite({ platform: 'qqmusic', id: 'm', _songId: '1' }, true),
    err => err.code === 'rate-limited'
  )
})

test('雷达推荐：认得 VecSongs 里的曲目', async () => {
  stub({
    'music.recommend.TrackRelationServer.GetRadarSong': { code: 0, data: {
      VecSongs: [{ Track: { id: 1, mid: 'MID00000000001', title: '某首歌', interval: 200, singer: [{ name: 'A', mid: 's' }], album: { mid: 'al', title: 'Al' } } }],
      HasMore: 0,
    } },
  })
  const { plugin } = await loadPlugin('plugins/qqmusic', CRED)
  const songs = await plugin.n1ko.user.getRecommendSongs()
  assert.equal(songs.length, 1)
  assert.equal(songs[0].id, 'MID00000000001')
})

test('收藏：歌曲类型按上游规则转换；80092（已在 / 已不在）算成功；retCode 非 0 报错', async () => {
  let addResult = { code: 0, data: { retCode: 0 } }
  const calls = stub({ 'music.musicasset.PlaylistDetailWrite.AddSonglist': () => addResult })
  const { plugin } = await loadPlugin('plugins/qqmusic', CRED)
  const fav = (type) => plugin.n1ko.user.setFavorite({ platform: 'qqmusic', id: 'm', _songId: '1', _songType: type }, true)
  const lastType = () => calls.filter(c => c.method === 'AddSonglist').slice(-1)[0].param.v_songInfo[0].songType

  await fav(1); assert.equal(lastType(), 0)
  await fav(111); assert.equal(lastType(), 111)
  await fav(13); assert.equal(lastType(), 1)

  addResult = { code: 80092 }
  await fav(0)

  addResult = { code: 0, data: { retCode: 3 } }
  await assert.rejects(() => fav(0), /retCode 3/)
})

test('写接口：网页版身份被 80105 拒了就换安卓身份重试，并记住', async () => {
  const calls = stub({
    'music.musicasset.PlaylistDetailWrite.AddSonglist': (param, comm) =>
      comm.ct === '11' ? { code: 0, data: { retCode: 0 } } : { code: 80105 },
  })
  const { plugin } = await loadPlugin('plugins/qqmusic', CRED)
  const item = { platform: 'qqmusic', id: 'm', _songId: '1', _songType: 0 }
  await plugin.n1ko.user.setFavorite(item, true)
  const adds = calls.filter(c => c.method === 'AddSonglist')
  assert.equal(adds.length, 2)
  assert.match(String(adds[0].headers.Cookie || ''), /qqmusic_key=KEY/, '网页版要把凭据放进 Cookie')
  assert.equal(adds[1].comm.ct, '11')
  assert.equal(adds[1].comm.tmeAppID, 'qqmusic')

  // 记住了：下一次直接用安卓身份，不再先撞一次 80105
  await plugin.n1ko.user.setFavorite(item, true)
  const later = calls.filter(c => c.method === 'AddSonglist').slice(2)
  assert.equal(later.length, 1)
  assert.equal(later[0].comm.ct, '11')
})

test('写接口：两种身份都被 80105 拒，报错给宿主', async () => {
  stub({ 'music.musicasset.PlaylistDetailWrite.AddSonglist': { code: 80105 } })
  const { plugin } = await loadPlugin('plugins/qqmusic', CRED)
  await assert.rejects(
    () => plugin.n1ko.user.setFavorite({ platform: 'qqmusic', id: 'm', _songId: '1' }, true),
    /80105/
  )
})
