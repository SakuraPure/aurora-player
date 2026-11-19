// 播放控制：当前列表（= 音柱展示的曲库 = 播放队列）、上一首/下一首、播放模式、音量、歌词、系统媒体控件
import { Spectrum } from './audio'
import * as ncm from './ncm'
import { mediaUrl, parseLrc, withTranslation, type LrcLine, type Track, type TrackList } from './library'

export type Mode = 'list' | 'shuffle' | 'one'
const MODES: Mode[] = ['list', 'shuffle', 'one']

export class Player {
  readonly spectrum = new Spectrum()
  readonly el = this.spectrum.el
  list: TrackList = { id: '', name: '', tracks: [] }
  current: Track | null = null
  mode: Mode = (localStorage.getItem('player.mode') as Mode) || 'list'
  lyrics: LrcLine[] = []
  loading = false
  toast: (msg: string) => void = () => {}
  private subs = new Set<() => void>()
  private token = 0
  private fails = 0
  private blobUrl = ''
  private started = false // 当前歌曲已成功开始播放
  private retried = false

  constructor() {
    this.el.volume = +(localStorage.getItem('player.volume') ?? 0.8)
    this.el.addEventListener('ended', () => {
      if (this.mode === 'one') { this.el.currentTime = 0; this.spectrum.play().catch(() => {}) } else this.next(true)
    })
    // 播放中途出错（多为网易云地址过期）：重新取一次地址并回到原位置；加载阶段的错误由 play() 自己处理
    this.el.addEventListener('error', () => {
      const tr = this.current
      if (!tr || !this.started) return
      this.started = false
      if (tr.source === 'ncm' && !this.retried) {
        this.retried = true
        const at = this.time
        this.play(tr, true).then(() => this.seek(at))
      } else {
        this.toast(`无法播放：${tr.title}`)
        this.skipAfterFail()
      }
    })
    for (const ev of ['play', 'pause', 'loadedmetadata', 'volumechange']) this.el.addEventListener(ev, () => this.emit())

    const ms = navigator.mediaSession
    if (ms) {
      ms.setActionHandler('play', () => this.toggle(true))
      ms.setActionHandler('pause', () => this.toggle(false))
      ms.setActionHandler('previoustrack', () => this.prev())
      ms.setActionHandler('nexttrack', () => this.next())
      ms.setActionHandler('seekto', (d) => d.seekTime !== undefined && this.seek(d.seekTime))
    }
  }

  on(fn: () => void) { this.subs.add(fn) }
  private emit() { this.subs.forEach((f) => f()) }

  get playing() { return this.spectrum.playing }
  get time() { return this.el.currentTime || 0 }
  get duration() { return isFinite(this.el.duration) && this.el.duration > 0 ? this.el.duration : this.current?.dur || 0 }
  get volume() { return this.el.volume }
  indexOf(tr: Track | null = this.current) { return tr ? this.list.tracks.findIndex((t) => t.key === tr.key) : -1 }

  setList(list: TrackList) {
    this.list = list
    this.emit()
  }

  async play(tr: Track, auto = false) {
    const my = ++this.token
    if (tr.key !== this.current?.key) this.retried = false
    this.started = false
    this.current = tr
    this.lyrics = []
    this.loading = true
    this.emit()
    try {
      let url: string
      if (tr.source === 'local' && tr.path) {
        url = mediaUrl(tr.path)
      } else if (tr.source === 'local') {
        if (this.blobUrl) URL.revokeObjectURL(this.blobUrl)
        url = this.blobUrl = URL.createObjectURL(tr.file!)
      } else {
        const r = await ncm.songUrl(tr.ncmId!)
        if (my !== this.token) return
        if (!r.url) throw new Error(tr.vip || ncm.loggedIn() ? '需要会员或暂无版权' : '需要登录或暂无版权')
        url = r.url
        if (r.trial) this.toast('仅返回了试听片段 · 登录会员账号可播放完整版')
        ncm.lyric(tr.ncmId!).then((l) => {
          if (my !== this.token) return
          this.lyrics = withTranslation(parseLrc(l.lrc), parseLrc(l.tlrc))
          this.emit()
        }).catch(() => {})
      }
      await this.spectrum.play(url)
      if (my !== this.token) return
      this.fails = 0
      this.started = true
    } catch (e) {
      if (my !== this.token) return
      const err = e as Error
      this.loading = false
      this.emit()
      if (err.name === 'NotAllowedError') return this.toast('浏览器阻止了自动播放 · 点击播放键继续')
      if (err.name === 'AbortError') return
      this.toast(`${tr.title}：${err.message || '播放失败'}`)
      if (auto) this.skipAfterFail()
      return
    }
    this.loading = false
    this.updateSession()
    this.emit()
    if (this.list.more && this.indexOf() >= this.list.tracks.length - 2) this.extend() // 电台：提前取下一批
  }

  /** 电台式列表（私人漫游）：取下一批追加到列表末尾（去重） */
  private extending: Promise<void> | null = null
  private extend() {
    const list = this.list
    if (!list.more) return Promise.resolve()
    return (this.extending ??= list.more()
      .then((add) => {
        const known = new Set(list.tracks.map((t) => t.key))
        list.tracks.push(...add.filter((t) => !known.has(t.key)))
        this.emit()
      })
      .catch(() => {})
      .finally(() => { this.extending = null }))
  }

  private skipAfterFail() {
    if (++this.fails < Math.min(6, this.list.tracks.length)) setTimeout(() => this.next(true), 400)
    else this.fails = 0
  }

  toggle(force?: boolean) {
    const want = force ?? !this.playing
    if (!this.current) { const first = this.list.tracks[0]; if (want && first) this.play(first); return }
    if (want) this.spectrum.play().catch(() => this.play(this.current!))
    else this.spectrum.pause()
  }

  async next(auto = false) {
    const list = this.list
    if (list.more && this.indexOf() >= list.tracks.length - 1) await this.extend() // 电台播到末尾：先取下一批
    if (list !== this.list) return
    const ts = list.tracks
    if (!ts.length) return
    const i = this.indexOf()
    let j = (i + 1) % ts.length
    if (this.mode === 'shuffle' && !list.more && ts.length > 1) do j = Math.floor(Math.random() * ts.length); while (j === i)
    this.play(ts[j], auto)
  }
  prev() {
    const ts = this.list.tracks
    if (this.time > 3 || !ts.length) return this.seek(0)
    const i = this.indexOf()
    this.play(ts[i < 0 ? 0 : (i - 1 + ts.length) % ts.length])
  }
  seek(sec: number) {
    if (this.spectrum.loaded) this.el.currentTime = Math.max(0, Math.min(sec, this.duration - 0.2))
  }
  setVolume(v: number) {
    this.el.volume = Math.max(0, Math.min(1, v))
    localStorage.setItem('player.volume', String(this.el.volume))
  }
  cycleMode() {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]
    localStorage.setItem('player.mode', this.mode)
    this.emit()
    return this.mode
  }
  /** 当前时间对应的歌词行下标 */
  lyricIndex(t = this.time) {
    let lo = 0, hi = this.lyrics.length - 1, ans = -1
    while (lo <= hi) { const m = (lo + hi) >> 1; if (this.lyrics[m].t <= t + 0.15) { ans = m; lo = m + 1 } else hi = m - 1 }
    return ans
  }

  private updateSession() {
    const tr = this.current
    if (!navigator.mediaSession || !tr) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: tr.title, artist: tr.artist, album: tr.album,
      artwork: tr.cover ? [{ src: tr.cover, sizes: '512x512' }] : [],
    })
  }
}
