/**
 * 歌词页：天际屏（抬头显示）那种样子，悬在烟里。
 *
 * - 中间两行：当前句是磨砂玻璃字，下一句是小一号、淡一些的玻璃字、在正下方（都由 LyricSmoke 照着这一栏画）。
 * - 颜色进度：唱过的玻璃染上封面色（主色 → 副色渐变），正在唱的那个字最亮、一点点被染上；
 *   时间只有每句的开头，所以从这句开始到下一句开始按字数平均推进。
 *   进度每帧写在这一栏的 data-lyric-progress 上（以字为单位），玻璃字的着色器、主光束都按它走。
 * - 光斑：从正在唱的字和前后几个字的字顶、字缝的上半截往上冒，飘散、淡掉（SkySparks，一层 2D 画布）。
 *   发射点 data-sky-head 由 LyricSmoke 按玻璃字的字位写；没有玻璃字时由这里按 DOM 里的字写。
 * - 两侧散落这一句里的字（跟着歌词一起换），横着排在歌词那条水平线上或略低，比当前句暗、灰；
 *   每个字斜后方一个放大、糊开的投影。
 * - 换句：下一句往上、放大，变成当前句；旧的往上飘、糊开散掉；再下一句从下面淡进来（玻璃那一层做）。
 * - 两侧的投影随着这一句唱下去慢慢变大、变糊、淡掉（--sky-p：这一句唱了几成，每帧写在这一栏上）。
 *
 * DOM 里也有这一句（逐字），给读屏、给量高度、给没有 WebGL 时兜底：
 * 玻璃画得出来时（根上有 data-glass-lyrics）这些字是透明的；画不出来就是白字 + 逐字染色 + 霓虹光。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'
import { cn } from '@/lib/utils'
import { spaceCJK } from '@/utils/cjkTypography'
import { useLyrics } from '@/hooks/useLyrics'
import { usePlayerStore } from '@/store/playerStore'
import { useArtLightStore } from '@/store/artLightStore'
import { getAudioCurrentTime } from '@/hooks/useAudioEngine'
import type { LyricLine } from '@/api/types'
import {
  SIDE_BOX,
  ghostOffsets,
  hashText,
  lineProgress,
  lineSideTokens,
  mixRgb,
  sideSlots,
  skyColors,
  progressSlots,
  sparkAlpha,
  spawnSpark,
  splitChars,
  stepSpark,
  type SkyColors,
  type Spark,
} from './skyline'

function cleanLyricText(text: string): string {
  return text
    .replace(/[[<]\d{1,2}:\d{2}(?:[.:]\d{1,3})?[\]>]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const EASE = [0.22, 0.61, 0.36, 1] as const

/** 当前句的视觉中心（占这一栏高度的比例）。玻璃字也画在这里（LyricSmoke 用的 0.42） */
const CENTER = 42
const DEFAULT_HALF = 40
/** 下一句和当前句之间的空隙 */
const GAP = 16

/** 类名写全（不拼字符串）：Tailwind 只保留源码里原样出现过的 @layer 类名 */
const SIDE_CLASS = {
  wide: ['sky-side-wide-0', 'sky-side-wide-1'],
  narrow: ['sky-side-narrow-0', 'sky-side-narrow-1'],
} as const

/** 实时播放位置（毫秒）：优先读音频元素，原生播放器接管时它是 0，退回 store */
function songTimeMs(): number {
  const player = usePlayerStore.getState()
  const audio = getAudioCurrentTime()
  const sec = Math.abs(audio - player.currentTime) < 1.5 ? audio : player.currentTime
  return sec * 1000
}

/** 玻璃字是不是画得出来（画得出来时光点由 LyricSmoke 按玻璃字的字位摆） */
function glassActive(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.glassLyrics !== undefined
}

/** 量当前句有多高：下一句贴着它排，当前句一行还是三行都不会压上去 */
function useHalfHeight(): [number, (el: HTMLElement | null) => void] {
  const [half, setHalf] = useState(DEFAULT_HALF)
  const observer = useRef<ResizeObserver | null>(null)
  const measure = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!el) return
    const update = () => {
      const h = el.offsetHeight
      if (h > 0) setHalf(Math.round(h / 2))
    }
    update()
    if (typeof ResizeObserver === 'function') {
      observer.current = new ResizeObserver(update)
      observer.current.observe(el)
    }
  }, [])
  useEffect(() => () => observer.current?.disconnect(), [])
  return [half, measure]
}

/**
 * CSS 玻璃字边上那一圈高光（省电排法用，样式在 index.css 的 .sky-css-glass）。
 * 从字的外形（透明度）里减去往里收了一点的外形，剩下的就是最外面一圈；涂成白的叠回去。
 * 引用写在行内样式里：写在外链样式表里的 url(#…) 有的内核会按样式表的地址去找。
 */
const GLASS_RIM_ID = 'sky-glass-rim'
const GLASS_RIM: CSSProperties = { filter: `url(#${GLASS_RIM_ID})` }

function GlassRimFilter() {
  return (
    <svg aria-hidden="true" width="0" height="0" className="pointer-events-none absolute">
      <filter id={GLASS_RIM_ID} x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
        <feMorphology in="SourceAlpha" operator="erode" radius="0.7" result="inner" />
        <feComposite in="SourceAlpha" in2="inner" operator="out" result="rim" />
        <feColorMatrix in="rim" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.75 0" result="light" />
        <feMerge>
          <feMergeNode in="SourceGraphic" />
          <feMergeNode in="light" />
        </feMerge>
      </filter>
    </svg>
  )
}

export function SkylineLyric({
  lines,
  className,
  wide = false,
  lite = false,
}: {
  lines: LyricLine[]
  className?: string
  /** 横屏：字大一号，两侧有地方散字 */
  wide?: boolean
  /**
   * 省电排法（电视盒子，不挂 LyricSmoke 的烟雾和聚光灯时用）：效果一样不少——逐字染色、光斑、两侧的字和投影、飘动都在，
   * 只是画得省：进度每 80 毫秒走一步而不是每帧；光斑的画布按 1 倍像素、每秒 30 帧画（光斑本来就是糊的，看不出差别）；
   * 换句只淡入淡出，不带放大和模糊。
   * 字的玻璃质感改用 CSS 画（index.css 的 .sky-css-glass）：着色器画的那种要整屏的 WebGL
   */
  lite?: boolean
}) {
  const reduce = !!useReducedMotion()
  const currentTimeSec = usePlayerStore(s => s.currentTime)
  const { currentIndex, isSynced } = useLyrics({ currentTimeSec, lines, offset: 500 })
  // 中西文之间补细空格（排版用，不占进度）
  const cleaned = useMemo(() => lines.map(line => spaceCJK(cleanLyricText(line.text))), [lines])
  const palette = useArtLightStore(s => s.palette)
  const source = useArtLightStore(s => s.source)
  // 没取到封面时调色板是默认的「场灯」青柠：和玻璃字那边一样按「没有封面」处理，退回蓝 → 紫
  const colors = useMemo(() => skyColors(source ? palette : null), [palette, source])
  const [half, measure] = useHalfHeight()
  const stageRef = useRef<HTMLDivElement>(null)

  const index = isSynced ? currentIndex : -1
  const text = index >= 0 && index < lines.length ? cleaned[index] || '♪' : null
  const next = text !== null && index + 1 < lines.length ? cleaned[index + 1] || null : null

  const vars = {
    '--sky-a': colors.a,
    '--sky-b': colors.b,
    '--sky-head': colors.head,
    '--sky-glow': colors.glow,
    '--sky-side': colors.side,
    '--sky-ghost': colors.ghost,
    '--sky-next': colors.next,
  } as CSSProperties

  return (
    <div
      ref={stageRef}
      className={cn('relative h-full min-h-0 w-full overflow-hidden', lite && 'sky-css-glass', className)}
      style={vars}
      data-lyric-stage=""
      data-lyric-key={index}
      data-lyric-text={text === '♪' ? '' : text ?? ''}
      data-lyric-next={next ?? ''}
    >
      {lite && <GlassRimFilter />}
      <SkySides lines={lines} index={index} wide={wide} reduce={reduce} lite={lite} />
      <AnimatePresence initial={false}>
        {text !== null && (
          <motion.div
            key={index}
            className="absolute inset-x-0 origin-center"
            style={{ top: `${CENTER}%` }}
            initial={reduce ? false : lite ? { opacity: 0, y: '-30%' } : { opacity: 0, scale: 0.55, y: '20%' }}
            animate={lite ? { opacity: 1, y: '-50%' } : { opacity: 1, scale: 1, y: '-50%' }}
            exit={reduce ? { opacity: 0 } : lite ? { opacity: 0, y: '-70%' } : { opacity: 0, scale: 1.04, y: '-85%', filter: 'blur(10px)' }}
            transition={reduce ? { duration: 0 } : { duration: lite ? 0.4 : 0.6, ease: EASE }}
          >
            <SkyLine
              measureRef={measure}
              stageRef={stageRef}
              text={text}
              lines={lines}
              index={index}
              colors={colors}
              wide={wide}
              reduce={reduce}
              lite={lite}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {next !== null && (
          <motion.p
            key={`next-${index}`}
            aria-hidden="true"
            // 玻璃那一层照着它的位置和字体画下一句
            data-next-target=""
            className={cn(
              'sky-next absolute inset-x-0 mx-auto w-[94%] text-balance text-center font-display font-bold leading-[1.35] tracking-[0.04em] line-clamp-2',
              wide ? 'text-[clamp(18px,1.5vw,28px)]' : 'text-[clamp(15px,4vw,22px)]',
            )}
            style={{ top: `calc(${CENTER}% + ${half + GAP}px)`, ...(lite ? GLASS_RIM : null) }}
            initial={reduce ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.2 } }}
            transition={reduce ? { duration: 0 } : { duration: 0.5, delay: 0.15, ease: EASE }}
          >
            {next}
          </motion.p>
        )}
      </AnimatePresence>
      <SkySparks stageRef={stageRef} color={colors.head} reduce={reduce} lite={lite} />
    </div>
  )
}

/* ---------------------------------------------------------------- 当前句 */

interface SkyLineProps {
  text: string
  lines: LyricLine[]
  index: number
  colors: SkyColors
  wide: boolean
  reduce: boolean
  lite: boolean
  /** 量当前句的高度（下一句贴着它排） */
  measureRef: (el: HTMLElement | null) => void
  stageRef: RefObject<HTMLDivElement>
}

function SkyLine({ text, lines, index, colors, wide, reduce, lite, measureRef, stageRef }: SkyLineProps) {
  const present = useIsPresent()
  const chars = useMemo(() => splitChars(text), [text])
  const slotCount = useMemo(() => progressSlots(chars).length, [chars])
  const charRefs = useRef<Array<HTMLSpanElement | null>>([])
  const colorsRef = useRef(colors)
  colorsRef.current = colors

  useEffect(() => {
    // 正在退场的旧句：不再写进度，免得和新句抢
    if (!present) return
    let raf = 0
    let lastHead = Number.NaN
    let lastColors: SkyColors | null = null
    const paint = () => {
      const player = usePlayerStore.getState()
      const songEnd = player.duration > 0 ? player.duration * 1000 : undefined
      const { head, frac, pos } = lineProgress(lines, index, songTimeMs(), chars, songEnd)
      const stage = stageRef.current
      if (stage) {
        stage.dataset.lyricProgress = pos.toFixed(3)
        // 这一句正在唱（开了头、还没唱完）：光斑只在这时候冒
        stage.dataset.skySinging = pos > 0 && pos < slotCount ? '1' : '0'
        // 这一句唱了几成：两侧的投影跟着变大、变糊、淡掉
        // 两位小数就够：值不变时不触发样式重算（投影带 blur，少重画几次）
        stage.style.setProperty('--sky-p', slotCount > 0 ? Math.min(1, Math.max(0, pos / slotCount)).toFixed(2) : '0')
      }

      // 兜底（没有 WebGL）时 DOM 里的字自己染色；玻璃画得出来时这些字是透明的，照样更新也不费事
      if (head !== lastHead || colorsRef.current !== lastColors) {
        lastHead = head
        lastColors = colorsRef.current
        const { a, b } = colorsRef.current
        chars.forEach((_, i) => {
          const el = charRefs.current[i]
          if (!el) return
          if (i < head) {
            el.dataset.s = 'sung'
            const tint = mixRgb(a, b, head > 0 ? i / head : 0)
            el.style.color = tint
            // 同一个颜色的三个通道：CSS 画的玻璃字（.sky-css-glass）要自己配透明度
            el.style.setProperty('--sky-c', tint.slice(4, -1))
          } else {
            el.dataset.s = i === head ? 'head' : 'todo'
            el.style.color = ''
          }
        })
      }
      const headEl = head >= 0 && head < chars.length ? charRefs.current[head] : null
      if (headEl) headEl.style.setProperty('--f', frac.toFixed(3))
      // 没有玻璃字时，光斑的发射点按 DOM 里的字算（有玻璃字时 LyricSmoke 按玻璃字的字位写）
      if (stage && !glassActive()) {
        const box = headEl?.offsetParent as HTMLElement | null
        if (headEl && box) {
          const b = box.getBoundingClientRect()
          const r = stage.getBoundingClientRect()
          const x = b.left - r.left + headEl.offsetLeft + headEl.offsetWidth * frac
          const y = b.top - r.top + headEl.offsetTop
          stage.dataset.skyHead = `${x.toFixed(1)},${y.toFixed(1)},${headEl.offsetWidth},${headEl.offsetHeight}`
        } else {
          delete stage.dataset.skyHead
        }
      }
    }
    const loop = () => {
      paint()
      raf = requestAnimationFrame(loop)
    }
    if (reduce || lite) {
      paint()
      const timer = setInterval(paint, reduce ? 250 : 80)
      return () => clearInterval(timer)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [chars, slotCount, lines, index, present, reduce, lite, stageRef])

  const size = wide ? 'text-[clamp(36px,3.2vw,64px)]' : 'text-[clamp(30px,8.4vw,54px)]'
  return (
    <div
      ref={measureRef}
      // 玻璃字照着它的字体画（data-beam-target 是 LyricSmoke 取字体的样本）；行宽和玻璃字一样是这一栏的 94%
      data-beam-target=""
      className={cn(
        'relative mx-auto w-[94%] text-balance text-center font-display font-black leading-[1.28] tracking-[0.03em]',
        size,
      )}
      aria-live="polite"
    >
      {/* 兜底时的霓虹光：同一句透明字，只留外面一圈光，垫在彩色字底下 */}
      <div aria-hidden="true" className="sky-glow pointer-events-none absolute inset-0">
        {text}
      </div>
      {chars.map((ch, i) => (
        <span
          key={i}
          ref={el => { charRefs.current[i] = el }}
          className="sky-char relative"
          style={lite ? GLASS_RIM : undefined}
          data-s="todo"
        >
          {ch}
        </span>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------------- 光斑 */

/** 每秒冒几颗 */
const SPARK_RATE = 16
/** 同时最多几颗（车机上也不费事） */
const SPARK_MAX = 48

/**
 * 进度头附近往上飘的光斑：一层盖在歌词上的 2D 画布，每帧读 data-sky-head（发射点）。
 * 发射点本身每帧往目标挪一点（阻尼），换字、换行时光斑的源头是滑过去的，不是跳过去的。
 * 暂停或这句没在唱时不再冒新的，已经冒出来的照样飘完；减弱动态效果时不画。
 */
function SkySparks({ stageRef, color, reduce, lite = false }: { stageRef: RefObject<HTMLDivElement>; color: string; reduce: boolean; lite?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const colorRef = useRef(color)
  colorRef.current = color

  useEffect(() => {
    if (reduce) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const sparks: Spark[] = []
    const head = { x: 0, y: 0, w: 0, h: 0, ready: false }
    let raf = 0
    let last = performance.now()
    let pending = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      // 省电排法：隔一帧画一次（每秒 30 帧）
      if (lite && now - last < 30) return
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const stage = stageRef.current
      if (!stage || document.hidden) return
      const width = stage.clientWidth
      const height = stage.clientHeight
      // 整屏的画布每帧都要重新传给显卡：电视盒子上按 1 倍像素画，要传的只有四分之一
      const dpr = lite ? 1 : Math.min(2, window.devicePixelRatio || 1)
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
      }

      const raw = stage.dataset.skyHead?.split(',').map(Number)
      if (raw && raw.length === 4 && raw.every(Number.isFinite)) {
        const [x, y, w, h] = raw
        if (!head.ready) {
          Object.assign(head, { x, y, w, h, ready: true })
        } else {
          const k = 1 - Math.exp(-dt * 12)
          head.x += (x - head.x) * k
          head.y += (y - head.y) * k
          head.w += (w - head.w) * k
          head.h += (h - head.h) * k
        }
      }
      const singing = head.ready && !!raw && stage.dataset.skySinging === '1' && usePlayerStore.getState().isPlaying
      if (singing) {
        pending += dt * SPARK_RATE
        while (pending >= 1) {
          pending -= 1
          if (sparks.length < SPARK_MAX) sparks.push(spawnSpark(head, Math.random))
        }
      } else {
        pending = 0
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      if (sparks.length === 0) return
      ctx.globalCompositeOperation = 'lighter'
      const [r, g, b] = colorRef.current.split(' ').map(Number)
      for (let i = sparks.length - 1; i >= 0; i--) {
        const p = sparks[i]
        stepSpark(p, dt)
        const a = sparkAlpha(p)
        if (a <= 0) {
          sparks.splice(i, 1)
          continue
        }
        // 偏白的芯、进度头颜色的光晕，边缘化开；每颗亮度不一样，最亮的也压着（叠在一起时还会再亮）
        const k = a * p.glow
        const core = `${Math.round(255 - (255 - r) * 0.35)}, ${Math.round(255 - (255 - g) * 0.35)}, ${Math.round(255 - (255 - b) * 0.35)}`
        const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 2.6)
        glow.addColorStop(0, `rgba(${core}, ${(k * 0.6).toFixed(3)})`)
        glow.addColorStop(0.35, `rgba(${r}, ${g}, ${b}, ${(k * 0.45).toFixed(3)})`)
        glow.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)
        ctx.fillStyle = glow
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r * 2.6, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [reduce, lite, stageRef])

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />
}

/* ---------------------------------------------------------------- 两侧散落的字 */

function SkySides({ lines, index, wide, reduce, lite }: { lines: LyricLine[]; index: number; wide: boolean; reduce: boolean; lite: boolean }) {
  const seed = useMemo(() => hashText(lines.map(l => l.text).join('\n')), [lines])
  const perSide = wide ? 4 : 2
  const slots = useMemo(() => sideSlots(seed, perSide), [seed, perSide])
  // 每个字的投影各自找周围的空处放（不统一往一个方向偏），同一首歌固定
  const ghosts = useMemo(() => ghostOffsets(slots, SIDE_BOX[wide ? 'wide' : 'narrow']), [slots, wide])
  // 跟着歌词一起换：每一句一整组新的字，取自这一句
  const tokens = useMemo(
    () => (index >= 0 ? lineSideTokens(lines, index, slots.length, seed + index) : []),
    [lines, index, slots.length, seed],
  )
  if (tokens.length === 0) return null
  return (
    <>
      {([0, 1] as const).map(side => (
        <div
          key={side}
          aria-hidden="true"
          className={cn('sky-side pointer-events-none absolute', SIDE_CLASS[wide ? 'wide' : 'narrow'][side])}
        >
          <AnimatePresence>
            {slots.map((slot, i) => {
              const token = tokens[i]
              if (slot.side !== side || !token) return null
              return (
                <motion.span
                  key={`${index}-${i}`}
                  className={cn('sky-word absolute', slot.depth > 0.5 && 'sky-word-far', !reduce && 'sky-drift')}
                  style={{
                    left: `${slot.x * 100}%`,
                    top: `${slot.y * 100}%`,
                    fontSize: `${(wide ? 30 : 18) * slot.scale}px`,
                    '--d': `${(i % 4) * -2.7}s`,
                    '--gx': ghosts[i].gx.toFixed(3),
                    '--gy': ghosts[i].gy.toFixed(3),
                  } as CSSProperties}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: slot.depth > 0.5 ? 0.7 : 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduce ? 0 : 0.6, ease: EASE }}
                >
                  <span className="sky-word-ghost">{token}</span>
                  <span className="sky-word-face" style={lite ? GLASS_RIM : undefined}>{token}</span>
                </motion.span>
              )
            })}
          </AnimatePresence>
        </div>
      ))}
    </>
  )
}
