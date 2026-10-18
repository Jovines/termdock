# Rust Preview 与正式版发布契约

## 当前阶段：独立 Preview

Rust Preview 已合入 master，但合并源码不等于发布安装包或切换正式版。

| 项目 | 正式版（当前 Electron） | Rust Preview |
| --- | --- | --- |
| 应用名称 | Termdock | Termdock Preview |
| Bundle ID | com.jovines.termdock | com.jovines.termdock.preview |
| 版本 | 根 package.json 正式版本 | 独立数字版本，例如 0.1.1、0.1.2 |
| GitHub Release | 正式 release | preview-v0.1.1 等 prerelease；不能标记 latest |
| 更新格式 | 既有 Electron/Squirrel ZIP feed | Tauri 签名 .app.tar.gz + preview.json |
| 更新源 | 既有正式更新源 | preview-channel Release 的 preview.json |
| 桌面配置 | ~/.termdock/desktop.json 等既有路径 | Preview app_config_dir 下 connections.json 与独立 WebView profile |

Preview 只从构建时固定的 HTTPS manifest 和公钥接受更新；页面和服务不能替换它们。
首次安装导入正式版书签/偏好，但不复制设备私钥、授权、cookie、证书信任。
两种 App 可并存，连接同一个已有服务；更新 App 不代表更新 CLI/服务，也不能停止 daemon 或 PTY。

## 生成 Preview 发布产物

在配置好的 macOS 构建环境、干净精确提交执行：

```sh
npm ci --ignore-scripts
npm ci --prefix desktop-rust
# 从机器私有发布配置加载；不得提交密钥或在命令行展开它们：
# TERMDOCK_PREVIEW_UPDATE_PUBLIC_KEY（独立 Preview updater 公钥，base64）
# TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD
# APPLE_SIGNING_IDENTITY（Developer ID Application）
npm --prefix desktop-rust run package:preview -- 0.1.1 /absolute/new/output-directory
```

该入口固定 Preview 名称、Bundle ID、独立版本、更新源，开启 updater artifacts，构建 App/DMG，核对签名与包身份，再输出版本资产、`preview.json` 和含源码 revision/SHA-256 的 `release.json`。不会发布、安装 App、启动或停止服务。发布公钥与当前客户端内置公钥必须匹配；密钥轮换须先让旧公钥签名的客户端接纳新公钥，不能直接替换渠道信任。

每个已发布 Preview 的版本都必须递增。多个架构需要分别构建、核对版本/公钥一致，再合并 manifest 的 platforms；不能把单架构资产冒充 universal。

发布步骤：

1. 按 macOS 发布技能完成签名、公证及包内资源/minOS 检查；记录实际公证状态，不能将 ad-hoc 本地测试包当正式分发包。
2. 为精确 revision 创建 `preview-v版本` **draft prerelease**，上传 DMG、`.app.tar.gz`、`.sig`、`preview.json`、`release.json`，核对远端每项大小和 SHA-256；确认后公开 prerelease，保持正式 latest 不变。
3. 版本资产可下载且摘要匹配后，才将该 manifest 更新到专用 `preview-channel` prerelease 的 `preview.json`。这是唯一允许替换的渠道指针；已公开的版本资产不覆盖。
4. 从上一版已签名 Preview 实际检查更新、下载验签、安装重启，确认仍是 Preview 身份和独立配置，连接/会话保留、正式 App 未变。随后再对新用户验证首次安装。

当前本地开发安装包没有发布通道公钥；新增发布配置不能让这些旧包凭空具备信任。首个带公钥的已签名 Preview 需要安装一次，此后同一独立渠道可以持续更新。

## 用户确认稳定后：Rust 接替正式版

**只有用户明确确认稳定并要求转正，才执行切换。** Preview 期间不向正式用户推送 Rust 实验版。

转正不是将 Preview 应用改个名字后上传；必须完成一次跨引擎升级：

- 构建正式 Rust `Termdock.app`，使用 `com.jovines.termdock`、正式 Developer ID 团队/签名要求，版本高于当时线上正式版，最低系统与架构符合受影响用户范围。
- 保持正式版更新入口。为旧 Electron/Squirrel 提供其能验证和安装的正式 ZIP/feed；不能把 Preview 的 Tauri `.app.tar.gz` 直接交给旧更新器。必要时先发布兼容过渡版本。
- 新 Rust 正式版内置正式 Tauri updater 渠道/信任，完成“旧 Electron 更新一次成为 Rust，之后 Rust 持续独立更新”的交接。现有 Preview updater 的 Preview 身份限制不能被移除来冒充这一步。
- 正式配置迁移保留连接、偏好和可安全复用的数据，旧数据先备份；Electron Chromium 与 WKWebView 的 profile、IndexedDB 及系统权限不假定兼容。不能在未实测时承诺所有登录态自动继承，也不能通过复制私钥/放松证书校验绕过重新授权。
- 从真实已安装旧正式版完成升级验收：检查旧更新器接受签名与 ZIP、落盘/重启后是 Rust 正式身份、书签与偏好迁移、服务/PTY 不被关闭、后续 Rust 更新及失败恢复。覆盖已有用户与首次安装。
- 正式升级链路通过后再停止 Preview 发布；Preview 用户通过单独、明确的迁移路径转正式版并备份配置，不能把 Preview 包直接改名覆盖正式安装。

在跨引擎升级实际通过前，只能报告“已准备转正机制/产物”，不能报告“线上 Electron 已可无缝更新为 Rust”。

实现所用更新协议参考：[Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)、[Tauri updater](https://v2.tauri.app/plugin/updater/)。
