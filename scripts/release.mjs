// 发布桌面版：签名构建 NSIS 安装包，并生成自动更新清单 latest.json
//
// 用法：npm run release                 构建；下载地址默认指向本版本的 GitHub Release（由 tauri.conf.json 的 endpoints 推出）
//       npm run release -- --publish     构建后用 gh 创建 Release v<版本>，上传安装包和 latest.json（tag 需先推送）
//       npm run release -- --base <地址>  安装包放在别处时，指定其所在目录的公开地址
//
// 签名私钥默认读 %USERPROFILE%\.tauri\aurora-updater.key（可用环境变量 TAURI_SIGNING_PRIVATE_KEY 指定路径或内容）。
// 私钥丢失后，已安装的客户端将无法验证之后的更新 —— 请妥善备份，绝不要提交到仓库。
//
// 产物（src-tauri/target/release/bundle/nsis/）：
//   AURORA_<版本>_x64-setup.exe       安装包（也是更新包）
//   AURORA_<版本>_x64-setup.exe.sig   签名
//   latest.json                       更新清单：上传到 tauri.conf.json 里 plugins.updater.endpoints 指向的地址
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const key = process.env.TAURI_SIGNING_PRIVATE_KEY || join(homedir(), '.tauri', 'aurora-updater.key')
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !existsSync(key)) {
  console.error(`找不到签名私钥：${key}\n用 npx tauri signer generate -w "${key}" 生成，并把 .pub 的内容填进 tauri.conf.json 的 plugins.updater.pubkey`)
  process.exit(1)
}
// endpoints 形如 https://github.com/<用户>/<仓库>/releases/latest/download/latest.json
const conf = JSON.parse(readFileSync(join('src-tauri', 'tauri.conf.json'), 'utf8'))
const repo = (conf.plugins?.updater?.endpoints?.[0] || '').match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\//)?.[1]
const tag = `v${pkg.version}`
const base = (arg('--base') || process.env.AURORA_RELEASE_BASE
  || (repo ? `https://github.com/${repo}/releases/download/${tag}` : '')).replace(/\/+$/, '')
const publish = process.argv.includes('--publish')
if (publish && !repo) { console.error('--publish 只支持 GitHub：tauri.conf.json 的 endpoints 不是 GitHub Releases 地址'); process.exit(1) }

execSync('npx tauri build --bundles nsis', {
  stdio: 'inherit',
  env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '' },
})

const dir = join('src-tauri', 'target', 'release', 'bundle', 'nsis')
const exe = `AURORA_${pkg.version}_x64-setup.exe`
const signature = readFileSync(join(dir, `${exe}.sig`), 'utf8').trim()

// 更新说明取 DEVLOG.md 里本版本的小节
const log = readFileSync('DEVLOG.md', 'utf8')
const m = log.match(new RegExp(`### v${pkg.version.replace(/\./g, '\\.')}[^\\n]*\\n([\\s\\S]*?)(?=\\n##|\\n---)`))
const notes = m ? m[1].trim() : `AURORA v${pkg.version}`

const manifest = {
  version: pkg.version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: { 'windows-x86_64': { signature, url: base ? `${base}/${exe}` : exe } },
}
writeFileSync(join(dir, 'latest.json'), JSON.stringify(manifest, null, 2))
console.log(`\n已生成 ${join(dir, 'latest.json')}（下载地址 ${manifest.platforms['windows-x86_64'].url}）`)
if (!base) console.warn('⚠ 没有指定 --base：latest.json 里的下载地址只是文件名，上传前需要改成完整地址')

// gh 先建草稿、传完附件再正式发布，客户端不会看到只有清单没有安装包的 Release
if (publish) {
  const notesFile = join(dir, 'notes.md')
  writeFileSync(notesFile, notes)
  execSync(`gh release create ${tag} "${join(dir, exe)}" "${join(dir, 'latest.json')}" --repo ${repo} --verify-tag --title "AURORA ${tag}" --notes-file "${notesFile}"`, { stdio: 'inherit' })
  console.log(`\n已发布 https://github.com/${repo}/releases/tag/${tag}`)
}
