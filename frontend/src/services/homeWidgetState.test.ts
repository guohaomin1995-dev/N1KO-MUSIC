/**
 * 桌面小部件：推给原生的那份状态怎么拼（封面只在换了的时候带图）、透明度怎么换算。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildWidgetPayload,
  runWhenReady,
  runWhenReadyTracked,
  START_WATCH_MS,
  startWatchStep,
  stoppedByError,
  transparencyToOpacity,
} from '@/services/homeWidgetState'

const song = { title: 'Yellow', artist: 'Coldplay', duration: 266 }
const base = { song, playing: true, position: 12.4, duration: 0, cover: '', sentCoverKey: null, starred: false, canStar: true }

describe('buildWidgetPayload', () => {
  it('没有在放的歌：一份空状态，小部件显示「挑首歌」', () => {
    expect(buildWidgetPayload({ ...base, song: null })).toEqual({
      hasSong: false, title: '', artist: '', coverKey: '', cover: '',
      playing: false, position: 0, duration: 0, starred: false, canStar: false, rate: 1,
    })
  })

  it('带上播放速度（原生按它推进度）；没给、给错按 1 倍', () => {
    expect(buildWidgetPayload({ ...base, rate: 1.5 }).rate).toBe(1.5)
    expect(buildWidgetPayload(base).rate).toBe(1)
    expect(buildWidgetPayload({ ...base, rate: 0 }).rate).toBe(1)
    expect(buildWidgetPayload({ ...base, rate: Number.NaN }).rate).toBe(1)
  })

  it('播放器还没报时长时用歌曲自己的时长；报了就用播放器的', () => {
    expect(buildWidgetPayload(base).duration).toBe(266)
    expect(buildWidgetPayload({ ...base, duration: 270.5 }).duration).toBe(270.5)
  })

  it('封面第一次出现带图；key 没变就不再带（data: 图片几十 KB，不该每 5 秒过一次桥）', () => {
    const cover = 'https://nas.example/rest/getCoverArt?id=al-1&size=480&t=abc&s=123'
    const first = buildWidgetPayload({ ...base, cover })
    expect(first.cover).toBe(cover)
    // key 去掉了每次都变的鉴权参数：同一张图换了一组 t / s 也算没变
    expect(first.coverKey).not.toContain('t=abc')
    const again = buildWidgetPayload({ ...base, cover: cover.replace('t=abc&s=123', 't=xyz&s=999'), sentCoverKey: first.coverKey })
    expect(again.coverKey).toBe(first.coverKey)
    expect(again.cover).toBe('')
  })

  it('换了一张封面：重新带图；这首歌没有封面：key 是空串，原生据此清掉旧图', () => {
    const first = buildWidgetPayload({ ...base, cover: 'https://nas.example/a.jpg' })
    const changed = buildWidgetPayload({ ...base, cover: 'https://nas.example/b.jpg', sentCoverKey: first.coverKey })
    expect(changed.cover).toBe('https://nas.example/b.jpg')
    const none = buildWidgetPayload({ ...base, cover: '', sentCoverKey: first.coverKey })
    expect(none).toMatchObject({ coverKey: '', cover: '' })
  })

  it('刚换歌、封面还没算出来：照旧报上一次的 key、不带图（不然原生会清掉旧图，闪一下占位图）', () => {
    const first = buildWidgetPayload({ ...base, cover: 'https://nas.example/a.jpg' })
    const pending = buildWidgetPayload({ ...base, song: { title: 'Fix You', artist: 'Coldplay' }, cover: '', sentCoverKey: first.coverKey, coverPending: true })
    expect(pending).toMatchObject({ title: 'Fix You', coverKey: first.coverKey, cover: '' })
    // 算出来了：真没有封面才报空 key；有就带图
    expect(buildWidgetPayload({ ...base, cover: '', sentCoverKey: first.coverKey }).coverKey).toBe('')
    expect(buildWidgetPayload({ ...base, cover: 'https://nas.example/b.jpg', sentCoverKey: first.coverKey }).cover).toBe('https://nas.example/b.jpg')
  })

  it('音源不支持收藏：不亮心（哪怕歌曲对象上带着 starred）', () => {
    expect(buildWidgetPayload({ ...base, starred: true, canStar: false })).toMatchObject({ starred: false, canStar: false })
    expect(buildWidgetPayload({ ...base, starred: true })).toMatchObject({ starred: true, canStar: true })
  })

  it('播放位置不是数（刚换歌的一瞬间）按 0', () => {
    expect(buildWidgetPayload({ ...base, position: Number.NaN }).position).toBe(0)
  })
})

describe('transparencyToOpacity', () => {
  it('设置里是透明度，原生要的是背景有多实；越界的值收回来', () => {
    expect(transparencyToOpacity(0)).toBe(100)
    expect(transparencyToOpacity(15)).toBe(85)
    expect(transparencyToOpacity(100)).toBe(0)
    expect(transparencyToOpacity(140)).toBe(0)
    expect(transparencyToOpacity(-5)).toBe(100)
    expect(transparencyToOpacity(Number.NaN)).toBe(100)
  })
})

describe('runWhenReady', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('已经就绪：当场就做，不等', () => {
    const run = vi.fn()
    runWhenReady(() => true, run)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('还没就绪（冷启动时音源还没连上）：等到就绪那一刻做，只做一次', () => {
    vi.useFakeTimers()
    let ready = false
    const run = vi.fn()
    runWhenReady(() => ready, run, { intervalMs: 300 })
    vi.advanceTimersByTime(900)
    expect(run).not.toHaveBeenCalled()
    ready = true
    vi.advanceTimersByTime(300)
    expect(run).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(3000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('等太久（音源一直连不上）：不再等，照做，让应用自己报错', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    runWhenReady(() => false, run, { intervalMs: 300, timeoutMs: 2000 })
    vi.advanceTimersByTime(1800)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(600)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('取消了（界面卸载）：之后就绪也不做', () => {
    vi.useFakeTimers()
    let ready = false
    const run = vi.fn()
    const cancel = runWhenReady(() => ready, run)
    cancel()
    ready = true
    vi.advanceTimersByTime(5000)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('runWhenReadyTracked', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('已经就绪（平时音源早就连着）：当场做，不抛异常，集合里不留东西', () => {
    const pending = new Set<() => void>()
    const run = vi.fn()
    expect(() => runWhenReadyTracked(pending, () => true, run)).not.toThrow()
    expect(run).toHaveBeenCalledTimes(1)
    expect(pending.size).toBe(0)
  })

  it('还没就绪：等的时候记在集合里，做完自己拿掉', () => {
    vi.useFakeTimers()
    const pending = new Set<() => void>()
    let ready = false
    const run = vi.fn()
    runWhenReadyTracked(pending, () => ready, run, { intervalMs: 300 })
    expect(pending.size).toBe(1)
    ready = true
    vi.advanceTimersByTime(300)
    expect(run).toHaveBeenCalledTimes(1)
    expect(pending.size).toBe(0)
  })

  it('卸载时把集合里的都取消：之后就绪也不做', () => {
    vi.useFakeTimers()
    const pending = new Set<() => void>()
    let ready = false
    const run = vi.fn()
    runWhenReadyTracked(pending, () => ready, run)
    pending.forEach(cancel => cancel())
    ready = true
    vi.advanceTimersByTime(5000)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('stoppedByError', () => {
  it('开播之后最新的一条是「出错」：值得再试；更早的出错、用户自己按停、被系统打断都不算', () => {
    const since = 10_000
    expect(stoppedByError([{ at: 12_000, reason: 'error' }], since)).toBe(true)
    expect(stoppedByError([{ at: 9_000, reason: 'error' }], since)).toBe(false)
    expect(stoppedByError([{ at: 11_000, reason: 'error' }, { at: 12_000, reason: 'ui' }], since)).toBe(false)
    expect(stoppedByError([{ at: 12_000, reason: 'element' }], since)).toBe(false)
    expect(stoppedByError([], since)).toBe(false)
  })
})

describe('startWatchStep', () => {
  const since = 10_000
  const watch = { playing: true, sameSong: true, startTime: 30, currentTime: 30, records: [], since, now: since + 500 }

  it('在放、位置也往前走了：真放起来了，收手', () => {
    expect(startWatchStep({ ...watch, currentTime: 30.6 })).toBe('done')
  })

  it('状态是「在放」但位置没动（还在取流）：接着盯', () => {
    expect(startWatchStep(watch)).toBe('wait')
  })

  it('出错停了：再试——不管是第几秒停的（播放器自己的重试用完才停，以前只在 2.5 秒看一次，常常错过）', () => {
    const records = [{ at: since + 9_000, reason: 'error' }]
    expect(startWatchStep({ ...watch, playing: false, records, now: since + 9_500 })).toBe('retry')
  })

  it('用户按停、被系统打断：不替他重开', () => {
    expect(startWatchStep({ ...watch, playing: false, records: [{ at: since + 2_000, reason: 'ui' }] })).toBe('done')
    expect(startWatchStep({ ...watch, playing: false, records: [{ at: since + 2_000, reason: 'element' }] })).toBe('done')
  })

  it('开播之前就有的出错记录不算；换了歌、盯够了都收手', () => {
    expect(startWatchStep({ ...watch, playing: false, records: [{ at: since - 1, reason: 'error' }] })).toBe('wait')
    expect(startWatchStep({ ...watch, sameSong: false })).toBe('done')
    expect(startWatchStep({ ...watch, now: since + START_WATCH_MS })).toBe('done')
  })
})
