# Termdock Preview 桌面体验迁移

Preview 与稳定 Electron App 并存，保留独立名称及 `com.jovines.termdock.preview` 身份。运行时使用本任务源码构建的现有 React 工作区，连接中心和浮窗直接复用 `desktop/renderer`，不另做布局。Node 服务端和 OPAQUE/Noise 算法无修改；不部署 9834，不安装或升级已有 Node 服务，不合入主仓库。

本任务交付可独立评审的客户端实现。真实 macOS 视觉、不同焦点下的按键、IME、原生通知及最终原生终端整合仍需唯一 Mac 集成成员验收；源码或 Chromium 通过不代表体验已无差异。用户目标 Mac 已停止一切访问，后续只在配置构建 Mac 验证。

## 构建与资源核对

需要根项目 Node 22+ 依赖、Rust 1.93 和 WebView 系统依赖；macOS 最低 14。Tauri 锁定 2.12.3。

```sh
npm ci --ignore-scripts
npm ci --prefix desktop-rust
npm --prefix desktop-rust run verify
npm --prefix desktop-rust run build
# 唯一 Mac 集成成员在干净提交/隔离构建目录运行：
npm --prefix desktop-rust run package:mac
```

根项目安装依赖必须使用 `--ignore-scripts`，避免既有 postinstall 启动 PTY 或写入用户 `.termdock` marker；构建前端无需执行该服务初始化脚本。

`build`、`dev`、`package:mac` 都实际执行 `prepare:workspace`：先构建现有 React 客户端，再复制到被忽略的 `.workspace-dist`，包含字体、worker、HTML preview shell 和原有 FFmpeg 压缩资源。`package:mac` 拒绝源码 WIP。Git archive 构建需设置 `TERMDOCK_PREVIEW_SOURCE_REVISION=<精确40位提交>`。诊断、截图及生成资源不入库，运行时资源由 Tauri `bundle.resources` 装入签名 App 的 `workspace/`。

`workspace/workspace-manifest.json` 记录源码 revision、dirty 标志、客户端版本，以及每个运行资源的大小和 SHA-256；开发 WIP 另记录 diff hash。正式包必须来自 clean revision，核对包内 manifest 与本次构建输出一致。Rust 只提供 manifest 中列出的规范路径，检查 canonical root、大小和 hash；缺失、篡改、编码穿越或符号链接越界均失败关闭，不回远端旧 HTML/JS，不混用两套资源，不提供通用文件系统代理。资源 map、压缩副本不打包。Preview 构建读取同一源码 vite 的 globPatterns/includeAssets，用实际生成 SW 的 AST 固定大小写匹配；APFS 不能把 `app-*` 额外匹配到大型 `App-*` 工作区模块。后者仍完整打包并在原 lazy CacheFirst 路径首次使用时缓存，后台 importScripts 保持。平台 minifier 可使 SW 字节不同，必须逐个资源对账，不能拿 Linux hash 冒充 Mac hash。

图标继续由 Rust build.rs 在 Tauri codegen 前把稳定原 PNG 的 RGBA16 转为 Preview 专用 RGBA8；原 PNG 与稳定 ICNS 无修改。独立启动修复提交为 `dd3078f8d7e54225050ed7300a08e52c53247a4a`，已由唯一 Mac 操作者确认真实目标启动和可见窗口，不能据此认定完整体验通过。

## 连接、身份与加密边界

每个目标保持独立持久 loopback origin、窗口 label、WebView profile 和页面 IndexedDB 身份。URL-only 首次登录学到目标 peer 后保留原 profile/端口。端口被占用明确报错，不随机换 origin。Preview 独立配置原子写入，首次仅导入稳定书签、最后连接、窗口记录及桌面偏好，不导入私钥、授权、cookie 或证书信任。

boot 目标、路由和桥在模块导入前初始化。`getServiceConnection()` 返回实际目标 origin/name；授权页显示目标而非物理代理端口或入口节点，异步旧结果不能覆盖新选择。普通浏览器和旧 Electron 无 Preview 方法时保持旧逻辑；实际目标本来是 loopback 时仍显示该真实地址。

原生 HTTP 只允许精确 public metadata/open/auth parameters，以及原有 OPAQUE `/api/auth/password/start`、`finish` 的 proof JSON；字段白名单、请求/响应大小限制、原服务限流/TTL继续生效。只为这两个 POST 注入已批准 source origin，页面实际 `passwordBootstrapOrigin()` 使用同一绑定。密码、hash、private keys 全留页面，Rust不计算或保存。无明文业务 fallback、ambient cookie/Authorization 转发或任意 Origin override。

窗口 Host、Origin、HttpOnly/SameSite cookie、精确 IPC 主页 URL 和目标/入口/备用路由均保留。HTTPS使用系统与Mozilla根，已有独立 origin leaf pin 仍校验真实握手签名，不能全局关闭 TLS 校验。稳定版信任不自动复制；未受信或变化证书明确拒绝。已有本机 daemon 的公开证书仅对匹配 server.json 的本机 origin 使用。

页面业务继续使用加密 fetch/secureSocket。原生 WebSocket 只原样传输 secure/relay，两者不携带环境 Origin/cookie/Authorization，不替页面申请 route ticket 或解密。Service Worker 注册保持启用，其后台 WebSocket 使用同一精确路由；首次无控制、后续受控、取消与断线均不回退普通 HTTP。预览 iframe 仍为 `sandbox="allow-scripts"`，仅 trusted preview shell 使用精确 same-origin ancestor；子文档无原生桥或父页存储权限。

| 目标服务/客户端矩阵 | 实际行为与证据 |
| --- | --- |
| 固定旧服务源码 79feaf2，protocolVersion=1，既有 capabilities | 生产 bundle URL-only、首次 selected=null/noSW、真实旧 HTTP OPAQUE、同页面 deviceIdentity 后续 Noise 与重载/SW通过；不要求服务升级 |
| 同一旧服务，仅入口可达 | 原有邀请 UI 消耗一次 route grant，再申请实际 route ticket；目标 Noise 中密码授权，错误密码不 grant，正确密码后业务通过；未手填 peer ID |
| 已保存 pinned target / legacy 有 Noise 密码协议 | 使用现有页面 pinned Noise 验证及权限结果；不依赖新增服务字段 |
| public metadata 未声明受支持的 protocolVersion=1/terminal-ws，或实际 proof/packet 不支持 | 明确失败关闭；版本号本身不授予权限，不退回明文；未测试的更早服务不能声称兼容 |
| 普通浏览器 / 旧 preload 无 Preview hook | 原 location.origin OPAQUE 绑定和现有页面加密上传保持，旧上传器不抢先执行 |

## 实际体验差异与复测

运行基线由 xq 在构建 Mac 采集：安装的稳定 App 为 1.4.298；对照的仓库 Electron 为 1.4.320，两者分别记录。AX实读发现 Preview 默认英文菜单、缺业务项，CmdW关闭窗口而不是会话。首次 File 空项输出已纠正：实际有 Close Window/Close All。构建 Mac 锁屏且无屏录权限，不能可靠注入按键、观察窗口/IME，不绕过锁屏或 TCC。

xq 后续真实签名 `8c3568f` 包启动进程存活超过75秒，越过 updater 配置初始化故障；AX 确认中文业务菜单及关闭当前会话等绑定恢复。仍观察到放大没有有效 accelerator、窗口缺 Bring All to Front：后续源在主线程将 AppKit keyEquivalent 修正为逻辑字符 `+` 与 Command（Tauri 物理键解析会静默忽略无效的 `Plus` 键名；NumpadAdd 不作为 Mac 最终绑定），并复用系统 bring-all-to-front role。修后真实 AX/启动复测待唯一 Mac 操作者回传，不能用源配置代替实际按键与视觉通过。后续根据完整AX恢复旧版OS角色原标签（Undo/Redo/Cut/Copy/Paste/Select All、Reload/Force Reload/Actual Size/Zoom In/Zoom Out、Minimize/Zoom及全屏）和原分组分隔线，中文业务项不变。xq更正后的真实plist显示稳定版无语言声明、Preview默认DevelopmentRegion=English；Preview声明en/zh-Hans/zh-Hant供AppKit自动注入菜单按用户语言选择，不能据plist宣称自动填充/听写/表情文案已匹配。通知 completion 改弱引用 center、主线程回调内取得强引用，避免 center 持有 completion 时的 ARC retain-cycle 告警；实际系统投递仍待验收。

| 原版路径与 Preview 原差异 | 对应实现/复现与作者复测 | Mac 待验证 |
| --- | --- | --- |
| 连接中心布局/反馈不同，缺环境引导 | prepare-renderer 复用原 index/app/styles/services；local_service 只读探测已有 daemon，原按钮显式安装/启动 CLI，退出不停止它，缺Node后重试重新探测 | 本机/远端添加、编辑、删除、取消、最后连接和窗口恢复 |
| 工作区 UI/字体/chrome 不同 | 自带同源 React 构建、原 chrome CSS、同字体资源；SecureAccessGate 原目标展示和组件卸载/新选择竞态回归通过 | 标题栏、主题、间距、尺寸/位置、resize/全屏、多显示器 |
| 中文菜单缺项，CmdW错误关闭整个窗口 | commands.json+desktop_ui 使用原菜单事件；⌘,设置、⌘N连接、⌘T新会话、⌘W关当前会话、⇧⌘[/]会话、⌥⌘[/]待处理、⌘B/⇧⌘B侧栏、reload/zoom/fullscreen、编辑roles | 菜单实际modifier/key展示；终端、搜索、输入框、分屏和不同窗口焦点下动作 |
| 无菜单栏/浮窗/跨服务状态 | 原托盘字形/聚合事实、context menu、原64/108/152浮窗，位置约束、非聚焦拖动、跨服务聚焦；不推断Agent内部状态或已读 | 点击/拖动、Mission Control/全屏、后台/休眠恢复、未读Dock |
| 文件/剪贴板缺原生入口 | native_desktop+local_files+bridge：Finder文件/原生movie/图片只读，只有当前pinned identity和本机公开identity都匹配才给路径；远端给字节，由当前页面加密上传 | Finder、各剪贴板来源、IME与文件错误反馈；实际媒体编码/预览 |
| 无真正原生通知 | UNUserNotificationCenter授权、tag替换、实际delivered记录后确认，拒绝/超时返回false；userInfo持久目标；聚焦等待页面ACK，重载重新投递未确认请求 | Developer ID签名Preview在新/旧用户，通知设置列表、横幅/提醒、真实投递/点击与Dock |
| 更新禁用 | build-pinned独立Preview HTTPS endpoint/pubkey；签名校验后再检查tar包Preview根目录/bundleID/version/路径，再显示ready和重启安装 | 实际独立更新资产与签名渠道尚待集成提供，未伪称current/更新通过 |
| Worker被关闭、首次授权受阻 | worker-transport精确Noise路由；实际bundle直连/入口授权、错误/断线、scope reload、SW受控和sandbox HTML通过 | WKWebView worker后台、通知回调、睡眠后重连及全部下载/拖拽/媒体真实窗口路径 |

独立更新格式为 Tauri updater HTTPS manifest + minisign 签名的 `Termdock Preview.app.tar.gz`。构建注入 `TERMDOCK_PREVIEW_UPDATE_ENDPOINT` / `TERMDOCK_PREVIEW_UPDATE_PUBLIC_KEY`；无渠道/公钥显示真实错误。生产插件以有效的无渠道配置初始化（空公钥表示未授权任何更新，不是假key），启动前将缺失/错误插件配置归一到安全默认并记录诊断；合法渠道只从build-pinned参数加载。真实插件测试覆盖打包generate_context的默认初始化、复现null Config错误、异常配置恢复和合法/非法endpoint、公钥，不要求用户填更新渠道才能启动。拒绝稳定 Electron 包、错误bundle ID/version、越界/重复路径及写入link子路径；不生成、存储或发布私钥。

## 可复现回归

文件与剪贴板只读桥保留50文件/128 MiB总量和页面ArrayBuffer接口，内部不再使用每字节JSON Value。Rust打开句柄并fstat，逐块核对长度、read_exact至多256 KiB，并在最后读取一个哨兵字节检查增长；截短、增长、越界索引/序列或回执重放均失败并释放会话。每块是一个有界base64字符串，下一块必须带上一块不可预测回执，防止把整个文件并发塞入IPC队列。窗口、页面epoch、当前路由与pinned target由宿主绑定；切换/重载/关闭前后均检查，不能把旧选择交给新目标。已验证本机服务路径仍需本机公开identity与当前pin双重匹配，传回前再次确认。

全局最多8个等待/执行请求、一个磁盘读取或剪贴板采集；最多8个活跃读会话且其预留页面缓冲区总量不超过128 MiB。空文件也占会话数。选择器先取得请求名额，不持有磁盘锁等待用户选文件。取消/AbortSignal、错误与pagehide释放句柄/临时目录；后台每5秒清理，30秒空闲或5分钟总寿命过期。UI生命周期回调不等待磁盘锁，窗口epoch立即失效；正在执行的OS读取完成后也会丢弃过期结果。未收到完整数据前页面不会开始上传，上传始终使用当前页面加密fetch。

macOS系统剪贴板提供原子NSData，没有流式尺寸预告，因此图片/movie在同一签名可执行文件的私有子进程中采集，主进程只接收最多256 KiB元数据。子进程不初始化Tauri窗口/配置或Node；采集前设置8秒CPU、10秒alarm及已有VM基线加512 MiB的地址空间限额，父进程每10ms采样自己的子进程RSS、384 MiB阈值终止，并检查窗口/目标及10秒时限。该RSS阈值是采样截止策略，不能当作瞬时峰值硬保证；实际macOS限制和包内IPC需唯一Mac操作者验证。异常/超限不向页面交付部分结果，仅终止本应用拥有的子进程。图片先检查尺寸（保留32 MiB RGBA8面积上限）再解码、直接编码PNG至私有临时目录；movie一次只保留一个系统NSData、累计至多128 MiB，直接落临时文件，避免base64/JSON/解码多份全量拷贝。跨窗口/目标、过期、错误或取消会清理这些目录。Linux回归验证桥契约、监督器和实际文件读链路，不冒充AppKit采集或macOS Tauri IPC通过。

实际模块的仓库外受限内存测量在`/tmp/termdock-preview-memory-fix`：2 MiB/8 MiB文件逐块完整读出并校验，地址空间64 MiB、CPU10秒，峰值RSS分别3676/3828 KiB，每次序列化最多349654bytes，无每字节Value。原只读评审2 MiB数字数组样本RSS77324 KiB、仅Value数组64 MiB；这些是读取模块进程的观测，不能外推完整桌面RSS。128 MiB真实边界另用稀疏文件完整分块遍历，不分配128 MiB或更大的Rust字节数组。生产bundle+固定79旧router Chromium两路新增实际Rust2 MiB读句柄→桥ArrayBuffer→同设备Noise multipart上传，业务监听器确认完整字节、断线不回明文；OS回调仍为测试适配。

```sh
cargo test --manifest-path desktop-rust/src-tauri/Cargo.toml --no-default-features --locked
node --test desktop-rust/renderer/bridge.test.mjs desktop-rust/scripts/workspace-sw.test.mjs
# 固定旧服务归档：从79feaf2 git archive解出源码并安装其锁定根依赖；不打客户端补丁。
TD_PREVIEW_OLD_SERVER_ROOT=/path/to/immutable-79feaf2 \
  cargo test --manifest-path desktop-rust/src-tauri/Cargo.toml --no-default-features --locked \
  --test bundled_workspace -- --ignored --nocapture
```

实际Chromium测试装载 `.workspace-dist` 和真实 bridge/lifecycle，经 Rust manifest proxy 到旧服务，使用原授权 UI、真实 OPAQUE/deviceIdentity/Noise。原生OS IPC目录/设备信息是测试适配，绝不称WKWebView/OS IPC通过。旧HTML被显式标记且不得出现，错误密码检查目标store零grant，业务只到解密后private listener。HTML sandbox验证无桥/不能读父存储；断线请求失败。该最小业务fixture未提供真实PTY，App仍可显示恢复终端加载状态，不用它宣称完整工作区体验通过。

锁定旧源码 revision：`79feaf2442dd71a06806cc652252e9a7db4b54fb`。fixture启动时实际核对：

- passwordLoginRoutes.ts：`17c214fdfbc87002d987d540487a7e94ac16cf18156978f7c52bb569156f94c2`
- passwordBootstrap.ts：`37516de21f762d8c3f66c84497cbdf6da3bff6b59dc65acc4ba31590da7d8942`
- runtime.ts：`c59ccc3f23bd1c4b9096ff386c48910a3e4308bc945f274bad69352b96455aa5`

客户端密码/授权显示/transportBoundary、图片粘贴、加密拖拽、下载与取消、HTML/媒体、后台连接/通知，以及Flexoki/z-index守卫回归通过。根tsc仍有两处原基线server测试错误，干净79feaf2归档同样复现；routing回归另有两处原native architecture fixture缺revision错误，也在干净基线复现，未越界修复。

## 原生终端集成接口

本任务不改 `native-terminal`，壳仍明示 `nativeTerminal.available=false`。`with_native_host` 为Tauri真实macOS主线程共同NSView入口；`termdockPreviewLifecycle.snapshot()/subscribe()` 提供焦点、隐藏、viewport与overlay矩形及resize触发，注销时清理监听器。它是接入触发，不能将 MutationObserver 通知当成 NSView 已隐藏确认。

最终唯一集成者须保留NativePanel !Send/!Sync主线程所有权；create绑定window/view/epoch/target/device/renderer与字体/页面Palette，raw write连续seq≤256KiB，仅pump HostEvent::Ack表示消费。隐藏仍pump；每次原生主操作后可能Backpressure，保留重试。overlay显示前先隐藏所有交叠native sibling并等确认，关闭后先set_rect(points/scale/zoom)，再visible/focus。Shortcut复用原页面菜单；PasteRequested通过本地只读桥后页面secure fetch上传；LayoutRequested重测。回放只用原始有序journal，禁止从xterm可见纯文本恢复PTY。IME、分屏、搜索、选择及overlay实际行为待集成Mac验收。
