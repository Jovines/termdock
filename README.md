# Termdock

一个面向移动端与桌面端的 Web 终端，由 tmux 持久托管会话，xterm.js + WebGL 负责渲染，Express + WebSocket 提供后端通信。

![License](https://img.shields.io/badge/license-MIT-green)

## 功能特性

### 终端能力

- **xterm.js + WebGL 渲染**：使用 `@xterm/addon-webgl` 加速绘制，自动处理上下文丢失与纹理刷新
- **tmux 持久会话**：所有会话由 tmux 托管，关闭页面/掉线后仍可恢复，支持 `detach`、`destroy`、强杀
- **WebSocket 双向通信**：单条持久连接同时承载输入与输出（取代旧的 SSE + POST 方案）
- **自动重连**：网络或后端中断后会自动尝试 attach 回原会话
- **鼠标支持**：完整透传 SGR 鼠标协议，vim、htop、tmux copy-mode 内的滚动/点击都按预期工作
- **OSC 0 CWD 嗅探**：标签页可动态显示当前进程或目录，无需轮询 `/proc`

### 多会话与标签栏

- **多会话管理**：创建、切换、重启、重命名（双击标签）、强杀
- **预渲染所有会话**：避免页面切换时 WebGL 上下文丢失
- **磁盘持久化**：会话布局与 tmux 元数据落盘，重启后自动恢复

### 移动端体验

- **Swiper 翻页**：左右滑动在多个终端之间切换，与终端内滚动手势已做冲突隔离
- **触摸优先的设置抽屉**：分 Tab、可滑动、长按 destroy
- **可定制虚拟键盘**：内置 Esc / Tab / Ctrl / Alt / Cmd / 方向键 / Enter / Backspace，并支持自定义工具条预设
- **手势**：点击 = 鼠标左键，长按 = 右键，捏合缩放调字号，触摸滑动 = 终端滚动
- **iOS 适配**：处理选择菜单、键盘弹起、翻页与会话恢复时的纹理刷新等细节

### 安全与认证

- **密码保护**（可选）：通过 `termdock --set-password` 启用，登录页 + Cookie 会话
- **登录限流**：基于来源 IP 的指数退避，防暴力破解
- **CSRF 防护**：所有写入接口要求 CSRF token
- **WebSocket 升级鉴权**：未登录的 upgrade 请求会被 401 拒绝
- **路径校验**：内置 `pathValidator` 防止路径穿越

### PWA

- 自托管 JetBrains Mono NL + Symbols Nerd Font（含 Bold）
- 完整的 PWA 图标 / 启动屏 / manifest，可安装到主屏幕全屏运行
- Service Worker 缓存静态资源，支持离线打开

## 技术栈

- **前端**：React 18 + TypeScript + Vite 7
- **终端渲染**：`@xterm/xterm` + `@xterm/addon-webgl` + `@xterm/addon-fit`
- **状态管理**：Zustand
- **触摸滑动**：Swiper
- **拖拽排序**：dnd-kit
- **后端**：Express 5 + ws + node-pty + tmux
- **样式**:Tailwind CSS
- **图标**：Remix Icon + Nerd Fonts

## 快速开始

### 一行命令启动

```bash
npx termdock
```

默认监听 `0.0.0.0:9834`，并在后台运行。常用变体：

```bash
npx termdock --host 127.0.0.1 --port 4000
termdock --foreground            # 前台运行
termdock --status                # 查看后台状态
termdock --stop                  # 停止后台服务
```

### 设置访问密码（强烈推荐）

如果服务暴露在 LAN 上，**务必先设置密码**，否则任何能访问到主机/端口的人都能执行 shell 命令：

```bash
# 交互式设置（输入隐藏）
termdock --set-password

# 通过管道设置（CI / 脚本场景）
echo "my-secret" | termdock --set-password

# 关闭鉴权
termdock --clear-password
```

密码状态存放在 `~/.termdock/auth.json`（mode 0600，scrypt 哈希，不可逆）。修改密码会使所有已登录会话失效。

服务在未设置密码时启动会打印醒目的安全警告。

### 从源码安装

```bash
git clone https://github.com/Jovines/termdock.git
cd termdock
./install-local.sh
```

脚本会执行 `npm install` → `npm rebuild node-pty --build-from-source` → `npm run build` → `npm install -g .`。在 macOS 上会额外检查 `node-pty` 的 `spawn-helper` 是否生成成功，若失败会提示安装 Xcode Command Line Tools。

若你开启了访问密码，并希望在自动化脚本里无交互访问（不关闭鉴权），可先尝试复用 cookie，再按需登录刷新：

```bash
# 首先直接尝试复用已有 cookie（推荐）
bash auth-login.sh

# 仅当 cookie 失效时，再提供原密码刷新登录态
export TERMDOCK_PASSWORD="<your-termdock-password>"
bash auth-login.sh

# 自动化请求统一带 cookie
curl -b ~/.termdock/automation.cookies http://localhost:9834/api/auth/status
```

这不会创建第二套密码，也不会关闭鉴权。

卸载：

```bash
./uninstall-local.sh
```

### 开发模式

```bash
# 同时启动前后端
npm run dev

# 或分开启动
npm run dev:client   # Vite 前端：9833
npm run dev:server   # tsx watch 后端：9834
```

开发期请访问 `http://localhost:9833`，Vite 会把 API/WebSocket 代理到后端 9834。

### 构建

```bash
npm run build
```

输出：

- `dist/client/`：前端静态资源
- `dist/server/`：Node.js 服务端 + CLI 入口

直接运行构建产物：

```bash
node dist/server/cli.js
# 或
npm start
```

## 系统依赖

- **Node.js ≥ 18**
- **tmux**：会话托管必需，请确保 `tmux` 在 PATH 中
- **macOS**：需安装 Xcode Command Line Tools 以便 `node-pty` 编译 `spawn-helper`
- **Linux**：通常需要 `build-essential`、`python3` 才能编译 `node-pty`

## 项目结构

```
termdock/
├── src/
│   ├── main.tsx                          # 应用入口
│   ├── App.tsx                           # 根组件
│   ├── index.css                         # 全局样式
│   ├── lib/
│   │   ├── terminal/                     # xterm 适配层、主题、API
│   │   ├── stores/                       # Zustand store
│   │   │   ├── useTerminalStore.ts
│   │   │   └── useMultiSessionStore.ts
│   │   ├── components/
│   │   │   ├── MultiTerminalView.tsx     # 多会话 Swiper 主视图
│   │   │   ├── auth/LoginScreen.tsx      # 登录页
│   │   │   ├── terminal/                 # 终端视图、错误/加载、移动键盘
│   │   │   ├── settings/                 # 调试面板、工具条预设
│   │   │   ├── ui/ErrorBoundary.tsx
│   │   │   └── views/TerminalView.tsx
│   │   ├── hooks/                        # 字号、滚动、断连清理、视口高度等
│   │   └── utils/                        # 错误处理、调试
│   └── server/
│       ├── cli.ts                        # CLI 入口（前后台、密码管理）
│       ├── entry.ts                      # Express + WebSocket 启动
│       ├── config.ts                     # 端口配置（9833/9834）
│       ├── routes/
│       │   ├── auth.ts                   # 登录 / 登出 / 状态
│       │   └── terminal.ts               # 终端 + tmux 路由
│       └── utils/
│           ├── authProtection.ts         # scrypt 密码哈希、会话、限流
│           ├── csrfProtection.ts
│           └── pathValidator.ts
├── public/                               # PWA 图标、字体、manifest
├── install-local.sh / uninstall-local.sh
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## 主要 API 端点

> 写入接口需要登录后获取 CSRF token，并通过 Cookie + token 一起调用。

### 鉴权

| 方法 | 端点 | 描述 |
|------|------|------|
| GET  | `/api/auth/status` | 查询是否启用鉴权 / 当前 cookie 是否有效 |
| POST | `/api/auth/login`  | 登录（限流） |
| POST | `/api/auth/logout` | 登出 |
| GET  | `/api/csrf-token`  | 获取 CSRF token（需登录） |

### 终端 / tmux

| 方法 | 端点 | 描述 |
|------|------|------|
| POST | `/api/terminal/create` | 创建新会话 |
| GET  | `/api/terminal/:sessionId/ws` *(WebSocket)* | 双向通信通道 |
| POST | `/api/terminal/:sessionId/input` | 发送输入（HTTP 兜底） |
| POST | `/api/terminal/:sessionId/resize` | 调整终端尺寸 |
| POST | `/api/terminal/:sessionId/tmux` | 执行 tmux 控制命令 |
| POST | `/api/terminal/:sessionId/restart` | 重启会话 |
| POST | `/api/terminal/:sessionId/detach` | 断开 attach |
| GET  | `/api/terminal/:sessionId/attach` | 重新 attach |
| GET  | `/api/terminal/:sessionId/health` | 健康检查 |
| DELETE | `/api/terminal/:sessionId` | 关闭会话 |
| POST | `/api/terminal/force-kill` | 强制结束 |
| GET  | `/api/terminal/tmux/sessions` | 列出所有 tmux 会话 |
| DELETE | `/api/terminal/tmux/sessions/:name` | 销毁指定 tmux 会话 |
| GET  | `/api/terminal/processes` | 进程列表 |

## 主题

当前内置 **Flexoki Dark** —— 一套低对比度、暖色调的配色，长时间阅读更舒适。
主题定义在 `src/lib/terminal/theme.ts`，可按需扩展。

## 配置

### CLI 参数

```
--host <host>        绑定地址（默认 0.0.0.0）
--port <port>        监听端口（默认 9834）
--foreground         前台运行
--status             查看后台服务状态
--stop               停止后台服务
--set-password       设置 / 修改访问密码（交互式）
--clear-password     清除密码并关闭鉴权
-h, --help           查看帮助
```

### 环境变量

```bash
PORT=9834                      # 后端端口
HOST=0.0.0.0                   # 绑定地址
NODE_ENV=development           # 运行环境
TERM=xterm-256color            # 终端类型
SHELL=/bin/zsh                 # 默认 shell
MAX_TERMINAL_SESSIONS=20       # 最大会话数
TERMINAL_IDLE_TIMEOUT=1800000  # 空闲超时 (毫秒)
```

### 状态目录

```
~/.termdock/
├── auth.json        # 密码哈希（mode 0600，仅在启用鉴权时存在）
├── server.json      # 后台进程 PID / 端口
└── server.log       # 后台运行日志
```

## 移动端控制

### 虚拟按键

Esc / Tab / Ctrl / Alt / Cmd / ↑↓←→ / Enter / Backspace，并支持在设置中自定义工具条预设。

### 触摸交互

- **点击**：模拟鼠标左键
- **长按**：模拟鼠标右键
- **滑动**（终端区）：滚动当前会话内容
- **滑动**（边缘）：在多个会话之间翻页
- **捏合缩放**：调整字号

## 发布到 npm

```bash
npm publish
```

`prepublishOnly` 钩子会自动执行 `npm run build`。发布前请确认：

- npm 包名可用
- `repository` / `homepage` / `bugs` 字段已更新
- README、版本号已同步

## 浏览器支持

- Chrome 88+
- Firefox 79+
- Safari 14+（含 iOS 14+）
- Edge 88+

## 许可证

MIT
