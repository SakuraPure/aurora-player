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

// ---------------- 封面取色：给波形的极光拖尾用 ----------------
export type RGB = [number, number, number]
function rgb2hsv(r: number, g: number, b: number): RGB {
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b)
  let h = 0
  if (d) {
    h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
    h /= 6
    if (h < 0) h += 1
  }
  return [h, mx ? d / mx : 0, mx]
}
function hsv2rgb(h: number, s: number, v: number): RGB {
  h = ((h % 1) + 1) % 1
  const f = (n: number) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)) }
  return [f(5), f(3), f(1)]
}
const hueDist = (a: number, b: number) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d) }

/**
 * 从封面取 4 个渐变色：按色相直方图找主色峰（彩度加权），沿色相最短路径排序，
 * 再提亮到适合"发光"的明度范围；几乎无彩色的封面给一组带主色调的银白。
 */
export function extractPalette(img: CanvasImageSource): RGB[] {
  const S = 40, B = 36 // 缩到 40×40 采样；色相 36 桶（每桶 10°）
  const cv = document.createElement('canvas')
  cv.width = cv.height = S
  const g = cv.getContext('2d', { willReadFrequently: true })!
  g.drawImage(img, 0, 0, S, S)
  const px = g.getImageData(0, 0, S, S).data // 跨域图片未授权时会抛错，由调用方兜底
  const w = new Float32Array(B), hs = new Float32Array(B), ss = new Float32Array(B), vs = new Float32Array(B)
  let chroma = 0
  for (let i = 0; i < px.length; i += 4) {
    const [h, s, v] = rgb2hsv(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255)
    chroma += s * v
    if (v < 0.12 || s < 0.08) continue
    const k = Math.min(B - 1, Math.floor(h * B)), wt = s * s * v // 偏向鲜艳的颜色
    w[k] += wt; hs[k] += h * wt; ss[k] += s * wt; vs[k] += v * wt
  }
  chroma /= S * S
  const smooth = Array.from(w, (_, k) => w[(k + B - 1) % B] + 2 * w[k] + w[(k + 1) % B])
  const top = Math.max(...smooth)

  // 几乎无彩色：银白渐变，带一点主色调
  if (chroma < 0.05 || top <= 0) {
    const k = smooth.indexOf(top), h = top > 0 ? hs[k] / w[k] || 0.6 : 0.6
    return [hsv2rgb(h - 0.03, 0.1, 0.86), hsv2rgb(h, 0.16, 0.97), hsv2rgb(h + 0.03, 0.08, 1), hsv2rgb(h + 0.05, 0.14, 0.9)]
  }

  // 取最多 4 个相距 ≥ 40° 的色相峰
  const picks: { h: number; s: number; v: number }[] = []
  for (const k of [...smooth.keys()].sort((a, b) => smooth[b] - smooth[a])) {
    if (picks.length >= 4 || smooth[k] < top * 0.08) break
    const ks = [k, (k + 1) % B, (k + B - 1) % B], tw = ks.reduce((a, j) => a + w[j], 0)
    if (!tw) continue
    const avg = (arr: Float32Array) => ks.reduce((a, j) => a + arr[j], 0) / tw
    let h = hs[k] / (w[k] || 1)
    if (!w[k]) h = (k + 0.5) / B
    if (picks.some((p) => hueDist(p.h, h) < 40 / 360)) continue
    picks.push({ h, s: avg(ss), v: avg(vs) })
  }
  // 沿色相最短路径排序：从最大色相空隙之后开始
  picks.sort((a, b) => a.h - b.h)
  if (picks.length > 1) {
    let gap = -1, at = 0
    picks.forEach((p, i) => { const n = picks[(i + 1) % picks.length]; const d = (n.h - p.h + 1) % 1 || 1; if (d > gap) { gap = d; at = (i + 1) % picks.length } })
    picks.push(...picks.splice(0, at))
  } else {
    const p = picks[0] // 只有一个主色：两侧做轻微色相偏移
    picks.unshift({ ...p, h: p.h - 0.05, s: p.s * 0.8 })
    picks.push({ ...p, h: p.h + 0.06 })
  }
  // 提亮：明度拉到发光区间，饱和度收在 0.4–0.8
  const glow = (p: { h: number; s: number; v: number }): RGB =>
    hsv2rgb(p.h, Math.min(0.8, Math.max(0.4, p.s * 1.25)), 0.5 + 0.5 * Math.max(p.v, 0.82))
  const cols = picks.map(glow)
  // 均匀取 4 个渐变节点；对比色之间插值会发灰，插值点按两端饱和度补回
  return [0, 1, 2, 3].map((i) => {
    const f = (i / 3) * (cols.length - 1), j = Math.min(Math.floor(f), cols.length - 2), t = f - j
    const mixC = cols[j].map((c, n) => c + (cols[j + 1][n] - c) * t) as RGB
    if (t < 0.01 || t > 0.99) return mixC
    const [h, sat, v] = rgb2hsv(...mixC), s0 = rgb2hsv(...cols[j])[1], s1 = rgb2hsv(...cols[j + 1])[1]
    return hsv2rgb(h, Math.max(sat, (s0 + (s1 - s0) * t) * 0.85), Math.max(v, 0.9))
  })
}
