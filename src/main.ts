import * as THREE from 'three'
import './style.css'
import { Player } from './player'
import { fmt, type Track } from './library'
import { coverCanvas, extractPalette, type RGB } from './covers'
import { initUI } from './ui'
import { initTour } from './tour'
import { inApp } from './ncm'
import * as SH from './shaders'

const N = 48 // 屏幕上的音柱数（循环复用）；音柱 id 不取模，滚动时依次对应曲库里的歌
const Z0 = 20 // 相机距离
const GAP = 0.56 // 音柱间隙占比
// 封面背景（开关）参数
const BG_SIZE = 1.08 // 中景封面边长 / 可视高度：放大到略超出屏幕高，上下边缘羽化消失
const BG_Y = 0.03 // 略微上移，下缘藏到播放器后
const BG_OP = 0.36 // 中景不透明度
const BG_FEATHER = 0.55, BG_LOD = 0.6 // 中景边缘羽化比例、轻微柔化（保持清晰可辨）
const $ = (id: string) => document.getElementById(id)!
const { lerp, clamp } = THREE.MathUtils
const mod = (a: number, n: number) => ((a % n) + n) % n
const sm = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)
const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt))

// ---------------- 渲染器（正视透视相机，只用于卡片翻转的 3D 感） ----------------
const canvas = $('gl') as HTMLCanvasElement
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100)
camera.position.set(0, 0, Z0)

const L = { visW: 0, visH: 0, rowW: 0, x0: 0, slot: 0, amp: 0, cover: 0, barW: 0 }

// ---------------- 主画面：背景 + 波形/音柱 + 拖尾 + 阴影 ----------------
const data = new Float32Array(N * 2 * 4)
const dataTex = new THREE.DataTexture(data, N, 2, THREE.RGBAFormat, THREE.FloatType)
const blankTex = new THREE.Texture()
const U = {
  uD: { value: dataTex }, uN: { value: N }, uSlot: { value: 1 }, uX0: { value: 0 }, uRowW: { value: 1 }, uOffset: { value: 0 },
  uMorph: { value: 0 }, uStage: { value: 0 }, uAmp: { value: 1 }, uGap: { value: GAP }, uTrail: { value: 1.5 }, uTime: { value: 0 },
  uShadow: { value: new THREE.Vector2() }, uNear: { value: 0 }, uCursor: { value: 0 },
  uBgCur: { value: blankTex }, uBgPrev: { value: blankTex }, uBgRect: { value: new THREE.Vector4() }, uBgFull: { value: new THREE.Vector4() },
  uView: { value: new THREE.Vector2() }, uBgRest: { value: new THREE.Vector2(BG_FEATHER, BG_LOD) }, uBgOn: { value: 0 }, uBgCurA: { value: 0 },
  uBgPrevA: { value: 0 }, uBgAmb: { value: 0 }, uBgFeather: { value: BG_FEATHER }, uBgLod: { value: BG_LOD }, uBgK: { value: 0 }, uBgOp: { value: BG_OP },
  uPal: { value: Array.from({ length: 4 }, () => new THREE.Vector3()) }, uPalMix: { value: 0 },
}
const stageMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.ShaderMaterial({ vertexShader: SH.stageVert, fragmentShader: SH.stageFrag, uniforms: U, depthTest: false, depthWrite: false }),
)
stageMesh.renderOrder = -1
scene.add(stageMesh)

// ---------------- 封面纹理（按需加载，只保留最近的） ----------------
const loader = new THREE.TextureLoader().setCrossOrigin('anonymous')
interface CoverTex { tex: THREE.Texture; ready: number }
const texCache = new Map<string, CoverTex>()
function coverTex(tr: Track): CoverTex {
  const hitE = texCache.get(tr.key)
  if (hitE) { texCache.delete(tr.key); texCache.set(tr.key, hitE); return hitE }
  const e: CoverTex = { tex: blankTex, ready: 0 }
  const fallback = () => { e.tex.image = coverCanvas(tr); e.tex.needsUpdate = true; e.ready = 1 }
  if (tr.cover) e.tex = loader.load(tr.cover, () => { e.ready = 1 }, undefined, fallback)
  else { e.tex = new THREE.CanvasTexture(coverCanvas(tr)); e.ready = 1 }
  e.tex.anisotropy = 8
  texCache.set(tr.key, e)
  for (const [k, old] of texCache) {
    if (texCache.size <= 40) break
    if (cards.some((c) => c.active && c.u.uTex.value === old.tex) || k === bgCur?.key || k === bgPrev?.key) continue
    old.tex.dispose()
    texCache.delete(k)
  }
  return e
}

// ---------------- 封面卡片 ----------------
type Rect = { x: number; y: number; w: number; h: number } // 中心 + 半宽高（世界坐标，z=0 平面）
interface Card {
  id: number; p: number; v: number; target: number; side: number; active: boolean; entry: CoverTex | null; fade: number
  rect: Rect // 卡片正面投影到 z=0 平面的矩形（封面背景吸收/释放用）
  mesh: THREE.Mesh; shadow: THREE.Mesh
  u: { uTex: { value: THREE.Texture }; uCover: { value: number }; uDim: { value: number } }
  su: { uExt: { value: THREE.Vector2 }; uHalf: { value: THREE.Vector2 }; uBlur: { value: number }; uAlpha: { value: number } }
}
const cardGeo = new THREE.BoxGeometry(1, 1, 1)
const planeGeo = new THREE.PlaneGeometry(1, 1)
const cards: Card[] = Array.from({ length: 8 }, () => {
  const u = { uTex: { value: blankTex }, uCover: { value: 0 }, uDim: { value: 1 } }
  const su = { uExt: { value: new THREE.Vector2() }, uHalf: { value: new THREE.Vector2() }, uBlur: { value: 0.1 }, uAlpha: { value: 0 } }
  const mesh = new THREE.Mesh(cardGeo, new THREE.ShaderMaterial({ vertexShader: SH.cardVert, fragmentShader: SH.cardFrag, uniforms: u }))
  const shadow = new THREE.Mesh(planeGeo, new THREE.ShaderMaterial({
    vertexShader: SH.shadowVert, fragmentShader: SH.shadowFrag, uniforms: su, transparent: true, depthTest: false, depthWrite: false,
  }))
  shadow.renderOrder = 0
  mesh.renderOrder = 1
  mesh.visible = shadow.visible = false
  scene.add(shadow, mesh)
  return { id: 0, p: 0, v: 0, target: 0, side: 1, active: false, entry: null, fade: 0, rect: { x: 0, y: 0, w: 0, h: 0 }, mesh, shadow, u, su }
})

// ---------------- 状态 ----------------
const player = new Player()
const spectrum = player.spectrum
const raw = new Float32Array(N), mean = new Float32Array(N), local = new Float32Array(N), barT = new Float32Array(N), waveT = new Float32Array(N), env = new Float32Array(N)
const barV = new Float32Array(N), waveV = new Float32Array(N), focus = new Float32Array(N).fill(1)
// 光晕弹簧：位置 + 速度（欠阻尼 → 停下时惯性冲出）
const barH = new Float32Array(N), barHv = new Float32Array(N), waveH = new Float32Array(N), waveHv = new Float32Array(N)
let t = 0, last = performance.now(), intro = 0, base = 0.4
let morph = 0 // 0 波形 → 1 柱形
let stageLin = 0, stageT = 0, stage = 0 // 0 平面 → 1 立体（阴影）
let offset = 0, offsetT = 0
let barsT = 0 // 0 波形，1 柱形（点击波形区域进入）
let hovered: number | null = null, hovered2D: number | null = null
let pinned: number | null = null // 从曲库面板定位的音柱：滚动到位后弹出
let mouseInside = false, downX = 0, downY = 0, lastPrimary = '', lastCta = ''
const ndc = new THREE.Vector2(9, 9)

const barX = (i: number) => {
  let u = ((i + 0.5) * L.slot + offset) % L.rowW
  if (u < 0) u += L.rowW
  return L.x0 + u
}
const idFromU = (u: number) => Math.floor(u)
const slotOf = (id: number) => mod(id, N)
const wrapDist = (u: number, id: number) => Math.abs(u - id - 0.5)
const trackOf = (id: number): Track | null => { const ts = player.list.tracks; return ts.length ? ts[mod(id, ts.length)] : null }

const HALO_K = 55, HALO_C = 4.6
function spring(pos: Float32Array, vel: Float32Array, target: Float32Array, dt: number) {
  for (let s = 0; s < 2; s++) {
    const h = dt / 2
    for (let i = 0; i < N; i++) {
      vel[i] += (HALO_K * (target[i] - pos[i]) - HALO_C * vel[i]) * h
      pos[i] += vel[i] * h
    }
  }
}

// ---------------- 拾取 ----------------
const ray = new THREE.Raycaster(), rowPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), hit = new THREE.Vector3()
const cubic = (a: number, b: number, c: number, d: number, t: number) =>
  b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)))
// 与着色器一致的波形线高度
function waveYAt(x: number) {
  const xn = (x - L.x0) / L.rowW
  const uc = (x - L.x0 - offset) / L.slot - 0.5, j = Math.floor(uc)
  const w = (k: number) => waveV[(((j + k) % N) + N) % N]
  return cubic(w(-1), w(0), w(1), w(2), uc - j) * sm(0, 0.015, xn) * sm(1, 0.985, xn)
}
function pick() {
  ray.setFromCamera(ndc, camera)
  if (!mouseInside || !ray.ray.intersectPlane(rowPlane, hit)) return { inRegion: false, inWave: false, u: 0 }
  const xn = (hit.x - L.x0) / L.rowW
  const inX = xn > 0.05 && xn < 0.95
  return {
    inRegion: inX && Math.abs(hit.y) < L.amp * 1.3, // 音柱区域，之外即"空白处"
    // 波形跳动的区域（波峰最高约 1.5 倍振幅）：点这里就进入音柱，不必正好点在跳动的线上
    inWave: inX && Math.abs(hit.y) < L.amp * 1.5,
    u: (hit.x - L.x0 - offset) / L.slot,
  }
}
// 立体态下鼠标所指的封面卡片
function cardAt() {
  ray.setFromCamera(ndc, camera)
  const hitCard = ray.intersectObjects(cards.filter((c) => c.active && c.p > 0.5).map((c) => c.mesh))[0]
  return cards.find((c) => c.mesh === hitCard?.object)
}

// ---------------- 卡片：弹出 / 收回 ----------------
function popCard(id: number) {
  let c = cards.find((c) => c.active && c.id === id)
  if (!c) {
    const tr = trackOf(id)
    if (!tr) return
    c = cards.find((c) => !c.active) ?? [...cards].sort((a, b) => a.target - b.target || a.p - b.p)[0]
    release(c)
    Object.assign(c, { id, p: 0, v: 0, active: true, side: barX(id) > L.x0 + L.rowW * 0.6 ? -1 : 1 })
    c.entry = coverTex(tr)
    c.fade = c.entry.ready
    c.u.uTex.value = c.entry.tex
    c.mesh.visible = c.shadow.visible = true
    c.rect = barRect(id)
  }
  c.target = 1
}
function release(c: Card) {
  c.active = false
  c.entry = null
  c.target = 0
  c.mesh.visible = c.shadow.visible = false
}

const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0)
const qx = new THREE.Quaternion(), p0 = new THREE.Vector3(), p1 = new THREE.Vector3()

function updateCard(c: Card, dt: number) {
  const up = c.target > 0.5
  const k = up ? 90 : 150, d = up ? 11 : 2 * Math.sqrt(150) // 弹出略带回弹，收回临界阻尼
  for (let s = 0; s < 3; s++) {
    c.v += (k * (c.target - c.p) - d * c.v) * (dt / 3)
    c.p += c.v * (dt / 3)
  }
  if (!up && c.p < 0.004 && Math.abs(c.v) < 0.08) return release(c)

  const pe = Math.max(c.p, 0), pc = Math.min(pe, 1)
  const si = slotOf(c.id)
  const v = barV[si], hi = Math.max(Math.abs(v), 0.024)
  const xi = barX(c.id), C = L.cover
  // 起点 = 侧立的白色音柱（只露出厚度那一面），终点 = 侧前方转正的封面
  p0.set(xi, v / 2, 0)
  p1.set(xi + c.side * (C * 0.5 + L.slot * 1.2), 0, C * 0.12)
  c.mesh.position.lerpVectors(p0, p1, pe)
  c.mesh.scale.set(
    lerp(0.001, C, clamp((pe - 0.05) / 0.75, 0, 1.1)),
    lerp(hi, C, clamp(pe / 0.65, 0, 1.08)),
    lerp(L.barW, C * 0.025, clamp(pe / 0.6, 0, 1)),
  )
  // 从侧面（90°）翻转到正面；转正后随鼠标轻微倾斜
  const yaw = c.side * (Math.PI / 2) * (1 - pe)
  const tx = clamp((hit.x - c.mesh.position.x) / C, -1, 1), ty = clamp((hit.y - c.mesh.position.y) / C, -1, 1)
  c.mesh.quaternion.setFromAxisAngle(Y, yaw + tx * 0.12 * pc).multiply(qx.setFromAxisAngle(X, -ty * 0.12 * pc))
  c.fade = damp(c.fade, c.entry?.ready ?? 0, 6, dt) // 网络封面加载完成后再淡入
  c.u.uCover.value = sm(0.35, 0.85, pe) * c.fade
  c.u.uDim.value = lerp(focus[si], 1, pc)

  // 投影：起点与音柱阴影一致，抬得越高越大越虚
  const hw = (c.mesh.scale.x * Math.abs(Math.cos(yaw)) + c.mesh.scale.z * Math.abs(Math.sin(yaw))) / 2
  const hh = c.mesh.scale.y / 2
  const f = Z0 / (Z0 - c.mesh.position.z)
  c.rect = { x: c.mesh.position.x * f, y: c.mesh.position.y * f, w: hw * f, h: hh * f }
  const blur = lerp(0.02 + 0.1 * stage, C * 0.12, pc)
  const off = U.uShadow.value
  c.shadow.position.set(
    c.mesh.position.x + lerp(off.x * stage, C * 0.08, pc),
    c.mesh.position.y + lerp(off.y * stage, -C * 0.12, pc), -0.01,
  )
  c.su.uHalf.value.set(hw, hh)
  c.su.uBlur.value = blur
  c.su.uAlpha.value = lerp(0.8 * stage, 0.7, pc)
  c.su.uExt.value.set(2 * (hw + blur * 2), 2 * (hh + blur * 2))
  c.shadow.scale.set(c.su.uExt.value.x, c.su.uExt.value.y, 1)
}

// ---------------- UI ----------------
const ui = {
  hint: $('hint'), back: $('back'), label: $('label'),
  lbNo: $('lb-no'), lbTitle: $('lb-title'), lbAlbum: $('lb-album'), lbArtist: $('lb-artist'), lbDur: $('lb-dur'), lbCta: $('lb-cta'),
}
const app = initUI(player, { locate })
// 使用教程：第一次打开时等开屏动画走完再弹出；曲库底部、F1、托盘菜单可以重新打开
const tour = initTour({ beforeOpen: () => app.closePanel() })
if (!tour.seen) setTimeout(() => tour.open(), 1800)
$('pn-tour').addEventListener('click', () => tour.open())
if (inApp) {
  import('./desktop').then((d) => d.initDesktop(player, {
    toast: app.toast,
    onMini: (on) => { if (on) { backToWave(); app.closePanel(); tour.close() } }, // 迷你模式只保留波形与播放条
    tour: () => tour.open(),
  }))
}
// 换了曲库：收起所有封面
let shownList = player.list
player.on(() => {
  if (player.list === shownList) return
  shownList = player.list
  cards.forEach(release)
  hovered = pinned = null
})
function playId(id: number) {
  const tr = trackOf(id)
  if (!tr) return
  if (tr.key === player.current?.key) player.toggle()
  else player.play(tr)
}
/** 把列表第 ti 首滚到音柱中央（只在柱形/立体态下） */
function locate(ti: number) {
  const M = player.list.tracks.length
  if (ti < 0 || !M || (barsT < 0.5 && stageT < 0.5)) return
  const uc = (L.rowW / 2 - offsetT) / L.slot - 0.5
  let id = Math.round(uc) - mod(Math.round(uc), M) + ti
  while (id - uc > M / 2) id -= M
  while (uc - id > M / 2) id += M
  offsetT = L.rowW / 2 - (id + 0.5) * L.slot
  pinned = stageT > 0.5 ? id : null
}
// ---------------- 封面背景（开关；关闭时画面与原效果完全一致） ----------------
// 当前歌曲的封面作为波形背景；点击音柱进入立体态时背景被吸收进弹出的封面，点击播放或返回时再从封面处释放回背景
const BG_KEY = 'fx.coverBg'
let bgEnabled = localStorage.getItem(BG_KEY) === '1'
let bgCur: Track | null = null, bgPrev: Track | null = null
let bgCurFade = 0, bgPrevA = 0 // 换歌交叉淡化
let bgK = 0 // 0 = 背景，1 = 吸收进音柱
let bgDir = 0 // 1 吸收中，-1 释放中
let bgAnchor: number | null = null
const bgSmall: Rect = { x: 0, y: 0, w: 0.1, h: 0.1 } // 吸收的目标 / 释放的起点
const par = new THREE.Vector2() // 视差：背景随鼠标反向轻移，与静止的波形拉开层次
const bgHi = new Map<string, CoverTex>()
const palCache = new Map<string, RGB[] | null>() // 封面取色结果（null = 取不到，用默认极光色）

/** 当前封面的拖尾配色：封面加载好后取一次并缓存 */
function paletteOf(tr: Track, tex: CoverTex): RGB[] | null {
  if (palCache.has(tr.key)) return palCache.get(tr.key)!
  if (!tex.ready || !tex.tex.image) return null
  let pal: RGB[] | null = null
  try { pal = extractPalette(tex.tex.image as CanvasImageSource) } catch { /* 图片不可读：保持默认极光色 */ }
  palCache.set(tr.key, pal)
  if (palCache.size > 200) palCache.delete(palCache.keys().next().value!)
  return pal
}

/** 背景用高清封面（网易云取 1024），未就绪前先用卡片的 512 */
function bgTex(tr: Track): CoverTex {
  const lo = coverTex(tr)
  if (!tr.cover?.includes('param=512y512')) return lo
  let hi = bgHi.get(tr.key)
  if (!hi) {
    const e: CoverTex = { tex: blankTex, ready: 0 }
    e.tex = loader.load(tr.cover.replace('param=512y512', 'param=1024y1024'), () => { e.ready = 1 }, undefined, () => {})
    bgHi.set(tr.key, (hi = e))
    for (const [k, old] of bgHi) {
      if (bgHi.size <= 3) break
      if (k === bgCur?.key || k === bgPrev?.key || k === tr.key) continue
      old.tex.dispose()
      bgHi.delete(k)
    }
  }
  return hi.ready ? hi : lo
}
function barRect(id: number): Rect {
  const v = barV[slotOf(id)]
  return { x: barX(id), y: v / 2, w: L.barW / 2, h: Math.max(Math.abs(v) / 2, L.barW) }
}
function anchorRect(id: number): Rect {
  return cards.find((c) => c.active && c.id === id)?.rect ?? barRect(id)
}
function fullRect(): Rect {
  const S = L.visH * BG_SIZE
  return { x: -par.x * L.visW * 0.014, y: L.visH * BG_Y - par.y * L.visH * 0.014, w: S / 2, h: S / 2 }
}
function absorb(id: number) {
  bgAnchor = id
  bgDir = 1
  Object.assign(bgSmall, anchorRect(id))
}
/** 从矩形 r（卡片 / 音柱）释放回背景；若换了歌且旧背景还在，旧背景原位淡出、新封面从卡片里展开 */
function releaseFrom(r: Rect) {
  const tr = player.current
  if (tr && tr.key !== bgCur?.key) {
    if (bgK < 0.5 && bgCur) { bgPrev = bgCur; bgPrevA = bgCurFade }
    bgCur = tr
    bgK = 1
  }
  if (bgK <= 0) return
  bgCurFade = 1
  Object.assign(bgSmall, r)
  bgDir = -1
}
function releaseSource(): Rect {
  const c = cards.find((c) => c.active && c.id === hovered) ?? cards.filter((c) => c.active).sort((a, b) => b.p - a.p)[0]
  return c ? c.rect : bgAnchor !== null ? barRect(bgAnchor) : { x: 0, y: 0, w: L.barW, h: L.barW }
}
const lgLerp = (a: number, b: number, f: number) => Math.exp(lerp(Math.log(Math.max(a, 1e-3)), Math.log(Math.max(b, 1e-3)), f))

function updateBg(dt: number) {
  par.x = damp(par.x, mouseInside ? ndc.x : 0, 2.2, dt)
  par.y = damp(par.y, mouseInside ? ndc.y : 0, 2.2, dt)
  // 换歌：背景可见时交叉淡化；已被吸收时直接替换
  const tr = player.current
  if ((tr?.key ?? '') !== (bgCur?.key ?? '')) {
    if (bgK > 0.5 && bgDir !== -1) { bgCur = tr; bgCurFade = 1 }
    else { if (bgCur) { bgPrev = bgCur; bgPrevA = bgCurFade } bgCur = tr; bgCurFade = 0 }
  }
  const cur = bgCur ? bgTex(bgCur) : null
  if (cur?.ready) bgCurFade = Math.min(1, bgCurFade + dt / 1.1)
  bgPrevA = Math.max(0, bgPrevA - dt / 1.1)
  if (bgPrevA <= 0) bgPrev = null

  // 吸收 / 释放进度；吸收目标跟随卡片（平滑，避免卡片收回时跳变）
  if (bgDir === 1) {
    bgK = Math.min(1, bgK + dt / 0.85)
    if (bgK >= 1) bgDir = 0
    if (bgAnchor !== null) {
      const a = anchorRect(bgAnchor)
      bgSmall.x = damp(bgSmall.x, a.x, 16, dt); bgSmall.y = damp(bgSmall.y, a.y, 16, dt)
      bgSmall.w = damp(bgSmall.w, a.w, 16, dt); bgSmall.h = damp(bgSmall.h, a.h, 16, dt)
    }
  } else if (bgDir === -1) {
    bgK = Math.max(0, bgK - dt / 1.05)
    if (bgK <= 0) bgDir = 0
  }

  // 几何：宽度先收（像被抽进细长的音柱），高度随后；尺寸按对数插值，缩放速度均匀
  const F = fullRect(), S = bgSmall, k = bgK
  const kp = ease(k), kx = ease(clamp(k / 0.7, 0, 1)), ky = ease(clamp((k - 0.15) / 0.85, 0, 1))
  U.uBgRect.value.set(lerp(F.x, S.x, kp), lerp(F.y, S.y, kp), lgLerp(F.w, S.w, kx), lgLerp(F.h, S.h, ky))
  U.uBgFull.value.set(F.x, F.y, F.w, F.h)
  const shown = sm(0, 1, bgCurFade)
  // 飞行中更实、更清晰、边缘更利落，抵达音柱前一刻淡出融入
  U.uBgCurA.value = lerp(BG_OP, 0.95, sm(0.05, 0.55, k)) * (1 - sm(0.78, 1, k)) * shown
  U.uBgAmb.value = (1 - sm(0, 0.65, k)) * shown
  U.uBgFeather.value = lerp(BG_FEATHER, 0.03, sm(0, 0.55, k))
  U.uBgLod.value = lerp(BG_LOD, 0, sm(0, 0.5, k))
  U.uBgK.value = k
  U.uBgPrevA.value = sm(0, 1, bgPrevA)
  U.uBgCur.value = cur?.tex ?? blankTex
  U.uBgPrev.value = bgPrev ? bgTex(bgPrev).tex : blankTex
  U.uBgOn.value = damp(U.uBgOn.value, bgEnabled && (bgCur || bgPrev) ? 1 : 0, 3, dt)

  // 波形拖尾配色取自封面：换歌时颜色平滑过渡，开关关闭时淡回默认极光色
  const pal = bgCur && cur ? paletteOf(bgCur, cur) : null
  if (pal) {
    const snap = U.uPalMix.value < 0.01 // 从默认色切入时直接就位，避免从黑色渐变
    U.uPal.value.forEach((v, i) => {
      const [r, g, b] = pal[i]
      if (snap) v.set(r, g, b)
      else v.set(damp(v.x, r, 2.4, dt), damp(v.y, g, 2.4, dt), damp(v.z, b, 2.4, dt))
    })
  }
  U.uPalMix.value = damp(U.uPalMix.value, bgEnabled && pal ? 1 : 0, 3, dt)
}

const fxBtn = $('fx-bg')
function renderFx() {
  fxBtn.classList.toggle('on', bgEnabled)
  fxBtn.setAttribute('aria-pressed', String(bgEnabled))
}
fxBtn.addEventListener('click', () => {
  bgEnabled = !bgEnabled
  localStorage.setItem(BG_KEY, bgEnabled ? '1' : '0')
  renderFx()
  app.toast(bgEnabled ? (player.current ? '封面背景：开' : '封面背景：开 · 播放歌曲后显示') : '封面背景：关', 1600)
})
renderFx()

let hintKey = ''
function setHint(key: string) {
  if (key === hintKey) return
  hintKey = key
  const text: Record<string, string> = {
    wave: '点击波形',
    bars: '点击音柱进入立体 · 点击空白处返回',
    stage: '移动鼠标翻阅 · 滚轮推动音柱 · 点击封面播放 · 点击空白处返回',
    empty: '曲库是空的 · 点击右上角导入本地音乐或浏览网易云',
  }
  ui.hint.classList.remove('show')
  setTimeout(() => { ui.hint.textContent = text[key]; ui.hint.classList.add('show') }, 180)
  document.body.dataset.mode = key
}

// ---------------- 交互 ----------------
addEventListener('pointermove', (e) => {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
  mouseInside = e.target === canvas // 鼠标在面板 / 播放器上时不影响音柱
})
document.documentElement.addEventListener('mouseleave', () => { mouseInside = false })
addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY })
addEventListener('pointerup', (e) => {
  if (e.target !== canvas || Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return
  if (app.panelOpen) app.closePanel()
  else onClick()
})
// 波形 --点击波形区域--> 柱形 --点击音柱--> 立体 + 封面；任意状态点击空白处 / Esc 返回波形
function onClick() {
  const pk = pick()
  if (stageT > 0.5) {
    const c = cardAt()
    const id = c ? c.id : pk.inRegion ? hovered : null
    if (id !== null) {
      playId(id)
      releaseFrom(anchorRect(id)) // 点击播放：封面从这张卡片里释放成为背景
    } else backToWave()
  } else if (barsT > 0.5) {
    if (pk.inRegion && morph > 0.5) {
      stageT = 1
      hovered = idFromU(pk.u)
      popCard(hovered)
      absorb(hovered) // 背景被吸收进弹出的这根音柱
    } else if (!pk.inRegion) backToWave()
  } else if (pk.inWave) {
    if (player.list.tracks.length) barsT = 1
    else app.openPanel('sources')
  }
}
function backToWave() {
  if (bgK > 0 && bgDir !== -1) releaseFrom(releaseSource()) // 返回：从当前封面处释放回背景
  stageT = 0; barsT = 0; hovered = pinned = null
}
addEventListener('wheel', (e) => {
  if (stageT < 0.5) return
  e.preventDefault()
  offsetT -= (e.deltaY + e.deltaX) * L.slot * 0.011
}, { passive: false })
addEventListener('keydown', (e) => {
  const tgt = e.target
  if (tgt instanceof HTMLElement && tgt.closest('input, textarea')) { if (e.key === 'Escape') tgt.blur(); return }
  if (e.key === 'Escape') app.panelOpen ? app.closePanel() : backToWave()
  if (e.key === ' ') {
    e.preventDefault()
    ;(document.activeElement as HTMLElement | null)?.blur() // 避免空格同时触发聚焦中的按钮
    player.toggle()
  }
  if (e.key === 'b' || e.key === 'B') fxBtn.click()
  if ((e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.metaKey) app.toggleLike()
  if (stageT > 0.5 && e.key === 'ArrowLeft') offsetT += L.slot
  if (stageT > 0.5 && e.key === 'ArrowRight') offsetT -= L.slot
})
ui.back.addEventListener('click', backToWave)

// ---------------- 尺寸 ----------------
function resize() {
  const w = innerWidth, h = innerHeight
  if (!w || !h) return // 窗口最小化 / 面板隐藏时可能是 0×0：跳过，否则比例为 NaN 会污染所有平滑状态
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  L.visH = 2 * Z0 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
  L.visW = L.visH * camera.aspect
  L.rowW = Math.min(L.visW * 0.84, L.visH * 2.3)
  L.x0 = -L.rowW / 2
  L.slot = L.rowW / N
  L.amp = L.visH * 0.21
  L.cover = Math.min(L.visH * 0.34, L.visW * 0.27)
  L.barW = L.slot * (1 - GAP)
  U.uSlot.value = L.slot
  U.uX0.value = L.x0
  U.uRowW.value = L.rowW
  U.uAmp.value = L.amp
  U.uView.value.set(L.visW / 2, L.visH / 2)
  U.uShadow.value.set(L.visH * 0.008, -L.visH * 0.014)
  stageMesh.scale.set(L.visW * 1.05, L.visH * 1.05, 1)
}
addEventListener('resize', resize)
resize()

// ---------------- 主循环 ----------------
const corner = new THREE.Vector3()
const hidden = new Set<number>()

// 空闲降帧：没在播放、也没有任何操作超过 IDLE_MS，时间渐渐放慢到停止（开屏演示同时收成平缓的呼吸），
// 画面停稳 SETTLE 秒后主循环不再渲染；任何操作、播放状态变化、窗口重新可见都会立即唤醒
const IDLE_MS = 20000, SETTLE = 3
let lastInput = performance.now(), calm = 0, still = 0

function tick(now: number) {
  const dt = clamp((now - last) / 1000, 0, 1 / 30)
  last = now
  const idle = !player.playing && performance.now() - lastInput > IDLE_MS
  calm = clamp(calm + (idle ? dt / 2.5 : -dt / 0.5), 0, 1)
  still = calm >= 1 ? still + dt : 0
  t += dt * (1 - ease(calm))
  U.uTime.value = t
  intro = Math.min(1, intro + dt * 0.6)
  const introE = ease(intro)

  spectrum.calm = ease(calm)
  spectrum.update(t, dt)
  app.frame()

  stageLin = clamp(stageLin + (stageT > 0.5 ? dt : -dt) / 0.9, 0, 1)
  stage = ease(stageLin)
  U.uStage.value = stage

  // 拾取 & 状态
  const pk = pick()
  if (stageT < 0.5) {
    const want = barsT > 0.5 || stageLin > 0.02
    morph = damp(morph, want ? 1 : 0, want ? 4 : 2.4, dt)
    hovered2D = barsT > 0.5 && pk.inRegion && morph > 0.5 ? idFromU(pk.u) : null
    hovered = null
  } else {
    morph = damp(morph, 1, 5, dt)
    hovered2D = null
    const over = cardAt() // 鼠标在封面上时保持该封面，方便点击
    if (over) hovered = over.id
    else if (pk.inRegion) {
      pinned = null
      const cand = idFromU(pk.u)
      if (hovered === null || (cand !== hovered && wrapDist(pk.u, hovered) > 0.62)) hovered = cand
    } else hovered = pinned !== null && Math.abs(offset - offsetT) < L.slot ? pinned : null
  }
  offset = damp(offset, offsetT, 9, dt)

  // 平滑状态一旦出现 NaN 会永久残留：自愈
  if (!Number.isFinite(base + mean[0] + barV[0] + waveV[0] + barH[0] + waveH[0])) {
    base = 0.4
    for (const a of [mean, barV, waveV, barH, barHv, waveH, waveHv]) a.fill(0)
  }
  // 频谱 → 以"加权均值"为基线（而非 0），得到有正有负的信号
  let es = 0, ws = 0
  for (let i = 0; i < N; i++) {
    const xn = (barX(i) - L.x0) / L.rowW
    env[i] = Math.pow(Math.sin(Math.PI * clamp(xn, 0, 1)), 1.6)
    const jit = 0.8 + 0.4 * (0.5 + 0.5 * Math.sin(t * (1.7 + ((i * 0.618) % 1) * 2.2) + i * 2.4))
    const bass = 0.5 + 0.2 * Math.sin(t * 0.23) // 低频中心缓慢漂移，波形结构不固定
    raw[i] = spectrum.sample(Math.min(1, Math.abs(xn - bass) * 2.2)) * jit
    es += raw[i] * env[i]
    ws += env[i]
  }
  base = damp(base, es / ws, 1.2, dt)
  // 基线 = 全局均值与局部均值（慢速）的混合：持续的能量分布被抵消，节拍造成的起伏更明显
  for (let i = 0; i < N; i++) {
    let sum = 0
    for (let k = -8; k <= 8; k++) sum += raw[(i + k + N) % N]
    mean[i] = damp(mean[i], sum / 17, 1.5, dt)
  }
  for (let i = 0; i < N; i++) {
    const x = barX(i)
    const flow = 0.3 * Math.sin(x * 0.9 - t * 1.6) + 0.16 * Math.sin(x * 2.1 + t * 1.1)
    barT[i] = Math.tanh((raw[i] - lerp(base, mean[i], 0.5)) * 3.6 + flow) * L.amp * env[i] * introE
  }
  // 波形线用空间模糊后的信号，保持顺滑；音柱保留细节
  waveT.set(barT)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < N; i++) {
      const g = (k: number) => waveT[(i + k + N) % N]
      local[i] = (g(-2) + 4 * g(-1) + 6 * g(0) + 4 * g(1) + g(2)) / 16
    }
    waveT.set(local)
  }
  for (let i = 0; i < N; i++) {
    barV[i] = damp(barV[i], barT[i], Math.abs(barT[i]) > Math.abs(barV[i]) ? 18 : 10, dt)
    waveV[i] = damp(waveV[i], waveT[i] * 1.5, 12, dt)
  }
  spring(barH, barHv, barV, dt)
  spring(waveH, waveHv, waveV, dt)

  // 卡片
  for (const c of cards) if (c.active && c.id !== hovered) c.target = 0
  if (hovered !== null && stageT > 0.5) popCard(hovered)
  hidden.clear()
  for (const c of cards) if (c.active) { updateCard(c, dt); if (c.active) hidden.add(slotOf(c.id)) }
  updateBg(dt)

  // 聚焦：有音柱被指向时，其余音柱稍微变暗
  const fid = stageT > 0.5 ? hovered : hovered2D
  const fs = fid === null ? -1 : slotOf(fid)
  for (let i = 0; i < N; i++) {
    focus[i] = damp(focus[i], fs >= 0 && fs !== i ? 0.74 : 1, 8, dt)
    data.set([barV[i], barH[i], waveV[i], waveH[i]], i * 4)
    data.set([hidden.has(i) ? 1 : 0, focus[i], 0, 0], (N + i) * 4)
  }
  dataTex.needsUpdate = true
  U.uMorph.value = morph
  U.uOffset.value = offset

  // 封面信息
  const primary = cards.find((c) => c.active && c.id === hovered && c.p > 0.6)
  const ptr = primary && trackOf(primary.id)
  if (primary && ptr) {
    const M = player.list.tracks.length
    const key = `${primary.id}|${ptr.key}`
    if (key !== lastPrimary) {
      ui.lbNo.textContent = `No.${String(mod(primary.id, M) + 1).padStart(2, '0')} / ${M}`
      ui.lbTitle.textContent = ptr.title
      ui.lbAlbum.textContent = ptr.album || (ptr.source === 'local' ? '本地音乐' : '网易云音乐')
      ui.lbArtist.textContent = ptr.artist
      ui.lbDur.textContent = ptr.dur ? fmt(ptr.dur) : ''
      lastPrimary = key
    }
    const isCur = ptr.key === player.current?.key
    const cta = !isCur ? '点击播放' : player.loading ? '加载中…' : player.playing ? '正在播放 · 点击暂停' : '已暂停 · 点击继续'
    if (cta !== lastCta) { ui.lbCta.textContent = cta; lastCta = cta }
    ui.label.classList.toggle('playing', isCur && player.playing)
    primary.mesh.updateMatrix()
    const lw = ui.label.offsetWidth
    const sxOf = (sd: number) => {
      corner.set(0.5 * sd, 0.5, 0.5).applyMatrix4(primary.mesh.matrix).project(camera)
      return (corner.x * 0.5 + 0.5) * innerWidth + sd * 28
    }
    let side = primary.side
    let sx = sxOf(side)
    if ((side > 0 && sx + lw > innerWidth - 20) || (side < 0 && sx - lw < 20)) sx = sxOf((side = -side))
    const sy = clamp((-corner.y * 0.5 + 0.5) * innerHeight, 80, innerHeight - 300)
    ui.label.style.transform = `translate(${sx}px, ${sy}px) translateX(${side > 0 ? 0 : -100}%)`
    ui.label.classList.add('show')
  } else {
    ui.label.classList.remove('show')
    lastPrimary = ''
  }

  // 可点击处给出反馈：鼠标在波形区域内时，波形线在鼠标所在的横向位置微微加粗 + 手型光标
  const lineHover = barsT < 0.5 && stageT < 0.5 && pk.inWave
  U.uNear.value = damp(U.uNear.value, lineHover ? 1 : 0, 10, dt)
  if (lineHover) U.uCursor.value = hit.x
  const clickable = lineHover || (barsT > 0.5 && stageT < 0.5 && pk.inRegion) || (stageT > 0.5 && (pk.inRegion || !!cardAt()))
  if (canvas.style.cursor !== (clickable ? 'pointer' : '')) canvas.style.cursor = clickable ? 'pointer' : ''

  ui.back.classList.toggle('show', barsT > 0.5 || stageT > 0.5)
  setHint(stageT > 0.5 ? 'stage' : barsT > 0.5 ? 'bars' : !player.list.tracks.length && !app.booting ? 'empty' : 'wave')
  renderer.render(scene, camera)
}

let frozen = false // 开发调试：冻结实时帧，便于逐帧检查动画
let running = true, frames = 0
function frame(now: number) {
  if (!frozen) tick(now)
  frames++
  running = still < SETTLE
  if (running) requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
function wake() {
  lastInput = performance.now()
  if (running) return
  running = true
  still = 0 // 第一帧 dt 可能为 0，不清零会立刻再次判定"已停稳"
  last = performance.now()
  requestAnimationFrame(frame)
}
for (const ev of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'resize']) addEventListener(ev, wake, { passive: true })
document.addEventListener('visibilitychange', wake)
player.on(wake)

// 开发调试：浏览器面板隐藏时 rAF 不运行，可用 __dbg.run(秒, ndcX, ndcY) 手动推进
if (import.meta.env.DEV) {
  let simNow = 0
  const run = (sec: number, mx?: number, my?: number) => {
    if (mx !== undefined) { ndc.set(mx, my!); mouseInside = true }
    simNow = Math.max(simNow, last)
    for (let i = 0; i < sec * 60; i++) tick((simNow += 1000 / 60))
  }
  Object.assign(window, { __dbg: { run, freeze: (f: boolean) => { frozen = f }, onClick, cards, player, locate, get frames() { return frames }, get idle() { return { running, calm, still, sinceInput: performance.now() - lastInput } }, get state() { return { barsT, stageT, morph, hovered, offset, bgK, bgDir, bgEnabled, bgCur: bgCur?.title, bgFade: bgCurFade, palMix: U.uPalMix.value, pal: U.uPal.value.map((v) => v.toArray().map((c) => +c.toFixed(2))) } }, waveYAt } })
}
