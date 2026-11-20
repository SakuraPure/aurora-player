// 音频引擎 + 频谱。同一个 <audio> 元素常驻并接入 AnalyserNode；
// 尚未播放过任何歌曲时输出程序化模拟的节拍频谱（开屏演示），暂停时安静呼吸。

const BANDS = 64

export class Spectrum {
  bands = new Float32Array(BANDS) // 0 = 低频, 1 = 高频, 值 0..1
  level = 0
  /** 0..1：空闲时开屏演示逐渐收成暂停时的平缓呼吸 */
  calm = 0
  readonly el = new Audio()
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private freq: Uint8Array<ArrayBuffer> | null = null

  constructor() {
    this.el.crossOrigin = 'anonymous' // 网易云 CDN 带 CORS 头，分析器才能读到数据
    this.el.preload = 'auto'
  }

  get loaded() { return !!this.el.getAttribute('src') }
  get playing() { return !this.el.paused }

  private graph() {
    if (this.ctx) return
    this.ctx = new AudioContext()
    const src = this.ctx.createMediaElementSource(this.el)
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.analyser.smoothingTimeConstant = 0.72
    this.freq = new Uint8Array(this.analyser.frequencyBinCount)
    src.connect(this.analyser)
    this.analyser.connect(this.ctx.destination)
  }

  /** at：换源后从该秒继续（切换音质时用） */
  async play(url?: string, at = 0) {
    this.graph()
    if (url !== undefined) {
      this.el.src = url
      if (at > 0) this.el.currentTime = at // 元数据加载前设置 = 起播位置
    }
    await this.ctx!.resume()
    await this.el.play()
  }
  pause() { this.el.pause() }

  sample(b: number) {
    const f = Math.min(Math.max(b, 0), 1) * (BANDS - 1)
    const i = Math.floor(f)
    const a = this.bands[i], c = this.bands[Math.min(i + 1, BANDS - 1)]
    return a + (c - a) * (f - i)
  }

  update(t: number, dt: number) {
    const real = this.analyser && this.playing
    if (real) this.analyser!.getByteFrequencyData(this.freq!)
    const demo = !this.loaded
    const P = 60 / 98 // BPM 98
    const ph = (t % P) / P
    const kick = Math.exp(-ph * 6.5)
    const snare = Math.exp(-(((t + P) % (2 * P)) / P) * 8)
    const hat = Math.exp(-(((t + P / 4) % (P / 2)) / (P / 2)) * 10)
    let sum = 0
    for (let k = 0; k < BANDS; k++) {
      const b = k / (BANDS - 1)
      let v: number
      const quiet = 0.06 + 0.04 * Math.sin(t * 1.2 + b * 6)
      if (real) {
        // 对数频率映射 30Hz – 15kHz
        const sr = this.ctx!.sampleRate, n = this.freq!.length
        const hz = 30 * Math.pow(500, b)
        const idx = Math.min(n - 1, Math.round((hz / (sr / 2)) * n))
        v = Math.pow(this.freq![idx] / 255, 1.4) * (1 + b * 0.6)
      } else if (demo) {
        const mel = 0.5 + 0.5 * Math.sin(t * 0.9 + b * 7 + Math.sin(t * 0.37 + b * 3) * 2)
        const shimmer = 0.5 + 0.5 * Math.sin(t * 5.3 + k * 1.9) * Math.sin(t * 3.1 - k * 0.7)
        v =
          Math.pow(1 - b, 1.6) * (0.32 + 0.6 * kick) +
          Math.exp(-Math.pow((b - 0.38) / 0.16, 2)) * (0.25 + 0.45 * snare) +
          (0.18 + 0.32 * mel) * (1 - b * 0.55) +
          b * b * 0.35 * hat +
          0.08 * shimmer
        v = v * 0.82 + (quiet - v * 0.82) * this.calm
      } else {
        v = quiet
      }
      v = Math.min(v, 1.15)
      const cur = this.bands[k]
      this.bands[k] = cur + (v - cur) * (1 - Math.exp(-dt * (v > cur ? 22 : 6)))
      sum += this.bands[k]
    }
    this.level += (sum / BANDS - this.level) * (1 - Math.exp(-dt * 4))
  }
}
