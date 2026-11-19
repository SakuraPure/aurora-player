// 程序化封面：本地歌曲没有内嵌封面、或网络封面加载失败时的兜底（全部原创图形，无外部图片）
import type { Track } from './library'

type Style = 'aurora' | 'rings' | 'burst' | 'orbs' | 'topo' | 'grid' | 'bars' | 'stars' | 'stripes'
const PRESETS: { pal: [string, string, string]; style: Style }[] = [
  { pal: ['#071430', '#19e3b1', '#7b5cff'], style: 'aurora' },
  { pal: ['#1a0b2e', '#ff4fa3', '#ffb86b'], style: 'rings' },
  { pal: ['#06141c', '#2de2ff', '#b6ff5c'], style: 'burst' },
  { pal: ['#120a24', '#8a5cff', '#2affc6'], style: 'orbs' },
  { pal: ['#0a1420', '#7fd0ff', '#e8f7ff'], style: 'topo' },
  { pal: ['#140d1f', '#ff6a88', '#6a8dff'], style: 'grid' },
  { pal: ['#03130d', '#3dff9a', '#00b3ff'], style: 'bars' },
  { pal: ['#070818', '#c3a6ff', '#5cf2ff'], style: 'stars' },
  { pal: ['#1b0f0a', '#ffcf5c', '#ff5c8a'], style: 'rings' },
  { pal: ['#071523', '#47ffd1', '#ff7ae0'], style: 'aurora' },
  { pal: ['#0f0a1a', '#ff9a3c', '#7a3cff'], style: 'orbs' },
  { pal: ['#0d0f14', '#e6ff5c', '#3cffd8'], style: 'stripes' },
]

export const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0 }

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const S = 512
const FONT = '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'

export function makeCover(info: { title: string; artist: string; album: string }, seed: number): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = cv.height = S
  const g = cv.getContext('2d')!
  const R = rng(seed * 9973 + 17)
  const pre = PRESETS[seed % PRESETS.length]
  const [bg, c1, c2] = pre.pal

  const grd = g.createLinearGradient(0, 0, S * 0.3, S)
  grd.addColorStop(0, bg)
  grd.addColorStop(1, '#020206')
  g.fillStyle = grd
  g.fillRect(0, 0, S, S)

  g.save()
  switch (pre.style) {
    case 'aurora': {
      g.globalCompositeOperation = 'lighter'
      for (let k = 0; k < 4; k++) {
        const base = 150 + k * 45 + R() * 30, amp = 30 + R() * 40, fr = 0.008 + R() * 0.01, ph = R() * 6
        const col = k % 2 ? c2 : c1
        for (let x = 0; x < S; x += 2) {
          const y = base + Math.sin(x * fr + ph) * amp + Math.sin(x * fr * 2.7 + ph) * amp * 0.3
          const lg = g.createLinearGradient(0, y - 140, 0, y)
          lg.addColorStop(0, 'transparent')
          lg.addColorStop(1, col)
          g.globalAlpha = 0.05 + 0.08 * Math.pow(Math.sin(x * 0.11 + ph * 3) * 0.5 + 0.5, 3)
          g.fillStyle = lg
          g.fillRect(x, y - 140, 2, 140)
        }
      }
      g.globalCompositeOperation = 'source-over'
      g.globalAlpha = 1
      g.fillStyle = '#020308'
      g.beginPath(); g.moveTo(0, S)
      for (let x = 0; x <= S; x += 32) g.lineTo(x, 390 - Math.abs(Math.sin(x * 0.013 + seed)) * 70 - R() * 22)
      g.lineTo(S, S); g.fill()
      break
    }
    case 'rings': {
      const cx = S / 2, cy = 230, r = 140
      const rg = g.createLinearGradient(0, cy - r, 0, cy + r)
      rg.addColorStop(0, c2); rg.addColorStop(1, c1)
      g.shadowColor = c1; g.shadowBlur = 60
      g.fillStyle = rg
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill()
      g.shadowBlur = 0
      g.fillStyle = bg
      for (let k = 0; k < 7; k++) g.fillRect(0, cy + 10 + k * 20, S, 3 + k * 1.6)
      g.strokeStyle = c2; g.lineWidth = 1
      for (let k = 1; k < 7; k++) { g.globalAlpha = 0.35 - k * 0.04; g.beginPath(); g.arc(cx, cy, r + k * 22, 0, Math.PI * 2); g.stroke() }
      break
    }
    case 'burst': {
      g.translate(S / 2, S * 0.62)
      g.globalCompositeOperation = 'lighter'
      for (let k = 0; k < 90; k++) {
        const a = (k / 90) * Math.PI * 2 + R() * 0.03, len = 120 + R() * 260
        g.strokeStyle = k % 3 ? c1 : c2
        g.globalAlpha = 0.15 + R() * 0.5
        g.lineWidth = 0.6 + R() * 2.2
        g.beginPath(); g.moveTo(Math.cos(a) * 20, Math.sin(a) * 20); g.lineTo(Math.cos(a) * len, Math.sin(a) * len); g.stroke()
      }
      const core = g.createRadialGradient(0, 0, 0, 0, 0, 90)
      core.addColorStop(0, '#ffffff'); core.addColorStop(0.25, c1); core.addColorStop(1, 'transparent')
      g.globalAlpha = 1; g.fillStyle = core; g.fillRect(-90, -90, 180, 180)
      break
    }
    case 'orbs': {
      g.globalCompositeOperation = 'lighter'
      g.filter = 'blur(28px)'
      for (let k = 0; k < 6; k++) {
        g.fillStyle = k % 2 ? c1 : c2
        g.globalAlpha = 0.5 + R() * 0.4
        g.beginPath(); g.arc(80 + R() * 350, 80 + R() * 330, 50 + R() * 90, 0, Math.PI * 2); g.fill()
      }
      g.filter = 'none'
      g.globalCompositeOperation = 'source-over'
      g.globalAlpha = 0.9; g.strokeStyle = '#ffffff'; g.lineWidth = 1.5
      g.beginPath(); g.arc(S / 2, S / 2 - 20, 120, 0, Math.PI * 2); g.stroke()
      break
    }
    case 'topo': {
      g.lineWidth = 1.3
      const cx = S * (0.4 + R() * 0.2), cy = S * (0.4 + R() * 0.15)
      for (let k = 0; k < 26; k++) {
        const r0 = 12 + k * 15
        g.strokeStyle = k % 5 === 0 ? c2 : c1
        g.globalAlpha = 0.85 - k * 0.025
        g.beginPath()
        for (let a = 0; a <= 64; a++) {
          const th = (a / 64) * Math.PI * 2
          const rr = r0 * (1 + 0.16 * Math.sin(th * 3 + k * 0.35) + 0.08 * Math.sin(th * 5 - k * 0.2))
          const x = cx + Math.cos(th) * rr, y = cy + Math.sin(th) * rr * 0.86
          a ? g.lineTo(x, y) : g.moveTo(x, y)
        }
        g.stroke()
      }
      break
    }
    case 'grid': {
      const hz = 300
      const sky = g.createLinearGradient(0, 0, 0, hz)
      sky.addColorStop(0, 'transparent'); sky.addColorStop(1, c1)
      g.globalAlpha = 0.55; g.fillStyle = sky; g.fillRect(0, 0, S, hz)
      g.globalAlpha = 0.9; g.strokeStyle = c2; g.lineWidth = 1.4
      for (let k = -12; k <= 12; k++) { g.beginPath(); g.moveTo(S / 2 + k * 8, hz); g.lineTo(S / 2 + k * 70, S); g.stroke() }
      for (let k = 0; k < 12; k++) { const y = hz + Math.pow(k / 11, 2.2) * (S - hz); g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke() }
      g.fillStyle = '#ffffff'; g.globalAlpha = 0.95
      g.beginPath(); g.moveTo(S / 2, 120); g.lineTo(S / 2 + 70, 250); g.lineTo(S / 2 - 70, 250); g.closePath()
      g.lineWidth = 2.5; g.strokeStyle = '#fff'; g.stroke()
      break
    }
    case 'bars': {
      const n = 22, w = S / n
      for (let k = 0; k < n; k++) {
        const h = 60 + Math.pow(Math.sin((k / n) * Math.PI), 1.5) * 260 * (0.5 + R() * 0.6)
        const lg = g.createLinearGradient(0, S - 80 - h, 0, S - 80)
        lg.addColorStop(0, c2); lg.addColorStop(1, c1)
        g.fillStyle = lg; g.shadowColor = c1; g.shadowBlur = 20
        g.fillRect(k * w + w * 0.22, S - 80 - h, w * 0.56, h)
      }
      break
    }
    case 'stars': {
      for (let k = 0; k < 260; k++) {
        g.fillStyle = R() > 0.8 ? c2 : '#ffffff'
        g.globalAlpha = 0.3 + R() * 0.7
        g.fillRect(R() * S, R() * S, R() * 2.2, R() * 2.2)
      }
      const pts = Array.from({ length: 8 }, () => [90 + R() * 330, 90 + R() * 300])
      g.globalAlpha = 0.8; g.strokeStyle = c1; g.lineWidth = 1.2
      g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke()
      g.fillStyle = c2; g.shadowColor = c2; g.shadowBlur = 16
      pts.forEach(([x, y]) => { g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill() })
      break
    }
    case 'stripes': {
      g.translate(S / 2, S / 2); g.rotate(-Math.PI / 5)
      for (let k = -10; k < 10; k++) {
        g.fillStyle = k % 2 ? c1 : c2
        g.globalAlpha = 0.25 + ((k + 10) % 4) * 0.18
        g.fillRect(k * 34, -S, 16, S * 2)
      }
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.globalAlpha = 1; g.fillStyle = bg
      g.beginPath(); g.rect(0, 0, S, S); g.arc(S / 2, S / 2 - 30, 130, 0, Math.PI * 2, true); g.fill('evenodd')
      break
    }
  }
  g.restore()

  // 颗粒质感
  const img = g.getImageData(0, 0, S, S), d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const n = (R() - 0.5) * 18
    d[i] += n; d[i + 1] += n; d[i + 2] += n
  }
  g.putImageData(img, 0, 0)

  // 字体排版
  const bot = g.createLinearGradient(0, S - 170, 0, S)
  bot.addColorStop(0, 'transparent'); bot.addColorStop(1, 'rgba(0,0,0,0.7)')
  g.fillStyle = bot; g.fillRect(0, S - 170, S, 170)
  g.fillStyle = '#ffffff'
  g.font = `600 13px ${FONT}`
  g.letterSpacing = '4px'
  g.globalAlpha = 0.7
  g.fillText(`AURORA RECORDS · AR-${String((seed % 999) + 1).padStart(3, '0')}`, 30, 44)
  g.globalAlpha = 1
  // 长标题按宽度缩小字号
  const fit = (text: string, weight: number, size: number, max: number) => {
    let sz = size
    do g.font = `${weight} ${sz}px ${FONT}`; while (g.measureText(text).width > max && (sz -= 2) > 18)
    return text
  }
  g.letterSpacing = '2px'
  g.fillText(fit(info.title, 700, 50, S - 56), 28, S - 72)
  g.letterSpacing = '5px'
  g.globalAlpha = 0.8
  g.fillText(fit((info.album || 'SINGLE').toUpperCase(), 500, 15, S - 60), 31, S - 40)
  g.textAlign = 'right'
  g.letterSpacing = '1px'
  g.fillText(fit(info.artist, 500, 15, S * 0.45), S - 30, 44)
  return cv
}

// 兜底封面缓存（canvas 生成较慢，按需生成并只保留最近的）
const cache = new Map<string, { cv: HTMLCanvasElement; url: string }>()
function fallback(tr: Track) {
  let e = cache.get(tr.key)
  if (e) { cache.delete(tr.key); cache.set(tr.key, e); return e }
  e = { cv: makeCover(tr, hash(tr.key)), url: '' }
  cache.set(tr.key, e)
  if (cache.size > 64) cache.delete(cache.keys().next().value!)
  return e
}
export const coverCanvas = (tr: Track) => fallback(tr).cv
/** <img> 用的封面地址 */
export function coverSrc(tr: Track) {
  if (tr.cover) return tr.cover
  const e = fallback(tr)
  return (e.url ||= e.cv.toDataURL('image/jpeg', 0.85))
}
