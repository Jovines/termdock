# 加密连接与 CLI 中继

手机直连沿用原密码登录页。浏览器使用现有密码完成 OPAQUE 双向证明，验证服务身份并授权设备，再建立 Noise 加密连接；密码及现有 scrypt 凭据不会随请求发送。设备身份在浏览器 IndexedDB 中保存，密码授权有效期为 30 天，修改密码或退出登录会使相关授权失效。

无密码服务保留直接进入的行为：首次通过 HTTPS 获取并固定服务身份，随后建立 Noise 连接。此开放模式首次信任依赖 HTTPS，不具备密码证明的独立身份保证；启用密码立即终止开放权限，开放身份不能创建持久授权。

分享访问使用“服务与设备 → 邀请设备”，选择只读、可操作或整服务权限，生成十分钟有效、只能使用一次的链接和二维码。接收端打开链接后接受邀请，无需抄写服务 ID 或 JSON。服务端 CLI 的 `termdock --federation-pairing [--url https://service:9834]` 同样输出邀请链接和二维码，只有兼容旧工具时才使用 `--json`。CLI 配对码从本机 `~/.termdock/federation/pairing.json` 读取，通过可信方式分享。

下列配置是管理员启用跨服务路由的步骤，普通手机密码登录不需要配置它们。入口 B 配好 C 的路径后，在 B 的“添加服务”粘贴 C 的邀请链接；浏览器通过 B 请求通道，由 C 独立授权。

A 能访问 B、C，而 B、C 无法互通时，在 A 上运行：

```sh
chmod 600 relay.json
termdock --federation-relay relay.json
```

`relay.json` 示例（替换所有示例值）：

```json
{
  "entryUrl": "https://b.example",
  "relayToken": "replace-with-a-random-token-at-least-32-characters",
  "caPath": "trusted-ca.pem",
  "targets": [
    { "serviceId": "C-verified-service-identity", "url": "https://c.example", "caPath": "c-trusted-ca.pem" }
  ]
}
```

B 的 `~/.termdock/federation/routes.json` 配置对应 `{ "relays": [{ "id": "A", "token": "同一个随机令牌", "targets": ["C-verified-service-identity"] }] }`。配置文件含凭据，使用 `0600` 权限。中继令牌只允许登记和转发已列出的目标，不授予任何目标终端权限。

URL 仅接受 HTTPS/WSS，证书和主机名必须验证，不允许跳转。`caPath` 可省略以使用系统信任；设置时使用指定 CA，路径相对于配置文件，目标可单独覆盖 CA。禁止通过关闭证书校验绕过错误。

进程持续运行并在连接中断后退避重试。SIGINT/SIGTERM 关闭活动通道；A 休眠或退出时依赖它的访问失效。目标身份、配对和端到端加密在客户端与 C 之间完成，中继只传递加密载荷。

配对及授权 UI 支持整服务完整权限，或指定后端 Session 的查看、输入、尺寸和终止权限。输入权限可以执行该终端系统用户有权运行的命令。活动通道必须在目标持续检查授权，撤销后不可继续使用旧流。

普通 PWA 仍须信任代码来源。应用层加密不能阻止被替换的前端在加密前读取输入；不能把普通 PWA 宣传为可抵御主动替换前端代码的 HTTPS 代理。

运行时要求 Node.js 22 或更新版本。加密实现使用 `@chainsafe/libp2p-noise` 17.0.0 与 Ed25519 设备身份，密码证明使用 `@serenity-kit/opaque` 1.1.0。连接达到 60 分钟或任一方向 512 MiB 时关闭，重连重新握手；不重放未确认的终端输入。HTTP 上传按块背压，最大 110 MiB。服务端身份文件权限为 `0600`；浏览器密钥可被同源代码使用，不宣称硬件不可导出保护。

HTML 预览先经加密通道读取资源，再在独立 opaque 沙箱显示；支持经典脚本、CSS 引用、图片及预览目录内的 `fetch`。当前安全预览不支持 ES 模块、Worker、XHR、嵌套 iframe 和表单提交，遇到这些资源会显示限制提示。真实浏览器已验证预览脚本无法直接访问业务 API。

验证包含真实浏览器密码登录、Service Worker 下的登录、邀请接收及活动流撤销，真实 Noise/WebSocket 的直连和中继、100 MiB 上传，以及 Web/Server/Desktop 构建。macOS 签名安装包、真机 iOS 前后台和 Mac 休眠尚未在对应设备验收；普通 PWA 的代码来源限制不会因这些功能上线而消失。

## macOS 自动中继

需要 Mac 在应用运行期间承担中继时，将上述 CLI 配置显式保存为 `~/.termdock/federation/relay.json`，设置 `chmod 600` 后重新打开 Termdock。Mac 主进程使用同一 Runtime CLI 启动中继，日志保存在同目录 `relay.log`；关闭单个窗口不影响它，退出应用会发送 SIGTERM 停止中继。网络重连由 CLI 负责。

此文件不存在时不会启动中继，也不会从已保存的 Mac 服务连接自动复制凭据或共享权限。修改配置后重启应用；移除配置后重启即可禁用。Mac 和 Runtime 都需升级到包含该 CLI 能力的版本。

## 入口服务直接访问目标

B 能直接访问 C 时，可在 B 的 `~/.termdock/federation/routes.json` 增加固定的 `directTargets`，无需运行 A：

```json
{
  "relays": [],
  "directTargets": [
    { "serviceId": "C-verified-service-identity", "url": "https://c.example", "caPath": "c-trusted-ca.pem" }
  ]
}
```

`caPath` 按入口配置目录解析。仅接受 HTTPS/WSS 服务地址或精确的 `/api/federation/secure` 路径；不接受客户端提供的任意目标 URL。实际访问路径为手机 → B → C，目标 C 仍独立验证手机身份和权限，B 只转发端到端密文。每次打开通道时连接 C，配置已登记不代表 C 当前在线；目标断线会关闭该通道。

修改 `directTargets` 后重启入口服务。客户端以稳定服务身份隔离标签页、文件状态和终端缓存；第一次验证本入口的直接服务时迁移升级前的标签页状态。工作组仍保留旧 origin 标识，并用已验证服务目录映射；工作组服务间消息同步和磁盘静态加密不在此次传输改造范围内。

## 保留多个服务工作区

左侧栏使用公共服务切换器。macOS 通过原生桥接聚焦已有窗口；已固定身份的同一服务使用备用地址时优先复用现有窗口，不迁移或清除原存储分区。PWA 保留入口文档，并通过同源 `/workspace.html?termdock-workspace=<peerId>` 创建其他工作区，每个工作区拥有独立的 JavaScript 上下文、加密客户端和按服务身份划分的状态。常规切换不再整页刷新；首次授权时仍可能需要一次刷新来建立初始存储归属。

工作区地址只包含已保存的服务身份，目标地址和路线从本机服务目录读取；不加载目标服务的远程 HTML，不传递原生凭据，也不共享各服务的业务请求客户端。Service Worker 仅将这个固定应用入口识别为额外的业务请求所有者，预览文档仍受原有目标身份和预览路径约束。下载、通知跳转和手机键盘尺寸也按工作区处理。后台工作区暂停终端画面订阅，远端终端继续运行；系统回收整个 PWA 后，仍需恢复连接和缓存内容。

连接优先采用最近十分钟内成功的路线，慢路线在 400ms 后允许另一条已登记路线参与连接，最多同时两条；一次性配对保持串行，已验证的授权拒绝会停止当前连接尝试。前台恢复不再按后台停留时长直接断开连接，先进行有超时的权限检查，失败后快速重试并逐步退避。自动重连不能重新添加用户在其他工作区移除的服务。

本轮优化按用户要求不运行测试，构建检查与实际功能验收分开记录。真实 macOS/iOS 的工作区切换、前后台恢复、输入、上传下载、预览和通知路径仍待用户实机验收，不以编译成功代替功能验收。
