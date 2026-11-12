/**
 * 把一张图（data: URL）存进系统相册。目前只有安卓原生壳实现（GalleryPlugin.java，
 * 写 MediaStore 的 Pictures/X-MUSIC，Android 10 起不需要存储权限）。
 *
 * 用在扫码登录：只有一部手机的人没法拿手机扫自己的屏幕，把二维码存进相册，
 * 再去网易云 / QQ / 微信的扫一扫里从相册选这张图。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

interface GalleryPlugin {
  saveImage(options: { data: string; name?: string }): Promise<void>
}

const Gallery = registerPlugin<GalleryPlugin>('Gallery')

/** 这个环境能不能直接存进相册（桌面 / 网页版都不能，界面改提示截图） */
export function canSaveToGallery(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

/** 成功 resolve；系统太老（Android 9 及以下）或写入失败时 reject */
export async function saveImageToGallery(dataUrl: string, name: string): Promise<void> {
  if (!canSaveToGallery()) throw new Error('unsupported')
  if (!dataUrl.startsWith('data:image/')) throw new Error('not an inline image')
  await Gallery.saveImage({ data: dataUrl, name })
}
