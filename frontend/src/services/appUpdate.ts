/**
 * 安卓 App 的版本更新：查 GitHub 上本仓库的最新 Release，比当前版本新、而且挂着 .apk 附件，
 * 就提示更新。安装包在 App 里下（原生 AppUpdaterPlugin，带进度、可取消，关掉弹窗也接着下），
 * 下完直接拉起系统安装界面覆盖安装；下不动时还能改用浏览器下载。
 *
 * 只在安卓原生壳里做：iOS 不能侧载安装包，桌面版和网页版另有更新方式。
 * GitHub 在国内经常连不上，检查失败时要说清楚「打开代理再试」，而不是一句「检查失败」。
 */
import { Capacitor, CapacitorHttp, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { create } from 'zustand'
import { pluginErrorCode } from '@/services/errors'
import pkg from '../../package.json'

/** 发布安装包的仓库 */
export const UPDATE_REPO = 'guohaomin1995-dev/N1KO-MUSIC'
export const RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases`
const LATEST_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`

/** 自动检查的最短间隔：GitHub 未登录接口每小时只给 60 次 */
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const LAST_CHECK_KEY = 'msp-update-last-check'
const SKIPPED_KEY = 'msp-update-skipped'

export const CURRENT_VERSION: string = pkg.version

export interface AppRelease {
  version: string
  tag: string
  notes: string
  apkUrl: string
  apkSize?: number
  pageUrl: string
  publishedAt?: string
}

export function updateSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

/** 版本号比较（去掉前缀 v，按数字逐段比；1.17.0 > 1.16.12） */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.trim().replace(/^v/i, '').split(/[.+-]/).map(n => parseInt(n, 10) || 0)
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

interface GithubRelease {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  published_at?: string
  draft?: boolean
  prerelease?: boolean
  assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>
}

/** GitHub 的 Release 响应 → 我们关心的几项；没有 .apk 附件的不算一个可装的版本 */
export function parseRelease(raw: GithubRelease): AppRelease | null {
  if (!raw || raw.draft || raw.prerelease || !raw.tag_name) return null
  const apk = (raw.assets ?? []).find(a => a.name?.toLowerCase().endsWith('.apk') && a.browser_download_url)
  if (!apk?.browser_download_url) return null
  return {
    version: raw.tag_name.replace(/^v/i, ''),
    tag: raw.tag_name,
    notes: (raw.body ?? '').trim(),
    apkUrl: apk.browser_download_url,
    apkSize: apk.size,
    pageUrl: raw.html_url ?? RELEASES_PAGE,
    publishedAt: raw.published_at,
  }
}

async function fetchLatestRelease(): Promise<AppRelease | null> {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  // 原生请求：不受网页跨域限制，也走系统代理
  const res = Capacitor.isNativePlatform()
    ? await CapacitorHttp.request({ url: LATEST_API, method: 'GET', headers, connectTimeout: 10000, readTimeout: 15000 })
    : await fetch(LATEST_API, { headers }).then(async r => ({ status: r.status, data: await r.json() }))
  if (res.status === 404) return null
  if (res.status < 200 || res.status >= 300) throw new Error(`GitHub ${res.status}`)
  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data
  return parseRelease(data as GithubRelease)
}

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function writeStorage(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* 存不下只是下次多检查一次 */ }
}

export type UpdateCheckOutcome = 'available' | 'latest' | 'failed' | 'skipped'

/* ---------------------------------------------------------------- 应用内下载与安装 */

interface AppUpdaterPlugin {
  download(options: { url: string; fileName: string; expectedSize?: number }): Promise<{ path: string; size: number }>
  cancel(): Promise<void>
  canInstall(): Promise<{ allowed: boolean }>
  install(options: { path: string }): Promise<{ status: 'started' | 'needs-permission' }>
  addListener(event: 'progress', listener: (e: { received: number; total: number }) => void): Promise<PluginListenerHandle>
}

const AppUpdater = registerPlugin<AppUpdaterPlugin>('AppUpdater')

/**
 * idle 还没下 · downloading 下载中 · ready 下好了（点安装拉起系统安装界面）·
 * needs-permission 系统还没允许本 App 安装应用（设置页已打开，回来后自动再装）· error 出错
 */
export type DownloadPhase = 'idle' | 'downloading' | 'ready' | 'needs-permission' | 'error'

export interface DownloadState {
  phase: DownloadPhase
  /** 下载的是哪个版本：换了版本就从头来 */
  version?: string
  received: number
  total: number
  path?: string
  /** 原生层的错误码：NETWORK / HTTP_404 / SIZE_MISMATCH / BAD_PACKAGE / NOT_NEWER / NOT_FOUND … */
  errorCode?: string
}

const IDLE: DownloadState = { phase: 'idle', received: 0, total: 0 }

/** 安装包在缓存目录里的文件名（原生层只收 [A-Za-z0-9._-]+.apk） */
export function apkFileName(version: string): string {
  return `X-MUSIC-${version.replace(/[^A-Za-z0-9._-]/g, '')}.apk`
}

/** 原生层 reject 带的错误码（Capacitor 放在 error.code 上） */
function errorCodeOf(e: unknown): string {
  return pluginErrorCode(e) || 'UNKNOWN'
}

interface AppUpdateState {
  release: AppRelease | null
  /** 弹窗是否打开 */
  open: boolean
  checking: boolean
  download: DownloadState
  /** 在 App 里下载安装包；下完自动弹回来等安装 */
  startDownload: () => Promise<void>
  cancelDownload: () => Promise<void>
  /** 拉起系统安装界面；还没被允许安装应用时会打开设置页，状态变成 needs-permission */
  install: () => Promise<void>
  /** 从设置页回来：已经允许了就接着装 */
  resumeInstall: () => Promise<void>
  /** 检查一次。manual = 用户点的「检查更新」：不看间隔、也不管之前跳过的版本 */
  check: (manual?: boolean) => Promise<UpdateCheckOutcome>
  close: () => void
  /** 这个版本不再自动提示 */
  skip: () => void
}

export const useAppUpdateStore = create<AppUpdateState>((set, get) => ({
  release: null,
  open: false,
  checking: false,
  download: IDLE,
  startDownload: async () => {
    const release = get().release
    if (!release || get().download.phase === 'downloading') return
    set({ download: { ...IDLE, phase: 'downloading', version: release.version, total: release.apkSize ?? 0 } })
    let handle: PluginListenerHandle | null = null
    try {
      handle = await AppUpdater.addListener('progress', e => {
        const d = get().download
        if (d.phase !== 'downloading' || d.version !== release.version) return
        set({ download: { ...d, received: e.received, total: e.total > 0 ? e.total : d.total } })
      })
      const result = await AppUpdater.download({
        url: release.apkUrl,
        fileName: apkFileName(release.version),
        expectedSize: release.apkSize,
      })
      // 关着弹窗在后台下的，下完弹回来让人点安装
      set({ download: { phase: 'ready', version: release.version, received: result.size, total: result.size, path: result.path }, open: true })
    } catch (e) {
      const code = errorCodeOf(e)
      if (code === 'CANCELLED') set({ download: IDLE })
      else set(s => ({ download: { ...s.download, phase: 'error', errorCode: code }, open: true }))
    } finally {
      void handle?.remove()
    }
  },
  cancelDownload: async () => {
    if (get().download.phase !== 'downloading') return
    try { await AppUpdater.cancel() } catch { /* 原生层已经结束了，download 那边会收尾 */ }
  },
  install: async () => {
    const d = get().download
    if (!d.path) return
    try {
      const { status } = await AppUpdater.install({ path: d.path })
      set({ download: { ...d, phase: status === 'needs-permission' ? 'needs-permission' : 'ready' } })
    } catch (e) {
      const code = errorCodeOf(e)
      // 缓存被系统清掉了：回到「还没下」，重新下一次就好
      if (code === 'NOT_FOUND') set({ download: IDLE })
      else set({ download: { ...d, phase: 'error', errorCode: code } })
    }
  },
  resumeInstall: async () => {
    if (get().download.phase !== 'needs-permission') return
    try {
      const { allowed } = await AppUpdater.canInstall()
      if (allowed) await get().install()
    } catch { /* 留在 needs-permission，界面上还有「继续安装」 */ }
  },
  check: async (manual = false) => {
    if (!updateSupported() || get().checking) return 'skipped'
    if (!manual) {
      const last = Number(readStorage(LAST_CHECK_KEY) || 0)
      if (Date.now() - last < AUTO_CHECK_INTERVAL_MS) return 'skipped'
    }
    set({ checking: true })
    try {
      const release = await fetchLatestRelease()
      writeStorage(LAST_CHECK_KEY, String(Date.now()))
      if (!release || compareVersions(release.version, CURRENT_VERSION) <= 0) {
        set({ release: null })
        return 'latest'
      }
      if (!manual && readStorage(SKIPPED_KEY) === release.version) return 'skipped'
      // 又出了更新的版本：之前下好的旧安装包作废（正在下的不打断）
      const d = get().download
      const stale = d.phase !== 'idle' && d.phase !== 'downloading' && d.version !== release.version
      set({ release, open: true, ...(stale ? { download: IDLE } : {}) })
      return 'available'
    } catch {
      return 'failed'
    } finally {
      set({ checking: false })
    }
  },
  close: () => set({ open: false }),
  skip: () => {
    const release = get().release
    if (release) writeStorage(SKIPPED_KEY, release.version)
    set({ open: false })
  },
}))

/** 用系统浏览器打开（下载安装包 / 打开发布页）。原生壳里外站链接会被交给系统浏览器 */
export function openInBrowser(url: string) {
  const link = document.createElement('a')
  link.href = url
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  document.body.appendChild(link)
  link.click()
  link.remove()
}
