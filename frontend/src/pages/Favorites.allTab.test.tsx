/**
 * @vitest-environment happy-dom
 *
 * 收藏页「全部」tab：各音源的收藏合成一张单子，跨源同一首只留一条（代表版本按播放优先序），
 * 默认就停在「全部」，每行带来源标识；切到单个音源只看那一家。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Song } from '@/api/types'

const song = (id: string, title: string, artist: string, serverId: string, duration = 200): Song =>
  ({ id, title, artist, album: 'A', duration, serverId, starred: true }) as Song

const groups = [
  { serverId: 'nas', name: 'Subsonic - 192.168.1.150', type: 'subsonic', status: 'success' as const,
    data: { songs: [song('n1', '晴天', '周杰伦', 'nas'), song('n2', '稻香', '周杰伦', 'nas')], albums: [], artists: [] } },
  { serverId: 'wy', name: '网易云音乐 · 我', type: 'plugin', pluginId: 'netease', status: 'success' as const,
    // 「晴天」与 NAS 那首是同一首（歌名、歌手相同，时长差 1 秒）
    data: { songs: [song('w1', '晴天', '周杰伦', 'wy', 201), song('w2', '失眠了', '吴琳珂', 'wy')], albums: [], artists: [] } },
  { serverId: 'qq', name: 'QQ 音乐 · 我', type: 'plugin', pluginId: 'qqmusic', status: 'success' as const,
    data: { songs: [song('q1', '告白气球', '周杰伦', 'qq')], albums: [], artists: [] } },
]

vi.mock('@/hooks/useSourceQueries', async importOriginal => ({
  ...(await importOriginal<typeof import('@/hooks/useSourceQueries')>()),
  useSourceStarred: vi.fn(() => groups),
  usePlaybackPriorityOrder: vi.fn(() => groups.map(g => ({ serverId: g.serverId, name: g.name, type: g.type }))),
}))
vi.mock('@/hooks/useServerQueries', () => ({
  useStarred: vi.fn(() => ({ data: undefined, isLoading: false, isError: false })),
}))
vi.mock('@/components/music/SongList', () => ({
  SongList: ({ songs, sourceBadge }: { songs: Song[]; sourceBadge?: boolean }) => (
    <ul data-testid="songs" data-badge={String(!!sourceBadge)}>
      {songs.map(s => <li key={`${s.serverId}:${s.id}`} data-src={s.serverId}>{s.title}</li>)}
    </ul>
  ),
}))

const { default: FavoritesPage } = await import('./Favorites')

let root: Root | null = null
afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  document.body.innerHTML = ''
})

async function mount(path = '/favorites') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[path]}>
          <Routes><Route path="/favorites" element={<FavoritesPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  })
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
}

const rows = () => [...document.querySelectorAll('[data-testid=songs] li')].map(li => `${li.textContent}@${li.getAttribute('data-src')}`)
const tabs = () => [...document.querySelectorAll('[role=tab]')].map(el => ({ text: el.textContent ?? '', selected: el.getAttribute('aria-selected') === 'true' }))

describe('收藏页「全部」tab', () => {
  it('默认停在「全部」：三家合并，跨源同一首只留一条（NAS 版本），每行带来源标识', async () => {
    await mount()
    const t = tabs()
    expect(t[0].text).toContain('All')
    expect(t[0].selected).toBe(true)
    expect(t[0].text).toContain('4')
    expect(rows()).toEqual(['晴天@nas', '稻香@nas', '失眠了@wy', '告白气球@qq'])
    expect(document.querySelector('[data-testid=songs]')?.getAttribute('data-badge')).toBe('true')
  })

  it('点单个音源只看那一家，不带来源标识', async () => {
    await mount()
    const wy = [...document.querySelectorAll('[role=tab]')].find(el => el.textContent?.includes('网易云')) as HTMLButtonElement
    act(() => { wy.click() })
    // 等 #057 的面板过渡播完（旧的 0.2 s 淡出），旧面板才会从文档里移除
    await act(async () => { await new Promise(r => setTimeout(r, 600)) })
    expect(rows()).toEqual(['晴天@wy', '失眠了@wy'])
    expect(document.querySelector('[data-testid=songs]')?.getAttribute('data-badge')).toBe('false')
  })
})
