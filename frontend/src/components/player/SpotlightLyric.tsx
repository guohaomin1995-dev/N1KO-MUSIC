/**
 * 歌词页只放当前这一句，大字，悬在烟里。
 *
 * 换句时旧句糊开、往上散掉，新句从糊里出来——像烟里慢慢显出来的字，不是滚动列表。
 * 字底下垫一层很淡的暗晕（.lyric-glow），烟最亮的地方白字也读得清。
 *
 * 当前句带 data-beam-target。这一栏带 data-lyric-stage / -key / -text：
 * LyricSmoke 照着它的位置和字体把这句画成玻璃字，画得出来时这里的字变透明（只留给读屏）。
 */

import { useMemo } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { cn } from '@/lib/utils'
import { spaceCJK } from '@/utils/cjkTypography'
import { useLyrics } from '@/hooks/useLyrics'
import { usePlayerStore } from '@/store/playerStore'
import type { LyricLine } from '@/api/types'

function cleanLyricText(text: string): string {
  return text
    .replace(/[[<]\d{1,2}:\d{2}(?:[.:]\d{1,3})?[\]>]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const EASE_SMOKE = [0.22, 0.61, 0.36, 1] as const

export function SpotlightLyric({
  lines,
  className,
  wide = false,
}: {
  lines: LyricLine[]
  className?: string
  /** 横屏字可以再大一号 */
  wide?: boolean
}) {
  const reduce = useReducedMotion()
  const currentTimeSec = usePlayerStore(s => s.currentTime)
  const { currentIndex, isSynced } = useLyrics({ currentTimeSec, lines, offset: 500 })
  const displayTexts = useMemo(
    () => lines.map(line => cleanLyricText(line.text) || '♪'),
    [lines]
  )

  const index = isSynced ? currentIndex : -1
  const text = index >= 0 && index < lines.length ? displayTexts[index] : null

  return (
    <div
      className={cn('relative h-full min-h-0 w-full overflow-hidden', className)}
      data-lyric-stage=""
      data-lyric-key={index}
      data-lyric-text={text ?? ''}
    >
      <AnimatePresence initial={false}>
        {text !== null && (
          <motion.p
            key={index}
            data-beam-target=""
            aria-live="polite"
            initial={reduce ? false : { opacity: 0, filter: 'blur(14px)', scale: 0.97, y: '-42%' }}
            animate={{ opacity: 1, filter: 'blur(0px)', scale: 1, y: '-50%' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, filter: 'blur(12px)', scale: 1.03, y: '-58%' }}
            transition={reduce ? { duration: 0 } : { duration: 0.9, ease: EASE_SMOKE }}
            className={cn(
              'lyric-glow absolute inset-x-0 top-[42%] origin-center text-balance text-center font-display font-black',
              'leading-[1.28] tracking-[0.02em] text-white line-clamp-3',
              wide ? 'text-[clamp(40px,3.6vw,72px)]' : 'text-[clamp(32px,9vw,60px)]',
            )}
          >
            {spaceCJK(text)}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  )
}
