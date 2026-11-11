/**
 * 原生媒体控制桥（仅 Capacitor 原生壳生效）
 * 把 playerStore 的播放状态同步到 capacitor-music-controls-plugin：
 * - Android：MediaStyle 前台服务通知（保证退后台音频不被挂起）
 * - iOS：MPRemoteCommandCenter 锁屏/控制中心 + AVAudioSession 后台续播
 * 事件回流：锁屏/通知上的 play/pause/next/previous/seek 调回 playerStore
 */

import { useEffect } from 'react'
import { CapacitorMusicControls } from 'capacitor-music-controls-plugin'
import { usePlayerStore } from '@/store/playerStore'
import { seekHowl } from '@/hooks/useAudioEngine'
import { findAdapterFor } from '@/api'
import { isNativePlatform, nativeOS } from '@/lib/platform'
import { notePauseReason } from '@/lib/playbackTrail'
import { useSettingsStore } from '@/store/settingsStore'

/** 原生端报上来的一次按键：message 是按键名，拖动进度时带 position（秒） */
interface RemoteEvent {
  message?: string
  position?: number
}

function togglePlayRemote() {
  const s = usePlayerStore.getState()
  if (s.isPlaying) {
    notePauseReason('remote', 'toggle')
    s.pause()
  } else {
    s.resume()
  }
}

/** 上一首：播放超过 3 秒重播当前歌曲（与 PlayerBar 行为一致） */
function prevWithRestart() {
  const state = usePlayerStore.getState()
  if (state.currentTime > 3) {
    seekHowl(0)
  } else {
    state.prev()
  }
}

export function useNativeMediaControls() {
  useEffect(() => {
    if (!isNativePlatform) return

    let created = false
    let lastElapsedPush = 0
    /*
     * create() 还没回来的时候别再叫第二次。以前 created 要等 create() 回来才变真，
     * 这期间每一次 store 更新（播放中每秒好几次）都会再叫一次 create()——
     * iOS 那边每次都同步下载一遍封面、注销再注册一遍锁屏按键，一首歌开头能排起一长串。
     * 等待期间换了歌就记一笔，回来后只为最新那首再建一次；建失败了 10 秒内不重试。
     */
    let creating = false
    /** 正在建的是哪一首（serverId:id）；等待期间换了歌才需要再建一次 */
    let creatingFor: string | null = null
    let recreatePending = false
    let retryAt = 0
    const keyOf = (song: { serverId?: string; id: string } | null) => (song ? `${song.serverId ?? ''}:${song.id}` : null)

    const createForCurrentSong = () => {
      const { currentSong, isPlaying, currentTime } = usePlayerStore.getState()
      if (!currentSong) return
      if (creating) {
        if (keyOf(currentSong) !== creatingFor) recreatePending = true
        return
      }
      if (!created && Date.now() < retryAt) return
      creating = true
      creatingFor = keyOf(currentSong)
      // 256 封面：插件会把 bitmap 两次塞进 MediaSession metadata，
      // 512 位图接近 Binder 事务上限（TransactionTooLargeException 闪退）
      const cover = currentSong.coverArt
        ? (findAdapterFor(currentSong.serverId)?.getCoverUrl(currentSong.coverArt, 256) ?? '')
        : ''
      CapacitorMusicControls.create({
        track: currentSong.title,
        artist: currentSong.artist,
        album: currentSong.album ?? '',
        cover,
        isPlaying,
        dismissable: true,
        hasPrev: true,
        hasNext: true,
        hasClose: true,
        hasScrubbing: true,
        duration: Math.round(currentSong.duration ?? 0),
        elapsed: Math.round(currentTime),
        // Android 端 MusicControlsInfos 对所有字符串键做 getString（缺键抛 JSONException，
        // create 会被 reject，通知/前台服务根本不会创建），必须全部传齐；
        // 空串走插件内置的 android.R 媒体图标兜底
        ticker: `${currentSong.title} · ${currentSong.artist}`,
        playIcon: '',
        pauseIcon: '',
        prevIcon: '',
        nextIcon: '',
        closeIcon: '',
        notificationIcon: '',
      }).then(() => {
        created = true
        retryAt = 0
        lastElapsedPush = Date.now()
      }).catch(() => {
        // 建失败了：锁屏上可能还挂着上一首，标成没建好，10 秒后再试
        created = false
        retryAt = Date.now() + 10_000
      }).finally(() => {
        creating = false
        creatingFor = null
        // 建的那一会儿里队列被清空了：别把控件留在锁屏上
        if (!usePlayerStore.getState().currentSong) {
          recreatePending = false
          destroyControls()
          return
        }
        if (recreatePending) {
          recreatePending = false
          createForCurrentSong()
          return
        }
        // 建的那一会儿里播放状态可能变过（比如刚好暂停了）：补推一次，锁屏上别停在旧状态
        if (created) {
          const latest = usePlayerStore.getState()
          CapacitorMusicControls.updateElapsed({ elapsed: Math.round(latest.currentTime), isPlaying: latest.isPlaying })
        }
      })
    }

    const destroyControls = () => {
      if (!created) return
      CapacitorMusicControls.destroy()
      created = false
    }

    /*
     * 锁屏 / 通知 / 耳机线控 → 播放器动作。
     *
     * 插件不会按 music-controls-play 这样的名字发事件：安卓原生端所有按键都走
     * bridge.triggerJSEvent('controlsNotification', 'document', { message })，
     * 落在 document 上的一个 DOM 事件，按键名在 message 里。
     * 以前按 message 的名字 addListener，一个都收不到——蓝牙耳机、通知栏、锁屏的按键全部石沉大海。
     */
    const step = () => useSettingsStore.getState().seekStepSeconds || 15
    const actions: Record<string, (info: RemoteEvent) => void> = {
      'music-controls-play': () => usePlayerStore.getState().resume(),
      'music-controls-pause': () => {
        notePauseReason('remote', 'pause')
        usePlayerStore.getState().pause()
      },
      'music-controls-stop': () => {
        notePauseReason('remote', 'stop')
        usePlayerStore.getState().pause()
      },
      'music-controls-toggle-play-pause': togglePlayRemote,
      // 有线 / 单键耳机的中键；会话不活跃时系统把它交给按键广播，走的是这个名字
      'music-controls-headset-hook': togglePlayRemote,
      'music-controls-next': () => usePlayerStore.getState().next(),
      'music-controls-previous': prevWithRestart,
      'music-controls-skip-forward': () => {
        const s = usePlayerStore.getState()
        seekHowl(Math.min(s.duration || Infinity, s.currentTime + step()))
      },
      'music-controls-skip-backward': () => {
        seekHowl(Math.max(0, usePlayerStore.getState().currentTime - step()))
      },
      'music-controls-seek-to': info => {
        if (typeof info.position === 'number' && isFinite(info.position)) seekHowl(info.position)
      },
      // 用户划掉通知 → 暂停，下次状态变化时重建
      'music-controls-destroy': () => {
        notePauseReason('remote', 'notification dismissed')
        usePlayerStore.getState().pause()
        created = false
      },
    }
    /* 线控一次按下，原生端可能从会话回调和按键广播各报一遍；300ms 内同一个键只认一次 */
    let lastMessage = ''
    let lastAt = 0
    const dispatch = (info: RemoteEvent | null | undefined) => {
      const message = info?.message
      if (!message) return
      const action = actions[message]
      if (!action) return
      const now = Date.now()
      if (message === lastMessage && now - lastAt < 300 && message !== 'music-controls-seek-to') return
      lastMessage = message
      lastAt = now
      action(info)
    }

    const cleanups: Array<() => void> = []
    if (nativeOS === 'android') {
      const onDocumentEvent = (event: Event) => dispatch(event as unknown as RemoteEvent)
      document.addEventListener('controlsNotification', onDocumentEvent)
      cleanups.push(() => document.removeEventListener('controlsNotification', onDocumentEvent))
    } else {
      // iOS 端走 notifyListeners('controlsNotification')。系统面板那边 WKWebView 的 Media Session 也会接一份，
      // 这里只照旧挂着，不改 iOS 现有的行为
      const legacy = Object.keys(actions).map(name =>
        CapacitorMusicControls.addListener(name, (info: RemoteEvent) => actions[name](info ?? { message: name }))
      )
      cleanups.push(() => legacy.forEach(p => p.then(h => h.remove()).catch(() => {})))
    }

    // 状态变化 → 原生控制
    const unsubscribe = usePlayerStore.subscribe((state, prev) => {
      const songChanged = state.currentSong?.id !== prev.currentSong?.id
      if (songChanged) {
        if (state.currentSong) {
          createForCurrentSong()
        } else {
          destroyControls()
        }
        return
      }
      if (!state.currentSong) return
      if (!created) {
        createForCurrentSong()
        return
      }
      if (state.isPlaying !== prev.isPlaying) {
        CapacitorMusicControls.updateIsPlaying({ isPlaying: state.isPlaying })
        CapacitorMusicControls.updateElapsed({
          elapsed: Math.round(state.currentTime),
          isPlaying: state.isPlaying,
        })
        lastElapsedPush = Date.now()
        return
      }
      // 锁屏进度条同步：播放中每 5s 节流推一次；seek 跳变立即推
      const jumped = Math.abs(state.currentTime - prev.currentTime) > 2
      const due = Date.now() - lastElapsedPush > 5000
      if (state.isPlaying && (jumped || due)) {
        CapacitorMusicControls.updateElapsed({
          elapsed: Math.round(state.currentTime),
          isPlaying: true,
        })
        lastElapsedPush = Date.now()
      }
    })

    return () => {
      unsubscribe()
      cleanups.forEach(fn => fn())
      destroyControls()
    }
  }, [])
}
