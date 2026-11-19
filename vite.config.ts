import { defineConfig, type Connect, type Plugin } from 'vite'
import { createRequire } from 'node:module'

// 网易云音乐：在本地开发/预览服务器上挂一个极薄的中间层，调用 NeteaseCloudMusicApi（非官方接口，仅供个人学习使用）。
// 前端 POST /api/ncm/<接口名>，登录 cookie 由前端保存并通过 x-ncm-cookie 头带上。
const ALLOW = new Set([
  'cloudsearch', 'song_detail', 'song_url_v1', 'lyric', 'playlist_track_all', 'recommend_songs', 'toplist',
  'personalized', 'top_playlist', 'top_playlist_highquality', 'recommend_resource', 'personal_fm',
  'login_qr_key', 'login_qr_create', 'login_qr_check', 'user_account', 'user_playlist', 'logout',
])
// 这些参数会改变请求的去向或身份，不接受前端传入
const STRIP = ['proxy', 'realIP', 'randomCNIP', 'domain', 'headers', 'ua', 'e_r', 'crypto', 'cookie']

function ncm(): Plugin {
  const require = createRequire(import.meta.url)
  let api: Record<string, (q: object) => Promise<{ status?: number; body: unknown }>> | null = null

  const handle: Connect.NextHandleFunction = async (req, res, next) => {
    const m = req.url?.match(/^\/api\/ncm\/(\w+)/)
    if (!m) return next()
    const fn = m[1]
    const send = (status: number, body: unknown) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST' || !ALLOW.has(fn)) return send(404, { code: 404, message: 'unknown api' })

    let raw = ''
    for await (const chunk of req) raw += chunk
    let params: Record<string, unknown> = {}
    try { params = raw ? JSON.parse(raw) : {} } catch { return send(400, { code: 400, message: 'bad json' }) }
    for (const k of STRIP) delete params[k]

    api ??= require('NeteaseCloudMusicApi')
    const query = { ...params, cookie: String(req.headers['x-ncm-cookie'] || ''), timestamp: Date.now() }
    if (fn === 'song_url_v1') Object.assign(query, { crypto: 'weapi' }) // 默认 eapi 通道在匿名状态下会被风控拦截
    try {
      const out = await api![fn](query)
      send(out.status || 200, out.body)
    } catch (e) {
      const err = e as { status?: number; body?: unknown; message?: string }
      send(err.status || 502, err.body ?? { code: 502, message: String(err.message || e) })
    }
  }

  return {
    name: 'ncm-api',
    configureServer: (s) => { s.middlewares.use(handle) },
    configurePreviewServer: (s) => { s.middlewares.use(handle) },
  }
}

export default defineConfig({
  plugins: [ncm()],
  clearScreen: false,
  server: { watch: { ignored: ['**/src-tauri/**'] } }, // 不监听 Rust 构建产物
})
