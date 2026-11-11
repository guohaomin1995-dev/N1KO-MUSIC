/**
 * 安卓 App 的「发现新版本」弹窗（数据与检查逻辑在 services/appUpdate）。
 *
 * 打开 App 时自动检查一次（6 小时内不重复，跳过的版本不再提示）；设置 → 关于里的「检查更新」
 * 也会弹它。安装包放在 GitHub 上，国内常常下不动，弹窗里必须说清楚「下不下来就打开代理」。
 */
import { useEffect } from 'react'
import { ArrowCircleUp, DownloadSimple, Globe } from '@phosphor-icons/react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/use-toast'
import { useT } from '@/i18n'
import { CURRENT_VERSION, openInBrowser, updateSupported, useAppUpdateStore } from '@/services/appUpdate'

function formatSize(bytes?: number): string {
  if (!bytes) return ''
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function AppUpdateDialog() {
  const { t } = useT()
  const { release, open, check, close, skip } = useAppUpdateStore()

  // 启动后稍等一会儿再查：别和首屏的曲库请求抢网络
  useEffect(() => {
    if (!updateSupported()) return
    const timer = window.setTimeout(() => { void check(false) }, 4000)
    return () => window.clearTimeout(timer)
  }, [check])

  if (!release) return null

  const download = () => {
    openInBrowser(release.apkUrl)
    close()
    toast({ title: t('appUpdate.downloadStarted'), description: t('appUpdate.downloadStartedHint') })
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) close() }}>
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
          <div className="max-h-[38vh] overflow-y-auto whitespace-pre-wrap rounded-md bg-fill px-4 py-3 text-[14px] leading-relaxed text-ink-2">
            {release.notes}
          </div>
        )}

        {/* 安装包在 GitHub：下不动的头号原因是没开代理，提前说 */}
        <p className="flex gap-2 rounded-md bg-leaf/10 px-4 py-3 text-[13.5px] leading-relaxed text-ink">
          <Globe size={18} weight="bold" className="mt-0.5 flex-none text-leaf" aria-hidden="true" />
          <span>{t('appUpdate.proxyHint')}</span>
        </p>

        <div className="flex flex-col gap-2 pt-1">
          <Button onClick={download} className="w-full">
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
        </div>
      </DialogContent>
    </Dialog>
  )
}
