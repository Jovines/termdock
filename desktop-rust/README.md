# Termdock Rust Preview

Rust/Tauri 桌面客户端，使用 Web/xterm 终端，并复用现有 React 工作区与连接中心。源码已合入 master。

目前作为 `Termdock Preview` / `com.jovines.termdock.preview` 独立安装，与正式 Electron App 并存。Preview 的桌面版本及更新渠道独立于正式 App 和 Node CLI/服务端。

## 构建

需要 Node 22+、Rust 1.93、对应系统 WebView 开发依赖；macOS 最低 14。

```sh
npm ci --ignore-scripts
npm ci --prefix desktop-rust
npm --prefix desktop-rust run verify
npm --prefix desktop-rust run build
```

`--ignore-scripts` 避免根项目 postinstall 初始化用户服务。构建入口准备 React 客户端与连接中心；签名 App 包含完整工作区，不依赖目标服务的旧前端资源。

公开 Preview 的版本、签名更新包和渠道指针按 [发布契约](RELEASE.md) 生成与发布；普通本地构建没有发布密钥也能运行，但不能冒称已配置自动更新。用户确认稳定后，按同一契约将 Rust 转为正式版，并验证旧 Electron 到 Rust 的直接升级链路。

## 行为边界

- 每个服务保持独立 loopback origin、profile 与页面设备身份；首次导入正式书签/偏好，不导入私钥、授权、cookie、证书信任。
- 密码与业务加密保留现有 OPAQUE/Noise 页面协议；原生桥只读本机数据，上传仍由当前页面加密完成。
- 桌面与浏览器复用同一套 Web 终端、输入法、剪贴板与路径交互。
- GUI 更新不停止服务或 PTY。CLI/服务 Runtime 更新与桌面 App 更新分别呈现。
- 源码测试、浏览器测试、原生受控窗口测试与用户实际交互验收分别报告；本地已签名开发构建不等于公证发布或完整 UX 通过。

## 窗口诊断

`--window-chrome-check NEW_ABSOLUTE_DIRECTORY LOOPBACK_ORIGIN FIXTURE_DESCRIPTOR` 保留独立窗口框架诊断，使用全新的私有配置目录和非生产 loopback 服务。描述文件必须明确启用 `controlledWindowChrome` 并提供对应服务身份；不会读取用户书签或连接生产端口。

## GitHub Actions

[macOS Rust client](../.github/workflows/macos-preview.yml) 在相关 master 推送、PR 和手动触发时，使用 GitHub 的 macOS Apple Silicon runner 编译。工作流运行终端/桥接回归、Rust 测试，构建内嵌工作区并上传 `macos-arm64-test-SHA` artifact；其中 App 为临时签名测试包，未公证，不进入 Preview 自动更新源。

正式 Preview 的 Developer ID 签名、公证和更新密钥仍按 [发布契约](RELEASE.md) 在受控发布环境执行。后续将该步骤迁入 GitHub 前，须在 Actions Secrets 配置现有 Developer ID `.p12` 与密码、Apple 公证 API key，以及**同一套** Preview updater 私钥/公钥，不能生成新密钥替换已有更新信任链。

[Publish verified Preview draft](../.github/workflows/promote-preview.yml) 接收已有公证草稿的版本与精确源码 SHA，核对实际 Git 标签、安装包摘要和公证记录后公开版本并更新 Preview 渠道。它不负责导入签名私钥或执行公证，也不修改既有版本标签。GitHub 的 `target_commitish` 在标签已存在时只是创建提示；发布校验以实际标签解析出的 commit 为准。
