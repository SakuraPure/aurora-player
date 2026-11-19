# 网易云音乐接口维护文档

本项目通过**非官方接口**访问网易云音乐（仅供个人学习使用）。本文说明接口层的结构、每个接口的请求与返回、加密方式、登录与 cookie、常见故障，以及新增接口的步骤。

> 代码以本文档写作时的 v0.8.0 为准；改动接口层时请同步更新本文档。

---

## 1. 总体结构

同一套前端代码在两种环境下运行，网易云请求走两套**接口名、参数、返回结构完全一致**的实现：

```
                        src/ncm.ts  call(fn, params)
                       ┌───────────────┴────────────────┐
             网页版（浏览器）                     桌面版（Tauri 客户端）
   fetch POST /api/ncm/<fn>                 invoke('ncm_call', { fnName, params, cookie })
   头 x-ncm-cookie: <登录 cookie>                         │
                │                                          ▼
                ▼                           src-tauri/src/lib.rs  ncm_call 命令
   vite.config.ts 中间层（开发 / 预览服务器）               │
                │                                          ▼
                ▼                           src-tauri/src/ncm.rs  Ncm::call(name, params, cookie)
   npm 包 NeteaseCloudMusicApi                 （自己实现的 weapi 加密 + reqwest）
                │                                          │
                └──────────────► music.163.com ◄───────────┘
```

| 位置 | 职责 |
| --- | --- |
| `src/ncm.ts` | 前端唯一入口：`call()` 按环境分发；把原始 JSON 转成 `Track` / `TrackList` / `PlaylistInfo`；扫码登录、cookie 保存 |
| `vite.config.ts` | 网页版中间层：接口白名单 `ALLOW`、过滤危险参数 `STRIP`、转调 npm 包 |
| `src-tauri/src/ncm.rs` | 桌面版：18 个接口的 Rust 实现，全部走 weapi |
| `src-tauri/src/lib.rs` | 注册 `ncm_call` 命令（调试版会在日志里记录每次调用成功与否） |
| `src/player.ts` | 取播放地址 / 歌词、音质、地址过期重试、私人漫游续取 |

**两套实现的差别**：网页版沿用 npm 包各接口的默认加密通道（多数是 eapi，`song_url_v1` 被强制改成 weapi）；桌面版所有接口统一走 weapi。网易云改动接口时，npm 包由其作者维护更新，**Rust 实现需要我们自己跟进**。

---

## 2. 调用约定

### 前端

```ts
// src/ncm.ts
async function call<T = any>(fn: string, params: Record<string, unknown> = {}): Promise<T>
```

- 返回网易云原始响应 JSON（`body`），不做包装。
- 失败时抛出 `Error`，`message` 为可直接展示给用户的中文说明。
- 登录 cookie 由 `call()` 自动带上，调用方不用管。

### 网页版中间层（`vite.config.ts`）

- 只接受 `POST /api/ncm/<接口名>`，接口名必须在 `ALLOW` 里，否则 404。
- 请求体是 JSON 参数；cookie 放在请求头 `x-ncm-cookie`。
- 删除前端传来的 `proxy`、`realIP`、`randomCNIP`、`domain`、`headers`、`ua`、`e_r`、`crypto`、`cookie`：这些参数会改变请求的去向或身份。
- 自动加 `timestamp`（避免缓存）。
- 响应：HTTP 状态码取 npm 包返回的 `status`，正文是网易云的 `body`。

### 桌面版（`src-tauri/src/ncm.rs`）

- Tauri 命令 `ncm_call(fn_name, params, cookie) -> Result<Value, String>`。
- 成功判断与 npm 包一致：响应 `code` ∈ `[200, 201, 302, 400, 502, 800, 801, 802, 803]` 视为成功（扫码状态码也算成功）；否则返回 `Err("<message>（<code>）")`。
- 网络错误：`Err("网络错误：…")`；返回内容不是 JSON：`Err("网易云返回了无法解析的内容（HTTP xxx）")`。

---

## 3. 加密与请求格式（weapi）

桌面版全部接口、网页版的 `song_url_v1` 都走 weapi。实现见 `ncm.rs` 的 `weapi()`、`rsa_hex()`、`aes_cbc_b64()`。

1. 业务参数加上 `csrf_token`（取 cookie 里的 `__csrf`，未登录为空串），序列化成 JSON 文本 `text`。
2. 随机生成 16 位 `secretKey`（字符集 `a-zA-Z0-9`）。
3. `params = base64(AES-128-CBC(base64(AES-128-CBC(text, presetKey)), secretKey))`
   - `presetKey = "0CoJUm6Qyw8W8jud"`，`iv = "0102030405060708"`，PKCS7 填充。
4. `encSecKey = hex( reverse(secretKey) ^ 65537 mod N )`，**无填充 RSA**，左侧补 0 到 256 位十六进制。
   - 模数 `N` 见 `ncm.rs` 的 `MODULUS` 常量（取自 npm 包内置公钥）。
5. 请求：

```
POST https://music.163.com/weapi/<路径去掉开头的 /api/>
Content-Type: application/x-www-form-urlencoded
Referer: https://music.163.com
User-Agent: <桌面 Chrome UA，见 ncm.rs 的 UA 常量>
Cookie: <设备 cookie> ; <登录 cookie>

params=<...>&encSecKey=<...>
```

**设备 cookie**（`Ncm::new()` 每次启动生成一次，与 npm 包的做法一致）：
`__remember_me=true`、`ntes_kaola_ad=1`、`_ntes_nuid`（随机 64 位十六进制）、`_ntes_nnid=<nuid>,<毫秒时间戳>`、`WNMCID`、`WEVNSM=1.0.0`、`os=pc`、`osver`、`appver`、`channel=netease`、`NMTID=00O<随机>`。登录 cookie 中的同名项会覆盖它们。

**为什么用 weapi**：匿名状态下，默认 eapi 通道请求播放地址会返回 `-460 检测到您的网络环境存在风险`，weapi 正常。**不要**用伪造国内 IP（`realIP` / `randomCNIP`）的方式绕过风控。

**正确性保障**：`ncm.rs` 的单元测试用 npm 包（crypto-js + node-forge）生成的结果做对照，AES 与 RSA 输出逐字节一致。

---

## 4. 接口清单

"需登录"指不登录时拿不到有意义的结果；"网页版通道"是 npm 包的默认加密方式。

### 4.1 搜索与歌曲

| 接口名 | 前端函数 | 网易云路径 | 主要参数 | 关键返回 | 需登录 | 网页版通道 |
| --- | --- | --- | --- | --- | --- | --- |
| `cloudsearch` | `search(kw)` 单曲；`searchPlaylists(kw, offset)` 歌单 | `/api/cloudsearch/pc` | `s` 关键词、`type`（1 单曲 / 1000 歌单）、`limit`、`offset`、`total: true` | 单曲 `result.songs[]`；歌单 `result.playlists[]`、`result.playlistCount` | 否 | eapi |
| `song_detail` | （未直接使用） | `/api/v3/song/detail` | `c: '[{"id":1},{"id":2}]'` | `songs[]`、`privileges[]` | 否 | weapi |
| `song_url_v1` | `songUrl(id, level)` | `/api/song/enhance/player/url/v1` | `ids: '[id]'`、`level`（见第 7 节）、`encodeType: 'flac'` | `data[0].url`、`level`、`br`、`type`、`freeTrialInfo` | 否（高音质与会员歌曲需要） | **强制 weapi** |
| `lyric` | `lyric(id)` | `/api/song/lyric` | `id`、`tv/lv/rv/kv: -1`、`_nmclfl: 1` | `lrc.lyric` 原文、`tlyric.lyric` 翻译、`romalrc` 罗马音 | 否 | eapi |

- 播放地址**有时效**（地址路径里带时间戳），只能在播放时现取，不要缓存。
- `url` 为空：会员歌曲或无版权。`freeTrialInfo` 不为空：只返回了试听片段（约 30–45 秒）。
- 翻译歌词与原文时间戳相同，`withTranslation()`（`src/library.ts`）按时间戳配对，容差 0.3 秒。

### 4.2 歌单与榜单

| 接口名 | 前端函数 | 网易云路径 | 主要参数 | 关键返回 | 需登录 | 网页版通道 |
| --- | --- | --- | --- | --- | --- | --- |
| `playlist_track_all` | `playlist(id, name)` | 两步：`/api/v6/playlist/detail` → `/api/v3/song/detail` | `id`、`limit`（前端传 500）、`offset` | `songs[]` | 视歌单 | eapi |
| `toplist` | `loadChartInfo()` | `/api/toplist` | — | `list[]`：`id`、`name`、`coverImgUrl`、`trackCount` | 否 | eapi |
| `user_playlist` | `userPlaylists(uid)` | `/api/user/playlist` | `uid`、`limit`、`offset`、`includeVideo: true` | `playlist[]`（第一个通常是"我喜欢的音乐"） | 是 | weapi |
| `personalized` | `recommendPlaylists()`（未登录时） | `/api/personalized/playlist` | `limit`、`total: true`、`n: 1000` | `result[]`（封面字段是 `picUrl`） | 否 | weapi |
| `recommend_resource` | `recommendPlaylists()`（登录后） | `/api/v1/discovery/recommend/resource` | — | `recommend[]` | 是（未登录返回 301） | weapi |
| `top_playlist` | `categoryPlaylists(cat, offset)` | `/api/playlist/list` | `cat` 分类名、`order: 'hot'`、`limit`、`offset`、`total: true` | `playlists[]`、`more`、`total` | 否 | weapi |
| `top_playlist_highquality` | `highQualityPlaylists(cat, before)` | `/api/playlist/highquality/list` | `cat`、`limit`、`lasttime`（前端参数名 `before`）、`total: true` | `playlists[]`、`more`、`lasttime` | 否 | weapi |

- `playlist_track_all` 先取歌单详情拿到全部 `trackIds`，再按 `offset/limit` 截取后批量查歌曲详情。
- 分页方式不同：分类歌单、歌单搜索按 `offset`；精品歌单按上一页返回的 `lasttime`（传给下一页的 `before`）。
- 分类名必须是网易云的中文分类（如 `全部`、`华语`、`民谣`、`ACG`），前端可选列表见 `CATS`。

### 4.3 个性化（为你推荐）

| 接口名 | 前端函数 | 网易云路径 | 关键返回 | 需登录 | 网页版通道 |
| --- | --- | --- | --- | --- | --- |
| `recommend_songs` | `daily()` 每日推荐 | `/api/v3/discovery/recommend/songs` | `data.dailySongs[]` | 是 | weapi |
| `personal_fm` | `fm()` 私人漫游 | `/api/v1/radio/get` | `data[]`（每次几首，**老格式**，见第 5 节） | 否（未登录给通用推荐） | weapi |
| （复用 `playlist_track_all`） | 私人雷达 | 固定歌单 id `3136952023` | `songs[]` | 否（登录后按口味生成） | — |

- 私人漫游做成电台式列表：`TrackList.more` 指向取下一批的函数，播放器在快播完时调用并追加去重（`player.ts` 的 `extend()`）。

### 4.4 登录与账号

| 接口名 | 前端函数 | 网易云路径 | 主要参数 | 关键返回 | 网页版通道 |
| --- | --- | --- | --- | --- | --- |
| `login_qr_key` | `qrStart()` | `/api/login/qrcode/unikey` | `type: 3` | 包一层：`{ code: 200, data: { unikey } }` | eapi |
| `login_qr_create` | `qrStart()` | **不请求网易云**，本地生成 | `key`、`qrimg: true` | `{ code: 200, data: { qrurl, qrimg } }` | — |
| `login_qr_check` | `qrCheck(key)`，每 2 秒轮询 | `/api/login/qrcode/client/login` | `key`、`type: 3` | `code` + `cookie`（见下） | eapi |
| `user_account` | `account()` | `/api/nuser/account/get` | — | `profile`（未登录为 `null`）：`userId`、`nickname`、`avatarUrl` | weapi |
| `logout` | `logout()` | `/api/logout` | — | — | eapi |

- 二维码内容是 `https://music.163.com/login?codekey=<unikey>`。网页版由 npm 包的 `qrcode` 生成 PNG data URL，桌面版由 Rust `qrcode` crate 生成 SVG data URL。
- 扫码状态码：`800` 过期、`801` 等待扫码、`802` 已扫码待确认、`803` 成功。
- `803` 时 `cookie` 字段是登录 cookie：网页版是 npm 包拼好的 Set-Cookie 原文；桌面版只保留每条 Set-Cookie 的 `name=value`，用 `; ` 连接。两种格式前端都能直接存、直接传回。

### 4.5 固定 ID

| 用途 | ID | 位置 |
| --- | --- | --- |
| 热歌榜 / 新歌榜 / 飙升榜 | `3778678` / `3779629` / `19723756` | `CHARTS` |
| 私人雷达 | `3136952023` | `RADAR_ID` |

---

## 5. 数据格式与转换

### 歌曲 → `Track`（`toTrack()`）

网易云有新老两种歌曲格式，`toTrack()` 两种都兼容：

| 含义 | 新格式（多数接口） | 老格式（`personal_fm` 等） |
| --- | --- | --- |
| 歌手 | `ar[].name` | `artists[].name` |
| 专辑 / 封面 | `al.name`、`al.picUrl` | `album.name`、`album.picUrl` |
| 时长（毫秒） | `dt` | `duration` |

- `fee === 1` 记为会员歌曲（`vip`），只用于给出更准确的错误提示。
- `Track.key = "ncm:<id>"`，用于去重和判断"是否当前歌曲"。

### 歌单 → `PlaylistInfo`（`toPl()`）

封面字段可能是 `coverImgUrl` 或 `picUrl`（`personalized`），创建者取 `creator.nickname`，歌曲数取 `trackCount`。

### 图片地址

- 网易云返回的图片地址可能是 `http://`，统一换成 `https://`（`https()`）。
- 加 `?param=WxH` 取缩略图：卡片与背景用 `512y512`，封面背景的高清版用 `1024y1024`，面板列表用 `80y80`。

---

## 6. 登录与 cookie

- 登录 cookie 保存在 `localStorage` 的 `ncm.cookie`（桌面版保存在 WebView2 的数据目录里，与网页版互不相通）。
- 是否已登录：cookie 中是否含 `MUSIC_U`（`loggedIn()`）。
- 启动时调用 `account()`：返回的 `profile` 为空说明登录已失效，会自动清掉本地 cookie。
- 退出登录：调用 `logout` 并清掉本地 cookie。
- **不经手密码**：只支持扫码登录。

---

## 7. 音质

`song_url_v1` 的 `level` 可选值（前端列表见 `LEVELS`）：

| level | 名称 | 说明 |
| --- | --- | --- |
| `standard` | 标准 | MP3 128k |
| `higher` | 较高 | MP3 192k |
| `exhigh` | 极高 | MP3 320k（默认） |
| `lossless` | 无损 | FLAC，需黑胶 VIP |
| `hires` | Hi-Res | 24bit FLAC，需黑胶 VIP |
| `jymaster` | 超清母带 | 需黑胶 SVIP |

- 所选档位不可用时（未登录、非会员、歌曲本身没有），网易云**自动降到可用的最高档**，并在 `data[0].level`、`br`、`type` 里返回实际档位。界面显示的是实际档位。
- 实测：未登录时免费歌曲最高可拿到 `exhigh`（320k）。
- npm 包对 `sky`（沉浸环绕声，需要 `immerseType`）和 `vivid`（需要换客户端标识）有特殊处理，Rust 实现**没有**移植，目前界面也不提供这两档。

---

## 8. CDN 与跨域

- 音频与图片 CDN（`*.music.126.net`）返回 `Access-Control-Allow-Origin: *`。
- 因此 `<audio crossOrigin="anonymous">` 接入 AnalyserNode 后能读到频谱，封面能直接做 WebGL 纹理、做封面取色，**不需要代理**。
- 若将来某个 CDN 域名不再返回该头：频谱会变成全 0、封面纹理会报跨域错误。届时需要在中间层 / Rust 里加代理。

---

## 9. 播放器中的容错

| 情况 | 处理（`src/player.ts`） |
| --- | --- |
| 地址为空 | 提示"需要会员或暂无版权"/"需要登录或暂无版权"；自动连播时跳到下一首；连续失败达到 6 次（或列表长度）就停下，避免整张列表空转 |
| 只拿到试听片段 | 提示"仅返回了试听片段" |
| 播放途中出错（多为地址过期） | 重新取一次地址并回到原位置；再失败才跳过 |
| 切换音质 | 按新档位重新取地址，从原位置接着播 |
| 私人漫游播到末尾 | 先取下一批再继续 |

---

## 10. 测试

```bash
# 加密与本地曲库单元测试（不联网）
cd src-tauri && cargo test --lib

# 联网测试：搜索、播放地址、音质降级、歌词、歌单、榜单、发现、私人漫游、扫码登录、账号
cd src-tauri && cargo test --lib -- --ignored
```

- 联网测试只能覆盖**匿名**行为；登录后的每日推荐、私人雷达个性化、会员音质需要手动验证。
- 网页版：`npm run dev` 后在浏览器里验证；开发模式下 `window.__dbg.player` 可直接操作播放器。
- 桌面版页面调试：用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` 启动后通过 CDP 执行脚本（本机 9222 端口被 Chrome 占用，不要用）。**已安装的客户端运行时不能同时开开发版**（共用数据目录，会报 0x8007139F）。

---

## 11. 新增一个接口的步骤

1. **查定义**：在 `node_modules/NeteaseCloudMusicApi/module/<接口名>.js` 找到网易云路径、参数和默认加密方式。
2. **先用 Node 验证 weapi 可用**（匿名即可）：

   ```bash
   node -e "require('./node_modules/NeteaseCloudMusicApi').<接口名>({ ...参数, crypto: 'weapi' }).then(r => console.log(r.status, JSON.stringify(r.body).slice(0, 300)))"
   ```

3. **网页版**：把接口名加进 `vite.config.ts` 的 `ALLOW`。
4. **桌面版**：在 `ncm.rs` 的 `call()` 里加一个分支（路径、参数、默认值与 npm 包一致），并在 `live_endpoints` 测试里加断言。
5. **前端**：在 `src/ncm.ts` 加函数，返回 `Track` / `TrackList` / `PlaylistInfo` 等统一结构；注意新老歌曲格式。
6. **验证**：`cargo test --lib -- --ignored`，再在浏览器里实际用一遍。
7. 更新本文档的接口清单和 `DEVLOG.md`。

---

## 12. 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `-460 检测到您的网络环境存在风险` | 走了 eapi，或请求头 / 设备 cookie 不完整 | 确认走 weapi；对照 npm 包最新的 `util/request.js` 检查 UA、cookie |
| `301` | 需要登录 | 检查 cookie 是否带上、是否过期（`account()` 返回 null） |
| 播放地址 `url` 为空 | 会员歌曲 / 无版权 | 正常现象，界面已有提示 |
| 只能听 30–45 秒 | `freeTrialInfo` 试听片段 | 需要会员账号 |
| 扫码一直停在 801 | 未扫码，或 key 过期 | 二维码过期（800）后点二维码刷新 |
| 频谱全 0 / 封面加载失败 | CDN 不再返回 CORS 头 | 见第 8 节 |
| 网页版正常、桌面版报错 | 网易云改了接口，npm 包已更新而 Rust 未跟进 | 对比 npm 包新旧版本的 `module/<接口名>.js` 和 `util/request.js`，同步到 `ncm.rs` |

**跟进上游**：

```bash
npm view NeteaseCloudMusicApi version   # 查看最新版本
npm install NeteaseCloudMusicApi@latest # 升级网页版依赖
```

升级后对比本项目用到的 18 个 `module/*.js` 和 `util/request.js`、`util/crypto.js` 的差异，有变化就同步到 `ncm.rs` 并跑联网测试。

---

## 13. 合规与安全

- 非官方接口，仅供个人学习使用；不要批量抓取，不要用于商业用途。
- 不伪造 IP 绕过风控，不经手账号密码。
- 中间层只开放白名单接口，并丢弃会改变请求去向的参数，防止被当成任意代理。
- 桌面版本地音频 / 封面协议只放行用户已添加路径内的音频文件（见 `src-tauri/src/library.rs`）。
