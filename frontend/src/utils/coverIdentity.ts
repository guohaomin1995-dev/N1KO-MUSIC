/**
 * 「是不是同一首歌、同一张封面」的指纹。通知栏（nativeMediaControls）和桌面小部件（homeWidget）
 * 都靠它判断要不要把封面重新交给原生。
 */

export const songKey = (song: { serverId?: string; id: string } | null) => (song ? `${song.serverId ?? ''}:${song.id}` : null)

/**
 * 封面列表的指纹。data: 图片有几百 KB，拿长度和中间一段比就够了；
 * 服务器封面地址每次生成都带新的随机鉴权参数（t / s），比之前先去掉，不然同一张图也算「变了」
 */
export function coversIdentity(urls: string[]): string {
  return urls
    .map(url => {
      if (url.startsWith('data:') || url.startsWith('blob:')) return `${url.length}:${url.slice(32, 96)}`
      let plain = url
      try {
        plain = decodeURIComponent(url)
      } catch {
        // 解不开就按原样比
      }
      return plain.replace(/[?&](t|s)=[^&]*/g, '')
    })
    .join('|')
}
