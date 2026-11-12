/**
 * 安卓 App 的「发现新版本」弹窗（数据与检查逻辑在 services/appUpdate）。
 *
 * 打开 App 时自动检查一次（6 小时内不重复，跳过的版本不再提示）；设置 → 关于里的「检查更新」
 * 也会弹它。安装包放在 GitHub 上，国内常常下不动，弹窗里必须说清楚「下不下来就打开代理」。
 *
 * 安装包在 App 里下：进度条、可取消；关掉弹窗接着在后台下，下完弹回来。下好后「立即安装」
 * 拉起系统安装界面。第一次装会先跳到「安装未知应用」的设置页，回来后自动接着装。
 * 下载出错时给「重试」和「改用浏览器下载」两条路。
 */
import { useEffect } from 'react'
import { ArrowCircleUp, CheckCircle, DownloadSimple, Globe, WarningCircle } from '@phosphor-icons/react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/use-toast'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { CURRENT_VERSION, type DownloadState, openInBrowser, updateSupported, useAppUpdateStore } from '@/services/appUpdate'

/**
 * 更新说明是 GitHub Release 的 Markdown。只认最常用的两种写法：
 * 「## 标题」加粗、「- 列表项」变圆点；其余按普通段落，不引入整套 Markdown 渲染。
 */
function ReleaseNotes({ text }: { text: string }) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => {
        const heading = line.match(/^#{1,6}\s+(.*)$/)
        if (heading) {
          return <p key={i} className={cn('font-semibold text-ink', i > 0 && 'pt-2')}>{heading[1]}</p>
        }
        const item = line.match(/^[-*]\s+(.*)$/)
        if (item) {
          return (
            <p key={i} className="flex gap-2">
              <span aria-hidden="true" className="text-leaf">•</span>
              <span>{item[1]}</span>
            </p>
          )
        }
        return <p key={i}>{line}</p>
      })}
    </div>
  )
}

function formatSize(bytes?: number): string {
  if (!bytes) return ''
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 原生层错误码 → 文案键 */
function errorKey(code?: string): string {
  if (!code) return 'appUpdate.err.unknown'
  if (code === 'NETWORK') return 'appUpdate.err.network'
  if (code.startsWith('HTTP_')) return 'appUpdate.err.http'
  if (code === 'SIZE_MISMATCH') return 'appUpdate.err.incomplete'
  if (code === 'BAD_PACKAGE') return 'appUpdate.err.badPackage'
  if (code === 'NOT_NEWER') return 'appUpdate.err.notNewer'
  return 'appUpdate.err.unknown'
}

function DownloadProgress({ d }: { d: DownloadState }) {
  const { t } = useT()
  const ratio = d.total > 0 ? Math.min(1, d.received / d.total) : 0
  return (
    <div className="space-y-2" aria-live="polite">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        aria-label={t('appUpdate.downloading')}
        className="h-2 overflow-hidden rounded-pill bg-ink/[0.1]"
      >
        <div
          className="h-full origin-left rounded-pill bg-leaf transition-transform duration-200 ease-out"
          style={{ transform: `scaleX(${ratio})` }}
        />
      </div>
      <p className="num flex justify-between text-[13px] text-ink-3">
        <span>{t('appUpdate.downloading')}</span>
        <span>
          {d.total > 0
            ? `${formatSize(d.received) || '0.0 MB'} / ${formatSize(d.total)} · ${Math.round(ratio * 100)}%`
            : formatSize(d.received)}
        </span>
      </p>
    </div>
  )
}

export function AppUpdateDialog() {
  const { t } = useT()
  const { release, open, check, close, skip, download: d, startDownload, cancelDownload, install, resumeInstall } = useAppUpdateStore()

  // 启动后稍等一会儿再查：别和首屏的曲库请求抢网络
  useEffect(() => {
    if (!updateSupported()) return
    const timer = window.setTimeout(() => { void check(false) }, 4000)
    return () => window.clearTimeout(timer)
  }, [check])

  // 从「安装未知应用」设置页回来：允许了就接着装
  useEffect(() => {
    if (d.phase !== 'needs-permission') return
    const onVisible = () => { if (document.visibilityState === 'visible') void resumeInstall() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [d.phase, resumeInstall])

  if (!release) return null

  const useBrowser = () => {
    openInBrowser(release.apkUrl)
    close()
    toast({ title: t('appUpdate.downloadStarted'), description: t('appUpdate.downloadStartedHint') })
  }

  // 下载中关掉弹窗：不打断，后台接着下，下完弹回来
  const onOpenChange = (next: boolean) => {
    if (next) return
    if (d.phase === 'downloading') toast({ title: t('appUpdate.backgroundToast') })
    close()
  }

  const ready = d.phase === 'ready' || d.phase === 'needs-permission'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowCircleUp size={22} weight="fill" className="text-leaf" aria-hidden="true" />
            {t('appUpdate.title', { version: release.version })}
          </DialogTitle>
          <DialogDescription className="num">
            {t('appUpdate.current', { version: CURRENT_VERSION })}
            {release.apkSize ? ` · ${t('appUpdate.size', { size: formatSize(release.apkSize) })}` : ''}
          </DialogDescription>
        </DialogHeader>

        {release.notes && (
          <div className="max-h-[38vh] overflow-y-auto rounded-md bg-fill px-4 py-3 text-[14px] leading-relaxed text-ink-2">
            <ReleaseNotes text={release.notes} />
          </div>
        )}

        {/* 安装包在 GitHub：下不动的头号原因是没开代理，提前说（下好了就不必再说） */}
        {!ready && (
          <p className="flex gap-2 rounded-md bg-leaf/10 px-4 py-3 text-[13.5px] leading-relaxed text-ink">
            <Globe size={18} weight="bold" className="mt-0.5 flex-none text-leaf" aria-hidden="true" />
            <span>{t('appUpdate.proxyHint')}</span>
          </p>
        )}

        {d.phase === 'downloading' && <DownloadProgress d={d} />}

        {ready && (
          <p className="flex gap-2 rounded-md bg-fill px-4 py-3 text-[13.5px] leading-relaxed text-ink">
            <CheckCircle size={18} weight="fill" className="mt-0.5 flex-none text-leaf" aria-hidden="true" />
            <span>{t(d.phase === 'needs-permission' ? 'appUpdate.needsPermission' : 'appUpdate.readyHint')}</span>
          </p>
        )}

        {d.phase === 'error' && (
          <p role="alert" className="flex gap-2 rounded-md bg-fill px-4 py-3 text-[13.5px] leading-relaxed text-ink">
            <WarningCircle size={18} weight="fill" className="mt-0.5 flex-none text-danger" aria-hidden="true" />
            <span>{t(errorKey(d.errorCode), { code: d.errorCode?.replace('HTTP_', '') ?? '' })}</span>
          </p>
        )}

        <div className="flex flex-col gap-2 pt-1">
          {d.phase === 'idle' && (
            <>
              <Button onClick={() => { void startDownload() }} className="w-full">
                <DownloadSimple size={18} weight="bold" />
                {t('appUpdate.download')}
              </Button>
              <div className="flex gap-2">
                <Button variant="secondary" className="flex-1" onClick={close}>
                  {t('appUpdate.later')}
                </Button>
                <Button variant="ghost" className="flex-1" onClick={skip}>
                  {t('appUpdate.skip')}
                </Button>
              </div>
            </>
          )}

          {d.phase === 'downloading' && (
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => onOpenChange(false)}>
                {t('appUpdate.background')}
              </Button>
              <Button variant="ghost" className="flex-1" onClick={() => { void cancelDownload() }}>
                {t('appUpdate.cancel')}
              </Button>
            </div>
          )}

          {ready && (
            <>
              <Button onClick={() => { void install() }} className="w-full">
                <ArrowCircleUp size={18} weight="bold" />
                {t(d.phase === 'needs-permission' ? 'appUpdate.continueInstall' : 'appUpdate.install')}
              </Button>
              <Button variant="secondary" className="w-full" onClick={close}>
                {t('appUpdate.later')}
              </Button>
            </>
          )}

          {d.phase === 'error' && (
            <>
              <Button onClick={() => { void startDownload() }} className="w-full">
                <DownloadSimple size={18} weight="bold" />
                {t('appUpdate.retry')}
              </Button>
              <div className="flex gap-2">
                <Button variant="secondary" className="flex-1" onClick={useBrowser}>
                  {t('appUpdate.useBrowser')}
                </Button>
                <Button variant="ghost" className="flex-1" onClick={close}>
                  {t('appUpdate.later')}
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
