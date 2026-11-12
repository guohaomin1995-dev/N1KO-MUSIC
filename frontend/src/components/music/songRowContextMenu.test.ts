import { describe, expect, it } from 'vitest'
import { isTouchContextMenu } from './SongList'

const contextMenu = (pointerType?: string) => {
  const e = new Event('contextmenu') as Event & { pointerType?: string }
  if (pointerType !== undefined) Object.defineProperty(e, 'pointerType', { value: pointerType })
  return e
}

describe('长按带出的 contextmenu 不再和多选叠在一起', () => {
  it('触摸 / 触控笔长按带出来的算长按', () => {
    expect(isTouchContextMenu(contextMenu('touch'), false)).toBe(true)
    expect(isTouchContextMenu(contextMenu('pen'), false)).toBe(true)
  })

  it('老内核没有 pointerType：手指还按着就算长按', () => {
    expect(isTouchContextMenu(contextMenu(), true)).toBe(true)
  })

  it('鼠标右键、触控板双指点按照旧打开菜单', () => {
    expect(isTouchContextMenu(contextMenu('mouse'), false)).toBe(false)
    expect(isTouchContextMenu(contextMenu(), false)).toBe(false)
  })
})
