/**
 * @vitest-environment happy-dom
 *
 * 插件音源冷启动要连好几秒：连上之前拿不到适配器、没有服务器封面。
 * 连上之后封面地址必须跟着更新——否则取色一直只能用封面接口按歌名搜来的替补图（常常是别的歌的封面）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

const registry = vi.hoisted(() => ({ ready: false }))
vi.mock('@/api', () => ({
  findAdapterFor: () => (registry.ready ? { getCoverUrl: (id: string) => `https://cover.example/${id}.jpg` } : null),
}))

const { useCoverUrl } = await import('./useCoverUrl')
const { useServerStore } = await import('@/store/serverStore')
const { useSettingsStore } = await import('@/store/settingsStore')

let root: Root | null = null
afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  document.body.innerHTML = ''
})

const song = { coverArt: 'album-1', serverId: 'qq-1', title: '立夏居', artist: '陈婉晴' }
let seen: string | undefined

function Probe() {
  seen = useCoverUrl(song).primary
  return null
}

describe('来源连上之后，封面地址跟着更新', () => {
  it('连上之前没有服务器封面；连上（适配器登记、connectedServerIds 有它）之后就有了', () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    useSettingsStore.setState({ coverSource: 'server_first' } as never)
    useServerStore.setState({ connectedServerIds: [] } as never)
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => { root!.render(<Probe />) })
    expect(seen).toBeUndefined()

    registry.ready = true
    act(() => { useServerStore.setState({ connectedServerIds: ['qq-1'] } as never) })
    expect(seen).toBe('https://cover.example/album-1.jpg')
  })
})
