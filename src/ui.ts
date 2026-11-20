// DOM 界面：曲库面板（网易云扫码登录 / 搜索 / 歌单，本地导入）、底部播放器、歌词、提示
import * as ncm from './ncm'
import { fmt, filesFromDrop, readLocal, scanPaths, type Track, type TrackList } from './library'
import { coverSrc } from './covers'
import type { Player } from './player'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const LAST_KEY = 'lib.last'

export interface UIHooks {
  /** 在音柱中定位到列表第 index 首 */
  locate(index: number): void
}

export function initUI(player: Player, hooks: UIHooks) {
  const el = {
    libBtn: $('lib-btn'), libName: $('lib-name'), libCount: $('lib-count'),
    panel: $('panel'), sources: $('pn-sources'), listView: $('pn-list'),
    account: $('pn-account'), qr: $('pn-qr'), qrImg: $<HTMLImageElement>('pn-qr-img'), qrMsg: $('pn-qr-msg'),
    search: $<HTMLFormElement>('pn-search'), q: $<HTMLInputElement>('pn-q'), lists: $('pn-lists'), local: $('pn-local'),
    listName: $('pn-list-name'), listCount: $('pn-list-count'), tracks: $('pn-tracks'), qmode: $('pn-qmode'),
    filter: $<HTMLInputElement>('pn-filter'),
    plsView: $('pn-pls'), plsName: $('pn-pls-name'), chips: $('pn-chips'), plsList: $('pn-pls-list'),
    inFolder: $<HTMLInputElement>('in-folder'), inFiles: $<HTMLInputElement>('in-files'), folders: $('pn-folders'), note: $('pn-note'),
    lyric: $('lyric'), toast: $('toast'), drop: $('drop'),
    img: $<HTMLImageElement>('np-img'), title: $('np-title'), artist: $('np-artist'), btn: $('np-btn'),
    cur: $('np-cur'), dur: $('np-dur'), seek: $('np-track'), fill: $('np-fill'), mode: $('np-mode'),
    vol: $('np-vtrack'), vfill: $('np-vfill'), mute: $('np-mute'), qbtn: $('np-q'), qmenu: $('np-qmenu'),
  }

  // ---------------- 提示 ----------------
  let toastTimer = 0
  const toast = (msg: string, ms = 2600) => {
    el.toast.textContent = msg
    el.toast.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => el.toast.classList.remove('show'), ms)
  }
  player.toast = toast

  // ---------------- 面板 ----------------
  let open = false
  type View = 'sources' | 'list' | 'pls'
  let listFrom: View = 'sources' // 列表视图的返回目标：曲库首页或歌单浏览
  const show = (view: View) => {
    el.sources.hidden = view !== 'sources'
    el.listView.hidden = view !== 'list'
    el.plsView.hidden = view !== 'pls'
    if (view === 'list') renderTracks(true)
  }
  const openPanel = (view: 'sources' | 'list' = player.list.tracks.length ? 'list' : 'sources') => {
    open = true
    el.panel.classList.add('show')
    el.panel.setAttribute('aria-hidden', 'false')
    show(view)
    recheckAccount(10 * 60e3) // 打开曲库时顺便确认登录状态，失效的话马上就能看到
  }
  const closePanel = () => {
    open = false
    el.panel.classList.remove('show')
    el.panel.setAttribute('aria-hidden', 'true')
    stopQr()
  }
  el.libBtn.addEventListener('click', () => (open ? closePanel() : openPanel()))
  el.panel.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanel))
  $('pn-back').addEventListener('click', () => show(listFrom))
  $('pn-pls-back').addEventListener('click', () => show('sources'))

  // ---------------- 网易云：账号 / 扫码登录 ----------------
  let profile: ncm.Profile | null = null
  let playlists: ncm.PlaylistInfo[] = []
  let expired = false // 本次运行中检测到登录失效：提示重新登录，而不是显示成从没登录过
  function renderAccount() {
    el.account.innerHTML = profile
      ? `<img src="${esc(profile.avatarUrl)}?param=60y60" alt="" /><span>${esc(profile.nickname)}</span><button data-act="logout">退出</button>`
      : expired ? `<span>登录已过期 · 重新扫码即可恢复</span><button data-act="login">重新登录</button>`
      : `<span>未登录 · 可浏览与播放免费歌曲</span><button data-act="login">扫码登录</button>`
  }
  ncm.onExpired(() => {
    expired = true
    profile = null
    playlists = []
    renderAccount()
    renderLists() // 收起私人漫游、每日推荐等需要登录的入口
    toast('网易云登录已过期 · 打开曲库重新扫码登录', 6000)
  })
  el.account.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).dataset.act
    if (act === 'login') startQr()
    if (act === 'logout') { ncm.logout(); profile = null; playlists = []; renderAccount(); renderLists(); toast('已退出网易云账号') }
  })

  let qrTimer = 0, qrKey = ''
  function stopQr() { clearInterval(qrTimer); qrTimer = 0; el.qr.hidden = true }
  async function startQr() {
    stopQr()
    el.qr.hidden = false
    el.qr.classList.remove('dim')
    el.qrMsg.textContent = '正在获取二维码…'
    try {
      const { key, img } = await ncm.qrStart()
      qrKey = key
      el.qrImg.src = img
      el.qrMsg.textContent = '打开网易云音乐 App 扫码登录'
    } catch (e) { el.qrMsg.textContent = `获取失败：${(e as Error).message}`; return }
    qrTimer = window.setInterval(async () => {
      const key = qrKey
      const code = await ncm.qrCheck(key).catch(() => 0)
      if (key !== qrKey || !qrTimer) return
      if (code === 802) { el.qr.classList.add('dim'); el.qrMsg.textContent = '已扫码，请在手机上确认登录' }
      if (code === 800) { clearInterval(qrTimer); qrTimer = 0; el.qr.classList.add('dim'); el.qrMsg.textContent = '二维码已过期，点击二维码刷新' }
      if (code === 803) { stopQr(); expired = false; toast('登录成功'); await loadAccount() }
    }, 2000)
  }
  el.qrImg.addEventListener('click', () => { if (!qrTimer) startQr() })

  let checkedAt = 0
  async function loadAccount() {
    checkedAt = Date.now()
    profile = await ncm.account().catch(() => null)
    playlists = profile ? await ncm.userPlaylists(profile.userId).catch(() => []) : []
    renderAccount()
    renderLists()
  }
  // 登录失效时网易云多数接口不报错、而是悄悄降级成未登录的内容，只有 user_account 能可靠地说明登录是否还有效：
  // 距上次确认超过 maxAge 就再确认一次（失效时由 onExpired 处理；网络错误不算失效）
  function recheckAccount(maxAge: number) {
    if (!profile || Date.now() - checkedAt < maxAge) return
    checkedAt = Date.now()
    ncm.account().catch(() => {})
  }
  // 桌面版常驻托盘，可能几天不重启：窗口重新显示时也确认一次
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') recheckAccount(6 * 3600e3) })

  // ---------------- 曲库首页：为你推荐 / 榜单 / 发现歌单 / 我的歌单 ----------------
  type Row = { id: string; name: string; count?: number; cover?: string; day?: number; glyph?: string; sub?: string; arrow?: boolean }
  type Browse = { kind: 'rec' | 'cat' | 'hq' | 'search'; title: string; q?: string }
  type Source = Row & { group: string; load?: () => Promise<TrackList>; browse?: Browse; radio?: boolean }
  let localTracks: Track[] = []
  function sources(): Source[] {
    const pl = (group: string) => (p: ncm.PlaylistInfo): Source => ({
      group, id: `ncm:pl:${p.id}`, name: p.name, count: p.count || undefined, cover: p.cover, load: () => ncm.playlist(p.id, p.name),
    })
    const rec: Source = { group: profile ? '为你推荐' : '发现歌单', id: 'browse:rec', name: '推荐歌单', glyph: '荐', arrow: true, browse: { kind: 'rec', title: '推荐歌单' } }
    const forYou: Source[] = profile
      ? [
          { group: '为你推荐', id: 'ncm:fm', name: '私人漫游', glyph: '∞', sub: '按你的口味连续播放', radio: true, load: ncm.fm },
          { group: '为你推荐', id: 'ncm:daily', name: '每日推荐', day: new Date().getDate(), load: ncm.daily },
          { group: '为你推荐', id: `ncm:pl:${ncm.RADAR_ID}`, name: '私人雷达', glyph: '◎', load: () => ncm.playlist(ncm.RADAR_ID, '私人雷达') },
          rec,
        ]
      : []
    return [
      ...forYou,
      ...ncm.CHARTS.map(pl('榜单')),
      ...(profile ? [] : [rec]),
      { group: '发现歌单', id: 'browse:cat', name: '分类歌单', glyph: '类', sub: '官方歌单与用户创建的歌单', arrow: true, browse: { kind: 'cat', title: '分类歌单' } },
      { group: '发现歌单', id: 'browse:hq', name: '精品歌单', glyph: '精', arrow: true, browse: { kind: 'hq', title: '精品歌单' } },
      ...playlists.map(pl('我的歌单')),
    ]
  }
  const thumb = (u: string) => esc(/126\.net\/[^?]*$/.test(u) ? `${u}?param=80y80` : u)
  const tile = (s: Row) =>
    s.cover ? `<img src="${thumb(s.cover)}" alt="" loading="lazy" />`
    : s.day ? `<i class="ph day">${s.day}</i>`
    : s.glyph ? `<i class="ph glyph">${esc(s.glyph)}</i>`
    : `<i class="ph"></i>`
  const row = (s: Row) =>
    `<li data-id="${esc(s.id)}" class="${player.list.id === s.id ? 'on' : ''}">${tile(s)}` +
    `<span>${esc(s.name)}${s.sub ? `<em>${esc(s.sub)}</em>` : ''}</span><small>${s.count ? `${s.count} 首` : s.arrow ? '›' : ''}</small></li>`
  function renderLists() {
    let group = ''
    el.lists.innerHTML = sources().map((s) => (s.group !== group ? `<li class="pn-sub">${esc((group = s.group))}</li>` : '') + row(s)).join('')
    el.local.innerHTML = localTracks.length ? row({ id: 'local', name: '本地音乐', count: localTracks.length, cover: localTracks.find((t) => t.cover)?.cover }) : ''
  }
  el.lists.addEventListener('click', async (e) => {
    const li = (e.target as HTMLElement).closest('li')
    const src = li && sources().find((s) => s.id === li.dataset.id)
    if (!src) return
    if (src.browse) return openBrowse(src.browse)
    li.querySelector('small')!.textContent = '载入中…'
    try {
      const list = await src.load!()
      listFrom = 'sources'
      await useList(list, true)
      localStorage.setItem(LAST_KEY, JSON.stringify({ id: src.id, name: src.name }))
      if (src.radio && list.tracks[0]) { player.play(list.tracks[0]); hooks.locate(0) } // 电台：点开即播
    } catch (err) {
      toast(`载入失败：${(err as Error).message}`)
      renderLists()
    }
  })
  el.local.addEventListener('click', () => {
    if (!localTracks.length) return
    listFrom = 'sources'
    useList(localList(), true)
    localStorage.setItem(LAST_KEY, JSON.stringify({ id: 'local', name: '本地音乐' }))
  })

  // ---------------- 搜索：单曲 / 歌单 ----------------
  let qMode: 'song' | 'pl' = 'song'
  el.qmode.addEventListener('click', () => {
    qMode = qMode === 'song' ? 'pl' : 'song'
    el.qmode.textContent = qMode === 'song' ? '单曲' : '歌单'
    el.q.placeholder = qMode === 'song' ? '搜索歌曲 / 歌手 / 专辑' : '搜索歌单（官方或用户创建）'
    el.q.focus()
  })
  el.search.addEventListener('submit', async (e) => {
    e.preventDefault()
    const q = el.q.value.trim()
    if (!q) return
    el.q.blur()
    if (qMode === 'pl') return openBrowse({ kind: 'search', title: `歌单 · ${q}`, q })
    try {
      const tracks = await ncm.search(q)
      if (!tracks.length) return toast('没有找到相关歌曲')
      listFrom = 'sources'
      useList({ id: `ncm:search:${q}`, name: `搜索 · ${q}`, tracks }, true)
    } catch (err) { toast(`搜索失败：${(err as Error).message}`) }
  })

  // ---------------- 歌单浏览：推荐 / 分类（含官方）/ 精品 / 搜索结果，可加载更多 ----------------
  type Pls = Browse & { cat: string; items: ncm.PlaylistInfo[]; more: boolean; offset: number; before: number; loading: boolean }
  let pls: Pls | null = null
  function openBrowse(b: Browse) {
    pls = { ...b, cat: '全部', items: [], more: false, offset: 0, before: 0, loading: false }
    el.plsName.textContent = b.title
    show('pls')
    el.plsList.scrollTop = 0
    renderChips()
    loadPls()
  }
  function renderChips() {
    const on = !!pls && (pls.kind === 'cat' || pls.kind === 'hq')
    el.chips.hidden = !on
    if (on) el.chips.innerHTML = ncm.CATS.map((c) => `<button class="${c === pls!.cat ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')
  }
  el.chips.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button')
    if (!b || !pls || b.dataset.cat === pls.cat) return
    pls = { ...pls, cat: b.dataset.cat!, items: [], more: false, offset: 0, before: 0, loading: false }
    el.plsList.scrollTop = 0
    renderChips()
    loadPls()
  })
  async function loadPls() {
    const st = pls
    if (!st || st.loading) return
    st.loading = true
    renderPls()
    try {
      let r: { list: ncm.PlaylistInfo[]; more: boolean }
      if (st.kind === 'rec') r = { list: await ncm.recommendPlaylists(), more: false }
      else if (st.kind === 'cat') r = await ncm.categoryPlaylists(st.cat, st.offset)
      else if (st.kind === 'hq') { const h = await ncm.highQualityPlaylists(st.cat, st.before); st.before = h.before; r = h }
      else r = await ncm.searchPlaylists(st.q!, st.offset)
      const known = new Set(st.items.map((p) => p.id))
      st.items.push(...r.list.filter((p) => !known.has(p.id)))
      st.offset += r.list.length
      st.more = r.more && r.list.length > 0
    } catch (err) {
      if (pls === st) toast(`载入失败：${(err as Error).message}`)
    }
    st.loading = false
    if (pls === st) renderPls()
  }
  function renderPls() {
    if (!pls) return
    const rows = pls.items.map((p) =>
      `<li data-pl="${p.id}">${tile({ ...p, id: String(p.id) })}<span>${esc(p.name)}<em>${p.creator ? `${esc(p.creator)} · ` : ''}${p.count} 首</em></span></li>`).join('')
    const tail = pls.loading ? `<li class="pn-empty">载入中…</li>`
      : pls.more ? `<li class="pn-more" data-more>加载更多</li>`
      : pls.items.length ? '' : `<li class="pn-empty">没有找到歌单</li>`
    el.plsList.innerHTML = rows + tail
  }
  el.plsList.addEventListener('click', async (e) => {
    const li = (e.target as HTMLElement).closest('li')
    if (!li || !pls) return
    if (li.dataset.more !== undefined) return loadPls()
    const p = pls.items.find((x) => x.id === +li.dataset.pl!)
    if (!p) return
    const em = li.querySelector('em')!
    em.textContent = '载入中…'
    try {
      const list = await ncm.playlist(p.id, p.name)
      listFrom = 'pls'
      await useList(list, true)
      localStorage.setItem(LAST_KEY, JSON.stringify({ id: list.id, name: p.name }))
    } catch (err) {
      toast(`载入失败：${(err as Error).message}`)
      renderPls()
    }
  })

  async function useList(list: TrackList, showList = false) {
    if (!list.tracks.length) { toast(`${list.name} 是空的`); return }
    player.setList(list)
    renderLists()
    if (showList && open) show('list')
  }

  // ---------------- 本地音乐 ----------------
  // 网页版：读取拖入 / 选择的 File（刷新后丢失）
  // 桌面版：记住添加的文件夹 / 文件路径，启动时重新扫描；音频经 media 协议从磁盘流式播放
  const PATHS_KEY = 'local.paths'
  let localPaths: string[] = []
  try { if (ncm.inApp) localPaths = JSON.parse(localStorage.getItem(PATHS_KEY) || '[]') } catch { /* ignore */ }
  const localList = (): TrackList => ({ id: 'local', name: '本地音乐', tracks: localTracks })

  async function afterImport(added: Track[]) {
    if (!localTracks.length) return toast('没有找到可播放的音频文件')
    await useList(localList())
    localStorage.setItem(LAST_KEY, JSON.stringify({ id: 'local', name: '本地音乐' }))
    if (!added.length) return toast('这些音乐已经在曲库里了')
    toast(`已导入 ${added.length} 首本地音乐`)
    player.play(added[0])
    hooks.locate(player.indexOf(added[0]))
  }

  async function importLocal(files: File[]) {
    const tracks = await readLocal(files, (d, n) => n > 3 && toast(`正在读取本地音乐 ${d} / ${n}`, 4000))
    if (!tracks.length) return toast('没有找到可播放的音频文件')
    const known = new Set(localTracks.map((t) => t.key))
    const added = tracks.filter((t) => !known.has(t.key))
    localTracks = [...localTracks, ...added]
    await afterImport(added)
  }

  const savePaths = () => localStorage.setItem(PATHS_KEY, JSON.stringify(localPaths))
  async function rescan() {
    localTracks = localPaths.length ? await scanPaths(localPaths) : []
    renderFolders()
    renderLists()
    if (player.list.id === 'local') player.setList(localList())
  }
  async function addPaths(paths: string[]) {
    const fresh = paths.filter((p) => !localPaths.includes(p))
    if (!fresh.length) return toast('这些位置已经添加过了')
    localPaths = [...localPaths, ...fresh]
    toast('正在读取本地音乐…', 8000)
    const known = new Set(localTracks.map((t) => t.key))
    try { await rescan() } catch (e) { return toast(`读取失败：${(e as Error).message}`) }
    // 没有音频的路径不记住
    const empty = fresh.filter((p) => !localTracks.some((t) => t.path!.startsWith(p)))
    if (empty.length) localPaths = localPaths.filter((p) => !empty.includes(p))
    savePaths()
    renderFolders()
    await afterImport(localTracks.filter((t) => !known.has(t.key)))
  }
  function renderFolders() {
    el.folders.innerHTML = localPaths
      .map((p, i) => `<li title="${esc(p)}"><span>${esc(p.split(/[\\/]/).filter(Boolean).pop() || p)}</span><button data-i="${i}" aria-label="移除">×</button></li>`)
      .join('')
  }
  el.folders.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest('button')
    if (!b) return
    localPaths.splice(+b.dataset.i!, 1)
    savePaths()
    await rescan()
    toast('已从曲库移除（不会删除文件）')
  })

  const AUDIO = ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'webm']
  async function pick(directory: boolean) {
    const dialog = await import('@tauri-apps/plugin-dialog')
    const r = await dialog.open(directory
      ? { directory: true, multiple: true, title: '选择音乐文件夹' }
      : { multiple: true, title: '选择音频文件', filters: [{ name: '音频', extensions: AUDIO }] })
    if (r) addPaths(Array.isArray(r) ? r : [r])
  }
  $('pn-folder').addEventListener('click', () => (ncm.inApp ? pick(true) : el.inFolder.click()))
  $('pn-files').addEventListener('click', () => (ncm.inApp ? pick(false) : el.inFiles.click()))
  for (const input of [el.inFolder, el.inFiles]) {
    input.addEventListener('change', () => {
      if (input.files?.length) importLocal([...input.files])
      input.value = ''
    })
  }
  if (ncm.inApp) {
    el.note.textContent = '添加的文件夹会被记住，下次启动自动载入；也可以直接拖进窗口'
    import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent(({ payload: p }) => {
        el.drop.classList.toggle('show', p.type === 'enter' || p.type === 'over')
        if (p.type === 'drop' && p.paths.length) addPaths(p.paths)
      }),
    )
  } else {
    addEventListener('dragover', (e) => { e.preventDefault(); el.drop.classList.add('show') })
    addEventListener('dragleave', (e) => { if (!e.relatedTarget) el.drop.classList.remove('show') })
    addEventListener('drop', (e) => {
      e.preventDefault()
      el.drop.classList.remove('show')
      if (e.dataTransfer) filesFromDrop(e.dataTransfer).then(importLocal)
    })
  }

  // ---------------- 列表视图 ----------------
  let renderedList: TrackList | null = null, renderedCount = 0
  function renderTracks(scroll = false) {
    const { list, current } = player
    el.listName.textContent = list.name
    if (renderedList !== list) el.filter.value = '' // 换了列表：清空列表内搜索
    // 列表对象变了、或电台追加了新歌时重绘
    if (renderedList !== list || renderedCount !== list.tracks.length) {
      renderedList = list
      renderedCount = list.tracks.length
      el.tracks.innerHTML = list.tracks.length
        ? list.tracks.map((t, i) =>
          `<li data-i="${i}"><i>${i + 1}</i><div><b>${esc(t.title)}</b><em>${esc(t.artist)}${t.album ? ` · ${esc(t.album)}` : ''}</em></div><small>${t.dur ? fmt(t.dur) : ''}</small></li>`).join('') +
          `<li class="pn-empty" data-nomatch hidden>没有匹配的歌曲</li>`
        : `<li class="pn-empty">列表为空</li>`
    }
    applyFilter()
    const ci = player.indexOf(current)
    el.tracks.querySelector('li.on')?.classList.remove('on')
    const on = el.tracks.children[ci] as HTMLElement | undefined
    on?.classList.add('on')
    if (scroll && on) on.scrollIntoView({ block: 'center' })
  }
  // 列表内搜索：空格分隔的每个关键词都要命中歌名 / 歌手 / 专辑（不分大小写、全半角）
  const norm = (s: string) => s.normalize('NFKC').toLowerCase()
  function applyFilter() {
    const ts = player.list.tracks
    const terms = norm(el.filter.value).split(/\s+/).filter(Boolean)
    let shown = 0
    el.tracks.querySelectorAll<HTMLElement>('li[data-i]').forEach((li) => {
      const t = ts[+li.dataset.i!]
      const ok = !t || terms.every((w) => norm(`${t.title} ${t.artist} ${t.album}`).includes(w))
      li.hidden = !ok
      if (ok) shown++
    })
    const none = el.tracks.querySelector<HTMLElement>('[data-nomatch]')
    if (none) none.hidden = !terms.length || shown > 0
    el.listCount.textContent = !ts.length ? '' : terms.length ? `${shown} / ${ts.length} 首` : `${ts.length} 首`
  }
  el.filter.addEventListener('input', () => { applyFilter(); el.tracks.scrollTop = 0 })
  el.filter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { // 回车：播放第一首匹配的歌
      el.tracks.querySelector<HTMLElement>('li[data-i]:not([hidden])')?.click()
    } else if (e.key === 'Escape' && el.filter.value) { // Esc：先清空搜索，再按一次才退出输入框
      e.stopPropagation()
      el.filter.value = ''
      applyFilter()
    }
  })
  el.tracks.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest('li')
    if (!li?.dataset.i) return
    const i = +li.dataset.i
    const tr = player.list.tracks[i]
    if (tr.key === player.current?.key) player.toggle()
    else player.play(tr)
    hooks.locate(i)
  })

  // ---------------- 底部播放器 ----------------
  const MODE_ICON: Record<string, [string, string]> = {
    list: ['列表循环', '<path d="M4 9.5V8a2 2 0 0 1 2-2h12l-2.5-2.5M20 14.5V16a2 2 0 0 1-2 2H6l2.5 2.5" />'],
    shuffle: ['随机播放', '<path d="M4 7h3.5c4 0 5 10 9 10H20M17.5 14.5 20 17l-2.5 2.5M4 17h3.5c1.4 0 2.4-1.2 3.2-2.7M13.3 9.7C14.1 8.2 15.1 7 16.5 7H20M17.5 4.5 20 7l-2.5 2.5" />'],
    one: ['单曲循环', '<path d="M4 9.5V8a2 2 0 0 1 2-2h12l-2.5-2.5M20 14.5V16a2 2 0 0 1-2 2H6l2.5 2.5" /><text x="10" y="14.6">1</text>'],
  }
  const renderMode = () => {
    const [name, svg] = MODE_ICON[player.mode]
    el.mode.innerHTML = `<svg viewBox="0 0 24 24">${svg}</svg>`
    el.mode.title = name
  }
  el.mode.addEventListener('click', () => { player.cycleMode(); toast(MODE_ICON[player.mode][0], 1400) })
  el.btn.addEventListener('click', () => player.toggle())
  $('np-prev').addEventListener('click', () => player.prev())
  $('np-next').addEventListener('click', () => player.next())

  // 进度条 / 音量条：按下即跳转，可拖动
  function slider(track: HTMLElement, onMove: (r: number) => void, onEnd?: (r: number) => void) {
    const ratio = (e: PointerEvent) => { const b = track.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)) }
    track.addEventListener('pointerdown', (e) => {
      track.setPointerCapture(e.pointerId)
      track.classList.add('drag')
      onMove(ratio(e))
    })
    track.addEventListener('pointermove', (e) => { if (track.classList.contains('drag')) onMove(ratio(e)) })
    const end = (e: PointerEvent) => { if (!track.classList.contains('drag')) return; track.classList.remove('drag'); onEnd?.(ratio(e)) }
    track.addEventListener('pointerup', end)
    track.addEventListener('pointercancel', end)
  }
  let seeking = -1
  slider(el.seek, (r) => { seeking = r; paintProgress() }, (r) => { player.seek(r * player.duration); seeking = -1 })
  slider(el.vol, (r) => { player.el.muted = false; player.setVolume(r) })
  el.mute.addEventListener('click', () => { player.el.muted = !player.el.muted })

  function paintProgress() {
    const dur = player.duration
    const t = seeking >= 0 ? seeking * dur : player.time
    el.cur.textContent = fmt(t)
    el.dur.textContent = fmt(dur)
    el.fill.style.width = `${dur ? (t / dur) * 100 : 0}%`
  }

  // ---------------- 音质：按钮显示实际拿到的音质，菜单里选择想要的档位 ----------------
  const gotLabel = () => {
    const g = player.got
    if (!g) return ncm.levelName(player.quality)
    if (g.level === 'local') return g.type.toUpperCase() || '本地'
    return ncm.levelName(g.level)
  }
  const gotDetail = () => {
    const g = player.got
    if (!g) return ''
    if (g.level === 'local') return `本地文件 · ${g.type.toUpperCase()}`
    return `${ncm.levelName(g.level)} · ${g.type.toUpperCase()} ${Math.round(g.br / 1000)}k`
  }
  // 实际音质低于所选（账号或歌曲不支持）时按钮变暗
  const downgraded = () => !!player.got && player.got.level !== 'local' && ncm.levelRank(player.got.level) >= 0 &&
    ncm.levelRank(player.got.level) < ncm.levelRank(player.quality)
  function renderQuality() {
    el.qbtn.textContent = gotLabel()
    el.qbtn.classList.toggle('lower', downgraded())
    el.qbtn.title = player.got ? `当前：${gotDetail()} · 已选：${ncm.levelName(player.quality)}` : `已选：${ncm.levelName(player.quality)}`
    if (el.qmenu.hidden) return
    el.qmenu.innerHTML = `<div class="qm-head">音质</div>` +
      ncm.LEVELS.map((l) => `<button data-lv="${l.id}" class="${l.id === player.quality ? 'on' : ''}"><b>${l.name}</b><small>${l.note}</small></button>`).join('') +
      `<p class="qm-note">${player.got ? `当前：${esc(gotDetail())}<br>` : ''}无损及以上需要黑胶 VIP；不可用时自动用可用的最高音质</p>`
  }
  const closeQ = () => { el.qmenu.hidden = true; el.qbtn.classList.remove('open') }
  el.qbtn.addEventListener('click', () => {
    el.qmenu.hidden = !el.qmenu.hidden
    el.qbtn.classList.toggle('open', !el.qmenu.hidden)
    renderQuality()
  })
  el.qmenu.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-lv]')
    if (!b) return
    const lv = b.dataset.lv as ncm.Level
    closeQ()
    if (lv === player.quality) return
    await player.setQuality(lv)
    toast(downgraded() ? `已选「${ncm.levelName(lv)}」· 这首歌当前最高为「${ncm.levelName(player.got!.level)}」` : `音质：${ncm.levelName(lv)}`)
  })
  addEventListener('pointerdown', (e) => { if (!el.qmenu.hidden && !(e.target as HTMLElement).closest('.np-q')) closeQ() })
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.qmenu.hidden) { closeQ(); e.stopImmediatePropagation() } }, true)

  let shownKey = '-'
  function renderNP() {
    const tr = player.current
    el.btn.classList.toggle('paused', !player.playing)
    el.btn.classList.toggle('loading', player.loading)
    document.body.classList.toggle('is-paused', !player.playing)
    const muted = player.el.muted || player.volume === 0
    el.vfill.style.width = `${muted ? 0 : player.volume * 100}%`
    el.mute.parentElement!.classList.toggle('muted', muted)
    const npKey = tr ? tr.key : `none|${player.list.name}`
    if (npKey !== shownKey) {
      shownKey = npKey
      if (tr) el.img.src = coverSrc(tr)
      else el.img.removeAttribute('src')
      el.title.textContent = tr ? tr.title : '未在播放'
      el.artist.textContent = tr ? tr.artist : player.list.name || '打开曲库选择音乐'
    }
    el.libName.textContent = player.list.name || '曲库'
    el.libCount.textContent = player.list.tracks.length ? `${player.list.tracks.length} 首` : ''
    if (open && !el.listView.hidden) renderTracks()
    renderQuality()
    paintProgress()
  }
  player.on(renderNP)
  renderMode()
  renderNP()

  // 歌词：每帧检查当前行，换行时淡出再淡入
  let lyricIdx = -2, lyricTimer = 0
  function frame() {
    paintProgress()
    const i = player.lyrics.length ? player.lyricIndex() : -1
    if (i === lyricIdx) return
    lyricIdx = i
    const line = i >= 0 ? player.lyrics[i] : null
    el.lyric.classList.add('out')
    clearTimeout(lyricTimer)
    lyricTimer = window.setTimeout(() => {
      el.lyric.innerHTML = line?.text ? `<span>${esc(line.text)}</span>${line.tr ? `<small>${esc(line.tr)}</small>` : ''}` : ''
      el.lyric.classList.toggle('out', !line?.text)
    }, 220)
  }

  // ---------------- 启动：恢复账号与上次的歌单，默认热歌榜 ----------------
  let booting = true
  renderAccount()
  renderLists()
  ncm.loadChartInfo().then(renderLists).catch(() => {})
  ;(async () => {
    if (ncm.inApp && localPaths.length) await rescan().catch((e) => toast(`本地音乐读取失败：${(e as Error).message}`))
    await loadAccount()
    let last: { id: string; name: string } | null = null
    try { last = JSON.parse(localStorage.getItem(LAST_KEY) || 'null') } catch { /* ignore */ }
    // 上次的歌单：曲库首页里的条目、或从歌单浏览 / 搜索里打开过的任意歌单；默认热歌榜
    const chart = sources().find((s) => s.id === `ncm:pl:${ncm.CHARTS[0].id}`)!
    let load = sources().find((s) => s.id === last?.id && s.load)?.load
    if (!load && last?.id.startsWith('ncm:pl:')) load = () => ncm.playlist(+last!.id.slice(7), last!.name)
    el.libName.textContent = '载入中…'
    if (last?.id === 'local' && localTracks.length) await useList(localList())
    else try { await useList(await (load || chart.load!)()) } catch (e) {
      toast(`网易云曲库载入失败：${(e as Error).message}`)
      renderNP()
    }
    booting = false
  })()

  return { toast, frame, openPanel, closePanel, get panelOpen() { return open }, get booting() { return booting } }
}
