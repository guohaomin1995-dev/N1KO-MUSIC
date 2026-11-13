/**
 * 这台设备是怎么把画面画出来的：屏幕和页面的尺寸、像素比、内核版本、显卡、着色器的浮点精度。
 * 设置 · 关于里显示成一行（components/settings/DisplayInfo），电视、车机上画面不对劲时拍下来就能判断
 * ——这些设备接不了电脑调试，而「背景一格一格」「边缘有锯齿」这类问题全看这几个数。
 */

export interface DisplayInfo {
  /** 屏幕的物理像素 */
  screen: string
  /** 页面的布局尺寸（CSS 像素） */
  page: string
  dpr: number
  /** 页面被放大了几倍（1 是没放大） */
  zoom: number
  /** 内核，如 Chrome 83 */
  engine: string
  /** 显卡型号；拿不到就是空串 */
  gpu: string
  /** 片元着色器的浮点精度，如 "mediump 10 / highp 23"；highp 为 0 表示不支持 */
  precision: string
}

let cached: DisplayInfo | null = null

function probeGpu(): { gpu: string; precision: string } {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const gl = canvas.getContext('webgl')
    if (!gl) return { gpu: '', precision: '' }
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const gpu = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '')
    const bits = (kind: number) => gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, kind)?.precision ?? 0
    const precision = `mediump ${bits(gl.MEDIUM_FLOAT)} / highp ${bits(gl.HIGH_FLOAT)}`
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return { gpu, precision }
  } catch {
    return { gpu: '', precision: '' }
  }
}

export function getDisplayInfo(): DisplayInfo {
  if (cached) return cached
  const dpr = window.devicePixelRatio || 1
  const engine = /(Chrome|Firefox|Version)\/(\d+)/.exec(navigator.userAgent)
  const round = (v: number) => Math.round(v * 100) / 100
  cached = {
    screen: `${Math.round(window.screen.width * dpr)}×${Math.round(window.screen.height * dpr)}`,
    page: `${window.innerWidth}×${window.innerHeight}`,
    dpr: round(dpr),
    zoom: round(window.visualViewport?.scale ?? 1),
    engine: engine ? `${engine[1] === 'Version' ? 'Safari' : engine[1]} ${engine[2]}` : '',
    ...probeGpu(),
  }
  return cached
}
