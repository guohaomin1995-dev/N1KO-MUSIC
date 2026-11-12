// @vitest-environment happy-dom
/**
 * 安卓上的播放器对象（HybridAudio）被引擎当 HTMLAudioElement 用：
 * 「重挂监听」那条路会读 getAttribute('src')，以前没有这个方法，一调就抛 TypeError。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/platform', () => ({ isNativePlatform: true, nativeOS: 'android' }))
vi.mock('@/api/adapters/webdavNative', () => ({
  NATIVE_FLAC_PREFIX: 'webdav-native-flac:',
  WebDavNative: {
    addListener: vi.fn(async () => ({ remove: async () => {} })),
    ...Object.fromEntries(['openFlac', 'pauseFlac', 'rateFlac', 'resumeFlac', 'seekFlac', 'stopFlac', 'volumeFlac'].map(m => [m, vi.fn(async () => ({}))])),
  },
}))

const { createEngineAudio } = await import('./hybridAudio')

describe('HybridAudio 的 src 属性', () => {
  it('普通地址、原生 FLAC 地址、清空：getAttribute / setAttribute / removeAttribute 都对得上 src', () => {
    const audio = createEngineAudio()
    expect(audio.getAttribute('src')).toBeNull()

    audio.src = 'http://127.0.0.1:17321/play?u=x'
    expect(audio.getAttribute('src')).toBe('http://127.0.0.1:17321/play?u=x')

    audio.setAttribute('src', 'webdav-native-flac:https://dav.example/a.flac')
    expect(audio.getAttribute('src')).toBe('webdav-native-flac:https://dav.example/a.flac')
    expect(audio.src).toBe('webdav-native-flac:https://dav.example/a.flac')

    audio.removeAttribute('src')
    expect(audio.getAttribute('src')).toBeNull()
    expect(audio.src).toBe('')
  })
})
