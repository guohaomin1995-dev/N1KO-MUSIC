/**
 * 把一句歌词画成玻璃字要用的遮罩图，交给 LyricSmoke 的着色器。
 *
 * 一张图三个通道：
 *   R  清晰的字形（玻璃本体）
 *   G  轻微糊开的字形（和清晰字形一比，就得到字边那一圈细亮边）
 *   B  重度糊开的字形（字底下的投影；换句时字从糊里出来也用它）
 *
 * 断行自己做：中日韩字逐字可断，其余按词断。超过三行就把字号往下收。
 */

export interface LyricFont {
  /** CSS 字体声明里的 font-weight / font-family */
  weight: string
  family: string
  /** CSS 像素 */
  size: number
  letterSpacing: number
  lineHeight: number
}

export interface GlassMask {
  canvas: HTMLCanvasElement
  /** 在宿主（画布那一层）里的位置，CSS 像素，左上角为原点 */
  x: number
  y: number
  width: number
  height: number
}

const BREAKABLE = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/

/** 切成可以断行的小块：中日韩字一个一块，其余一个词（连带后面的空格）一块 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  let word = ''
  for (const ch of text) {
    if (BREAKABLE.test(ch)) {
      if (word) out.push(word)
      word = ''
      out.push(ch)
    } else if (/\s/.test(ch)) {
      word += ch
      out.push(word)
      word = ''
    } else {
      word += ch
    }
  }
  if (word) out.push(word)
  return out
}

/** 贪心断行。measure 返回一段文字的宽度 */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = []
  let line = ''
  for (const token of tokenize(text)) {
    const next = line + token
    if (line && measure(next.trimEnd()) > maxWidth) {
      lines.push(line.trimEnd())
      line = token.trimStart()
    } else {
      line = next
    }
  }
  if (line.trim()) lines.push(line.trimEnd())
  return lines
}

/**
 * 画遮罩。centerX / centerY 是这句歌词的中心在宿主里的位置（CSS 像素），
 * maxWidth 是可用的行宽，scale 是遮罩图的像素密度。
 */
export function rasterizeLyric(
  text: string,
  font: LyricFont,
  layout: { centerX: number; centerY: number; maxWidth: number },
  scale: number,
): GlassMask | null {
  const probe = document.createElement('canvas').getContext('2d')
  if (!probe || !text.trim()) return null

  let size = font.size
  let lines: string[] = []
  let widest = 0
  for (let attempt = 0; attempt < 6; attempt++) {
    probe.font = `${font.weight} ${size}px ${font.family}`
    setSpacing(probe, font.letterSpacing * (size / font.size))
    lines = wrapLines(text, layout.maxWidth, s => probe.measureText(s).width)
    widest = Math.max(...lines.map(l => probe.measureText(l).width))
    if (lines.length <= 3) break
    size *= 0.88
  }
  if (!lines.length) return null

  const lineHeight = size * (font.lineHeight / font.size)
  const pad = Math.ceil(size * 0.6)
  const width = Math.ceil(widest + pad * 2)
  const height = Math.ceil(lines.length * lineHeight + pad * 2)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.scale(scale, scale)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  ctx.globalCompositeOperation = 'lighter'
  ctx.font = `${font.weight} ${size}px ${font.family}`
  setSpacing(ctx, font.letterSpacing * (size / font.size))
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  const channels: Array<[string, number]> = [
    ['#ff0000', 0],
    ['#00ff00', Math.max(1, size * 0.035)],
    ['#0000ff', Math.max(5, size * 0.22)],
  ]
  for (const [color, blur] of channels) {
    ctx.filter = blur > 0 ? `blur(${blur}px)` : 'none'
    ctx.fillStyle = color
    lines.forEach((line, i) => {
      ctx.fillText(line, width / 2, pad + lineHeight * (i + 0.5))
    })
  }
  ctx.filter = 'none'

  return {
    canvas,
    x: layout.centerX - width / 2,
    y: layout.centerY - height / 2,
    width,
    height,
  }
}

function setSpacing(ctx: CanvasRenderingContext2D, px: number) {
  // Chrome 99+ / Safari 17+；不支持时字距用默认值，不影响别的
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string }
  if ('letterSpacing' in c) c.letterSpacing = `${px}px`
}

/** 玻璃的色相：主色相往副色相那边偏一点（相近色）。副色相离得太远就固定偏 28° */
export function glassHue(h: number, h2: number): number {
  let d = ((h2 - h + 540) % 360) - 180
  if (Math.abs(d) > 100) d = 28
  const shift = Math.sign(d || 1) * Math.min(35, Math.max(25, Math.abs(d)))
  return (h + shift + 360) % 360
}
