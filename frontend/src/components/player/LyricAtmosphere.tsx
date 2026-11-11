/**
 * 歌词页的底：糊开的封面。
 *
 * 颜色直接来自这张封面，不靠取色。WebGL 起不来时 LyricSmoke 退回这里。
 */

import { useEffect, useState } from 'react'

export function LyricAtmosphere({ coverUrl }: { coverUrl?: string }) {
  const [preview, setPreview] = useState<string | null>(null)

  useEffect(() => {
    if (!coverUrl) {
      setPreview(null)
      return
    }
    let cancelled = false
    const img = new Image()
    if (!coverUrl.startsWith('data:') && !coverUrl.startsWith('blob:')) img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (cancelled) return
      // 自定义封面常常是原图，整张糊开会把平板拖死。缩成一小块再放大，颜色还是这张封面
      const canvas = document.createElement('canvas')
      canvas.width = 64
      canvas.height = 64
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        setPreview(coverUrl)
        return
      }
      ctx.drawImage(img, 0, 0, 64, 64)
      try {
        setPreview(canvas.toDataURL('image/jpeg', 0.82))
      } catch {
        setPreview(null)
      }
    }
    img.onerror = () => { if (!cancelled) setPreview(null) }
    img.src = coverUrl
    return () => { cancelled = true }
  }, [coverUrl])

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-20 overflow-hidden">
      {preview && <img src={preview} alt="" className="lyric-haze" />}
      <div className="lyric-veil" />
    </div>
  )
}
