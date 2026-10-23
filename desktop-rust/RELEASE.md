# Rust 正式版与旧客户端迁移

用户已确认 Rust 稳定并授权转正。正式版要求 **macOS 14+、Apple Silicon**。
桌面版本在 `desktop-rust/package.json` / lockfile / `src-tauri/tauri.conf.json`；
CLI/npm 版本独立。最后一个 Preview 版本取 `desktop-rust/package.json` 的 `previewVersion`。

## 一次性迁移

- 正式 Rust：`Termdock.app`、`com.jovines.termdock`，首版 `1.4.358`；正式可执行文件固定为 `Termdock`。
- Electron 兼容桥：固定 `1.4.357`，继续支持 macOS 12；新正式 Release 的旧式
  `Termdock-darwin-arm64-VERSION.zip` 始终携带这份已签名、公证的桥接 App。
  老客户端只认这种文件名，先更新为桥。桥在 macOS 14+ 下载并核验正式 Rust DMG；
  macOS 12/13 保留可运行客户端并提示升级系统，不重复下载桥接包。
  桥核对 DMG 的 SHA-256、签名团队、公证票据和应用身份后，由独立安装进程备份、
  原子替换并启动 Rust；失败恢复旧应用。Squirrel 会按可执行文件名重命名 App，
  且重启依赖新包中的 ShipIt，因此只用于第一跳兼容 ZIP，不直接安装 Rust 包。
- 最后一个 Preview：`0.1.14`，保留 Preview 身份，让已发布的 Preview 通过原公钥
  与 `preview-channel/preview.json` 正常验签更新。过渡版随后检查固定正式渠道，
  验证正式更新包及 Developer ID 团队，退出旧正式 GUI、备份旧 App，再安装并启动
  同目录的 `Termdock.app`。成功后旧 Preview 移至唯一 Trash 备份。
- 配置只导入连接与偏好；原配置保留并生成私有备份。已存在正式配置时保留其选择；
  不转移 cookie、设备私钥、端口、WebView profile 或证书信任，用户重新授权。
- 两条路径都不停止独立服务或终端 PTY。旧客户端升级、Preview 升级、后续 Rust
  更新、失败恢复和首次安装必须分别验收，不用一次成功 fetch 代替真实安装验证。

## 正常正式发版

以后只构建一个 Rust 正式版。兼容桥复用首次发布的不可变资产，不重新编译 Electron；
Preview 渠道永久保留最后过渡版，不能删除，也不继续发布常规 Preview。

1. 递增桌面三个版本文件。完成回归、根构建及桌面检查；按仓库规则显式暂存路径、
   提交并推送完整源码。发布源必须是干净且与 `origin/master` 一致的精确 SHA。
2. 将 `git archive HEAD` 传到本次独立 Mac 目录；设置
   `TERMDOCK_PREVIEW_SOURCE_REVISION=完整SHA`、`GITHUB_SHA=完整SHA`。
   从机器私有配置加载原 Developer ID、Apple API 和已有 Tauri updater 密钥；
   正式版与 Preview 沿用同一现有公钥，不能在迁移时生成或轮换密钥。
3. 在签名 Mac 执行：

   ```sh
   npm ci --ignore-scripts
   npm ci --ignore-scripts --prefix desktop-rust
   npm --prefix desktop-rust run package:stable -- VERSION /absolute/new/output
   python3 desktop-rust/scripts/notarize-preview.py /absolute/new/output \
     desktop-rust/src-tauri/target/release/bundle/macos/Termdock.app /absolute/build.log
   ```

   首次正式版通过 `TERMDOCK_LEGACY_BRIDGE_ZIP` 提供已公证的 `1.4.357` ZIP。
   后续脚本从 `v1.4.358` 的公开资产读取 GitHub SHA-256/size 并下载或复用本机缓存，
   公证验证器仍检查桥的签名、Gatekeeper、staple、版本及实际 Mach-O minOS 12。
   自定义 `CARGO_TARGET_DIR` 时同步调整 App 路径。
4. 公证验证器要求 App、DMG、Rust ZIP、Tauri 更新包的签名、公证票据、minOS 14、
   原 updater 公钥/正式 endpoint 和嵌入 workspace SHA/资源摘要全部通过。
   DMG 公证并 staple 后重算最终资产摘要；不得先签更新包再改其字节。
5. 传回独立 Linux 目录并比对摘要，删除临时 `build-config.json`，执行
   `python3 desktop-rust/scripts/stage-release.py /absolute/artifacts` 上传草稿。
   完成实际安装验收后执行：

   ```sh
   STABLE_VERSION=VERSION STABLE_REVISION=完整SHA \
     python3 desktop-rust/scripts/promote-stable.py
   ```

   推广器核对实际 Git 标签、全部上传资产 size/SHA-256、公证记录与平台身份，
   先公开非 prerelease 并设 Latest，再移动 `stable-channel/latest.json`。
   拒绝已发布版本替换和渠道回退。公开后核验真实下载 URL/feed 字节与本地产物一致。

## 正式 Release 资产

| 资产 | 消费者 |
| --- | --- |
| `Termdock_VERSION_aarch64.dmg` | macOS 14+ 首次安装 |
| `Termdock-Rust-darwin-arm64-VERSION.zip` | macOS 14+ 手动解压安装（不交给 Squirrel） |
| `Termdock-darwin-arm64-VERSION.zip` | 未迁移的旧 Electron，内容固定为兼容桥 |
| `Termdock_VERSION_aarch64.app.tar.gz` / `.sig` | Rust 正式版与最后 Preview 桥 |
| `latest.json` | 同时复制到 `stable-channel` 的正式 Tauri feed |
| `release.json` | 精确源码、包身份、公证收据与全部资产摘要 |

只验证构建或签名不能宣称发布成功；尚未完成的真实 macOS/iOS 路径应明确记录。
