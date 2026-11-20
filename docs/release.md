# 桌面版发布与自动更新

桌面版（Tauri）用 `tauri-plugin-updater` 自动更新：客户端启动 4 秒后静默检查一次，托盘菜单"检查更新"可手动检查；发现新版本时标题栏出现"新版本 vX · 点击更新"，点击后下载、校验签名、安装（NSIS 被动模式），完成后自动重启。

> 发布渠道：GitHub Releases（[SakuraPure/aurora-player](https://github.com/SakuraPure/aurora-player/releases)）。客户端检查 `https://github.com/SakuraPure/aurora-player/releases/latest/download/latest.json`，即最新一个正式（非草稿、非预发布）Release 里的清单。
> 0.9.1 是第一个带更新源的版本，0.9.0 及更早的版本需要手动安装一次。

---

## 1. 签名密钥

- 私钥：`%USERPROFILE%\.tauri\aurora-updater.key`（无密码）；公钥：同目录 `aurora-updater.key.pub`，内容已写进 `tauri.conf.json` 的 `plugins.updater.pubkey`。
- **私钥绝不能提交到仓库**，也不要发给别人：拿到私钥就能给所有已安装的客户端推送任意"更新"。
- **一定要备份私钥**：丢失后，已安装的客户端无法再验证新的更新包，只能让用户手动下载安装新版（带新公钥的版本）。
- 换密钥：`npx tauri signer generate -w <路径>` 生成新的一对，更新 `pubkey`；之后的版本需要用户手动安装一次。

客户端校验的内容：更新包的 minisign 签名必须能用内置公钥验证，且**签名时的版本号必须等于清单里声明的版本号**（防止篡改清单把旧包当新版推送）。

## 2. 发布一个新版本

1. 改版本号：`package.json` 的 `version` 与 `src-tauri/Cargo.toml` 的 `version`（`tauri.conf.json` 直接读取 `package.json`）。
2. 在 `DEVLOG.md` 写好本版本的 `### vX.Y.Z ...` 小节 —— 发布脚本会把它作为更新说明。
3. 提交，打 tag 并推送：

   ```bash
   git commit -am "..." && git tag v<版本> && git push origin main v<版本>
   ```

4. 构建并发布：

   ```bash
   npm run release -- --publish
   ```

   脚本会带上签名私钥执行 `tauri build --bundles nsis`，在 `src-tauri/target/release/bundle/nsis/` 生成下表的文件；
   下载地址默认是 `https://github.com/<用户>/<仓库>/releases/download/v<版本>/<安装包>`（仓库由 `endpoints` 推出）。
   `--publish` 再用 `gh release create v<版本> --verify-tag` 新建 Release、上传安装包和 `latest.json`，更新说明同时作为 Release 正文。
   gh 先建草稿、附件传完才正式发布，所以客户端不会拿到"有清单、没安装包"的 Release。

   | 文件 | 用途 |
   | --- | --- |
   | `AURORA_<版本>_x64-setup.exe` | 安装包，也是更新包 |
   | `AURORA_<版本>_x64-setup.exe.sig` | 签名（内容已写进 latest.json，不需要单独上传） |
   | `latest.json` | 更新清单：版本、更新说明、发布时间、下载地址、签名 |

   不加 `--publish` 只构建，可以先在本地检查，再手动上传（先传安装包、后传清单）。

5. 验证：`curl -L https://github.com/<用户>/<仓库>/releases/latest/download/latest.json` 应返回新版本号。

> 注意：`createUpdaterArtifacts` 已开启，直接运行 `npx tauri build` 而不提供私钥会构建失败，请用 `npm run release`。

## 3. 发布渠道

当前使用 **GitHub Releases**（免费、带 HTTPS、有"最新版"固定链接）：

- `tauri.conf.json`：

  ```json
  "plugins": { "updater": { "endpoints": ["https://github.com/SakuraPure/aurora-player/releases/latest/download/latest.json"] } }
  ```

- 仓库必须公开：私有仓库的 Release 附件不能匿名下载，客户端取不到更新。
- 发预发布版（Pre-release）不会推送给客户端 —— `releases/latest` 只指向正式版。
- 撤回有问题的版本：把它改成草稿或删除，`latest` 会回到上一个正式版；但已经更新的客户端不会降级，修复只能再发一个更高的版本。

换成别的渠道（任意支持 HTTPS 的静态文件服务器 / 对象存储）：`endpoints` 指向 `latest.json`，发布时用 `--base` 指定安装包所在目录。生产环境必须是 HTTPS。
换渠道后，**第一个带新地址的版本要从旧渠道发布**（或让用户手动安装），之后的版本才会走新地址。

## 4. 本地测试更新流程（不影响已安装的客户端）

1. `npm run release -- --base http://127.0.0.1:8765` 构建出带签名的安装包和 `latest.json`。
2. 把安装包和 `latest.json` 复制到一个临时目录，`python -m http.server 8765 --bind 127.0.0.1` 提供下载。
3. 写一个临时配置文件（不要放进仓库）：

   ```json
   {
     "identifier": "com.aurora.player.dev",
     "version": "0.0.1",
     "plugins": { "updater": { "endpoints": ["http://127.0.0.1:8765/latest.json"], "dangerousInsecureTransportProtocol": true } }
   }
   ```

   - `identifier` 换成单独的，开发版就用自己的数据目录，不会碰到已安装客户端的登录、曲库和窗口记忆；
   - `version` 设得比清单低，客户端才会认为有更新。

4. `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 npx tauri dev --config <临时配置>`，通过 CDP 调用 `check()`、`download()`（只下载并校验签名，不安装）。
5. 测完删除 `%APPDATA%\com.aurora.player.dev` 和 `%LOCALAPPDATA%\com.aurora.player.dev`。

## 5. 相关的桌面外壳行为

| 功能 | 实现 |
| --- | --- |
| 关闭窗口 | 隐藏到托盘，音乐继续；托盘菜单"退出 AURORA"才真正退出（`src-tauri/src/lib.rs` 的 `on_window_event`） |
| 托盘 | 左键单击显示主窗口；右键菜单：播放 / 暂停、上一首、下一首、迷你模式、显示主窗口、检查更新、退出；悬停显示当前歌曲（`src-tauri/src/shell.rs`） |
| 迷你模式 | 400×96 置顶小窗，默认在屏幕右下角；只保留封面、标题、上一首 / 播放 / 下一首、返回按钮，波形在背后；拖动播放条可移动窗口 |
| 窗口记忆 | `tauri-plugin-window-state` 记住大小、位置、是否最大化；退出时若在迷你模式，先恢复普通窗口再保存 |
| 媒体键 | 全局快捷键插件注册播放 / 暂停、上一首、下一首 |
