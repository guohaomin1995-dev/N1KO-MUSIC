import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import oklchFallback from './postcss/oklch-fallback.mjs'

export default {
  plugins: [
    tailwindcss(),
    autoprefixer(),
    // 旧内核（Chrome / WebView < 111，车机常见）不认识 oklch()：补一份 rgb 写法，见插件头注释
    oklchFallback(),
  ],
}
