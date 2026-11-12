/**
 * 让房间随歌变色：跟着当前曲目正在显示的那张封面取色，写进根元素的 --art-*。
 * 只在外壳里挂一次（MainLayout）。
 */
import { useEffect, useRef } from 'react'
import { usePlayerStore } from '@/store/playerStore'
import { useArtLightStore } from '@/store/artLightStore'
import { usePlaybackCover } from '@/hooks/usePlaybackCover'
import { HOUSE_LIGHTS, applyPalette, getPalette, peekPalette } from '@/services/artLight'

function coverIdentity(url: string): string {
  if (url.startsWith('data:') || url.startsWith('blob:')) return `${url.length}:${url.slice(24, 64)}`
  return url
}

export function useArtLight() {
  const currentSong = usePlayerStore(s => s.currentSong)
  const { urls, pending } = usePlaybackCover(currentSong)
  const identity = urls.map(coverIdentity).join('|')
  const urlsRef = useRef(urls)
  urlsRef.current = urls

  useEffect(() => {
    const urls = urlsRef.current
    if (pending) return
    const { setPalette } = useArtLightStore.getState()
    if (urls.length === 0) {
      applyPalette(HOUSE_LIGHTS)
      setPalette(HOUSE_LIGHTS, null)
      return
    }

    let cancelled = false
    const apply = (palette: NonNullable<Awaited<ReturnType<typeof getPalette>>>, url: string) => {
      applyPalette(palette)
      setPalette(palette, url)
    }

    // 只认眼前这张封面（第一张）的缓存。后面几张是它加载失败时的替补——比如封面接口按歌名搜来的图，
    // 常常是别的歌的封面；第一张还没取过色就先去取它，不能拿替补的旧缓存顶上
    const first = peekPalette(urls[0])
    if (first) {
      apply(first, urls[0])
      return
    }

    const run = () => {
      void (async () => {
        for (const url of urls) {
          const palette = await getPalette(url)
          if (cancelled) return
          if (palette) {
            apply(palette, url)
            return
          }
        }
        if (!cancelled) {
          applyPalette(HOUSE_LIGHTS)
          setPalette(HOUSE_LIGHTS, null)
        }
      })()
    }
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback
    const cancelIdle = (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback
    if (idle && cancelIdle) {
      const handle = idle(run, { timeout: 400 })
      return () => {
        cancelled = true
        cancelIdle(handle)
      }
    }
    const timer = setTimeout(run, 60)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [identity, pending])
}
