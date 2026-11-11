/**
 * @vitest-environment happy-dom
 *
 * 歌词页只放当前这一句。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { SpotlightLyric } from './SpotlightLyric'
import { usePlayerStore } from '@/store/playerStore'
import type { LyricLine } from '@/api/types'

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
  { time: 2000, text: '第二句' },
  { time: 4000, text: '第三句' },
]

function renderAt(seconds: number) {
  usePlayerStore.setState({ currentTime: seconds } as never)
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root!.render(<SpotlightLyric lines={lines} />) })
}

describe('SpotlightLyric', () => {
  it('只放当前这一句', () => {
    // useLyrics 提前 500ms，2.4 秒时当前是第二句
    renderAt(2.4)
    const current = document.querySelector('[data-beam-target]')
    expect(current?.textContent).toContain('第二句')
    expect(document.body.textContent).not.toContain('第三句')
  })

  it('换句后显示新的一句', () => {
    renderAt(2.4)
    act(() => { usePlayerStore.setState({ currentTime: 5 } as never) })
    const currents = [...document.querySelectorAll('[data-beam-target]')].map(el => el.textContent)
    expect(currents.some(text => text?.includes('第三句'))).toBe(true)
  })
})
