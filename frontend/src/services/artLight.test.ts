// @vitest-environment happy-dom
/**
 * 取色缓存的键：同一张封面只算一次（鉴权参数每次都变），不同封面不能撞键。
 * 撞键的后果见 paletteCacheKey 的注释：Android 上 Subsonic 的封面全走本机转发，
 * 以前所有歌共用一个键，房间永远是第一张算过的封面的颜色。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEYS } from '@/services/storageKeys'

/* Node 26 自带的实验性 localStorage 没开 --localstorage-file 时是 undefined，会盖掉 happy-dom 的；给一个内存版 */
const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => { memoryStorage.set(k, String(v)) },
  removeItem: (k: string) => { memoryStorage.delete(k) },
  clear: () => memoryStorage.clear(),
})

const PROXY = 'http://127.0.0.1:17321/play?u='
const subsonic = (id: string, salt: string) =>
  `http://192.168.1.150:8025/rest/getCoverArt?id=${id}&size=256&u=me&t=${salt}&s=${salt.slice(0, 6)}&v=1.16.1&c=X-MUSIC`
const proxied = (url: string) => PROXY + encodeURIComponent(url)

describe('取色缓存的键', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })

  it('同一张封面换了鉴权参数还是同一个键', async () => {
    const { paletteCacheKey } = await import('./artLight')
    expect(paletteCacheKey(subsonic('al-1', 'aaaaaaaa'))).toBe(paletteCacheKey(subsonic('al-1', 'bbbbbbbb')))
    expect(paletteCacheKey(subsonic('al-1', 'aaaaaaaa'))).toBe('http://192.168.1.150:8025/rest/getCoverArt?id=al-1&size=256')
  })

  it('套了本机转发的：按里面的真地址算——不同封面不撞键，同一张和直连共用', async () => {
    const { paletteCacheKey } = await import('./artLight')
    const a = paletteCacheKey(proxied(subsonic('static-aaa', 'aaaaaaaa')))
    const b = paletteCacheKey(proxied(subsonic('static-bbb', 'aaaaaaaa')))
    expect(a).not.toBe(b)
    expect(a).toBe(paletteCacheKey(proxied(subsonic('static-aaa', 'cccccccc'))))
    expect(a).toBe(paletteCacheKey(subsonic('static-aaa', 'dddddddd')))
  })

  it('data / blob 地址用短哈希当键', async () => {
    const { paletteCacheKey } = await import('./artLight')
    expect(paletteCacheKey('blob:https://localhost/1234-5678')).toMatch(/^inline:\d+:\d+$/)
    expect(paletteCacheKey('data:image/png;base64,AAAA')).not.toBe(paletteCacheKey('data:image/png;base64,BBBB'))
  })

  it('旧版本留下的「…/play」撞键记录读盘时扔掉，不再套到任何一首歌上', async () => {
    const warm = { h: 52, c: 0.088, l: 0.5, h2: 90, c2: 0.062, swatches: [], neutral: false }
    const good = subsonic('static-aaa', 'aaaaaaaa')
    localStorage.setItem(STORAGE_KEYS.artLight, JSON.stringify([
      ['http://127.0.0.1:17321/play', warm],
      ['http://192.168.1.150:8025/rest/getCoverArt?id=static-aaa&size=256', { ...warm, h: 245 }],
    ]))
    const { peekPalette } = await import('./artLight')
    expect(peekPalette(proxied(subsonic('static-zzz', 'aaaaaaaa')))).toBeUndefined()
    expect(peekPalette(proxied(good))?.h).toBe(245)
  })
})
