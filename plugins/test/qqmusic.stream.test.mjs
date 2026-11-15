/**
 * QQ 音乐取流：文件名要用媒体文件 id（media_mid），不是歌曲 mid；要的音质没有文件时往下降。
 *
 * 真机上的事故：App 重启后从播放队列恢复的 QQ 歌只剩 { platform, id }，插件拿歌曲 mid 拼了文件名，
 * QQ 照样给了地址，CDN 回 404，播放器报 media error 4——QQ 的歌一首都放不了。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './harness.mjs'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function stub(handlers) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init && init.body || '{}'))
    const req = body.req_0 || {}
    calls.push({ module: req.module, method: req.method, param: req.param })
    const data = handlers[`${req.module}.${req.method}`]
    const payload = typeof data === 'function' ? data(req.param) : data
    return new Response(JSON.stringify({ code: 0, req_0: payload ?? { code: 0, data: {} } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  return calls
}

/** 取流接口：给什么文件名就回什么地址（真接口也不管文件在不在） */
const VKEY = param => ({ code: 0, data: { midurlinfo: [{ purl: `${param.filename[0]}?vkey=V`, result: 0 }] } })
const CDN = { code: 0, data: { sip: ['https://ws.stream.qqmusic.qq.com/'] } }

const DETAIL = {
  code: 0,
  data: { track_info: { mid: '003MyqqK0yVTXF', file: {
    media_mid: '003BY8EH4Ana3J', size_96aac: 3178641, size_128mp3: 4177334, size_320mp3: 0, size_flac: 0,
  } } },
}

test('只有歌曲 mid（重启后恢复的队列）：先查出媒体文件 id 再拼文件名', async () => {
  const calls = stub({
    'music.pf_song_detail_svr.get_song_detail_yqq': DETAIL,
    'music.vkey.GetVkey.UrlGetVkey': VKEY,
    'music.audioCdnDispatch.cdnDispatch.GetCdnDispatch': CDN,
  })
  const { plugin } = await loadPlugin('plugins/qqmusic')
  const source = await plugin.getMediaSource({ platform: 'qqmusic', id: '003MyqqK0yVTXF' }, 'medium')
  assert.match(source.url, /M500003BY8EH4Ana3J\.mp3/)
  const vkey = calls.find(c => c.method === 'UrlGetVkey')
  assert.deepEqual(vkey.param.filename, ['M500003BY8EH4Ana3J.mp3'])
  assert.deepEqual(vkey.param.songmid, ['003MyqqK0yVTXF'], 'songmid 还是歌曲 mid')

  // 第二次不再查
  await plugin.getMediaSource({ platform: 'qqmusic', id: '003MyqqK0yVTXF' }, 'low')
  assert.equal(calls.filter(c => c.method === 'get_song_detail_yqq').length, 1)
})

test('条目带着 _mediaMid：直接用，不查', async () => {
  const calls = stub({ 'music.vkey.GetVkey.UrlGetVkey': VKEY, 'music.audioCdnDispatch.cdnDispatch.GetCdnDispatch': CDN })
  const { plugin } = await loadPlugin('plugins/qqmusic')
  const source = await plugin.getMediaSource({ platform: 'qqmusic', id: 'SONGMID', _mediaMid: 'MEDIAMID' }, 'low')
  assert.match(source.url, /C400MEDIAMID\.m4a/)
  assert.ok(!calls.some(c => c.method === 'get_song_detail_yqq'))
})

test('要的音质没有文件：往下降到有文件的那档（不然 CDN 回 404）', async () => {
  stub({
    'music.pf_song_detail_svr.get_song_detail_yqq': DETAIL,
    'music.vkey.GetVkey.UrlGetVkey': VKEY,
    'music.audioCdnDispatch.cdnDispatch.GetCdnDispatch': CDN,
  })
  const { plugin } = await loadPlugin('plugins/qqmusic')
  // 这首没有 320 和 flac：要 high / lossless 都给 128 的 mp3
  const high = await plugin.getMediaSource({ platform: 'qqmusic', id: '003MyqqK0yVTXF' }, 'high')
  assert.match(high.url, /M500003BY8EH4Ana3J\.mp3/)
  const lossless = await plugin.getMediaSource({ platform: 'qqmusic', id: '003MyqqK0yVTXF' }, 'lossless')
  assert.match(lossless.url, /M500003BY8EH4Ana3J\.mp3/)

  // 列表里带来的文件信息同样算数：只有 aac 时要 medium 给 C400
  const aacOnly = await plugin.getMediaSource({
    platform: 'qqmusic', id: 'X', _mediaMid: 'M', _files: { low: true, medium: false, high: false, lossless: false },
  }, 'medium')
  assert.match(aacOnly.url, /C400M\.m4a/)
})

test('查不到媒体文件 id（接口报错、搜索也没有）：退回歌曲 mid，不让取流直接失败', async () => {
  stub({
    'music.pf_song_detail_svr.get_song_detail_yqq': { code: 500001, message: 'boom' },
    'music.vkey.GetVkey.UrlGetVkey': VKEY,
    'music.audioCdnDispatch.cdnDispatch.GetCdnDispatch': CDN,
  })
  const { plugin } = await loadPlugin('plugins/qqmusic')
  const source = await plugin.getMediaSource({ platform: 'qqmusic', id: '003MyqqK0yVTXF' }, 'medium')
  assert.match(source.url, /M500003MyqqK0yVTXF\.mp3/)
})

test('列表条目：有 file 就记下媒体文件 id 和各档有没有文件；没有 file 时留空，取流时再查', async () => {
  stub({
    'music.musicToplist.Toplist.GetDetail': { code: 0, data: { songInfoList: [
      { mid: 'A', title: 'a', singer: [], album: {}, file: { media_mid: 'MA', size_96aac: 1, size_128mp3: 1, size_320mp3: 0, size_flac: 0 } },
      { mid: 'B', title: 'b', singer: [], album: {} },
    ], data: { song: [] } } },
  })
  const { plugin } = await loadPlugin('plugins/qqmusic')
  const detail = await plugin.getTopListDetail({ id: '26' }, 1)
  assert.equal(detail.musicList.length, 2)
  const [a, b] = detail.musicList
  assert.equal(a._mediaMid, 'MA')
  assert.deepEqual(a._files, { low: true, medium: true, high: false, lossless: false })
  assert.equal(b._mediaMid, undefined)
  assert.equal(b._files, undefined)
})
