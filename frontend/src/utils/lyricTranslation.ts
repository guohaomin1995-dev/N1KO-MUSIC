/**
 * 歌词译文：把译文配到每一句原文上。纯函数，不碰网络。
 *
 * 译文有三种来路，最后都落在 LyricLine.translation 上：
 * - attachTranslation：音源自己给了一份译文歌词（网易云 tlyric、QQ 音乐 trans），时间戳和原文一样，按时间配；
 * - foldBilingual：双语歌词文件，同一个时间戳上两行（原文、译文），折成一行；
 * - alignTranslation：译文来自另一个音源的同一首歌，两边时间戳未必一样（版本不同），按原文的字配。
 */

import type { LyricLine } from '@/api/types'

const HAN = /[㐀-鿿]/
const KANA = /[぀-ヿ]/
const HANGUL = /[가-힯]/
const LETTER = /[A-Za-zÀ-ɏЀ-ӿ぀-ヿ㐀-鿿가-힯]/

/** 这一行是不是中文（有汉字、没有假名和谚文） */
export function isChineseText(text: string): boolean {
  return HAN.test(text) && !KANA.test(text) && !HANGUL.test(text)
}

/** 译文里的占位行：QQ 音乐没翻的句子写成 //，有的只有标点 */
function isBlankTranslation(text: string): boolean {
  return !LETTER.test(text) && !/\d/.test(text)
}

/** 比对用的原文：只留字母、数字、文字，不分大小写和全半角 */
export function normalizeLyricText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9À-ɏЀ-ӿ぀-ヿ㐀-鿿가-힯]+/g, '')
}

export function hasTranslation(lines: LyricLine[]): boolean {
  return lines.some(line => !!line.translation)
}

export function stripTranslation(lines: LyricLine[]): LyricLine[] {
  if (!hasTranslation(lines)) return lines
  return lines.map(({ translation: _translation, ...rest }) => rest)
}

/**
 * 这份歌词要不要去找译文：有词、还没有译文、不是中文歌。
 * 整首里有假名就按日语算（日语里纯汉字的句子不少）；否则中文句子过半就是中文歌，
 * 夹着几句英文副歌的中文歌不找。
 */
export function needsTranslation(lines: LyricLine[]): boolean {
  if (hasTranslation(lines)) return false
  const worded = lines.filter(line => LETTER.test(line.text))
  if (worded.length < 4) return false
  const kana = worded.filter(line => KANA.test(line.text)).length
  if (kana >= worded.length * 0.1) return true
  const chinese = worded.filter(line => isChineseText(line.text)).length
  return chinese < worded.length * 0.5
}

/** 同一时间戳差多少毫秒以内算同一句（两份歌词的小数位数不一样时会差几毫秒） */
const SAME_LINE_MS = 400

/**
 * 音源给的译文歌词按时间配到原文上。
 * 先找时间戳一模一样的；没有就找最近、还没被用掉的那一句（差不超过 SAME_LINE_MS）。
 */
export function attachTranslation(lines: LyricLine[], translation: LyricLine[]): LyricLine[] {
  const pool = translation.filter(line => line.time > 0 && !isBlankTranslation(line.text))
  if (!pool.length) return lines
  const byTime = new Map<number, number>()
  pool.forEach((line, i) => { if (!byTime.has(line.time)) byTime.set(line.time, i) })
  const used = new Set<number>()

  const nearestUnused = (time: number): number => {
    let pick = -1
    let best = SAME_LINE_MS + 1
    for (let i = 0; i < pool.length; i++) {
      const gap = Math.abs(pool[i].time - time)
      if (gap < best && !used.has(i)) {
        best = gap
        pick = i
      }
    }
    return pick
  }

  let changed = false
  const out = lines.map(line => {
    if (line.time <= 0 || !LETTER.test(line.text)) return line
    const exact = byTime.get(line.time)
    const pick = exact !== undefined && !used.has(exact) ? exact : nearestUnused(line.time)
    if (pick < 0) return line
    used.add(pick)
    const text = pool[pick].text
    if (normalizeLyricText(text) === normalizeLyricText(line.text)) return line
    changed = true
    return { ...line, translation: text }
  })
  return changed ? out : lines
}

/**
 * 双语歌词文件：同一个时间戳上正好两行、内容不同，折成「原文 + 译文」一行。
 * 两行里只有一行是中文时中文是译文，否则后一行是译文。
 * 整首里这样的成对句子太少（不到三对、或不到三成）就不折：那多半是文件本身的时间戳写重了。
 */
export function foldBilingual(lines: LyricLine[]): LyricLine[] {
  if (hasTranslation(lines)) return lines
  const groups: LyricLine[][] = []
  for (const line of lines) {
    const last = groups[groups.length - 1]
    if (last && line.time > 0 && last[0].time === line.time) last.push(line)
    else groups.push([line])
  }
  const timed = groups.filter(group => group[0].time > 0)
  const pairs = timed.filter(group => group.length === 2 && group[0].text !== group[1].text)
  if (pairs.length < 3 || pairs.length < timed.length * 0.3) return lines

  return groups.flatMap(group => {
    if (group.length !== 2 || group[0].time <= 0 || group[0].text === group[1].text) return group
    const [first, second] = group
    const translationFirst = isChineseText(first.text) && !isChineseText(second.text)
    const origin = translationFirst ? second : first
    const translation = translationFirst ? first : second
    return [{ ...origin, translation: translation.text }]
  })
}

/** 配上译文的句子至少占几成才算配对了（配错歌时原文对不上，占比很低） */
const ALIGN_MIN_COVERAGE = 0.5

/** 参考歌词里连着几句拼起来才是手上的一句时，最多拼几句 */
const JOIN_MAX = 3

/**
 * 译文来自另一份歌词（别的音源里的同一首歌）：按原文的字配，同样的句子出现多次时取时间最近的。
 * 两边断句不一样、参考歌词把这一句拆成了连着的两三句时，把那几句的译文接起来。
 * 配上的句子不到一半就当没找到，返回 null。
 */
export function alignTranslation(lines: LyricLine[], reference: LyricLine[]): LyricLine[] | null {
  const ref = reference
    .filter(line => !!line.translation)
    .map(line => ({ time: line.time, key: normalizeLyricText(line.text), translation: line.translation as string }))
    .filter(line => !!line.key)
  if (!ref.length) return null
  const byText = new Map<string, Array<(typeof ref)[number]>>()
  for (const line of ref) {
    const list = byText.get(line.key)
    if (list) list.push(line)
    else byText.set(line.key, [line])
  }

  /** 参考歌词里从某一句起连着几句，拼起来正好是 key：返回接好的译文（多处都行时取时间最近的） */
  const joined = (key: string, time: number): string | undefined => {
    let best: { gap: number; translation: string } | undefined
    for (let start = 0; start < ref.length; start++) {
      if (!key.startsWith(ref[start].key)) continue
      let text = ref[start].key
      for (let end = start + 1; end < ref.length && end - start < JOIN_MAX && text.length < key.length; end++) {
        text += ref[end].key
        if (text !== key) continue
        const gap = Math.abs(ref[start].time - time)
        if (!best || gap < best.gap) {
          best = { gap, translation: ref.slice(start, end + 1).map(line => line.translation).join(' ') }
        }
      }
    }
    return best?.translation
  }

  let worded = 0
  let matched = 0
  const out = lines.map(line => {
    const key = normalizeLyricText(line.text)
    if (!key) return line
    worded++
    const candidates = byText.get(key)
    const translation = candidates
      ? candidates.reduce((a, b) => (Math.abs(b.time - line.time) < Math.abs(a.time - line.time) ? b : a)).translation
      : joined(key, line.time)
    if (!translation) return line
    matched++
    return { ...line, translation }
  })
  if (!worded || matched < worded * ALIGN_MIN_COVERAGE) return null
  return out
}
