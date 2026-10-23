# Termdock Agent 规则

仓库存在多人/多 Agent 并行改动。

## 加密通信改动验收

- 业务请求统一使用页面的加密 `fetch` / `secureSocket`；Electron preload
  的隔离世界、Service Worker 后台、`sendBeacon`、原生 XHR 和媒体元素不会
  自动继承页面的 fetch 包装。不得在失败时回退到直接 HTTP 业务接口。
- 原生桥接只负责读取本机数据；上传由当前服务页面完成。保留旧客户端兼容时，
  必须测试旧 preload 不会抢先上传，以及本地入口中转远端时不会误插入本机路径。
- 修改通信层后，按入口验证：终端输入与重连、图片粘贴、文件拖拽、下载与取消、
  图片/视频/HTML 预览、通知后台回调；同时覆盖直连和只能经入口中转的目标。
- 测试必须包含首次加载（无 Service Worker 控制）、断线失败和旧客户端桥接，
  不能仅 mock 一个成功 fetch 就认定链路已加密。运行
  `src/lib/federation/transportBoundary.test.ts` 及受影响入口的回归测试；
  真实 macOS/iOS 尚未验收的路径要明确记录，不以浏览器模拟冒充实机结果。

## 只对自己的改动负责

- **提交/发版例外**:用户明确要求提交或发版时,默认把当前工作区内所有人的改动
  统一纳入同一个提交并发布,不再按 Agent 或改动来源拆分;仍须显式列出路径,
  **禁止** `git add -A` / `.` / `commit -a`,并在提交前完成构建。

- `tsc` / 构建报错时,只修自己 diff 内的错。不在自己 diff 内的错要记录并
  告知用户，但继续做可隔离的检查；只有它确实阻断本任务所需产物时才停下等待，
  不要“顺手”清理。
- 普通提交只 `git add` 自己改过的文件路径；上面的统一提交/发版模式按其范围纳入改动;**禁止** `git add -A` / `.` /
  `commit -a`。
- 允许在别人 WIP 的同一文件上做并行改动，但必须先快照现有 diff，只做不重叠的
  最小 hunk；不得覆盖、reset 或 checkout 别人的改动；仅在上面的统一提交/发版模式中允许暂存已审查的他人改动。发现 hunk 冲突时停下
  协调，不能擅自改写。
- commit message 描述实际纳入的全部改动；普通提交只描述本任务，统一提交/发版模式覆盖其完整范围。
- git 操作前先 `git status` 快照,操作后对照确认没动别人 WIP。

## Git 历史与资产

- **不重写已推送历史**;必须重写时先 `git clone --mirror` 备份,临时克隆里重写、
  `--force-with-lease` 推送,并告知其他 Agent 同步。
- 非运行时资产(3D 模型、预览图、诊断脚本等)不入库;大文件先问用户,放仓库外。

## macOS 原生通知验收

- 新增或修改 macOS 原生通知后，必须用 Developer ID 签名的 `/Applications/Termdock.app`
  在一个此前未授权 Termdock 通知的用户账户上验收；确认 `com.jovines.termdock`
  实际出现在“系统设置 → 通知”的应用列表中，并能选择横幅/提醒样式。
- Dock 徽标、前端 `granted`、IPC 返回 `true` 都不能代替系统注册与原生投递验证；
  必须检查 Info.plist 通知声明、签名身份，并以 Electron `show` / `failed` 事件和
  macOS 通知中心的实际记录为准。
- 安装包升级后要复测现有用户和新用户两个路径；若系统列表中没有 Termdock，优先
  检查安装版本、Bundle ID、Developer ID 签名和首次原生通知请求，不把问题误判为
  单纯的横幅开关。

## 工具

- 搜索用 `rg`,列文件用 `rg --files`,不要 `grep -r` / `find`。
- 改完 `src/` 用 `termdock-deploy` skill 构建和部署。遇他人 WIP 编译错时，按上面的可隔离检查与产物阻塞规则处理。
- **改动完成后自动部署到正式端口 9834**(`termdock-deploy` skill:
  build → `termdock --stop` → setsid 启动 → health 检查),不用再问用户。

## 色彩体系 (Flexoki)

- 项目色板 = **Flexoki 深色主题**(https://stephango.com/flexoki),亮色主题
  在 `html[data-theme='light']` 同族对应。
- 颜色只允许出自两个 token 文件:`src/index.css`(`:root` 每个 var 右侧
  标注了官方 token)和 `src/lib/terminal/theme.ts`(终端 ANSI,600→400 爬坡)。
  组件/服务端**禁止**新写十六进制色值;需要新色先在 token 文件里加变量。
- 强调色一律用**官方 400 值**(绿 #879A39 / 蓝 #4385BE / 红 #D14D41 /
  黄 #D0A215 / 紫 #8B7EC8),不要凭手感"提亮/调暗"——作者已按深底调好对比。
- 分层约定:主界面 chrome(安全区 / tab 条 / 键盘栏)用 `--chrome-bg`,
  必须**与终端底色同一块面**才沉浸(深色 = bg-2 `#1C1B1A`,浅色 = paper
  `#FFFCF0`;浅色若用 background-subtle 会在终端上下框出脏灰);`ui` 阶梯
  (#282726→#343331→#403E3C)= 浮层,normal → hover → active 递升;
  `bg`(#100F0F)只用于最深画布/遮罩叠色。
- 服务端发往客户端的颜色(onboarding 页、agent 状态点)同样只能在
  Flexoki 家族内取。
- `src/lib/flexokiPalette.test.ts` 守卫:核心变量值逐项对账官方值 +
  全库 hex 必须在 Flexoki 家族内。改色板 = 同步改该测试的 CORE_VARS。

## UI 层级 (z-index)

分「全局浮层刻度」与「面板局部刻度」两个世界:

- **全局刻度**(`fixed` 的遮罩/抽屉/弹窗/浮窗):**禁止**写裸 `z-[数字]`,
  统一用语义类:`z-chrome / z-chrome-hint / z-sidebar-* / z-menu-* /
  z-drawer-* / z-modal-* / z-toast / z-popover`。数值单一来源在
  `src/index.css` 的 `--z-*`,映射在 `tailwind.config.js`。
- **局部刻度**(面板/滚动容器内部的 `absolute`/`sticky` 控件:sticky 表头、
  悬浮「引用」按钮、局部下拉菜单):只用裸 `z-10 / z-20 / z-30`,铁律
  **< 40**(低于最低全局档),且**禁止**占用全局语义类——局部控件占全局
  档位就会和全屏浮层抢层级(「引用」按钮浮在 lightbox 图片上面就是这么
  来的)。
- **不能只比较子元素的 z-index**:带 `position + z-index`、`transform`、
  `opacity`、`filter/backdrop-filter` 等属性的祖先会创建独立 stacking context；
  子菜单即使写 `z-30`,也不可能越过祖先外部更高或同级后渲染的兄弟。
  局部弹层会跨到兄弟控件/分割线上方时,必须保证完整链路有序:
  **兄弟分割线/普通控件 `z-10` < 弹层宿主 `z-20` < 弹层 `z-30`**；否则
  把弹层 portal 到不会受困的局部容器。禁止把 `z-30` 菜单留在会与相邻
  `z-10` 竞争的 `z-10` 宿主里。
- 弹层会覆盖容器边界时,分割线**不要直接做成弹层宿主的 border**:border
  没有独立层级,半透明弹层还会把它透出来。应把分割线做成宿主内独立的
  `absolute z-10` 元素,由 `z-30` 弹层明确覆盖；或者让弹层使用不透底的
  surface。
- 新增浮层:先在 `src/index.css` 选/加一个档位,再用对应 `z-*` 类。
- 规则:子浮层必须高于弹出它的载体(例如设置抽屉里再弹的弹窗用
  `z-modal-*`,要盖住 `z-drawer-*`)。`src/lib/zIndexTokens.test.ts` 会守卫
  刻度有序、无裸数值、局部控件不碰全局档位,以及已登记的局部
  “兄弟控件 → 弹层宿主 → 弹层”链路有序。

## 移动端软键盘布局

- 全高输入工作区复用 `src/lib/components/layout/keyboardPanelLayout.ts` 的
  `getKeyboardPanelStyles`：导航在补偿容器外，rootStyle 给 flex-col 外层，
  contentStyle 给 `min-h-0 flex-1` 内容层，输入/工具栏为 `shrink-0` 兄弟。
- 唯一视口计算源是 `useViewportHeight`；业务组件禁止复制键盘高度监听、CSS
  补偿公式、根高度模式切换、viewport meta 切换或键盘动画期间 scrollTo 复位。
- 同一条祖先链只补偿一次。现有共享分屏保留父级平移与工具栏 portal 的特殊
  布局，子终端必须禁用自身补偿；不要将该特殊用法用于新页面。
- 同类 iOS 可见输入框按需用 `useKeyboardFocusGuard`，遮罩期间必须配
  `aria-hidden` / `pointer-events-none` 草稿镜像。普通弹窗优先使用原生布局。
- 修改后运行 `npm run test:keyboard-layout`；涉及终端入口再运行下述两组
  geometry 检查。自动化不替代 iOS 实机验收。设计与示例见
  [docs/soft-keyboard-adaptation.md](docs/soft-keyboard-adaptation.md)。

## 终端尺寸架构

- 浏览器终端统一通过 `src/lib/terminal/geometry.ts` 的 `createBrowserTerminal` 等待字体并创建，再交给 `TerminalGeometry` 管理尺寸；新增入口优先复用 `TerminalViewport`，不复制 `fit` / `resize` 流程。无调整尺寸权限的共享终端使用 `authority: 'server'`，禁止按本机容器改写远端网格。
- 生命周期为 `initialize`（字体与 renderer 就绪后同步测量，包括已有布局盒子的隐藏终端）、`reveal`（布局阶段、首次可见绘制前完成）、`update`（正常布局变化）。构造默认值和估算值不能作为连接尺寸；没有实测尺寸返回 `null`，重连不得用缓存覆盖这个显式退出尺寸接管的信号。
- 独立 tmux 显示连接的挂载与 resize 统一走 `src/server/utils/tmuxDisplayGeometry.ts`；显示 PTY 和观测 PTY 的尺寸必须在同一会话 I/O 队列里一起维护。重建观测 PTY 前读取实际窗口尺寸，禁止用默认 80×24 缩小已有会话。
- 修改这些公共入口、增加终端入口或重构初始化时，运行 `npm run test:terminal-geometry` 和 `npm run test:terminal-geometry:browser`；边界测试禁止入口直接调用 xterm / FitAddon 的尺寸方法，CI 包含真实 tmux 的断开后尺寸保持和 DPR 1/2 的首次显示检查。自动化浏览器和 CI 的 macOS PTY 检查不替代真实 macOS/iOS 客户端验收。

## 终端协作事实边界

- 协作通信和观测基于 terminal，不依赖各家 Agent 的 hook。CLI 经本机服务完成跨节点通信，不依赖网页/PWA/桌面客户端持续转发。
- 只报告实际观测：入队、远端接收、写入终端、终端快照、终端最后输出时间、明确回复。读取正文和回复都不能推导“已读”，不提供已读字段或状态。
- 不提供无法可靠观测的 Agent 内部状态、工具活动、排队状态或任务进度。显式任务报告须保留原始消息和时间，不据此推断整个会话忙闲。

## 会话数据与展示边界

- 会话列表沿用 `useSessionPersistence` 的库存、控制 WebSocket、缓存及本地变更归并链路；它是共享会话目录的唯一写入者。功能组件不得另拉一份 inventory 维护自己的会话数据源。
- 会话选择器使用 `useSessionDirectory()` 的 `SessionOption`，显示 `displayName` / `displaySubtitle`，用 `sessionId` 操作目标。原始 `name`、tmux 名称和路由 ID 不作为用户展示名。
- 名称统一经 `src/server/utils/sessionDisplayName.ts` 的 `getSessionPresentation` 解析，保留自定义/自动标题、实时标题、程序检测配置、目录与冷启动缓存。前端旧展示函数也是该规则的兼容入口；新增功能不得另写一套标题兜底规则。
- 服务端 inventory、协作目录与交接记录使用同一投影；持久化及路由身份保持独立。边界由 `sessionDirectoryBoundary.test.ts` 和共享目录回归测试守卫。详见 `docs/session-directory.md`。

## 共享会话能力边界

- 共享 UI 使用 `src/lib/federation/sessionCapabilities.ts` 的正向白名单：只从已认证的 session-list 与资源授权投影能力，未知或新增功能默认不开启，不复制本机完整菜单再逐项排除。
- 公共会话组件通过 `useSessionCapabilities().has(...)` 判断功能；共享环境缺少明确能力时禁止输入或操作，不能因 `canWrite` 默认值而启用。输入权限不代表拥有待办、再次分享或会话管理权限。
- 服务端授权校验始终生效，UI 隐藏不能替代鉴权；共享内容屏蔽应用操作右键，保留选中文字的原生复制。详见 `docs/shared-session-capabilities.md`。
