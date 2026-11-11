/**
 * @vitest-environment happy-dom
 *
 * 只有一部手机的扫码登录：手机 App 里在二维码下面提示「保存 / 截图 → 去对应 App 扫一扫里从相册选」，
 * 安卓有「保存二维码」按钮，存进相册后按钮变成「已保存到相册」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { PluginHost } from '@/plugins/host/PluginHost'
import type { PluginManifest } from '@/plugins/types'

const gallery = vi.hoisted(() => ({ can: true, save: vi.fn(async () => {}) }))
vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  isNativePlatform: true,
}))
vi.mock('@/services/gallery', () => ({
  canSaveToGallery: () => gallery.can,
  saveImageToGallery: gallery.save,
}))

const { QrLogin } = await import('./QrLogin')

function fakeHost(id: string) {
  return {
    manifest: { id, auth: { kind: 'qr' }, hosts: [] } as unknown as PluginManifest,
    call: vi.fn(async (method: string) => {
      if (method === 'n1ko.auth.createQr') return { key: 'k', content: 'https://music.163.com/login?codekey=k', expiresIn: 300, qrImage: 'data:image/png;base64,QUJD' }
      return { status: 'waiting' }
    }),
  } as unknown as PluginHost
}

let root: Root | null = null
afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  document.body.innerHTML = ''
  gallery.can = true
  gallery.save.mockClear()
})

async function mount(host: PluginHost) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  act(() => { root!.render(<QrLogin host={host} onAuthorized={() => {}} />) })
  await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve() })
}

describe('QrLogin：只有一部手机', () => {
  it('网易云：提示去网易云音乐 App 从相册扫，点保存后变成「已保存到相册」', async () => {
    await mount(fakeHost('netease'))
    expect(document.body.textContent).toContain('NetEase Cloud Music app')
    const save = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Save QR code'))
    expect(save, '安卓有保存按钮').toBeTruthy()
    await act(async () => {
      save!.click()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })
    expect(gallery.save).toHaveBeenCalledTimes(1)
    expect((gallery.save.mock.calls[0] as unknown as [string])[0]).toMatch(/^data:image\//)
    expect(document.body.textContent).toContain('Saved to Photos')
  })

  it('存不了（iOS 等）：没有按钮，提示改成截图', async () => {
    gallery.can = false
    await mount(fakeHost('netease'))
    expect([...document.querySelectorAll('button')].some(b => b.textContent?.includes('Save QR code'))).toBe(false)
    expect(document.body.textContent).toContain('screenshot')
  })

  it('保存失败：按钮提示改用截图', async () => {
    gallery.save.mockRejectedValueOnce(new Error('UNSUPPORTED'))
    await mount(fakeHost('netease'))
    const save = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Save QR code'))!
    await act(async () => {
      save.click()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })
    expect(document.body.textContent).toContain("Couldn't save")
  })
})
