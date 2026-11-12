/**
 * 原生媒体控制桥（仅 Capacitor 原生壳生效）
 * 把 playerStore 的播放状态同步到 capacitor-music-controls-plugin：
 * - MediaStyle 前台服务通知（保证退后台音频不被挂起）
 * 事件回流：锁屏/通知上的 play/pause/next/previous/seek 调回 playerStore
 */

import { useEffect, useRef } from 'react'
import { CapacitorMusicControls } from 'capacitor-music-controls-plugin'
import { usePlayerStore } from '@/store/playerStore'
import { seekHowl } from '@/hooks/useAudioEngine'
import { findAdapterFor } from '@/api'
import { isNativePlatform } from '@/lib/platform'
import { notePauseReason } from '@/lib/playbackTrail'
import { useSettingsStore } from '@/store/settingsStore'
import { usePlaybackCover } from '@/hooks/usePlaybackCover'

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

const songKey = (song: { serverId?: string; id: string } | null) => (song ? `${song.serverId ?? ''}:${song.id}` : null)

/**
 * 封面列表的指纹。data: 图片有几百 KB，拿长度和中间一段比就够了；
 * 服务器封面地址每次生成都带新的随机鉴权参数（t / s），比之前先去掉，不然同一张图也算「变了」
 */
function coversIdentity(urls: string[]): string {
  return urls
    .map(url => {
      if (url.startsWith('data:') || url.startsWith('blob:')) return `${url.length}:${url.slice(32, 96)}`
      let plain = url
      try {
        plain = decodeURIComponent(url)
      } catch {
        // 解不开就按原样比
      }
      return plain.replace(/[?&](t|s)=[^&]*/g, '')
    })
    .join('|')
}

/** 256 封面：插件会把位图两次塞进 MediaSession metadata，太大会撞 Binder 事务上限 */
const NOTIFICATION_COVER = 256

/** data: / blob: 图片缩成 256 的 JPEG 再给原生：原图可能好几 MB */
function shrinkInline(url: string): Promise<string | null> {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = NOTIFICATION_COVER
        canvas.height = NOTIFICATION_COVER
        const ctx = canvas.getContext('2d')
        if (!ctx || !img.naturalWidth) return resolve(null)
        const scale = Math.max(NOTIFICATION_COVER / img.naturalWidth, NOTIFICATION_COVER / img.naturalHeight)
        const w = img.naturalWidth * scale
        const h = img.naturalHeight * scale
        ctx.drawImage(img, (NOTIFICATION_COVER - w) / 2, (NOTIFICATION_COVER - h) / 2, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.86))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/** 按播放条的顺序挑第一张能用的：网络地址交给原生去下，页面里的图先缩小 */
async function notificationCover(urls: string[]): Promise<string> {
  for (const url of urls) {
    if (/^https?:\/\//i.test(url)) return url
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      const small = await shrinkInline(url)
      if (small) return small
    }
  }
  return ''
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
  /*
   * 通知栏 / 锁屏的封面和播放条用同一套来源：钉住的图、服务器封面、自定义封面接口。
   * 以前只认服务器的 coverArt，服务器没给封面的歌（播放条靠自定义接口补上的）通知栏就是空的。
   */
  const currentSong = usePlayerStore(s => s.currentSong)
  const { urls } = usePlaybackCover(currentSong, { size: NOTIFICATION_COVER })
  const coverRef = useRef<{ song: string | null; urls: string[] }>({ song: null, urls: [] })
  coverRef.current = { song: songKey(currentSong), urls }
  const coverKey = `${songKey(currentSong)}|${coversIdentity(urls)}`
  const refreshCoverRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    refreshCoverRef.current?.()
  }, [coverKey])

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
    const keyOf = songKey
    /** 当前通知用的是哪一首、哪一组封面；自定义封面晚到时要补建一次 */
    let builtCovers: string | null = null
    let coverPending = false

    /** 这一首在 React 那边已经算好的封面；刚换歌时它还是上一首的，先退回服务器封面 */
    const coversFor = (song: NonNullable<ReturnType<typeof usePlayerStore.getState>['currentSong']>) => {
      const known = coverRef.current
      if (known.song === keyOf(song)) return known.urls
      const server = song.coverArt ? findAdapterFor(song.serverId)?.getCoverUrl(song.coverArt, NOTIFICATION_COVER) : undefined
      return server ? [server] : []
    }

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
      const covers = coversFor(currentSong)
      const coversId = `${creatingFor}|${coversIdentity(covers)}`
      void notificationCover(covers).then(cover => CapacitorMusicControls.create({
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
      })).then(() => {
        created = true
        retryAt = 0
        lastElapsedPush = Date.now()
        builtCovers = coversId
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
        if (recreatePending || coverPending) {
          recreatePending = false
          coverPending = false
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

    /** 封面（自定义接口那张常常晚到）变了：同一首歌重建一次通知，换上新封面 */
    refreshCoverRef.current = () => {
      const song = usePlayerStore.getState().currentSong
      if (!song) return
      const wanted = `${keyOf(song)}|${coversIdentity(coversFor(song))}`
      if (wanted === builtCovers) return
      if (creating) {
        coverPending = true
        return
      }
      if (created) createForCurrentSong()
    }

    const destroyControls = () => {
      builtCovers = null
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
    const onDocumentEvent = (event: Event) => dispatch(event as unknown as RemoteEvent)
    document.addEventListener('controlsNotification', onDocumentEvent)
    cleanups.push(() => document.removeEventListener('controlsNotification', onDocumentEvent))

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
      refreshCoverRef.current = null
      destroyControls()
    }
  }, [])
}
