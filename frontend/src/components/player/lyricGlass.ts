/**
 * 把一句歌词画成玻璃字要用的遮罩图，交给 LyricSmoke 的着色器。
 *
 * 一张图三个通道：
 *   R  清晰的字形（玻璃本体）
 *   G  轻微糊开的字形（和清晰字形一比，就得到字边那一圈细亮边）
 *   B  重度糊开的字形（字底下的投影；换句时字从糊里出来也用它）
 *
 * 断行自己做：中日韩字逐字可断，其余按词断。超过三行就把字号往下收。
 *
 * 另有一张「字序图」给颜色进度用（天际屏歌词）：每个字占一格，
 *   R  这是第几个字（不算空格，0–254）
 *   G  在这个字里从左到右 0 → 1
 * 着色器拿 R×255 + G 和当前进度（同样以字为单位）一比，就知道哪里唱过了、进度头在哪。
 * 一行左边空白记成这一行第一个字的开头，右边空白记成最后一个字的结尾，糊开的光晕跟着字一起染色。
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
  /** 字序图（颜色进度用），和 canvas 同尺寸 */
  order: HTMLCanvasElement | null
  /** 每个字（不算空格）在遮罩里的格子，CSS 像素，按唱的顺序 */
  cells: LyricCell[]
  /** 在宿主（画布那一层）里的位置，CSS 像素，左上角为原点 */
  x: number
  y: number
  width: number
  height: number
}

export interface LyricCell {
  /** 第几个字（不算空格），也是在 cells 里的下标 */
  slot: number
  /** 这一行的第几行 */
  line: number
  x0: number
  x1: number
  top: number
  bottom: number
}

/**
 * 断好的行里每个字落在哪：按行居中排，字宽用 measure 量前缀的宽度。
 * 空格不占格子；断行只削掉空格，所以格子的顺序就是原文里唱的顺序。
 */
export function layoutCells(
  lines: string[],
  measure: (s: string) => number,
  width: number,
  pad: number,
  lineHeight: number,
): LyricCell[] {
  const cells: LyricCell[] = []
  lines.forEach((line, row) => {
    const chars = Array.from(line)
    const start = width / 2 - measure(line) / 2
    const top = pad + lineHeight * row
    let prefix = ''
    for (const ch of chars) {
      const x0 = start + measure(prefix)
      prefix += ch
      const x1 = start + measure(prefix)
      if (/\s/.test(ch)) continue
      cells.push({ slot: cells.length, line: row, x0, x1, top, bottom: top + lineHeight })
    }
  })
  return cells
}

/** 画字序图：每格 R = 第几个字，G 在格子里从 0 渐变到 1；格子横向连成一片（不留字距的缝） */
function drawOrder(cells: LyricCell[], width: number, height: number, scale: number, rows: number): HTMLCanvasElement | null {
  if (cells.length === 0) return null
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(scale, scale)
  const level = (slot: number) => Math.min(254, slot)
  for (let row = 0; row < rows; row++) {
    const inRow = cells.filter(c => c.line === row)
    if (inRow.length === 0) continue
    // 第一行往上、最后一行往下铺满：投影和光晕也有字序可查
    const top = row === 0 ? 0 : inRow[0].top
    const bottom = row === rows - 1 ? height : inRow[0].bottom
    const first = inRow[0]
    const last = inRow[inRow.length - 1]
    ctx.fillStyle = `rgb(${level(first.slot)} 0 0)`
    ctx.fillRect(0, top, first.x0 + 0.5, bottom - top)
    inRow.forEach((cell, i) => {
      const right = i + 1 < inRow.length ? inRow[i + 1].x0 : cell.x1
      const g = ctx.createLinearGradient(cell.x0, 0, right, 0)
      g.addColorStop(0, `rgb(${level(cell.slot)} 0 0)`)
      g.addColorStop(1, `rgb(${level(cell.slot)} 255 0)`)
      ctx.fillStyle = g
      ctx.fillRect(cell.x0, top, right - cell.x0 + 0.5, bottom - top)
    })
    ctx.fillStyle = `rgb(${level(last.slot)} 255 0)`
    ctx.fillRect(last.x1, top, width - last.x1, bottom - top)
  }
  return canvas
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

  // 量字宽要和上面画字用同一个字体与字距
  probe.font = `${font.weight} ${size}px ${font.family}`
  setSpacing(probe, font.letterSpacing * (size / font.size))
  const cells = layoutCells(lines, s => probe.measureText(s).width, width, pad, lineHeight)

  return {
    canvas,
    order: drawOrder(cells, width, height, scale, lines.length),
    cells,
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
