// 曲库模型 + 本地音乐导入（读取标签与内嵌封面）+ LRC 歌词解析
import { parseBlob } from 'music-metadata'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'

export interface Track {
  key: string
  source: 'local' | 'ncm'
  title: string
  artist: string
  album: string
  dur: number // 秒，0 = 未知
  cover?: string // 图片地址；无则用程序化封面
  file?: File // 网页版：拖入 / 选择的文件
  path?: string // 桌面版：磁盘路径（经 media 协议流式播放）
  ncmId?: number
  vip?: boolean
}
export interface TrackList { id: string; name: string; tracks: Track[] }

export const fmt = (s: number) => (isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00')

const AUDIO_EXT = /\.(mp3|flac|m4a|aac|ogg|oga|opus|wav|webm)$/i
export const isAudio = (f: File) => AUDIO_EXT.test(f.name) || f.type.startsWith('audio/')

/** 拖拽进来的文件 / 文件夹（递归）。必须在 drop 事件里同步调用 */
export function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e)
  if (!entries.length) return Promise.resolve([...dt.files])
  const out: File[] = []
  const walk = async (e: FileSystemEntry): Promise<void> => {
    if (e.isFile) {
      out.push(await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej)))
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader()
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) break
        for (const c of batch) await walk(c)
      }
    }
  }
  return Promise.all(entries.map(walk)).then(() => out)
}

const coverUrls = new Map<string, string>()
export async function readLocal(files: File[], onProgress?: (done: number, total: number) => void): Promise<Track[]> {
  const list = files.filter(isAudio).sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, 'zh'))
  const out: Track[] = []
  for (let i = 0; i < list.length; i++) {
    const f = list[i]
    const key = `local:${f.webkitRelativePath || f.name}:${f.size}`
    const base = f.name.replace(/\.[^.]+$/, '')
    const tr: Track = { key, source: 'local', file: f, title: base, artist: '本地音乐', album: '', dur: 0 }
    // 文件名 "歌手 - 歌名" 作为兜底
    const dash = base.split(/\s+-\s+/)
    if (dash.length === 2) Object.assign(tr, { artist: dash[0], title: dash[1] })
    try {
      const { common, format } = await parseBlob(f, { duration: false })
      if (common.title) tr.title = common.title
      if (common.artist || common.artists?.length) tr.artist = common.artists?.join(' / ') || common.artist!
      tr.album = common.album || ''
      tr.dur = format.duration || 0
      const pic = common.picture?.[0]
      if (pic) {
        let url = coverUrls.get(key)
        if (!url) coverUrls.set(key, (url = URL.createObjectURL(new Blob([pic.data as BlobPart], { type: pic.format }))))
        tr.cover = url
      }
    } catch { /* 标签损坏时用文件名 */ }
    out.push(tr)
    onProgress?.(i + 1, list.length)
  }
  return out
}

// ---------- 桌面版：扫描记住的文件夹 / 文件（src-tauri/src/library.rs） ----------
interface LocalRaw { path: string; title: string; artist: string; album: string; dur: number; cover: boolean }
export async function scanPaths(paths: string[]): Promise<Track[]> {
  const list = await invoke<LocalRaw[]>('local_scan', { paths })
  return list.map((r) => ({
    key: `local:${r.path}`, source: 'local', path: r.path, title: r.title, artist: r.artist, album: r.album, dur: r.dur,
    cover: r.cover ? convertFileSrc(r.path, 'cover') : undefined,
  }))
}
export const mediaUrl = (path: string) => convertFileSrc(path, 'media')

export interface LrcLine { t: number; text: string; tr?: string }

/** 把翻译歌词按时间戳挂到原文行上（网易云两者时间戳一致，容差 0.3 秒） */
export function withTranslation(orig: LrcLine[], trans: LrcLine[]): LrcLine[] {
  if (!trans.length) return orig
  let j = 0
  for (const line of orig) {
    while (j < trans.length - 1 && trans[j + 1].t <= line.t + 0.3) j++
    const c = trans[j]
    if (c && Math.abs(c.t - line.t) <= 0.3 && c.text && c.text !== line.text) line.tr = c.text
  }
  return orig
}
export function parseLrc(src: string): LrcLine[] {
  const out: LrcLine[] = []
  for (const line of src.split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)]
    if (!stamps.length) continue
    const text = line.slice(stamps[stamps.length - 1].index! + stamps[stamps.length - 1][0].length).trim() // 空行 = 间奏，清空显示
    for (const s of stamps) out.push({ t: +s[1] * 60 + parseFloat(s[2].replace(':', '.')), text })
  }
  return out.sort((a, b) => a.t - b.t)
}
