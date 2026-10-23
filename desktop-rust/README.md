# Termdock Rust desktop

Rust/Tauri 桌面客户端，使用 Web/xterm 终端，并复用现有 React 工作区与连接中心。源码已合入 master。

正式客户端为 `Termdock` / `com.jovines.termdock`，要求 macOS 14+（Apple Silicon）。桌面版本及更新渠道独立于 Node CLI/服务端；`previewVersion` 仅用于最后一个迁移过渡版。

## 构建

需要 Node 22+、Rust 1.93、对应系统 WebView 开发依赖；macOS 最低 14。

```sh
npm ci --ignore-scripts
npm ci --prefix desktop-rust
npm --prefix desktop-rust run verify
npm --prefix desktop-rust run build
```

`--ignore-scripts` 避免根项目 postinstall 初始化用户服务。构建入口准备 React 客户端与连接中心；工作区优先加载所连接服务自己的前端，同一窗口的页面及静态资源保持同一来源；服务部署后重新加载即可更新界面。目标前端不可达（包括只能中转访问业务的目标）时，使用签名 App 内置的完整工作区备用，不加载入口或其他服务的页面。缺失资源及业务请求失败不会触发来源切换。

正式包、旧客户端兼容 ZIP、Preview 迁移及后续发版按 [发布契约](RELEASE.md) 执行。普通本地构建没有发布密钥也能运行，但不能冒称已配置自动更新。

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

[Build signed and notarized Preview](../.github/workflows/signed-preview.yml) 支持在 master 手动触发完整云端流程：测试、Developer ID 签名、App 与 DMG 公证和 staple、Gatekeeper 验证、内嵌源码与资源摘要校验。默认只上传验证后的 artifact；勾选 `publish` 才会创建精确源码标签和草稿、校验上传摘要、公开预览版并更新独立 Preview 渠道。发布前先递增桌面 Preview 版本，已有版本拒绝覆盖；不会替换稳定版 latest。

Actions Secrets 必须沿用现有签名身份及更新信任链：`APPLE_CERTIFICATE`（base64 `.p12`）、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_API_KEY`、`APPLE_API_ISSUER`、`APPLE_API_PRIVATE_KEY`（`.p8` 内容）、`TAURI_SIGNING_PRIVATE_KEY`、`TERMDOCK_PREVIEW_UPDATE_PUBLIC_KEY`，以及可选的 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。Tauri 在临时钥匙串导入发布证书；公证密钥写入 runner 临时文件并在结束时清理。普通 PR/推送检查不读取发布凭证。详见 [发布契约](RELEASE.md)。

[Publish verified Preview draft](../.github/workflows/promote-preview.yml) 接收已有公证草稿的版本与精确源码 SHA，核对实际 Git 标签、安装包摘要和公证记录后公开版本并更新 Preview 渠道。它不负责导入签名私钥或执行公证，也不修改既有版本标签。GitHub 的 `target_commitish` 在标签已存在时只是创建提示；发布校验以实际标签解析出的 commit 为准。
