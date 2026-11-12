/**
 * 电视模式（Android TV / Google TV）。
 *
 * 电视上没有指针也没有触屏，只有一个遥控器：上下左右、确认、返回。
 * 开了电视模式，外壳换成左侧导航条 + 右上角正在播放，方向键交给焦点引擎（lib/spatialNav），
 * 焦点是白底黑字的反相（墨白）。
 *
 * 开不开看两样：设置里的 tvMode（auto / on / off），auto 时看原生壳报的「这台是电视」。
 * 原生壳的回答是异步的，但布局要在首帧就定下来——所以回答落一份在 localStorage，
 * 下次启动同步读；只有装好后第一次启动要等它（main.tsx 的启动守卫最多等 800ms）。
 */

import { useSyncExternalStore } from 'react'
import { registerPlugin } from '@capacitor/core'
import { nativeOS } from '@/lib/platform'
import { STORAGE_KEYS } from '@/services/storageKeys'
import { useSettingsStore, type TvModeSetting } from '@/store/settingsStore'

interface TvModePlugin {
  /** MainActivity 注册的 TvModePlugin：UiModeManager 报电视、有 leanback 特性，或者没有触摸屏 */
  isTelevision(): Promise<{ television: boolean }>
}

const TvModeNative = registerPlugin<TvModePlugin>('TvMode')

function readCachedDevice(): boolean | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.tvDevice)
    return raw === '1' ? true : raw === '0' ? false : null
  } catch {
    return null
  }
}

const cached = readCachedDevice()

/**
 * 原生插件之外的兜底判断：电视盒子的 WebView 没有精确指针、没有触摸点，UA 里是 Android 但不带 Mobile
 * （手机 UA 一定带 Mobile，平板的触摸点又不为 0）。几条同时成立才当电视。
 * 有的盒子既不报电视模式也不声明 leanback（原生 TvModePlugin 认不出），靠这一条进电视模式。
 */
export function looksLikeTelevision(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  if (nativeOS !== 'android') return false
  try {
    if (window.matchMedia('(any-pointer: fine)').matches) return false
  } catch {
    // 老 WebView 不认 any-pointer：跳过这一条，靠触摸点和 UA
  }
  if ((navigator.maxTouchPoints ?? 0) > 0) return false
  const ua = navigator.userAgent || ''
  return /android/i.test(ua) && !/mobile/i.test(ua)
}

let deviceIsTv = cached ?? false
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * 问原生壳这台是不是电视，答案落盘、广播给订阅者。
 * 只有 Android 壳有这个插件；旧版壳没有它时调用会失败，按「不是电视」处理。
 */
async function detect(): Promise<void> {
  if (nativeOS !== 'android') return
  // 先按设备特征判断，原生插件回话后取「或」：插件认不出、但长得像电视的盒子照样按电视走
  let television = looksLikeTelevision()
  try {
    const native = await TvModeNative.isTelevision()
    television = television || native.television
  } catch {
    // 插件不存在（旧壳）：只靠上面的特征判断
  }
  try {
    localStorage.setItem(STORAGE_KEYS.tvDevice, television ? '1' : '0')
  } catch {
    // 存不下就每次启动再问一次，不影响本次
  }
  if (television !== deviceIsTv) {
    deviceIsTv = television
    listeners.forEach(l => l())
  }
}

/** 模块加载时就开始问：等 React 挂上时多半已经有答案了 */
const detection = detect()

/** 同步判断：缓存里已经有答案，或者根本不是 Android（没什么可等的） */
export function tvDeviceKnownNow(): boolean {
  return cached !== null || nativeOS !== 'android'
}

/**
 * 启动守卫用：缓存里已经有答案（或者根本不是 Android）就立即放行，
 * 否则等原生壳回话，最多等 timeoutMs——超时就先按手机布局起，答案到了再换。
 */
export function whenTvDeviceKnown(timeoutMs = 800): Promise<void> {
  if (tvDeviceKnownNow()) return Promise.resolve()
  return Promise.race([detection, new Promise<void>(resolve => setTimeout(resolve, timeoutMs))])
}

export function resolveTvMode(setting: TvModeSetting, device: boolean): boolean {
  return setting === 'on' || (setting === 'auto' && device)
}

/** 这台设备本身是不是电视（与设置无关） */
export function isTvDevice(): boolean {
  return deviceIsTv
}

/** 事件处理里用（不订阅）：现在是不是电视模式 */
export function isTvModeActive(): boolean {
  return resolveTvMode(useSettingsStore.getState().tvMode, deviceIsTv)
}

export function useIsTvDevice(): boolean {
  return useSyncExternalStore(subscribe, () => deviceIsTv, () => false)
}

/** 组件里用：电视模式开着吗 */
export function useTvMode(): boolean {
  const setting = useSettingsStore(s => s.tvMode)
  const device = useIsTvDevice()
  return resolveTvMode(setting, device)
}
