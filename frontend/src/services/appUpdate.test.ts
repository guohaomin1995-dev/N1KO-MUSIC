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
/** 假的原生 AppUpdater：download / install 由各个测试安排结果，progress 监听器存下来手动触发 */
const updater = vi.hoisted(() => ({
  download: vi.fn(),
  cancel: vi.fn(async () => undefined),
  canInstall: vi.fn(),
  install: vi.fn(),
  progress: null as null | ((e: { received: number; total: number }) => void),
  addListener: vi.fn(),
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
  CapacitorHttp: { request: http.request },
  registerPlugin: () => updater,
}))

const { compareVersions, parseRelease, useAppUpdateStore, CURRENT_VERSION, apkFileName } = await import('./appUpdate')

const release = (tag: string, assets = [{ name: `X-MUSIC-${tag}.apk`, browser_download_url: `https://github.com/x/releases/download/${tag}/a.apk`, size: 12_000_000 }]) => ({
  tag_name: tag, body: '更新说明', html_url: 'https://github.com/x/releases/tag/' + tag, assets,
})

beforeEach(() => {
  localStorage.clear()
  useAppUpdateStore.setState({ release: null, open: false, checking: false, download: { phase: 'idle', received: 0, total: 0 } })
  http.request.mockReset()
  for (const fn of [updater.download, updater.canInstall, updater.install, updater.addListener]) fn.mockReset()
  updater.progress = null
  updater.addListener.mockImplementation(async (_event: string, listener: (e: { received: number; total: number }) => void) => {
    updater.progress = listener
    return { remove: async () => { updater.progress = null } }
  })
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

describe('应用内下载与安装', () => {
  const ready = () => {
    const r = parseRelease(release('v99.0.0'))!
    useAppUpdateStore.setState({ release: r, open: true })
    return r
  }
  /** 等原生 download 被调用（addListener 先 await 一拍） */
  const started = () => vi.waitFor(() => expect(updater.download).toHaveBeenCalled())

  it('边下边更新进度；下完变成可安装，弹窗弹回来；文件名只用安全字符', async () => {
    const r = ready()
    let finish!: (v: { path: string; size: number }) => void
    updater.download.mockReturnValue(new Promise(res => { finish = res }))
    const pending = useAppUpdateStore.getState().startDownload()
    await started()
    expect(updater.download).toHaveBeenCalledWith({ url: r.apkUrl, fileName: 'X-MUSIC-99.0.0.apk', expectedSize: 12_000_000 })
    expect(useAppUpdateStore.getState().download).toMatchObject({ phase: 'downloading', total: 12_000_000, received: 0 })
    updater.progress!({ received: 3_000_000, total: 12_000_000 })
    expect(useAppUpdateStore.getState().download.received).toBe(3_000_000)
    useAppUpdateStore.setState({ open: false }) // 关掉弹窗，后台接着下
    finish({ path: '/cache/updates/X-MUSIC-99.0.0.apk', size: 12_000_000 })
    await pending
    expect(useAppUpdateStore.getState().download).toMatchObject({ phase: 'ready', path: '/cache/updates/X-MUSIC-99.0.0.apk' })
    expect(useAppUpdateStore.getState().open).toBe(true)
    expect(updater.progress).toBeNull()
    expect(apkFileName('1.18.0-beta/../x')).toBe('X-MUSIC-1.18.0-beta..x.apk')
  })

  it('取消回到还没下；网络中断给出错误码并弹回来', async () => {
    ready()
    updater.download.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }))
    await useAppUpdateStore.getState().startDownload()
    expect(useAppUpdateStore.getState().download.phase).toBe('idle')

    useAppUpdateStore.setState({ open: false })
    updater.download.mockRejectedValueOnce(Object.assign(new Error('net'), { code: 'NETWORK' }))
    await useAppUpdateStore.getState().startDownload()
    expect(useAppUpdateStore.getState().download).toMatchObject({ phase: 'error', errorCode: 'NETWORK' })
    expect(useAppUpdateStore.getState().open).toBe(true)
  })

  it('第一次安装要先允许「安装未知应用」：从设置页回来、已允许就接着装', async () => {
    ready()
    updater.download.mockResolvedValue({ path: '/cache/updates/a.apk', size: 1 })
    await useAppUpdateStore.getState().startDownload()
    updater.install.mockResolvedValueOnce({ status: 'needs-permission' }).mockResolvedValueOnce({ status: 'started' })
    await useAppUpdateStore.getState().install()
    expect(useAppUpdateStore.getState().download.phase).toBe('needs-permission')

    updater.canInstall.mockResolvedValueOnce({ allowed: false })
    await useAppUpdateStore.getState().resumeInstall()
    expect(updater.install).toHaveBeenCalledTimes(1)

    updater.canInstall.mockResolvedValueOnce({ allowed: true })
    await useAppUpdateStore.getState().resumeInstall()
    expect(updater.install).toHaveBeenCalledTimes(2)
    expect(updater.install).toHaveBeenLastCalledWith({ path: '/cache/updates/a.apk' })
    expect(useAppUpdateStore.getState().download.phase).toBe('ready')
  })

  it('安装包被系统清掉了就回到还没下；不是本 App 的包报错', async () => {
    ready()
    useAppUpdateStore.setState({ download: { phase: 'ready', version: '99.0.0', received: 1, total: 1, path: '/cache/updates/a.apk' } })
    updater.install.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'NOT_FOUND' }))
    await useAppUpdateStore.getState().install()
    expect(useAppUpdateStore.getState().download.phase).toBe('idle')

    useAppUpdateStore.setState({ download: { phase: 'ready', version: '99.0.0', received: 1, total: 1, path: '/cache/updates/a.apk' } })
    updater.install.mockRejectedValueOnce(Object.assign(new Error('bad'), { code: 'BAD_PACKAGE' }))
    await useAppUpdateStore.getState().install()
    expect(useAppUpdateStore.getState().download).toMatchObject({ phase: 'error', errorCode: 'BAD_PACKAGE' })
  })

  it('又出了更新的版本：之前下好的旧包作废', async () => {
    useAppUpdateStore.setState({ download: { phase: 'ready', version: '98.0.0', received: 1, total: 1, path: '/cache/updates/old.apk' } })
    http.request.mockResolvedValue({ status: 200, data: release('v99.0.0') })
    await useAppUpdateStore.getState().check(true)
    expect(useAppUpdateStore.getState().download.phase).toBe('idle')
  })
})
