/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest'
import { lastInputWasKeyboard, restoreFocusOnlyForKeyboard } from './inputModality'

const closeEvent = () => new Event('focusOutside', { cancelable: true })

describe('菜单 / 弹窗收起时只在键盘操作后还焦点', () => {
  it('点按收起：不还焦点（不留焦点环），调用方自己的处理照跑', () => {
    window.dispatchEvent(new Event('pointerdown'))
    expect(lastInputWasKeyboard()).toBe(false)
    const own = vi.fn()
    const e = closeEvent()
    restoreFocusOnlyForKeyboard(own)(e)
    expect(own).toHaveBeenCalledWith(e)
    expect(e.defaultPrevented).toBe(true)
  })

  it('键盘收起（Esc / 回车选中）：照常还焦点给打开它的按钮', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(lastInputWasKeyboard()).toBe(true)
    const e = closeEvent()
    restoreFocusOnlyForKeyboard()(e)
    expect(e.defaultPrevented).toBe(false)
  })
})
