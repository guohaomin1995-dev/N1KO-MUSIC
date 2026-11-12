/**
 * @vitest-environment happy-dom
 *
 * 天际屏歌词：当前句 + 下一句，两侧散字；当前句交给玻璃那一层画（data-lyric-text），进度写在 data-lyric-progress。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { usePlayerStore } from '@/store/playerStore'
import type { LyricLine } from '@/api/types'

vi.mock('@/hooks/useAudioEngine', () => ({ getAudioCurrentTime: () => 0 }))

const { SkylineLyric } = await import('./SkylineLyric')

let root: Root | null = null

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  document.body.innerHTML = ''
})

const lines: LyricLine[] = [
  { time: 0, text: '第一句' },
  { time: 2000, text: '想拉你的手' },
  { time: 4000, text: '我沉默太久' },
]

function renderAt(seconds: number, wide = true) {
  usePlayerStore.setState({ currentTime: seconds, duration: 60 } as never)
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root!.render(<SkylineLyric lines={lines} wide={wide} />) })
}

describe('SkylineLyric', () => {
  it('中间是当前句（逐字）和下一句；没有上一句', () => {
    // useLyrics 提前 500ms，2.4 秒时当前是第二句
    renderAt(2.4)
    const chars = [...document.querySelectorAll('.sky-char')].map(el => el.textContent).join('')
    expect(chars).toBe('想拉你的手')
    expect(document.querySelector('.sky-next')?.textContent).toBe('我沉默太久')
    expect(document.body.textContent).not.toContain('第一句')
  })

  it('当前句交给玻璃那一层画：data-lyric-text 是这一句，换句用的 data-lyric-key、进度 data-lyric-progress 都在', async () => {
    renderAt(2.4)
    const stage = document.querySelector<HTMLElement>('[data-lyric-stage]')
    expect(stage?.dataset.lyricText).toBe('想拉你的手')
    expect(stage?.dataset.lyricKey).toBe('1')
    // 玻璃字照着它取字体
    expect(document.querySelector('[data-beam-target]')?.textContent).toContain('想拉你的手')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
    expect(Number(stage?.dataset.lyricProgress)).toBeGreaterThanOrEqual(0)
  })

  it('下一句也交给玻璃那一层画（data-lyric-next + 它的位置样本）；这一句唱了几成写在 --sky-p', async () => {
    renderAt(2.4)
    const stage = document.querySelector<HTMLElement>('[data-lyric-stage]')!
    expect(stage.dataset.lyricNext).toBe('我沉默太久')
    expect(document.querySelector('[data-next-target]')?.textContent).toBe('我沉默太久')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
    const p = Number(stage.style.getPropertyValue('--sky-p'))
    expect(p).toBeGreaterThanOrEqual(0)
    expect(p).toBeLessThanOrEqual(1)
  })

  it('两侧的字取自当前这一句，换句整组跟着换', () => {
    renderAt(2.4)
    const words = () => [...document.querySelectorAll('.sky-word-face')].map(el => el.textContent)
    const first = words()
    expect(first.filter(w => '想拉你的手'.includes(w ?? '')).length).toBeGreaterThanOrEqual(4)
    act(() => { usePlayerStore.setState({ currentTime: 4 } as never) })
    // 旧的一组还在淡出，新的一组已经换成「我沉默太久」里的字
    expect(words().filter(w => '沉默太久'.includes(w ?? '')).length).toBeGreaterThanOrEqual(3)
  })

  it('颜色变量来自封面，两侧有散落的字（不给读屏念）', () => {
    renderAt(2.4)
    const stage = document.querySelector<HTMLElement>('[data-lyric-stage]')!
    expect(stage.style.getPropertyValue('--sky-a')).toMatch(/^rgb\(/)
    expect(stage.style.getPropertyValue('--sky-glow')).toMatch(/^\d+ \d+ \d+$/)
    const words = document.querySelectorAll('.sky-word')
    expect(words.length).toBeGreaterThan(0)
    expect(document.querySelector('.sky-side')?.getAttribute('aria-hidden')).toBe('true')
  })
})
