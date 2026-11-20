// 使用教程：首次打开时弹出，一页一页介绍整套交互与主要功能；
// 曲库面板底部的「使用教程」、F1 / ?、桌面版托盘（macOS 菜单栏）菜单都可以重新打开
import { inApp } from './ncm'

const SEEN_KEY = 'aurora.tour'
// macOS 键盘上 F1 默认是调亮度（要按 Fn），教程里提示用 ? 打开
const MAC = /Mac/.test(navigator.userAgent)
const HELP = MAC ? '?' : 'F1'
const TRAY = MAC ? '菜单栏' : '托盘'

// ---------------- 插图（SVG，320×150） ----------------
const DEFS = `<defs>
  <linearGradient id="tg" gradientUnits="userSpaceOnUse" x1="-40" y1="0" x2="360" y2="0"><stop offset="0" stop-color="#22f5a8"/><stop offset=".4" stop-color="#2ad4ff"/><stop offset=".75" stop-color="#8c6bff"/><stop offset="1" stop-color="#ff6ad0"/></linearGradient>
  <linearGradient id="tw" gradientUnits="userSpaceOnUse" x1="-40" y1="0" x2="360" y2="0"><stop offset="0" stop-color="#ffd27a"/><stop offset=".4" stop-color="#ff8a5c"/><stop offset=".75" stop-color="#ff6ad0"/><stop offset="1" stop-color="#b36bff"/></linearGradient>
  <linearGradient id="tc" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb37a"/><stop offset=".55" stop-color="#ff6ad0"/><stop offset="1" stop-color="#6b5bff"/></linearGradient>
  <radialGradient id="tbg" cx=".5" cy=".55" r=".7"><stop offset="0" stop-color="#ff8a5c" stop-opacity=".42"/><stop offset=".6" stop-color="#8c3bff" stop-opacity=".16"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
  <filter id="tb" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="5"/></filter>
  <filter id="ts" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.5"/></filter>
</defs>`
const svg = (body: string) => `<svg viewBox="-40 0 400 150" aria-hidden="true">${DEFS}${body}</svg>`
const WAVE = 'M-40 78H40C70 78 84 40 116 40S156 70 176 82S214 118 238 108S276 78 296 78H360'
const glowLine = (d: string, grad = 'tg') =>
  `<path d="${d}" fill="none" stroke="url(#${grad})" stroke-width="13" opacity=".5" filter="url(#tb)"/><path d="${d}" class="t-line"/>`
/** 一排音柱：正值向上、负值向下，背后带极光光晕 */
const bars = (x0: number, vals: number[], step = 10, y = 78) => {
  const r = vals.map((v, k) => `<rect x="${x0 + k * step}" y="${v < 0 ? y : y - v}" width="5" height="${Math.abs(v)}" rx="1"/>`).join('')
  return `<g fill="url(#tg)" opacity=".5" filter="url(#tb)">${r}</g><g fill="#eef1f6">${r}</g>`
}
const cursor = (x: number, y: number) => `<path class="t-cursor" transform="translate(${x} ${y})" d="M0 0V15L4.2 11.2L7 17.5L9.6 16.4L6.9 10.3H12.2Z"/>`
const ripple = (x: number, y: number) => `<circle class="t-ripple" cx="${x}" cy="${y}" r="12"/>`
const cap = (x: number, y: number, t: string) => `<text x="${x}" y="${y}" text-anchor="middle" class="t-cap">${t}</text>`
const cover = (x: number, y: number, s: number, deco = true) =>
  `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="3" fill="url(#tc)"/>` +
  (deco ? `<circle cx="${x + s * 0.64}" cy="${y + s * 0.38}" r="${s * 0.16}" fill="#fff" opacity=".28"/>` : '')
const kbd = (x: number, y: number, t: string, w = 14) =>
  `<rect x="${x}" y="${y}" width="${w}" height="13" rx="3" class="t-kbd"/><text x="${x + w / 2}" y="${y + 9.2}" text-anchor="middle" class="t-k">${t}</text>`
const tile = (x: number, y: number, inner: string) => `<rect x="${x}" y="${y}" width="16" height="16" rx="3" fill="rgba(255,255,255,.07)"/>${inner}`
const row = (x: number, y: number, t: string, size = 7.5) => `<text x="${x}" y="${y}" class="t-t" font-size="${size}">${t}</text>`
const dim = (x: number, y: number, t: string, size = 6, anchor = 'start') => `<text x="${x}" y="${y}" class="t-d" font-size="${size}" text-anchor="${anchor}">${t}</text>`
// 与界面上一致的图标
const ICON_PREV = '<rect x="5" y="6" width="2" height="12" rx="1"/><path d="M18 6.9v10.2a.9.9 0 0 1-1.4.75L9.5 12.75a.9.9 0 0 1 0-1.5l7.1-5.1A.9.9 0 0 1 18 6.9z"/>'
const ICON_NEXT = '<rect x="17" y="6" width="2" height="12" rx="1"/><path d="M6 6.9v10.2a.9.9 0 0 0 1.4.75l7.1-5.1a.9.9 0 0 0 0-1.5L7.4 6.15A.9.9 0 0 0 6 6.9z"/>'
const ICON_FX = '<rect x="3.5" y="5" width="17" height="14" rx="2.6"/><circle cx="9" cy="10" r="1.6"/><path d="M4.2 17.2l4.9-4.4 3.4 3 3.1-2.6 4.2 4"/>'
const ICON_LIB = '<rect x="4" y="6" width="16" height="1.6" rx="0.8"/><rect x="4" y="11.2" width="11" height="1.6" rx="0.8"/><rect x="4" y="16.4" width="7" height="1.6" rx="0.8"/>'
const ICON_MODE = '<path d="M4 9.5V8a2 2 0 0 1 2-2h12l-2.5-2.5M20 14.5V16a2 2 0 0 1-2 2H6l2.5 2.5"/>'
const ICON_VOL = '<path d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4z"/><path d="M15.5 9a4 4 0 0 1 0 6" fill="none" stroke="#eef1f6" stroke-width="1.6" stroke-linecap="round"/>'
const icon = (x: number, y: number, s: number, paths: string, cls = 't-fill') => `<g class="${cls}" transform="translate(${x} ${y}) scale(${s})">${paths}</g>`
const play = (cx: number, cy: number, r: number) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(255,255,255,.12)" stroke="rgba(255,255,255,.35)" stroke-width=".8"/><path d="M${cx - r * 0.3} ${cy - r * 0.5}v${r}l${r * 0.85} ${-r * 0.5}z" fill="#fff"/>`

const ART = {
  welcome: svg(`<g class="t-breathe">${glowLine(WAVE)}</g>`),

  line: svg(`
    <rect x="6" y="30" width="142" height="80" rx="12" fill="rgba(255,255,255,.03)" stroke="rgba(255,255,255,.2)" stroke-width=".8" stroke-dasharray="3 3"/>
    <g>${glowLine('M14 78C44 78 52 48 80 48S116 80 140 78')}</g>
    ${ripple(96, 88)}${cursor(96, 89)}
    <path d="M156 70h20m-6-6 6 6-6 6" class="t-arrow"/>
    ${bars(188, [6, -10, 18, -26, 32, -16, 12, 24, -30, 14, -8, 12], 10, 70)}
    ${cap(77, 128, '点击波形区域的任意位置')}${cap(245, 128, '每根音柱 = 一首歌')}`),

  stage: svg(`
    ${bars(14, [4, -6, 10, -14, 18, -10], 11, 80)}
    <g transform="translate(90 44) skewY(-5)">
      <rect x="6" y="9" width="58" height="58" rx="3" fill="#000" opacity=".6" filter="url(#ts)"/>${cover(0, 0, 58)}
    </g>
    <rect x="162" y="44" width="86" height="64" rx="6" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.14)" stroke-width=".8"/>
    <rect x="170" y="44" width="14" height="1.6" fill="#fff"/>
    ${dim(170, 58, 'No.07 / 200', 5.5)}${row(170, 74, '歌名', 11)}${dim(170, 87, '歌手 · 3:42', 6.5)}
    <path d="M170 93h70" stroke="rgba(255,255,255,.12)" stroke-width=".6"/>${dim(170, 102, '点击播放', 6)}
    ${bars(262, [-12, 16, -8, 10, -6], 10, 80)}
    ${cap(160, 136, '移动鼠标 · 滚轮 · ← →  翻阅整个歌单')}`),

  play: svg(`
    <rect x="64" y="38" width="70" height="70" rx="3" fill="#000" opacity=".55" filter="url(#ts)" transform="translate(4 6)"/>
    ${cover(64, 32, 70, false)}${play(99, 67, 13)}${ripple(99, 67)}
    ${cap(99, 130, '点击封面：播放')}
    <rect x="178" y="48" width="118" height="26" rx="13" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.22)" stroke-width=".8"/>
    ${row(192, 64.5, '← 返回波形', 8.5)}${kbd(257, 54.5, 'Esc', 24)}
    ${cap(237, 130, '点击空白处 / Esc：返回')}`),

  library: svg(`
    <g transform="translate(24 30)">
      <rect width="50" height="50" rx="6" fill="#f4f6fa"/>
      <g fill="#14161c">
        <rect x="6" y="6" width="12" height="12" rx="1.5"/><rect x="32" y="6" width="12" height="12" rx="1.5"/><rect x="6" y="32" width="12" height="12" rx="1.5"/>
        <rect x="23" y="8" width="4" height="4"/><rect x="23" y="16" width="4" height="4"/><rect x="21" y="24" width="4" height="4"/><rect x="29" y="23" width="4" height="4"/>
        <rect x="37" y="25" width="4" height="4"/><rect x="24" y="33" width="4" height="4"/><rect x="32" y="35" width="4" height="4"/><rect x="38" y="38" width="4" height="4"/><rect x="26" y="40" width="4" height="4"/>
      </g>
    </g>
    ${cap(49, 98, '扫码登录')}
    <g class="t-bob"><rect x="114" y="22" width="14" height="18" rx="2" fill="rgba(255,255,255,.18)" stroke="rgba(255,255,255,.5)" stroke-width=".8"/><path d="M118 32h6M118 35.5h4" stroke="#fff" stroke-width=".8"/></g>
    <path d="M121 44v6m-3-3 3 3 3-3" class="t-arrow"/>
    <path d="M100 56h14l4 4h20a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3h-38a3 3 0 0 1-3-3v-21a3 3 0 0 1 3-3z" fill="rgba(255,255,255,.08)" stroke="rgba(255,255,255,.55)" stroke-width="1"/>
    ${cap(121, 98, '导入 / 拖进窗口')}
    <rect x="172" y="12" width="134" height="24" rx="12" fill="rgba(255,255,255,.05)" stroke="url(#tg)" stroke-width="1" class="t-pulse"/>
    ${icon(181, 17, 0.58, ICON_LIB)}${row(200, 27.5, '热歌榜', 8)}${dim(296, 27.5, '200 首', 6.5, 'end')}
    <rect x="172" y="44" width="134" height="98" rx="10" fill="rgba(22,24,30,.92)" stroke="rgba(255,255,255,.1)" stroke-width=".8"/>
    ${dim(182, 57, '为 你 推 荐', 5.2)}
    ${tile(182, 62, `<path d="M182 63h16" stroke="#f2f4f8" stroke-width="1.2"/><text x="190" y="74" text-anchor="middle" class="t-t" font-size="7" font-weight="700">20</text>`)}${row(206, 73, '每日推荐')}
    ${tile(182, 84, `<text x="190" y="96" text-anchor="middle" class="t-t" font-size="9">∞</text>`)}${row(206, 95, '私人漫游')}
    ${dim(182, 115, '榜 单', 5.2)}
    <rect x="182" y="120" width="16" height="16" rx="3" fill="url(#tc)"/>${row(206, 131, '热歌榜')}`),

  find: svg(`
    <rect x="-30" y="14" width="176" height="24" rx="8" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.25)" stroke-width=".8"/>
    ${row(-20, 29.5, '晴空', 8)}<rect x="112" y="19" width="28" height="14" rx="7" fill="none" stroke="rgba(255,255,255,.4)" stroke-width=".8"/>${dim(126, 28.6, '单曲', 6.5, 'middle')}
    ${[['1', '晴空', '夏木'], ['2', '晴空之下', '南风乐队'], ['3', '晴空万里', '林间']].map(([n, t, a], k) =>
      `${dim(-22, 56 + k * 22, n, 6, 'middle')}${row(-12, 54 + k * 22, t, 7.5)}${dim(-12, 63 + k * 22, a, 5.5)}`).join('')}
    <path d="M152 22h16m-4-4 4 4-4 4M168 31h-16m4-4-4 4 4 4" class="t-arrow"/>
    <rect x="174" y="14" width="176" height="24" rx="8" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.25)" stroke-width=".8"/>
    ${row(184, 29.5, '夏日', 8)}<rect x="316" y="19" width="28" height="14" rx="7" fill="rgba(255,255,255,.1)" stroke="url(#tg)" stroke-width="1" class="t-pulse"/>${dim(330, 28.6, '歌单', 6.5, 'middle')}
    ${ripple(330, 26)}${cursor(338, 30)}
    ${[['夏日午后的歌', '官方 · 48 首', 1], ['夏天的风和海', '用户 小满 · 120 首', 0.7], ['盛夏通勤', '用户 阿树 · 35 首', 0.45]].map(([t, a, o], k) =>
      `<rect x="178" y="${46 + k * 22}" width="16" height="16" rx="3" fill="url(#tc)" opacity="${o}"/>${row(200, 54 + k * 22, t as string, 7.5)}${dim(200, 63 + k * 22, a as string, 5.5)}`).join('')}
    ${cap(58, 134, '单曲：结果成为当前歌单')}${cap(262, 134, '歌单：官方和用户创建的歌单')}`),

  search: svg(`
    <rect x="70" y="8" width="180" height="134" rx="12" fill="rgba(22,24,30,.92)" stroke="rgba(255,255,255,.1)" stroke-width=".8"/>
    ${dim(82, 27, '←', 8)}${row(96, 27, '热歌榜', 9)}${dim(238, 27, '2 / 200', 6.5, 'end')}
    <rect x="82" y="36" width="156" height="22" rx="7" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.32)" stroke-width=".8"/>
    ${row(92, 50.5, '海', 8.5)}<rect x="102" y="41.5" width="1" height="11" fill="#fff" class="t-caret"/>
    <rect x="80" y="66" width="160" height="28" rx="6" fill="rgba(255,255,255,.07)"/>
    ${dim(94, 83, '1', 6.5, 'end')}${row(102, 78, '海边的风', 8)}${dim(102, 88.5, '夏木 · 海边的风', 6)}
    ${dim(94, 113, '37', 6.5, 'end')}${row(102, 108, '看海', 8)}${dim(102, 118.5, '南风乐队 · 远方', 6)}
    ${dim(160, 136, '回车播放第一首 · Esc 清空', 6, 'middle')}`),

  player: svg(`
    ${row(160, 26, '这一行是歌词', 9).replace('<text', '<text text-anchor="middle"')}${dim(160, 38, '外语歌下面还有中文翻译', 6.5, 'middle')}
    <rect x="8" y="54" width="304" height="46" rx="12" fill="rgba(255,255,255,.045)" stroke="rgba(255,255,255,.12)" stroke-width=".8"/>
    ${cover(16, 62, 30)}${row(54, 75, '歌名', 8)}${dim(54, 86, '歌手', 6)}
    ${icon(98, 70, 0.6, ICON_PREV)}${play(126, 77, 10)}${icon(139, 70, 0.6, ICON_NEXT)}
    ${dim(162, 79, '1:05', 5.5)}<path d="M178 77h48" stroke="rgba(255,255,255,.2)" stroke-width="2" stroke-linecap="round"/><path d="M178 77h18" stroke="#fff" stroke-width="2" stroke-linecap="round"/>${dim(230, 79, '3:42', 5.5)}
    <rect x="248" y="69.5" width="24" height="15" rx="7.5" fill="none" stroke="rgba(255,255,255,.3)" stroke-width=".8"/>${dim(260, 79.6, '极高', 6, 'middle')}
    ${icon(276, 69, 0.64, ICON_MODE, 't-stroke')}${icon(293, 69, 0.62, ICON_VOL)}
    ${dim(126, 114, '播放控制', 6, 'middle')}${dim(202, 114, '进度', 6, 'middle')}${dim(260, 114, '音质', 6, 'middle')}${dim(284, 114, '模式', 6, 'middle')}${dim(302, 114, '音量', 6, 'middle')}
    ${kbd(124, 127, '空格', 22)}${dim(152, 136, '播放 / 暂停', 6.5)}`),

  coverbg: svg(`
    <rect x="-40" width="400" height="150" fill="url(#tbg)"/>
    <rect x="115" y="22" width="90" height="90" rx="4" fill="url(#tc)" opacity=".38" filter="url(#ts)"/>
    <g class="t-breathe">${glowLine(WAVE, 'tw')}</g>
    ${kbd(254, 13, 'B')}
    <circle cx="292" cy="19.5" r="12" fill="rgba(255,255,255,.14)" stroke="rgba(255,255,255,.45)" stroke-width=".8" class="t-pulse"/>
    ${icon(284, 11.5, 0.67, ICON_FX, 't-stroke')}`),

  mini: svg(`
    <rect x="-40" width="400" height="22" fill="rgba(255,255,255,.035)"/>
    <circle cx="211" cy="11" r="9.5" fill="none" stroke="url(#tg)" stroke-width="1" class="t-pulse"/>
    <g fill="none" stroke="#eef1f6" stroke-width=".9"><rect x="205" y="6.5" width="12" height="9" rx="1.2"/><path d="M235 11.5h10"/><rect x="266" y="6.5" width="9" height="9" rx="1"/><path d="M296 6.5l9 9M305 6.5l-9 9"/></g>
    <rect x="210.5" y="10.5" width="5.5" height="3.5" rx=".6" fill="#eef1f6"/>
    <path d="M211 25C211 38 218 44 226 49" fill="none" stroke="rgba(255,255,255,.35)" stroke-dasharray="2 3"/>
    <rect x="160" y="52" width="150" height="34" rx="8" fill="rgba(20,22,28,.96)" stroke="rgba(255,255,255,.16)" stroke-width=".8"/>
    ${cover(166, 57, 24)}${row(196, 68, '歌名', 7)}${dim(196, 78, '歌手', 5.5)}
    ${icon(240, 63, 0.45, ICON_PREV)}${play(262, 69, 7.5)}${icon(272, 63, 0.45, ICON_NEXT)}
    <path d="M295 63h5v5M290 75h-5v-5" fill="none" stroke="#eef1f6" stroke-width=".9"/>
    ${cap(235, 100, '迷你模式：置顶的小播放条')}
    <rect x="22" y="40" width="112" height="80" rx="6" fill="rgba(34,36,44,.97)" stroke="rgba(255,255,255,.12)" stroke-width=".8"/>
    ${['播放 / 暂停', '上一首 / 下一首', '迷你模式 / 完整窗口', '使用教程', '检查更新', '退出 AURORA'].map((t, k) => row(32, 53 + k * 12, t, 6.5)).join('')}
    ${dim(78, 33, MAC ? '关闭窗口后留在菜单栏 · 单击控制' : '关闭窗口后留在托盘 · 右键控制', 6, 'middle')}
    <rect x="-40" y="128" width="400" height="22" fill="rgba(255,255,255,.05)"/>
    <circle cx="42" cy="139" r="2" fill="rgba(255,255,255,.35)"/><circle cx="54" cy="139" r="2" fill="rgba(255,255,255,.35)"/>
    <circle cx="70" cy="139" r="8" fill="none" stroke="url(#tg)" stroke-width="1" class="t-pulse"/>
    <g fill="#eef1f6"><rect x="64.5" y="139" width="2" height="4" rx=".5"/><rect x="67.5" y="135" width="2" height="8" rx=".5"/><rect x="70.5" y="137" width="2" height="6" rx=".5"/><rect x="73.5" y="136" width="2" height="7" rx=".5"/></g>`),

  keys: `<div class="tour-keys">
    <div><span><kbd>空格</kbd></span>播放 / 暂停</div>
    <div><span><kbd>B</kbd></span>封面背景</div>
    <div><span><kbd>Esc</kbd></span>返回波形</div>
    <div><span><kbd>←</kbd><kbd>→</kbd></span>翻阅封面</div>
    <div><span><kbd>${HELP}</kbd></span>使用教程</div>
    <div><span><kbd>Enter</kbd></span>播放搜到的第一首</div>
  </div>`,
}

interface Page { title: string; text: string; art: string; desktop?: boolean }
const PAGES: Page[] = [
  {
    title: '欢迎来到 AURORA 极光韵境', art: ART.welcome,
    text: '整个界面就是一条随音乐律动的<b>极光波形</b>。音乐来自<b>网易云音乐</b>和你电脑上的<b>本地音乐</b>。花一分钟看看怎么用它。',
  },
  {
    title: '点击波形，变成音柱', art: ART.line,
    text: '把鼠标移到中间波形跳动的区域，指针会变成手型，这时<b>点击</b>，波形就变成一排音柱，不用正好点在线上。<b>每根音柱就是当前歌单里的一首歌</b>，整个歌单都排在这一行里。',
  },
  {
    title: '点击音柱，翻出封面', art: ART.stage,
    text: '在音柱上点击，进入<b>立体视图</b>：鼠标下的音柱侧向翻出，成为这首歌的封面，旁边显示歌名和歌手。<b>移动鼠标</b>换一根音柱，<b>滚轮</b>或 <kbd>←</kbd><kbd>→</kbd> 推动整排音柱，翻阅整个歌单。',
  },
  {
    title: '点击封面播放，点击空白处返回', art: ART.play,
    text: '看中哪首就<b>点击它的封面</b>，开始播放。想回到波形，<b>点击空白处</b>、顶部的<span class="nw">「← 返回波形」</span>，或按 <kbd>Esc</kbd>。',
  },
  {
    title: '曲库：找到想听的音乐', art: ART.library,
    text: '右上角显示歌单名的按钮打开<b>曲库</b>。<b>扫码登录</b>网易云后有每日推荐、私人雷达、你的歌单，还有点开就播、一直播下去的<b>私人漫游</b>；不登录也能听榜单、浏览分类和精品歌单。本地音乐可以导入文件夹，或者直接<b>拖进窗口</b>。',
  },
  {
    title: '搜索单曲或歌单', art: ART.find,
    text: '曲库顶部的搜索框默认搜<b>单曲</b>，按 <kbd>Enter</kbd> 搜索，结果直接成为当前歌单。点框右侧的<b>「单曲」按钮</b>切换成「歌单」，就能搜到官方歌单和其他用户创建的歌单，点开就能听；再点一下切回单曲。',
  },
  {
    title: '在歌单里搜索', art: ART.search,
    text: '打开任意歌单后，列表顶部有<b>搜索框</b>：输入歌名、歌手或专辑立即筛选，用空格分隔多个关键词。按 <kbd>Enter</kbd> 播放第一首匹配的歌，<kbd>Esc</kbd> 清空搜索。',
  },
  {
    title: '播放条', art: ART.player,
    text: '底部是播放条：上一首 / 播放 / 下一首、进度条、<b>音质</b>（所选音质拿不到时自动降档，按钮显示实际音质）、<b>播放模式</b>（列表循环、随机、单曲循环）<span class="nw">和音量</span>。歌词显示在播放条上方，按 <kbd>空格</kbd> 播放或暂停。',
  },
  {
    title: '封面背景', art: ART.coverbg,
    text: '右上角的<b>图片按钮</b>，或按 <kbd>B</kbd>，打开<b>封面背景</b>：当前歌曲的封面铺在波形后面，极光的颜色也取自封面。点开音柱时，背景会被吸收进封面；播放新歌时，再从封面里释放出来。',
  },
  {
    title: MAC ? '迷你模式与菜单栏' : '迷你模式与系统托盘', art: ART.mini, desktop: true,
    text: MAC
      ? '标题栏的<b>迷你模式</b>按钮把窗口缩成一条置顶的小播放条，可以拖动，点右侧按钮回到完整窗口。<b>关闭窗口</b>后 AURORA 留在菜单栏继续播放，单击菜单栏里的图标可以控制播放或退出；点<b>程序坞</b>图标重新打开窗口。'
      : '标题栏的<b>迷你模式</b>按钮把窗口缩成一条置顶的小播放条，可以拖动，点右侧按钮回到完整窗口。<b>关闭窗口</b>后 AURORA 留在系统托盘继续播放，右键托盘图标可以控制播放或退出；键盘的<b>媒体键</b>也能直接控制。',
  },
  {
    title: '准备好了', art: ART.keys,
    text: inApp
      ? `以上就是全部操作。忘了的话，随时按 <kbd>${HELP}</kbd>、点曲库底部的「使用教程」，或者从${TRAY}菜单重新打开这份教程。`
      : `以上就是全部操作。忘了的话，随时按 <kbd>${HELP}</kbd>，或点曲库底部的「使用教程」重新打开这份教程。`,
  },
]

export interface TourHooks {
  /** 打开前：收起曲库面板等 */
  beforeOpen(): void
}

export function initTour(hooks: TourHooks) {
  const pages = PAGES.filter((p) => inApp || !p.desktop)
  const entryKey = document.querySelector('#pn-tour kbd')
  if (entryKey) entryKey.textContent = HELP
  const root = document.createElement('div')
  root.className = 'tour'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', '使用教程')
  root.innerHTML = `<div class="tour-card">
    <div class="tour-head"><span class="tour-step"></span><button class="tour-x" aria-label="关闭教程">×</button></div>
    <div class="tour-body"><div class="tour-art"></div><h2></h2><p></p></div>
    <div class="tour-foot">
      <div class="tour-dots">${pages.map(() => '<i></i>').join('')}</div>
      <button class="tour-prev">上一页</button><button class="tour-next">下一页</button>
    </div>
  </div>`
  document.body.append(root)
  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!
  const body = q('.tour-body'), art = q('.tour-art'), step = q('.tour-step'), title = q('h2'), text = q('p')
  const prev = q<HTMLButtonElement>('.tour-prev'), next = q<HTMLButtonElement>('.tour-next')
  const dots = [...root.querySelectorAll('.tour-dots i')]
  let i = 0, open = false

  function render(dir = 0) {
    const p = pages[i]
    art.innerHTML = p.art
    step.textContent = `${i + 1} / ${pages.length}`
    title.textContent = p.title
    text.innerHTML = p.text
    dots.forEach((d, k) => d.classList.toggle('on', k === i))
    prev.style.visibility = i ? '' : 'hidden'
    next.textContent = i === pages.length - 1 ? '开始使用' : '下一页'
    body.classList.remove('in-l', 'in-r')
    if (dir) { void body.offsetWidth; body.classList.add(dir < 0 ? 'in-l' : 'in-r') } // 重新触发翻页动画
  }
  function go(d: number) {
    const j = i + d
    if (j < 0) return
    if (j >= pages.length) return close()
    i = j
    render(d)
  }
  function show() {
    if (open || document.body.classList.contains('mini')) return // 迷你窗口放不下
    hooks.beforeOpen()
    i = 0
    open = true
    render()
    root.classList.add('show')
    next.focus()
  }
  function close() {
    if (!open) return
    open = false
    root.classList.remove('show')
    localStorage.setItem(SEEN_KEY, '1')
    ;(document.activeElement as HTMLElement | null)?.blur()
  }

  q('.tour-x').addEventListener('click', close)
  prev.addEventListener('click', () => go(-1))
  next.addEventListener('click', () => go(1))
  root.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true }) // 不让滚轮推动背后的音柱
  // 捕获阶段处理：教程打开时按键只用于翻页，不传给播放器（空格、B、方向键等）
  addEventListener('keydown', (e) => {
    if (!open) {
      const typing = e.target instanceof HTMLElement && !!e.target.closest('input, textarea')
      if (e.key === 'F1' || (e.key === '?' && !typing)) { e.preventDefault(); show() }
      return
    }
    e.stopPropagation()
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowRight' || e.key === 'PageDown') go(1)
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1)
    else if (e.key === 'Enter' && !(document.activeElement instanceof HTMLButtonElement)) go(1)
    else if (e.key === 'F1') e.preventDefault()
  }, true)

  return {
    open: show,
    close,
    get isOpen() { return open },
    /** 看过（或关掉过）教程 */
    get seen() { return localStorage.getItem(SEEN_KEY) === '1' },
  }
}
