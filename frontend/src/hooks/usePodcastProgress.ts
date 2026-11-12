/**
 * 播放播客节目时把位置记进本机（podcastProgressStore）。
 *
 * 和长音轨书签（useLongTrackBookmark）一个套路：定时记一次，暂停、切到后台、换下一期时
 * 补记一次。换歌时 React 先提交新状态、再跑上一轮 effect 的清理，那时候现读 store 读到的
 * 已经是下一期了——所以位置在每次 tick 里就存一份，清理时用存下来的这份。
 *
 * 接着放（seek 到记下的位置）在播放引擎里做，见 useAudioEngine 的书签续听。
 */

import { useEffect } from 'react'
import { usePlayerStore } from '@/store/playerStore'
import { isPodcastEpisode, podcastResumeSeconds, usePodcastProgressStore } from '@/store/podcastProgressStore'
import type { Song } from '@/api/types'

const TICK_MS = 5_000
/** 续听的 seek 最多这么久落地（引擎 0.5 s 后开始试，重试约 3 s） */
const RESUME_GRACE_MS = 15_000

export function usePodcastProgress() {
  // 带上 playVersion：同一期重新点播放（或失败后重试）也算新的一轮
  const playKey = usePlayerStore(s => (s.currentSong ? `${s.currentSong.serverId}|${s.currentSong.id}#${s.playVersion}` : ''))

  useEffect(() => {
    const song = usePlayerStore.getState().currentSong
    if (!song || !isPodcastEpisode(song)) return

    let lastSeen: { song: Song; seconds: number; duration: number } | null = null
    // 这一轮要续到哪儿：seek 落地之前播放器报的是从头开始的位置，不能拿它盖掉记下的进度
    const resumeTarget = podcastResumeSeconds(song)
    const startedAt = Date.now()

    const tick = () => {
      const st = usePlayerStore.getState()
      const now = st.currentSong
      if (!now || now.id !== song.id || now.serverId !== song.serverId) return
      const seconds = st.currentTime || 0
      // 刚换过来、位置还没走起来时别拿 0 盖掉上次的进度（续听的 seek 还没落地）
      if (seconds < 1) return
      if (resumeTarget !== null && Date.now() - startedAt < RESUME_GRACE_MS && Math.abs(seconds - resumeTarget) > 20) return
      lastSeen = { song: now, seconds, duration: st.duration || 0 }
      usePodcastProgressStore.getState().record(now, seconds, st.duration || undefined)
    }

    const flush = () => {
      if (!lastSeen) return
      usePodcastProgressStore.getState().record(lastSeen.song, lastSeen.seconds, lastSeen.duration || undefined)
    }

    const timer = setInterval(tick, TICK_MS)
    // 暂停那一下也记：之后可能就直接划掉 App 了
    const unsubscribe = usePlayerStore.subscribe((state, prev) => {
      if (prev.isPlaying && !state.isPlaying) tick()
    })
    const onHidden = () => { if (document.visibilityState === 'hidden') tick() }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', tick)
    return () => {
      clearInterval(timer)
      unsubscribe()
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', tick)
      flush()
    }
  }, [playKey])
}
