/**
 * 播客页上的几种时间写法：节目发布日期（「3 天前」「10月21日」「2024年5月3日」），
 * 节目时长 / 剩余时长（「52 分钟」「1 小时 5 分」）。
 */
import type { Locale } from '@/i18n'

type T = typeof import('@/i18n').t

const DAY = 24 * 60 * 60 * 1000

/** 发布日期：一周内说「几天前」，今年内说月日，更早的带上年份 */
export function formatEpisodeDate(ms: number | undefined, locale: Locale, now = Date.now()): string {
  if (!ms) return ''
  const date = new Date(ms)
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const dayStart = new Date(ms)
  dayStart.setHours(0, 0, 0, 0)
  const daysAgo = Math.round((today.getTime() - dayStart.getTime()) / DAY)
  if (daysAgo >= 0 && daysAgo < 7) {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-daysAgo, 'day')
  }
  const sameYear = date.getFullYear() === today.getFullYear()
  return new Intl.DateTimeFormat(locale, sameYear
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' }
  ).format(date)
}

/**
 * 时长：先取整到分钟再拆小时——不然 59 分 50 秒会写成「60 分钟」；
 * 不到一分钟按一分钟算，整小时写「1 小时」，其余「1 小时 5 分」。
 */
export function formatEpisodeLength(seconds: number, t: T): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h > 0) return m > 0 ? t('podcast.hoursMinutes', { h, m }) : t('podcast.hours', { h })
  return t('podcast.minutes', { n: m })
}
