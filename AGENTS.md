# Termdock Agent 规则

仓库存在多人/多 Agent 并行改动。

## 只对自己的改动负责

- `tsc` / 构建报错时,只修自己 diff 内的错。**不在自己 diff 内的错 → 停下,
  告知用户,等指示**,不要"顺手"清理。
- 提交时只 `git add` 自己改过的文件路径;**禁止** `git add -A` / `.` /
  `commit -a`。
- 别人 WIP 的文件保持 unstaged,不 stage / 不 reset / 不 checkout / 不修改。
- commit message 只描述自己的改动。

## 工具

- 搜索用 `rg`(ripgrep),不要 `grep -r`;查文件用 `Glob`,不要 `find`。
- 改完 `src/` 用 `termdock-deploy` skill 验证;若编译错属他人 WIP,先停。

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

- 全屏浮层(`fixed` 的遮罩/抽屉/弹窗/浮窗)**禁止**写裸 `z-[数字]`。
- 统一用语义类:`z-sidebar-* / z-menu-* / z-drawer-* / z-modal-* / z-toast /
  z-popover`。数值单一来源在 `src/index.css` 的 `--z-*`,映射在
  `tailwind.config.js`。
- 新增浮层:先在 `src/index.css` 选/加一个档位,再用对应 `z-*` 类。
- 规则:子浮层必须高于弹出它的载体(例如设置抽屉里再弹的弹窗用
  `z-modal-*`,要盖住 `z-drawer-*`)。`src/lib/zIndexTokens.test.ts` 会守卫
  刻度有序且无裸数值。
