// 网易云音乐客户端：经本地中间层（vite.config.ts）调用非官方接口。
import type { Track, TrackList } from './library'

const COOKIE_KEY = 'ncm.cookie'
let cookie = localStorage.getItem(COOKIE_KEY) || ''

export interface Profile { userId: number; nickname: string; avatarUrl: string }
export interface PlaylistInfo { id: number; name: string; count: number; cover: string }

async function call<T = any>(fn: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`/api/ncm/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ncm-cookie': cookie },
    body: JSON.stringify(params),
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body?.message || body?.msg || `网易云接口错误 ${r.status}`)
  return body
}

const https = (u?: string) => (u ? u.replace(/^http:\/\//, 'https://') : '')

interface RawSong { id: number; name: string; ar?: { name: string }[]; al?: { name: string; picUrl?: string }; dt?: number; fee?: number }
export function toTrack(s: RawSong): Track {
  return {
    key: `ncm:${s.id}`,
    source: 'ncm',
    ncmId: s.id,
    title: s.name,
    artist: (s.ar || []).map((a) => a.name).filter(Boolean).join(' / ') || '未知歌手',
    album: s.al?.name || '',
    dur: (s.dt || 0) / 1000,
    cover: s.al?.picUrl ? `${https(s.al.picUrl)}?param=512y512` : undefined,
    vip: s.fee === 1,
  }
}

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
  if (!r.profile) { logout(); return null }
  const { userId, nickname, avatarUrl } = r.profile
  return { userId, nickname, avatarUrl: https(avatarUrl) }
}
export function logout() {
  if (cookie) call('logout').catch(() => {})
  cookie = ''
  localStorage.removeItem(COOKIE_KEY)
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
  return (r.playlist || []).map((p: any) => ({ id: p.id, name: p.name, count: p.trackCount, cover: https(p.coverImgUrl) }))
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

// ---------- 播放地址 / 歌词 ----------
/** 地址有时效，播放时现取。trial = 只返回了试听片段 */
export async function songUrl(id: number): Promise<{ url: string; trial: boolean }> {
  const r = await call('song_url_v1', { id, level: loggedIn() ? 'exhigh' : 'standard' })
  const d = r.data?.[0]
  return { url: https(d?.url), trial: !!d?.freeTrialInfo }
}
/** 原文歌词 + 中文翻译（外语歌才有翻译） */
export async function lyric(id: number): Promise<{ lrc: string; tlrc: string }> {
  const r = await call('lyric', { id })
  return { lrc: r.lrc?.lyric || '', tlrc: r.tlyric?.lyric || '' }
}
