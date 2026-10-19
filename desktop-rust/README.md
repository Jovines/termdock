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
