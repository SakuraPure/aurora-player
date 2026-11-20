// 网易云音乐客户端（非官方接口）：
//   网页版 → 本地开发服务器中间层（vite.config.ts）
//   桌面版 → Tauri 的 Rust 实现（src-tauri/src/ncm.rs），接口名与参数相同
import type { Track, TrackList } from './library'

const COOKIE_KEY = 'ncm.cookie'
let cookie = localStorage.getItem(COOKIE_KEY) || ''
export const inApp = '__TAURI_INTERNALS__' in window

export interface Profile { userId: number; nickname: string; avatarUrl: string }
export interface PlaylistInfo { id: number; name: string; count: number; cover: string; creator?: string }

async function call<T = any>(fn: string, params: Record<string, unknown> = {}): Promise<T> {
  if (inApp) {
    const { invoke } = await import('@tauri-apps/api/core')
    try {
      return await invoke<T>('ncm_call', { fnName: fn, params, cookie })
    } catch (e) {
      const msg = String(e)
      if (/（301）$/.test(msg)) suspect() // ncm.rs 的错误格式："<网易云的提示>（<code>）"
      throw new Error(msg)
    }
  }
  const r = await fetch(`/api/ncm/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ncm-cookie': cookie },
    body: JSON.stringify(params),
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) {
    if ((body?.code ?? r.status) === 301) suspect()
    throw new Error(body?.message || body?.msg || `网易云接口错误 ${r.status}`)
  }
  return body
}

// ---------- 登录失效：本地还存着登录 cookie，但网易云已不认（在别处退出、改密码、长期未用等） ----------
let onExpire: (() => void) | null = null
/** 登录失效时回调：界面提示重新扫码 */
export function onExpired(fn: () => void) { onExpire = fn }
function expire() {
  if (!loggedIn()) return
  cookie = ''
  localStorage.removeItem(COOKIE_KEY)
  liked.clear()
  onExpire?.()
}
// 带着登录 cookie 却收到 301（需要登录）：先用 user_account 确认，确实失效才清掉，避免个别接口误报把人登出
let verifying = false
function suspect() {
  if (!loggedIn() || verifying) return
  verifying = true
  account().catch(() => {}).finally(() => { verifying = false })
}

const https = (u?: string) => (u ? u.replace(/^http:\/\//, 'https://') : '')

// 新接口用 ar / al / dt，私人漫游等老接口用 artists / album / duration
interface RawAlbum { name: string; picUrl?: string }
interface RawSong {
  id: number; name: string; fee?: number
  ar?: { name: string }[]; al?: RawAlbum; dt?: number
  artists?: { name: string }[]; album?: RawAlbum; duration?: number
}
export function toTrack(s: RawSong): Track {
  const al = s.al || s.album
  return {
    key: `ncm:${s.id}`,
    source: 'ncm',
    ncmId: s.id,
    title: s.name,
    artist: (s.ar || s.artists || []).map((a) => a.name).filter(Boolean).join(' / ') || '未知歌手',
    album: al?.name || '',
    dur: (s.dt || s.duration || 0) / 1000,
    cover: al?.picUrl ? `${https(al.picUrl)}?param=512y512` : undefined,
    vip: s.fee === 1,
  }
}
const toPl = (p: any): PlaylistInfo => ({
  id: p.id, name: p.name, count: p.trackCount, cover: https(p.coverImgUrl || p.picUrl), creator: p.creator?.nickname,
})

export const loggedIn = () => /MUSIC_U=/.test(cookie)

// ---------- 登录（扫码） ----------
export async function qrStart() {
  const k = await call('login_qr_key', {})
  const key: string = k.data.unikey
  const c = await call('login_qr_create', { key, qrimg: true })
  return { key, img: c.data.qrimg as string }
}
/** 800 过期 · 801 等待扫码 · 802 已扫码待确认 · 803 成功 */
export async function qrCheck(key: string): Promise<number> {
  const r = await call('login_qr_check', { key })
  if (r.code === 803 && r.cookie) {
    cookie = r.cookie
    localStorage.setItem(COOKIE_KEY, cookie)
  }
  return r.code
}
export async function account(): Promise<Profile | null> {
  if (!loggedIn()) return null
  const r = await call('user_account')
  if (!r.profile) { expire(); return null } // 网络错误会抛出，不会走到这里：只有网易云明确说"没登录"才算失效
  const { userId, nickname, avatarUrl } = r.profile
  return { userId, nickname, avatarUrl: https(avatarUrl) }
}
export function logout() {
  if (cookie) call('logout').catch(() => {})
  cookie = ''
  localStorage.removeItem(COOKIE_KEY)
  liked.clear()
}

// ---------- 红心（加入 / 移出「我喜欢的音乐」） ----------
const liked = new Set<number>()
export const isLiked = (id?: number) => !!id && liked.has(id)
/** 登录后取一次红心歌曲列表：在官方 App 或别的设备上红心过的歌也显示为已红心 */
export async function loadLiked(uid: number) {
  const r = await call('likelist', { uid })
  liked.clear()
  for (const id of r.ids || []) liked.add(id)
}
/** 先改本地状态（界面立即变化），请求失败时恢复并抛出 */
export async function like(id: number, on: boolean) {
  const flip = (v: boolean) => (v ? liked.add(id) : liked.delete(id))
  flip(on)
  // 网页版的接口库只把字符串 'false' 当作取消，布尔 false 会被当成红心
  try { await call('like', { id, like: String(on) }) } catch (e) { flip(!on); throw e }
}

// ---------- 歌单 / 搜索 ----------
export const CHARTS: PlaylistInfo[] = [
  { id: 3778678, name: '热歌榜', count: 0, cover: '' },
  { id: 3779629, name: '新歌榜', count: 0, cover: '' },
  { id: 19723756, name: '飙升榜', count: 0, cover: '' },
]
/** 补全榜单封面与歌曲数 */
export async function loadChartInfo() {
  const r = await call('toplist')
  for (const c of CHARTS) {
    const hit = (r.list || []).find((x: any) => x.id === c.id)
    if (hit) Object.assign(c, { cover: https(hit.coverImgUrl), count: hit.trackCount })
  }
}
export async function userPlaylists(uid: number): Promise<PlaylistInfo[]> {
  const r = await call('user_playlist', { uid, limit: 60 })
  return (r.playlist || []).map(toPl)
}
export async function playlist(id: number, name: string): Promise<TrackList> {
  const r = await call('playlist_track_all', { id, limit: 500 })
  return { id: `ncm:pl:${id}`, name, tracks: (r.songs || []).map(toTrack) }
}
export async function daily(): Promise<TrackList> {
  const r = await call('recommend_songs')
  return { id: 'ncm:daily', name: '每日推荐', tracks: (r.data?.dailySongs || []).map(toTrack) }
}
export async function search(keywords: string): Promise<Track[]> {
  const r = await call('cloudsearch', { keywords, limit: 60 })
  return (r.result?.songs || []).map(toTrack)
}

// ---------- 发现：推荐 / 分类 / 精品歌单、歌单搜索 ----------
/** 私人雷达：固定歌单 id，登录后内容按个人口味生成 */
export const RADAR_ID = 3136952023
/** 推荐歌单：登录后用每日推荐歌单，否则用通用推荐 */
export async function recommendPlaylists(): Promise<PlaylistInfo[]> {
  if (loggedIn()) {
    const r = await call('recommend_resource').catch(() => null)
    if (r?.recommend?.length) return r.recommend.map(toPl)
  }
  const r = await call('personalized', { limit: 30 })
  return (r.result || []).map(toPl)
}
export const CATS = ['全部', '华语', '欧美', '日语', '韩语', '粤语', '流行', '摇滚', '民谣', '电子', '说唱', '轻音乐', '古风', 'ACG', '影视原声', '爵士', '古典']
/** 分类歌单（含云音乐官方歌单与用户创建的歌单），按热度 */
export async function categoryPlaylists(cat: string, offset = 0): Promise<{ list: PlaylistInfo[]; more: boolean }> {
  const r = await call('top_playlist', { cat, offset, limit: 40, order: 'hot' })
  return { list: (r.playlists || []).map(toPl), more: !!r.more }
}
/** 精品歌单：before = 上一页最后一个歌单的更新时间 */
export async function highQualityPlaylists(cat: string, before = 0): Promise<{ list: PlaylistInfo[]; more: boolean; before: number }> {
  const r = await call('top_playlist_highquality', { cat, before, limit: 40 })
  return { list: (r.playlists || []).map(toPl), more: !!r.more, before: r.lasttime || 0 }
}
export async function searchPlaylists(keywords: string, offset = 0): Promise<{ list: PlaylistInfo[]; more: boolean }> {
  const r = await call('cloudsearch', { keywords, type: 1000, offset, limit: 40 })
  const list = (r.result?.playlists || []).map(toPl)
  return { list, more: offset + list.length < (r.result?.playlistCount || 0) }
}

// ---------- 私人漫游：一次取几首，快播完时由播放器继续取 ----------
async function fmBatch(): Promise<Track[]> {
  const r = await call('personal_fm')
  return (r.data || []).map(toTrack)
}
export async function fm(): Promise<TrackList> {
  return { id: 'ncm:fm', name: '私人漫游', tracks: await fmBatch(), more: fmBatch }
}

// ---------- 播放地址 / 歌词 ----------
// 音质：请求的档位不可用时（未登录 / 非会员 / 歌曲本身没有），网易云自动降到可用的最高档，并在 level 里返回实际档位
export const LEVELS = [
  { id: 'standard', name: '标准', note: '128k' },
  { id: 'higher', name: '较高', note: '192k' },
  { id: 'exhigh', name: '极高', note: '320k' },
  { id: 'lossless', name: '无损', note: 'FLAC' },
  { id: 'hires', name: 'Hi-Res', note: '24bit FLAC' },
  { id: 'jymaster', name: '超清母带', note: 'SVIP' },
] as const
export type Level = (typeof LEVELS)[number]['id']
export const levelName = (id: string) => LEVELS.find((l) => l.id === id)?.name ?? id
export const levelRank = (id: string) => LEVELS.findIndex((l) => l.id === id)
export interface SongUrl { url: string; trial: boolean; level: string; br: number; type: string }

/** 地址有时效，播放时现取。trial = 只返回了试听片段 */
export async function songUrl(id: number, level: Level): Promise<SongUrl> {
  const r = await call('song_url_v1', { id, level })
  const d = r.data?.[0]
  return { url: https(d?.url), trial: !!d?.freeTrialInfo, level: d?.level || '', br: d?.br || 0, type: (d?.type || '').toLowerCase() }
}
/** 原文歌词 + 中文翻译（外语歌才有翻译） */
export async function lyric(id: number): Promise<{ lrc: string; tlrc: string }> {
  const r = await call('lyric', { id })
  return { lrc: r.lrc?.lyric || '', tlrc: r.tlyric?.lyric || '' }
}

// 开发调试：模拟登录失效（塞一个网易云不认的 cookie）
if (import.meta.env.DEV) Object.assign(window, { __ncm: { call, setCookie: (c: string) => { cookie = c }, get cookie() { return cookie } } })
