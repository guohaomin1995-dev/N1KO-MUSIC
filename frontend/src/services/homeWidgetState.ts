/**
 * 桌面小部件要显示的那份状态怎么拼。纯函数，和播放器、原生桥分开放（services/homeWidget 用它）。
 */

import { coversIdentity } from '@/utils/coverIdentity'

/** play：没在放就放（不是切换）。原生那边在后台放不起来、把应用打开到前台时发这个 */
export type WidgetAction = 'toggle' | 'play' | 'next' | 'previous' | 'favorite'
export type WidgetSize = 'small' | 'large'

/** 小部件上按下的一个键。favorite 带上「要变成什么」：小部件上画的是空心，按下去就是要收藏 */
export interface WidgetActionEvent {
  action: WidgetAction
  starred?: boolean
}

export interface WidgetPayload {
  hasSong: boolean
  title: string
  artist: string
  /** 封面是哪一张（去掉了每次都变的鉴权参数）。空串：这首歌没有封面 */
  coverKey: string
  /** 封面的地址或 data: 图片。只在 coverKey 变了的那一次带上，其余时候是空串 */
  cover: string
  playing: boolean
  /** 秒 */
  position: number
  /** 秒 */
  duration: number
  starred: boolean
  canStar: boolean
  /** 播放速度：原生两次对表之间按它推进度 */
  rate: number
}

/** 设置里存的是「透明度」（0 不透明，100 全透明），原生要的是背景有多实 */
export function transparencyToOpacity(transparency: number): number {
  const t = Number.isFinite(transparency) ? transparency : 0
  return Math.round(100 - Math.min(100, Math.max(0, t)))
}

export function buildWidgetPayload(input: {
  song: { title: string; artist?: string; duration?: number } | null
  playing: boolean
  position: number
  duration: number
  cover: string
  /** 上一次发给原生的 coverKey；和这次一样就不再带图 */
  sentCoverKey: string | null
  /**
   * 这首歌的封面还没算出来（刚换歌的那一下，React 那边的封面列表还是上一首的）。
   * 这时候不能说「没有封面」——原生会把旧图清掉、闪一下占位图，随后新封面到了又换上；
   * 先照旧报上一次的 key，等算出来再发一次。
   */
  coverPending?: boolean
  starred: boolean
  canStar: boolean
  rate?: number
}): WidgetPayload {
  const { song } = input
  const rate = typeof input.rate === 'number' && input.rate > 0 && Number.isFinite(input.rate) ? input.rate : 1
  if (!song) {
    return {
      hasSong: false, title: '', artist: '', coverKey: '', cover: '',
      playing: false, position: 0, duration: 0, starred: false, canStar: false, rate,
    }
  }
  const coverKey = input.coverPending
    ? input.sentCoverKey ?? ''
    : input.cover ? coversIdentity([input.cover]) : ''
  const duration = input.duration > 0 ? input.duration : song.duration ?? 0
  return {
    hasSong: true,
    title: song.title,
    artist: song.artist ?? '',
    coverKey,
    cover: !input.coverPending && coverKey && coverKey !== input.sentCoverKey ? input.cover : '',
    playing: input.playing,
    position: Math.max(0, Number.isFinite(input.position) ? input.position : 0),
    duration: Math.max(0, Number.isFinite(duration) ? duration : 0),
    starred: input.canStar && input.starred,
    canStar: input.canStar,
    rate,
  }
}

/**
 * 等条件成立再做一件事（每隔一会儿看一眼），等太久就不等了、照做。返回一个取消函数。
 *
 * 用在从小部件冷启动应用时：按键动作比音源先到——流媒体音源的插件沙箱是异步装载的，
 * 这时候立刻开播只会失败（真机上就是应用被拉起来了，却停在 0:00 不动）。
 */
export function runWhenReady(
  ready: () => boolean,
  run: () => void,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): () => void {
  const interval = options.intervalMs ?? 300
  const deadline = Date.now() + (options.timeoutMs ?? 15_000)
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false
  const attempt = () => {
    timer = null
    if (cancelled) return
    if (ready() || Date.now() >= deadline) {
      run()
      return
    }
    timer = setTimeout(attempt, interval)
  }
  attempt()
  return () => {
    cancelled = true
    if (timer) clearTimeout(timer)
  }
}

/**
 * runWhenReady，外加把「还在等的」记在一个集合里（界面卸载时好一起取消），做完自己从集合里拿掉。
 *
 * 单独写成一个函数是吃过亏的：条件已经成立时 runWhenReady 会当场、同步地调 run，
 * 那一刻它的返回值（取消函数）还没交到调用方手里——在回调里直接用那个变量会抛
 * 「Cannot access before initialization」，动作就这么没了（真机上：音源连着的正常情况下，小部件的按钮全部失灵）。
 */
export function runWhenReadyTracked(
  pending: Set<() => void>,
  ready: () => boolean,
  run: () => void,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): void {
  let cancel: (() => void) | null = null
  let finished = false
  cancel = runWhenReady(
    ready,
    () => {
      finished = true
      if (cancel) pending.delete(cancel)
      run()
    },
    options,
  )
  if (!finished) pending.add(cancel)
}

/**
 * 小部件叫开播之后又停了：是不是「出错停的」——那就值得再试一次；用户自己按停的、被系统打断的不算。
 * 冷启动的头几秒，音源刚连上，第一次取流常常失败（真机上是 media error 4），隔两三秒再来就好了。
 * records 是 lib/playbackTrail 的暂停记录，新的在后。
 */
export function stoppedByError(records: ReadonlyArray<{ at: number; reason: string }>, since: number): boolean {
  const last = records[records.length - 1]
  return !!last && last.reason === 'error' && last.at >= since
}

/** 小部件叫开播之后最多盯多久：取流、出错后播放器自己重试几次，慢的网络上十来秒 */
export const START_WATCH_MS = 15_000

/**
 * 小部件叫开播之后，每隔一会儿看一眼该怎么办：
 * - done：真放起来了（在放、而且位置往前走了），或者换了歌、因为别的原因停了（用户按停、被系统打断），或者盯够了——收手；
 * - retry：是出错停的——再试一次（冷启动头几秒取流常失败，播放器自己的重试用完以后才会停，所以不能只看一次）；
 * - wait：还没有结果，接着盯。
 * 「在放」但位置没动不算放起来：播放器先把状态置成在放、再去取流，取流失败才停。
 */
export function startWatchStep(input: {
  playing: boolean
  sameSong: boolean
  /** 开播那一刻和现在的播放位置（秒） */
  startTime: number
  currentTime: number
  records: ReadonlyArray<{ at: number; reason: string }>
  since: number
  now: number
}): 'done' | 'retry' | 'wait' {
  if (!input.sameSong) return 'done'
  if (input.playing && input.currentTime - input.startTime >= 0.5) return 'done'
  if (!input.playing) {
    if (stoppedByError(input.records, input.since)) return 'retry'
    if (input.records.some(r => r.at >= input.since)) return 'done'
  }
  return input.now - input.since >= START_WATCH_MS ? 'done' : 'wait'
}
