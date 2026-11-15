/**
 * 设置 · 桌面小部件（只在安卓上出现）：背景透明度，和「添加到桌面」。
 *
 * 透明度改了立刻生效：settingsStore 一变，services/homeWidget 就把新值推给原生重画，不用回桌面重新加。
 * 「添加到桌面」是请桌面弹它自己的确认框；有的桌面不支持由应用发起（或者被系统权限拦了），
 * 那就提示手动去加——所以按钮下面一直写着手动的走法。
 */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { toast } from '@/components/ui/use-toast'
import { useT } from '@/i18n'
import { useSettingsStore } from '@/store/settingsStore'
import { requestWidgetPin, widgetStatus, type WidgetSize } from '@/services/homeWidget'
import { Row, Section, Segmented } from './primitives'

const STOPS = [0, 25, 50, 75, 100]

export function WidgetSettings() {
  const { t } = useT()
  const transparency = useSettingsStore(s => s.widgetTransparency)
  const setTransparency = useSettingsStore(s => s.setWidgetTransparency)
  const [pinSupported, setPinSupported] = useState(false)

  useEffect(() => {
    let alive = true
    void widgetStatus().then(status => {
      if (alive) setPinSupported(status.pinSupported)
    })
    return () => {
      alive = false
    }
  }, [])

  const add = async (size: WidgetSize) => {
    const requested = await requestWidgetPin(size)
    if (!requested) toast({ title: t('settings.widget.addManual') })
  }

  return (
    <Section title={t('settings.widget')}>
      <Row name={t('settings.widget.transparency')} desc={t('settings.widget.transparencyDesc')}>
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <Slider
            value={[transparency]}
            min={0}
            max={100}
            step={5}
            onValueChange={([v]) => setTransparency(v)}
            aria-label={t('settings.widget.transparency')}
            className="w-28"
          />
          <span className="num w-10 text-right text-[13px] text-ink-2">{transparency}%</span>
          <Segmented
            label={t('settings.widget.transparency')}
            value={String(transparency)}
            onChange={v => setTransparency(Number(v))}
            options={STOPS.map(stop => ({ value: String(stop), label: `${stop}%` }))}
          />
        </div>
      </Row>
      <Row name={t('settings.widget.add')} desc={t('settings.widget.addDesc')}>
        {pinSupported && (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => void add('small')} className="h-11 [@media(hover:hover)]:h-9">
              {t('settings.widget.addSmall')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void add('large')} className="h-11 [@media(hover:hover)]:h-9">
              {t('settings.widget.addLarge')}
            </Button>
          </div>
        )}
      </Row>
    </Section>
  )
}
