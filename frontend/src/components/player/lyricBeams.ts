/**
 * 进度点往上打的那几束光的「灯位」。
 *
 * 进度点只决定光源在哪。束数、整组往哪边偏、每一束的张角和亮度，都写在一套灯位里。
 * 换句、或者每隔几小节换一套新灯位，两套之间平滑过渡，所以数量和方向都是慢慢摆过去的。
 * 这里只算灯位，不碰画布，方便单独验证。
 */

export const SLOT_COUNT = 5
/** 相对正上方的最大偏角（弧度）。再大就会横着扫 */
const MAX_OFFSET = 0.95

export interface BeamPose {
  /** 相对正上方的偏角（弧度）。0 竖直，负向左，正向右 */
  angle: number
  /** 这一束的半张角（弧度） */
  spread: number
  /** 0 熄灭，1 最亮。空着的槽位是 0，换灯时从这里淡入 */
  alpha: number
  /** 这一束能打多远（倍数，1 为标准） */
  reach: number
}

export interface BeamRig {
  beams: BeamPose[]
}

/** 减弱动态效果时不换灯：竖直的一小簇，停住 */
export const STILL_RIG: BeamRig = {
  beams: [
    { angle: 0, spread: 0.2, alpha: 0.9, reach: 1 },
    { angle: -0.24, spread: 0.09, alpha: 0.45, reach: 0.9 },
    { angle: 0.22, spread: 0.07, alpha: 0.38, reach: 0.88 },
    { angle: 0, spread: 0.1, alpha: 0, reach: 1 },
    { angle: 0, spread: 0.1, alpha: 0, reach: 1 },
  ],
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
}

/**
 * 把抽出来的偏角拉开一点，再整组挪回允许的范围。
 * 挨得太近，几束光会糊成一束，束数变化就看不出来。
 */
function fitAngles(angles: number[], minGap: number, limit: number): number[] {
  const items = angles.map((angle, index) => ({ angle, index })).sort((p, q) => p.angle - q.angle)
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < items.length; i++) {
      const gap = items[i].angle - items[i - 1].angle
      if (gap < minGap) {
        const push = (minGap - gap) / 2
        items[i - 1].angle -= push
        items[i].angle += push
      }
    }
    const lo = items[0].angle
    if (lo < -limit) for (const item of items) item.angle += -limit - lo
    const hi = items[items.length - 1].angle
    if (hi > limit) for (const item of items) item.angle -= hi - limit
  }
  const out = new Array<number>(angles.length)
  for (const item of items) out[item.index] = clamp(item.angle, -limit, limit)
  return out
}

/** 由种子决定的一套灯位。同一个种子永远得到同一套 */
export function nextBeamRig(seed: number): BeamRig {
  const rand = mulberry32(seed)
  const roll = rand()
  const count = roll < 0.22 ? 2 : roll < 0.55 ? 3 : roll < 0.82 ? 4 : 5
  // 整组先偏到某一侧，再在组内散开；有时拆成左右两簇
  const lean = (rand() * 2 - 1) * 0.55
  const split = rand() < 0.35 && count >= 3
  const splitAt = split ? 1 + Math.floor(rand() * (count - 1)) : count
  const raw: number[] = []
  for (let i = 0; i < count; i++) {
    const side = split ? (i < splitAt ? -0.3 : 0.3) : 0
    const jitter = (rand() * 2 - 1) * (split ? 0.1 : 0.22)
    raw.push(lean + side + jitter)
  }
  const separated = fitAngles(raw, 0.14, MAX_OFFSET)
  const beams: BeamPose[] = []
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (i >= count) {
      beams.push({ angle: lean, spread: 0.1, alpha: 0, reach: 1 })
      continue
    }
    // 粗细两档混着来：细而亮的光束，配宽而淡的光幕
    const broad = rand() < 0.35
    beams.push({
      angle: separated[i],
      spread: broad ? 0.16 + rand() * 0.12 : 0.05 + rand() * 0.07,
      alpha: broad ? 0.3 + rand() * 0.35 : 0.45 + rand() * 0.55,
      reach: 0.75 + rand() * 0.45,
    })
  }
  let brightest = 0
  for (let i = 1; i < count; i++) {
    if (beams[i].alpha > beams[brightest].alpha) brightest = i
  }
  beams[brightest].alpha = Math.max(beams[brightest].alpha, 0.85)
  return { beams }
}

function smoothstep(t: number) {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

/** 两套灯位之间的插值。t 为 0 是 from，为 1 是 to */
export function mixBeamRigs(from: BeamRig, to: BeamRig, t: number): BeamPose[] {
  const eased = smoothstep(t)
  return from.beams.map((a, i) => {
    const b = to.beams[i]
    return {
      angle: a.angle + (b.angle - a.angle) * eased,
      spread: a.spread + (b.spread - a.spread) * eased,
      alpha: a.alpha + (b.alpha - a.alpha) * eased,
      reach: a.reach + (b.reach - a.reach) * eased,
    }
  })
}

/**
 * 拍子的包络：每拍开头一下脉冲再衰减，每小节第一拍更重。
 * beats 是从歌开头算起的拍数（可以是小数）。返回 0–1。
 */
export function beatPulse(beats: number): number {
  if (!isFinite(beats) || beats < 0) return 0
  const phase = beats - Math.floor(beats)
  const downbeat = Math.floor(beats) % 4 === 0
  return Math.exp(-phase * 5) * (downbeat ? 1 : 0.55)
}
