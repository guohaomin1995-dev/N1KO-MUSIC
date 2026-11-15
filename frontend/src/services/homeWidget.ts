/**
 * 桌面小部件（安卓）和播放器之间的桥，原生那一侧是 android/…/widget/HomeWidgetPlugin.java。
 *
 * 播放器 → 小部件：在放什么、放没放、放到哪、多少倍速、收藏了没。换歌、播放暂停、拖进度、改速度、收藏变了立刻推；
 *   正在放的时候每 5 秒再对一次播放位置（中间那几秒原生自己按时间往后推，进度条不用等这边）。
 *   桌面上一个小部件都没有时（大多数人，还有电视）什么都不推、封面也不缩；加上小部件时原生发 widgetsChanged，这边马上补推。
 * 小部件 → 播放器：按钮按下去变成 action 事件，和通知栏的按键走同一套动作。
 *
 * 封面只在换了的时候才发：钉住的图、自定义封面是几十 KB 的 data: 图片，不该每 5 秒过一次桥。
 */

import { useEffect, useRef, useState } from 'react'
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { usePlayerStore } from '@/store/playerStore'
import { useSettingsStore } from '@/store/settingsStore'
import { usePlaybackCover } from '@/hooks/usePlaybackCover'
import { useCurrentSongFavorite } from '@/hooks/useFavoriteState'
import { useSourceCapabilities } from '@/hooks/useSourceQueries'
import { useToggleStar } from '@/hooks/useServerQueries'
import { sourceSupportsFavorites } from '@/services/heartCapability'
import { sourceCapabilitiesOf } from '@/services/capabilities'
import { isNativePlatform, nativeOS } from '@/lib/platform'
import { getAdapterFor, hasAdapterFor } from '@/api'
import { getPauseRecords } from '@/lib/playbackTrail'
import { notificationCover, prevWithRestart, togglePlayRemote } from '@/services/nativeMediaControls'
import { coversIdentity, songKey } from '@/utils/coverIdentity'
import {
  buildWidgetPayload,
  runWhenReadyTracked,
  startWatchStep,
  transparencyToOpacity,
  type WidgetAction,
  type WidgetActionEvent,
  type WidgetPayload,
  type WidgetSize,
} from '@/services/homeWidgetState'

export type { WidgetAction, WidgetPayload, WidgetSize }

interface WidgetCounts {
  small: number
  large: number
}

interface HomeWidgetPlugin {
  update(state: WidgetPayload): Promise<{ coverAccepted?: boolean } | undefined>
  setStyle(options: { opacity: number }): Promise<void>
  status(): Promise<WidgetCounts & { pinSupported: boolean }>
  requestPin(options: { size: WidgetSize }): Promise<{ requested: boolean }>
  addListener(event: 'action', handler: (event: WidgetActionEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'widgetsChanged', handler: (event: WidgetCounts) => void): Promise<PluginListenerHandle>
}

const HomeWidget = registerPlugin<HomeWidgetPlugin>('HomeWidget')

/** 只有安卓原生壳里有桌面小部件 */
export const widgetSupported = isNativePlatform && nativeOS === 'android'

/** 大号小部件上的封面，手机上约 500 像素，平板上 600 多 */
const WIDGET_COVER = 640
/** 正在放的时候隔多久对一次播放位置 */
const POSITION_SYNC_MS = 5000

/** 开播出错后再试几次、隔多久；盯的时候多久看一眼 */
const START_RETRIES = 2
const START_RETRY_GAP_MS = 2500
const START_POLL_MS = 500

/**
 * 从小部件开播，然后盯一阵（见 startWatchStep）：出错停了隔一会儿再试，放起来了或者别的原因停了就收手。
 * 盯着的这件事登记在 track 里：界面卸载、或者小部件上又按了别的键时一起取消，免得用户都按停了它还替人重开。
 */
function startPlayback(track: Set<() => void>, retries = START_RETRIES) {
  const player = usePlayerStore.getState()
  const song = player.currentSong
  if (!song) return
  const key = songKey(song)
  const since = Date.now()
  const startTime = player.currentTime
  if (!player.isPlaying) player.resume()

  let timer: ReturnType<typeof setTimeout> | null = null
  const stop = () => {
    if (timer) clearTimeout(timer)
    timer = null
    track.delete(stop)
  }
  const poll = () => {
    timer = null
    const now = usePlayerStore.getState()
    const step = startWatchStep({
      playing: now.isPlaying,
      sameSong: songKey(now.currentSong) === key,
      startTime,
      currentTime: now.currentTime,
      records: getPauseRecords(),
      since,
      now: Date.now(),
    })
    if (step === 'wait') {
      timer = setTimeout(poll, START_POLL_MS)
      return
    }
    stop()
    if (step === 'retry' && retries > 0) {
      const retry = setTimeout(() => {
        track.delete(cancelRetry)
        startPlayback(track, retries - 1)
      }, START_RETRY_GAP_MS)
      const cancelRetry = () => {
        clearTimeout(retry)
        track.delete(cancelRetry)
      }
      track.add(cancelRetry)
    }
  }
  track.add(stop)
  timer = setTimeout(poll, START_POLL_MS)
}

/** 请桌面弹出「添加小部件」；桌面不支持（或用户的系统拦了）时返回 false，由界面提示手动去加 */
export async function requestWidgetPin(size: WidgetSize): Promise<boolean> {
  if (!widgetSupported) return false
  try {
    return (await HomeWidget.requestPin({ size })).requested
  } catch {
    return false
  }
}

export async function widgetStatus(): Promise<WidgetCounts & { pinSupported: boolean }> {
  if (!widgetSupported) return { pinSupported: false, small: 0, large: 0 }
  try {
    return await HomeWidget.status()
  } catch {
    return { pinSupported: false, small: 0, large: 0 }
  }
}

/** 收藏键：音源连上了、而且支持收藏才做（冷启动时按的，要等音源连上再看，不能用连上之前那一刻的判断） */
function canStarNow(serverId: string | undefined): boolean {
  if (!serverId || !hasAdapterFor(serverId)) return false
  return !!sourceCapabilitiesOf(getAdapterFor(serverId)).favorites
}

export function useHomeWidget() {
  /** 桌面上有没有小部件：没有就什么都不推（连 640 的封面也不去缩） */
  const [placed, setPlaced] = useState(false)
  const active = widgetSupported && placed
  const currentSong = usePlayerStore(s => s.currentSong)
  const updateCurrentSong = usePlayerStore(s => s.updateCurrentSong)
  const { urls } = usePlaybackCover(active ? currentSong : null, { size: WIDGET_COVER })
  const { starred, toggle } = useCurrentSongFavorite()
  const toggleStar = useToggleStar()
  const caps = useSourceCapabilities()
  const canStar = sourceSupportsFavorites(caps, currentSong?.serverId)
  const transparency = useSettingsStore(s => s.widgetTransparency)
  const rate = useSettingsStore(s => s.playbackRate)

  /** 推送时要用的最新值：推送发生在订阅回调里，拿不到这一轮渲染的变量 */
  const fresh = { song: songKey(currentSong), urls, starred, canStar, toggle, star: toggleStar.mutate, updateCurrentSong }
  const latest = useRef(fresh)
  latest.current = fresh
  const pushRef = useRef<(() => void) | null>(null)

  const coversKey = `${songKey(currentSong)}|${coversIdentity(urls)}`
  useEffect(() => {
    pushRef.current?.()
  }, [coversKey, starred, canStar, rate])

  useEffect(() => {
    if (!active) return
    void HomeWidget.setStyle({ opacity: transparencyToOpacity(transparency) }).catch(() => {})
  }, [transparency, active])

  // 桌面上有几个小部件：启动时问一次，之后原生加了 / 删了会通知
  useEffect(() => {
    if (!widgetSupported) return
    let gone = false
    let handle: PluginListenerHandle | null = null
    void widgetStatus().then(status => {
      if (!gone) setPlaced(status.small + status.large > 0)
    })
    void HomeWidget.addListener('widgetsChanged', counts => setPlaced(counts.small + counts.large > 0))
      .then(h => {
        if (gone) void h.remove()
        else handle = h
      })
      .catch(() => {})
    return () => {
      gone = true
      void handle?.remove()
    }
  }, [])

  useEffect(() => {
    if (!active) return

    let run = 0
    let lastPush = 0
    let sentCoverKey: string | null = null
    /** data: 图片缩一次要画一遍画布：同一组封面只缩一次 */
    let resolved: { key: string; cover: string } | null = null

    const push = () => {
      const mine = ++run
      const player = usePlayerStore.getState()
      const song = player.currentSong
      const known = latest.current
      // 刚换歌的那一下，React 那边算好的封面还是上一首的：先不动封面（见 coverPending），等它算好再补推一次
      const coverPending = !!song && known.song !== songKey(song)
      const urls = song && !coverPending ? known.urls : []
      const key = `${songKey(song)}|${coversIdentity(urls)}`
      const cover = resolved?.key === key
        ? Promise.resolve(resolved.cover)
        : notificationCover(urls, WIDGET_COVER).then(value => {
            resolved = { key, cover: value }
            return value
          })
      void cover
        .then(value => {
          // 等图的这一会儿里又有更新的一次推送：让它发，免得旧的盖掉新的
          if (mine !== run) return
          const now = usePlayerStore.getState()
          const payload = buildWidgetPayload({
            song: now.currentSong,
            playing: now.isPlaying,
            position: now.currentTime,
            duration: now.duration,
            cover: value,
            sentCoverKey,
            coverPending,
            starred: latest.current.starred,
            canStar: latest.current.canStar,
            rate: useSettingsStore.getState().playbackRate,
          })
          lastPush = Date.now()
          return HomeWidget.update(payload).then(result => {
            // 原生没收下封面（桌面上的小部件刚被删光）：下次还得带上图
            if (result?.coverAccepted !== false) sentCoverKey = payload.coverKey
          })
        })
        .catch(() => {
          // 小部件更新失败不影响播放
        })
    }
    pushRef.current = push
    push()

    const unsubscribe = usePlayerStore.subscribe((state, prev) => {
      if (songKey(state.currentSong) !== songKey(prev.currentSong)) return push()
      if (!state.currentSong) return
      if (state.isPlaying !== prev.isPlaying || state.duration !== prev.duration) return push()
      const jumped = Math.abs(state.currentTime - prev.currentTime) > 2
      const due = state.isPlaying && Date.now() - lastPush > POSITION_SYNC_MS
      if (jumped || due) push()
    })

    /** 小部件开播后还在盯着的（见 startPlayback）：又按了别的键、界面卸载时取消 */
    const watches = new Set<() => void>()
    const stopWatching = () => [...watches].forEach(cancel => cancel())

    const actions: Record<WidgetAction, (event: WidgetActionEvent) => void> = {
      toggle: () => {
        const player = usePlayerStore.getState()
        if (!player.currentSong) return
        if (player.isPlaying) togglePlayRemote()
        else startPlayback(watches)
      },
      play: () => startPlayback(watches),
      next: () => usePlayerStore.getState().next(),
      previous: prevWithRestart,
      favorite: event => {
        const song = usePlayerStore.getState().currentSong
        if (!song || !canStarNow(song.serverId)) return
        const { star, toggle: flip } = latest.current
        // 老版本的原生不带目标状态：只能按这边知道的切换
        if (typeof event.starred !== 'boolean') return flip()
        const target = event.starred
        // 收藏 / 取消收藏本身是幂等的：不管这边查没查到现在的状态，照着目标做就对
        star(
          { id: song.id, type: 'song', isStarred: !target, song },
          {
            onSuccess: () => {
              if (usePlayerStore.getState().currentSong?.id === song.id) latest.current.updateCurrentSong({ starred: target })
            },
          },
        )
      },
    }
    /*
     * 从小部件把应用冷启动起来时，动作比音源先到（原生那边把它留到这里挂上监听为止）：
     * 这首歌的音源还没连上就开播只会失败，等它连上再做。平时音源早就连着，一次都不用等。
     */
    const sourceReady = () => {
      const song = usePlayerStore.getState().currentSong
      return !song || hasAdapterFor(song.serverId)
    }
    const waiting = new Set<() => void>()
    const perform = (event: WidgetActionEvent) => {
      const act = actions[event.action]
      if (!act) return
      stopWatching()
      runWhenReadyTracked(waiting, sourceReady, () => act(event))
    }
    let handle: PluginListenerHandle | null = null
    let gone = false
    void HomeWidget.addListener('action', event => perform(event))
      .then(h => {
        if (gone) void h.remove()
        else handle = h
      })
      .catch(() => {})

    return () => {
      gone = true
      unsubscribe()
      waiting.forEach(cancel => cancel())
      stopWatching()
      pushRef.current = null
      void handle?.remove()
    }
  }, [active])
}
