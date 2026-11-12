import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import oklchFallback from './postcss/oklch-fallback.mjs'
import legacyCss from './postcss/legacy-css.mjs'

export default {
  plugins: [
    tailwindcss(),
    autoprefixer(),
    // 旧内核（Chrome / WebView < 111，车机常见）不认识 oklch()：补一份 rgb 写法，见插件头注释
    oklchFallback(),
    // 再老一点（电视盒子的 WebView 83）：:is()/:where()、dvh、overflow: clip、逻辑简写、aspect-ratio，见插件头注释。
    // 放在 oklch 之后，它复制出来的 rgb 版规则也一起处理
    legacyCss(),
  ],
}
