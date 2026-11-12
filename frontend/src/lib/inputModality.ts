/**
 * 最近一次输入是不是键盘。
 *
 * Radix 的菜单、弹窗收起时会把焦点还给打开它的按钮——键盘用户要从那里接着操作。
 * 可点按（或鼠标）打开又关掉时，Android WebView 把这次「还焦点」算成键盘焦点，
 * 按钮上留下一圈绿色焦点环（:focus-visible），像是卡在了选中状态。
 * 所以只在最近一次输入是键盘时才还焦点；点按收起的，焦点就留在原处。
 */

let keyboard = false

if (typeof window !== 'undefined') {
  // 捕获阶段：赶在 Radix 处理按键 / 点按、决定收起之前记下来
  window.addEventListener('keydown', () => { keyboard = true }, true)
  window.addEventListener('pointerdown', () => { keyboard = false }, true)
}

export function lastInputWasKeyboard(): boolean {
  return keyboard
}

/** 给 Radix Content 的 onCloseAutoFocus：先跑调用方自己的，不是键盘收起的就不还焦点 */
export function restoreFocusOnlyForKeyboard(handler?: (event: Event) => void) {
  return (event: Event) => {
    handler?.(event)
    if (!keyboard) event.preventDefault()
  }
}
