# Termdock Rust Preview

Rust/Tauri 桌面客户端，使用嵌入式 Ghostty 原生终端，并复用现有 React 工作区与连接中心。源码已合入 master。

目前作为 `Termdock Preview` / `com.jovines.termdock.preview` 独立安装，与正式 Electron App 并存。Preview 的桌面版本及更新渠道独立于正式 App 和 Node CLI/服务端。

## 构建

需要 Node 22+、Rust 1.93、对应系统 WebView 开发依赖；macOS 最低 14。

```sh
npm ci --ignore-scripts
npm ci --prefix desktop-rust
npm --prefix desktop-rust run verify
npm --prefix desktop-rust run build
```

`--ignore-scripts` 避免根项目 postinstall 初始化用户服务。构建入口准备 React 客户端、锁定 Ghostty 和字体资源；签名 App 包含完整工作区，不依赖目标服务的旧前端资源。已有 Ghostty 构建可通过机器本地 `TERMDOCK_GHOSTTY_PREFIX` 复用。

公开 Preview 的版本、签名更新包和渠道指针按 [发布契约](RELEASE.md) 生成与发布；普通本地构建没有发布密钥也能运行，但不能冒称已配置自动更新。用户确认稳定后，按同一契约将 Rust 转为正式版，并验证旧 Electron 到 Rust 的直接升级链路。

## 行为边界

- 每个服务保持独立 loopback origin、profile 与页面设备身份；首次导入正式书签/偏好，不导入私钥、授权、cookie、证书信任。
- 密码与业务加密保留现有 OPAQUE/Noise 页面协议；原生桥只读本机数据，上传仍由当前页面加密完成。
- Ghostty 输入、输出消费 ACK、恢复和浮层裁剪按页面/窗口/会话所有权隔离。普通浏览器仍使用 Web 终端。
- GUI 更新不停止服务或 PTY。CLI/服务 Runtime 更新与桌面 App 更新分别呈现。
- 源码测试、浏览器测试、原生受控窗口测试与用户实际交互验收分别报告；本地已签名开发构建不等于公证发布或完整 UX 通过。

原生终端及历史验收记录见 [NATIVE-INTEGRATION.md](NATIVE-INTEGRATION.md) 和 [native-terminal/README.md](native-terminal/README.md)。

### 原生终端鼠标选择

普通左键拖动优先在 Mac 本地选择终端文字，选中后使用 `⌘C` 复制；远端程序启用鼠标捕获时也适用。单击和滚轮仍传给程序。需要 Vim 等程序处理拖动时，按住 `⌥ Option` 再拖动。`Shift` 拖选保持可用。
