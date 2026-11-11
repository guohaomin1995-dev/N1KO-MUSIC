// Motion Prompt #060 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#060
// Motion Prompt #057 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#057
/**
 * 音源 tab：收藏页、歌单页顶上的「Subsonic / 网易云 / QQ 音乐」切换。
 *
 * 以前多个音源是一节接一节往下排，歌一多要划很久才到下一个音源。现在一次只看一个，
 * 在顶上切。动效照 motion-prompt 的两个元素移植（数值不改，颜色换成 App 自己的）：
 *
 *   #060 Segmented control（tab 栏）
 *     灰色圆角轨道（圆角 10、内缩 4px），选中格上托着一块高亮（圆角 8、阴影模糊 6），
 *     点别的格时高亮在 0.25 s 内滑过去，缓动 easeInOutCubic；选中的字反白。
 *   #057 Tabs（内容切换，只取它的面板过渡，下划线不用）
 *     旧面板 0.2 s 线性淡出；点击后 0.1 s 新面板开始 0.2 s 淡入，同时上浮 8px。
 *
 * 系统要求减弱动态效果时，滑动和过渡都变成瞬时。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Database, HardDrive } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { haptic } from '@/lib/haptics'
import { SourceLogo, pluginLogoSrc } from '@/components/sources/SourceBadge'

/** #060：0.25 s easeInOutCubic */
const SLIDE = { duration: 0.25, ease: [0.65, 0, 0.35, 1] as const }

export interface SourceTabItem {
  /** serverId；本地混合歌单用 'local' */
  id: string
  label: string
  /** 插件音源（网易云 / QQ）的 id，用来取官方图标 */
  pluginId?: string
  /** 本地混合歌单 */
  local?: boolean
  /** 数量；还没加载完时不给 */
  count?: number
  loading?: boolean
}

/**
 * 地址栏没指定时默认选哪个 tab：跳过已经加载完、确定是空的，停在第一个有内容的；
 * 全都空着（或者都还在加载）就是第一个。指定了且还在列表里，就听地址栏的。
 * 免得一进歌单页先看到一页「还没有歌单」，而网易云那边其实有一百多个。
 */
export function defaultTabId(items: SourceTabItem[], requested?: string): string {
  const asked = requested ? items.find(i => i.id === requested) : undefined
  if (asked) return asked.id
  const knownEmpty = (i: SourceTabItem) => !i.loading && i.count === 0
  const firstWithContent = items.find(i => !knownEmpty(i))
  return (firstWithContent ?? items[0]).id
}

/**
 * 音源名去掉后半截：「Subsonic - 192.168.1.150」「网易云音乐 · 账号名」放进 tab 太长，
 * tab 里只需要认得出是哪家。
 */
export function shortSourceName(name: string): string {
  const head = name.split(/\s+[-·•|]\s+/)[0]?.trim()
  return head || name
}

function TabIcon({ item, active }: { item: SourceTabItem; active: boolean }) {
  if (item.local) return <HardDrive size={16} weight={active ? 'fill' : 'regular'} aria-hidden="true" />
  if (pluginLogoSrc(item.pluginId)) return <SourceLogo pluginId={item.pluginId} size={18} />
  return <Database size={16} weight={active ? 'fill' : 'regular'} aria-hidden="true" />
}

export function SourceTabs({
  items,
  value,
  onChange,
  layoutId,
  className,
}: {
  items: SourceTabItem[]
  value: string
  onChange: (id: string) => void
  /** 同一页有两组 tab 时各用各的，滑块才不会在两组之间飞 */
  layoutId: string
  className?: string
}) {
  const reduce = useReducedMotion()
  return (
    <div
      role="tablist"
      className={cn(
        // 轨道：圆角 10、内缩 4px；吸顶时压在列表上，所以底是半透明的面 + 毛玻璃
        'inline-flex max-w-full gap-0.5 overflow-x-auto rounded-[10px] bg-surface/85 p-1 shadow-sm ring-1 ring-ink/[0.06] backdrop-blur-xl scrollbar-hide',
        className
      )}
    >
      {items.map(item => {
        const active = item.id === value
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              if (active) return
              haptic('selection')
              onChange(item.id)
            }}
            className={cn(
              'press-pop relative isolate inline-flex h-9 flex-none items-center gap-2 whitespace-nowrap rounded-[8px] px-3.5 text-[14px] font-semibold',
              // 字色跟着滑块一起换，时长同 #060 的 0.25 s
              'transition-colors duration-[250ms]',
              active ? 'text-lime-ink' : 'text-ink-2 hover:text-ink'
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                transition={reduce ? { duration: 0 } : SLIDE}
                aria-hidden="true"
                className="absolute inset-0 -z-10 rounded-[8px] bg-lime shadow-[0_2px_6px_rgb(0_0_0/0.2)]"
              />
            )}
            <TabIcon item={item} active={active} />
            <span>{item.label}</span>
            {item.count !== undefined && !item.loading && (
              <span className={cn('num text-[13px] font-medium', active ? 'text-lime-ink/70' : 'text-ink-3')}>
                {item.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/**
 * tab 下面那块内容。换 tab 时按 #057 的面板过渡：旧的淡出、新的晚 0.1 s 淡入并上浮 8px。
 * popLayout：旧面板退场时脱离文档流，新面板直接占位，长列表切换时页面不会先塌再撑。
 */
export function SourceTabPanel({ tabKey, children }: { tabKey: string; children: ReactNode }) {
  const reduce = useReducedMotion()
  return (
    <div className="relative">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={tabKey}
          role="tabpanel"
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0, transition: reduce ? { duration: 0 } : { delay: 0.1, duration: 0.2, ease: 'linear' } }}
          exit={{ opacity: 0, transition: reduce ? { duration: 0 } : { duration: 0.2, ease: 'linear' } }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

/**
 * 放音源 tab 的那一行：滚动时吸在顶部工具栏下面。
 *
 * 吸住以后底下的列表会从控件之间的缝里透出来，所以贴住时在这一行后面铺一条和工具栏同款的
 * 毛玻璃（.tab-dock::before，左右撑满内容区）；没贴住时那条是透明的，页头看起来和原来一样。
 * 贴没贴住用 IntersectionObserver 判断：把视口上沿往下收到吸附线再多 1px，元素一旦顶到吸附线，
 * 就不再「完整可见」。
 */
export function TabDock({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const top = parseFloat(getComputedStyle(el).top) || 0
    const io = new IntersectionObserver(
      ([entry]) => setStuck(entry.intersectionRatio < 1 && entry.boundingClientRect.top <= top + 1),
      { rootMargin: `-${Math.round(top) + 1}px 0px 0px 0px`, threshold: [1] }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return (
    <div
      ref={ref}
      data-stuck={stuck || undefined}
      className={cn('tab-dock sticky top-[calc(env(safe-area-inset-top)+60px)] z-raised', className)}
    >
      {children}
    </div>
  )
}
