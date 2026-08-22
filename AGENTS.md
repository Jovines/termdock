# Termdock Agent 规则

仓库存在多人/多 Agent 并行改动。

## 只对自己的改动负责

- **提交/发版例外**:用户明确要求提交或发版时,默认把当前工作区内所有人的改动
  统一纳入同一个提交并发布,不再按 Agent 或改动来源拆分;仍须显式列出路径,
  **禁止** `git add -A` / `.` / `commit -a`,并在提交前完成整体测试与构建。

- `tsc` / 构建报错时,只修自己 diff 内的错。不在自己 diff 内的错要记录并
  告知用户，但继续做可隔离的检查；只有它确实阻断本任务所需产物时才停下等待，
  不要“顺手”清理。
- 提交时只 `git add` 自己改过的文件路径;**禁止** `git add -A` / `.` /
  `commit -a`。
- 允许在别人 WIP 的同一文件上做并行改动，但必须先快照现有 diff，只做不重叠的
  最小 hunk；不得覆盖、reset、checkout 或 stage 别人的改动。发现 hunk 冲突时停下
  协调，不能擅自改写。
- commit message 只描述自己的改动。
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
- 改完 `src/` 用 `termdock-deploy` skill 验证;若编译错属他人 WIP,先停。
- **改动完成并验证后自动部署到正式端口 9834**(`termdock-deploy` skill:
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
