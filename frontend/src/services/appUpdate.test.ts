/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* Node 26 自带一个实验性的 localStorage，没开 --localstorage-file 时是 undefined，会盖掉 happy-dom 的；
   这里给一个内存版，测试不依赖运行时版本 */
const memory = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => { memory.set(k, String(v)) },
  removeItem: (k: string) => { memory.delete(k) },
  clear: () => memory.clear(),
})

const http = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
  CapacitorHttp: { request: http.request },
}))

const { compareVersions, parseRelease, useAppUpdateStore, CURRENT_VERSION } = await import('./appUpdate')

const release = (tag: string, assets = [{ name: `X-MUSIC-${tag}.apk`, browser_download_url: `https://github.com/x/releases/download/${tag}/a.apk`, size: 12_000_000 }]) => ({
  tag_name: tag, body: '更新说明', html_url: 'https://github.com/x/releases/tag/' + tag, assets,
})

beforeEach(() => {
  localStorage.clear()
  useAppUpdateStore.setState({ release: null, open: false, checking: false })
  http.request.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('compareVersions', () => {
  it('按数字逐段比，前缀 v 不影响', () => {
    expect(compareVersions('1.17.0', '1.16.1')).toBe(1)
    expect(compareVersions('v1.16.12', '1.16.2')).toBe(1)
    expect(compareVersions('1.16.1', 'v1.16.1')).toBe(0)
    expect(compareVersions('1.9.9', '1.10.0')).toBe(-1)
  })
})

describe('parseRelease', () => {
  it('取出版本号和 .apk 附件', () => {
    const r = parseRelease(release('v9.0.0'))
    expect(r?.version).toBe('9.0.0')
    expect(r?.apkUrl).toMatch(/\.apk$/)
    expect(r?.apkSize).toBe(12_000_000)
  })
  it('没有 apk 附件、草稿、预发布都不算', () => {
    expect(parseRelease(release('v9.0.0', []))).toBeNull()
    expect(parseRelease({ ...release('v9.0.0'), draft: true })).toBeNull()
    expect(parseRelease({ ...release('v9.0.0'), prerelease: true })).toBeNull()
  })
})

describe('检查更新', () => {
  it('有更新的版本：弹窗', async () => {
    http.request.mockResolvedValue({ status: 200, data: release('v99.0.0') })
    expect(await useAppUpdateStore.getState().check(true)).toBe('available')
    expect(useAppUpdateStore.getState().open).toBe(true)
    expect(useAppUpdateStore.getState().release?.version).toBe('99.0.0')
  })

  it('最新的就是当前版本：不弹', async () => {
    http.request.mockResolvedValue({ status: 200, data: release(`v${CURRENT_VERSION}`) })
    expect(await useAppUpdateStore.getState().check(true)).toBe('latest')
    expect(useAppUpdateStore.getState().open).toBe(false)
  })

  it('跳过的版本：自动检查不再提示，手动检查照样提示', async () => {
    http.request.mockResolvedValue({ status: 200, data: release('v99.0.0') })
    await useAppUpdateStore.getState().check(true)
    useAppUpdateStore.getState().skip()
    localStorage.removeItem('msp-update-last-check')
    expect(await useAppUpdateStore.getState().check(false)).toBe('skipped')
    expect(await useAppUpdateStore.getState().check(true)).toBe('available')
  })

  it('自动检查 6 小时内不重复', async () => {
    http.request.mockResolvedValue({ status: 200, data: release(`v${CURRENT_VERSION}`) })
    await useAppUpdateStore.getState().check(false)
    expect(await useAppUpdateStore.getState().check(false)).toBe('skipped')
    expect(http.request).toHaveBeenCalledTimes(1)
  })

  it('连不上 GitHub：报失败，不弹窗', async () => {
    http.request.mockRejectedValue(new Error('timeout'))
    expect(await useAppUpdateStore.getState().check(true)).toBe('failed')
    expect(useAppUpdateStore.getState().open).toBe(false)
  })
})
