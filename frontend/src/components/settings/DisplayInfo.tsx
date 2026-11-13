/**
 * 设置 · 关于 · 显示信息：一行字，说清这台设备是怎么画画面的（lib/displayInfo）。
 * 电视、车机接不了电脑调试，画面发糊、有色块、有锯齿时拍下这一行就够判断了。
 */
import { useMemo } from 'react'
import { useT } from '@/i18n'
import { getDisplayInfo } from '@/lib/displayInfo'
import { Row } from './primitives'

export function DisplayInfo() {
  const { t } = useT()
  const info = useMemo(() => getDisplayInfo(), [])
  return (
    <Row
      name={t('diag.display.title')}
      desc={t('diag.display.desc', {
        screen: info.screen,
        page: info.page,
        dpr: info.dpr,
        zoom: info.zoom,
        engine: info.engine || '—',
        gpu: info.gpu || '—',
        precision: info.precision || '—',
      })}
    />
  )
}
