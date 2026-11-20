// 桌面版（Tauri）专属：标题栏按钮、关闭到托盘、迷你模式、托盘控制、全局媒体键、自动更新。网页版不加载。
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { Player } from './player'

export interface DesktopHooks {
  toast(msg: string, ms?: number): void
  /** 进入 / 退出迷你模式（主画面借此回到波形、收起面板） */
  onMini(on: boolean): void
  /** 打开使用教程（托盘菜单） */
  tour(): void
}

export async function initDesktop(player: Player, hooks: DesktopHooks) {
  document.body.classList.add('app')
  // macOS 用系统的红绿灯按钮（tauri.macos.conf.json：标题栏覆盖在页面上），自绘的窗口按钮隐藏
  if (/Mac/.test(navigator.userAgent)) document.body.classList.add('mac')
  const $ = (id: string) => document.getElementById(id)!

  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const win = getCurrentWindow()
  $('win-min').addEventListener('click', () => win.minimize())
  $('win-max').addEventListener('click', () => win.toggleMaximize())
  // 关闭 = 隐藏到托盘，音乐继续；托盘菜单里"退出"才真正退出（由 Rust 的 CloseRequested 统一处理，同时让页面停止渲染）
  $('win-close').addEventListener('click', () => win.close())

  // ---------------- 迷你模式：窗口缩成置顶的小播放条，波形留在背后 ----------------
  $('win-mini').addEventListener('click', () => invoke('mini_mode', { on: true }))
  $('mini-exit').addEventListener('click', () => invoke('mini_mode', { on: false }))
  const drag = [document.querySelector('.player')!, document.querySelector('.np-info')!]
  listen<boolean>('mini', ({ payload: on }) => {
    document.body.classList.toggle('mini', on)
    // 迷你模式下整条播放器可拖动窗口（按钮除外）；普通模式下不能
    drag.forEach((d) => (on ? d.setAttribute('data-tauri-drag-region', '') : d.removeAttribute('data-tauri-drag-region')))
    hooks.onMini(on)
  })

  // ---------------- 托盘：播放控制、检查更新；悬停提示当前歌曲 ----------------
  listen<string>('tray', ({ payload }) => {
    if (payload === 'toggle') player.toggle()
    else if (payload === 'prev') player.prev()
    else if (payload === 'next') player.next()
    else if (payload === 'update') checkUpdate(true)
    else if (payload === 'tour') {
      // 迷你窗口放不下教程：先回到完整窗口，等布局换回来再打开
      if (document.body.classList.contains('mini')) invoke('mini_mode', { on: false }).then(() => setTimeout(hooks.tour, 400))
      else hooks.tour()
    }
  })
  let tip = ''
  player.on(() => {
    const tr = player.current
    const text = tr ? `${tr.title} - ${tr.artist}`.slice(0, 120) : 'AURORA'
    if (text !== tip) invoke('tray_tooltip', { text: (tip = text) })
  })

  // ---------------- 全局媒体键：播放/暂停、上一首、下一首（被其他程序占用时静默跳过） ----------------
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
    if (import.meta.env.DEV) hooks.toast('媒体键注册失败（可能被其他播放器占用）')
  }

  // ---------------- 自动更新：启动后静默检查；托盘"检查更新"手动检查 ----------------
  // 更新包带签名，下载后用内置公钥校验通过才会安装
  const pill = $('update-pill') as HTMLButtonElement
  const { getVersion } = await import('@tauri-apps/api/app')
  const version = await getVersion()
  let checking = false
  async function checkUpdate(manual: boolean) {
    if (checking) return
    const sources = await invoke<string[]>('update_source').catch(() => [])
    if (!sources.length) {
      if (manual) hooks.toast(`当前 v${version} · 还没有配置更新源`)
      return
    }
    checking = true
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const up = await check()
      if (!up) { if (manual) hooks.toast(`已是最新版本 v${version}`); return }
      offer(up)
      if (manual) hooks.toast(`发现新版本 v${up.version}`)
    } catch (e) {
      if (manual) hooks.toast(`检查更新失败：${e}`)
    } finally {
      checking = false
    }
  }
  type Update = NonNullable<Awaited<ReturnType<typeof import('@tauri-apps/plugin-updater').check>>>
  function offer(up: Update) {
    pill.hidden = false
    pill.disabled = false
    pill.textContent = `新版本 v${up.version} · 点击更新`
    pill.title = up.body || ''
    pill.onclick = async () => {
      pill.disabled = true
      let total = 0, got = 0
      try {
        await up.downloadAndInstall((ev) => {
          if (ev.event === 'Started') total = ev.data.contentLength || 0
          else if (ev.event === 'Progress') {
            got += ev.data.chunkLength
            pill.textContent = total ? `下载更新 ${Math.round((got / total) * 100)}%` : '下载更新…'
          } else if (ev.event === 'Finished') pill.textContent = '正在安装…'
        })
        const { relaunch } = await import('@tauri-apps/plugin-process')
        await relaunch()
      } catch (e) {
        pill.disabled = false
        pill.textContent = '更新失败 · 点击重试'
        hooks.toast(`更新失败：${e}`)
      }
    }
  }
  setTimeout(() => checkUpdate(false), 4000)

  // 开发调试用
  if (import.meta.env.DEV) Object.assign(window, { __desktop: { checkUpdate, version } })
}
