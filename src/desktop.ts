// 桌面版（Tauri）专属：无边框窗口的标题栏按钮、全局媒体键。网页版不加载。
import type { Player } from './player'

export async function initDesktop(player: Player, toast: (msg: string) => void) {
  document.body.classList.add('app')

  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const win = getCurrentWindow()
  const $ = (id: string) => document.getElementById(id)!
  $('win-min').addEventListener('click', () => win.minimize())
  $('win-max').addEventListener('click', () => win.toggleMaximize())
  $('win-close').addEventListener('click', () => win.close())

  // 全局媒体键：键盘上的播放/暂停、上一首、下一首（被其他程序占用时静默跳过）
  try {
    const gs = await import('@tauri-apps/plugin-global-shortcut')
    await gs.unregisterAll() // 开发时页面重载会重复注册
    await gs.register(['MediaPlayPause', 'MediaTrackNext', 'MediaTrackPrevious'], (e) => {
      if (e.state !== 'Pressed') return
      if (/PlayPause/i.test(e.shortcut)) player.toggle()
      else if (/Next/i.test(e.shortcut)) player.next()
      else if (/Previous/i.test(e.shortcut)) player.prev()
    })
  } catch (e) {
    console.warn('媒体键注册失败', e)
    if (import.meta.env.DEV) toast('媒体键注册失败（可能被其他播放器占用）')
  }
}
