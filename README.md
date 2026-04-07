# Termdock

一个完整的、功能丰富的 Web 终端应用程序，基于现代技术栈构建。

## 功能特性

- **完整的终端模拟器**: 使用 xterm.js 渲染引擎
- **实时数据流**: 通过 Server-Sent Events (SSE) 实现实时数据流
- **多主题支持**: 5种内置主题（Dark, Light, Solarized, Dracula, Nord）
- **移动端支持**: 完整的触摸滚动和移动端键盘控制
- **会话管理**: 支持创建、重启、强杀终端会话
- **鼠标支持**: 支持鼠标点击和滚轮事件（TUI 程序如 vim、htop）
- **自动重连**: 网络断开时自动尝试重连
- **现代 UI 设计**: 简洁美观的界面，支持明暗主题切换
- **PWA 支持**: 可安装的渐进式 Web 应用

## 技术栈

- **前端**: React 18 + TypeScript + Vite
- **终端渲染**: xterm.js
- **状态管理**: Zustand
- **后端**: Express + node-pty
- **样式**: Tailwind CSS
- **图标**: Remix Icon + Nerd Fonts

## 快速开始

### 一行命令启动

发布到 npm 后，用户可以直接运行：

```bash
npx termdock
```

默认监听 `0.0.0.0:43888`，并且默认后台运行，也支持：

```bash
npx termdock --host 127.0.0.1 --port 4000
```

查看状态或停止服务：

```bash
termdock --status
termdock --stop
```

### 安装依赖

```bash
npm install --include=dev
```

### 从源码一键安装命令

克隆仓库后可直接运行：

```bash
./install-local.sh
```

脚本会自动执行：

- `npm install`
- `npm rebuild node-pty --build-from-source`
- `npm run build`
- `npm install -g .`

在 macOS 上，脚本还会检查 `node-pty` 的 `spawn-helper` 是否成功生成；如果没有，会直接报错提示你先安装 Xcode Command Line Tools。

安装完成后可直接运行：

```bash
termdock
```

如需卸载：

```bash
./uninstall-local.sh
```

### 开发模式

```bash
# 启动前端开发服务器 (端口 5173)
npm run dev:client

# 启动后端服务器 (端口 43888)
npm run dev:server

# 或者同时启动前后端
npm run dev
```

### 构建生产版本

```bash
npm run build
```

构建结果：

- `dist/client`: 前端静态资源
- `dist/server`: Node.js 服务端与 CLI 入口

### 预览生产版本

```bash
npm start
```

也可以直接运行：

```bash
node dist/server/cli.js
```

## 项目结构

```
termdock/
├── src/
│   ├── main.tsx                 # 应用入口
│   ├── App.tsx                  # 根组件
│   ├── index.css                # 全局样式
│   ├── lib/
│   │   ├── terminal/
│   │   │   ├── types.ts         # 类型定义
│   │   │   ├── theme.ts         # 主题系统
│   │   │   ├── api.ts           # 核心 API 函数
│   │   │   ├── factory.ts       # API 工厂函数
│   │   │   └── index.ts         # 导出入口
│   │   ├── stores/
│   │   │   ├── useTerminalStore.ts    # 终端状态管理
│   │   │   └── useMultiSessionStore.ts # 多会话状态管理
│   │   ├── components/
│   │   │   ├── terminal/
│   │   │   │   ├── TerminalViewport.tsx   # xterm.js 终端视图
│   │   │   │   ├── TerminalError.tsx      # 错误提示
│   │   │   │   ├── TerminalLoading.tsx    # 加载状态
│   │   │   │   ├── MobileKeyboard.tsx     # 移动端虚拟键盘
│   │   │   │   ├── ConnectionStatus.tsx   # 连接状态
│   │   │   │   └── DebugPanel.tsx         # 调试面板
│   │   │   ├── ui/
│   │   │   │   └── ErrorBoundary.tsx      # 错误边界
│   │   │   ├── settings/
│   │   │   │   ├── DesktopSettings.tsx    # 桌面端设置
│   │   │   │   └── MobileSettings.tsx     # 移动端设置
│   │   │   └── views/
│   │   │       └── TerminalView.tsx       # 主终端视图
│   │   ├── hooks/
│   │   │   ├── useSessionPersistence.ts   # 会话持久化
│   │   │   ├── useKeyboardState.ts        # 键盘状态
│   │   │   ├── useFontSize.ts             # 字体大小
│   │   │   ├── useTouchScroll.ts          # 触摸滚动
│   │   │   └── useDisconnectCleanup.ts    # 断开连接清理
│   │   └── utils/
│   │       └── errorHandler.ts            # 错误处理
│   └── server/
│       ├── entry.ts               # Express 服务器入口
│       └── utils/
│           └── pty.ts             # PTY 工具函数
├── public/
│   └── manifest.webmanifest       # PWA 配置
├── dist/                          # 构建输出
├── package.json
├── vite.config.ts
├── tailwind.config.js
└── tsconfig.json
```

## API 端点

| 方法 | 端点 | 描述 |
|------|------|------|
| POST | `/api/terminal/create` | 创建新终端会话 |
| GET | `/api/terminal/:sessionId/stream` | SSE 流式输出 |
| POST | `/api/terminal/:sessionId/input` | 发送输入 |
| POST | `/api/terminal/:sessionId/resize` | 调整终端大小 |
| DELETE | `/api/terminal/:sessionId` | 关闭会话 |
| POST | `/api/terminal/:sessionId/restart` | 重启会话 |
| POST | `/api/terminal/force-kill` | 强制结束会话 |
| GET | `/api/terminal/:sessionId/debug` | 获取调试信息 |

## 主题

内置5种终端主题：

1. **Dark** - GitHub Dark 风格
2. **Light** - GitHub Light 风格
3. **Solarized** - Solarized Dark 风格
4. **Dracula** - Dracula 风格
5. **Nord** - Nord 风格

## 移动端控制

移动端提供完整的虚拟键盘和触摸交互：

### 虚拟按键

- **Esc** - 退出键
- **Tab** - 制表符
- **Ctrl** - Ctrl 修饰符
- **Alt** - Alt 修饰符
- **Cmd** - Cmd 修饰符 (Meta)
- **↑ ↓ ← →** - 方向键
- **Enter** - 回车键
- **Backspace** - 退格键

### 触摸交互

- **点击**: 模拟鼠标左键点击
- **长按**: 模拟鼠标右键点击
- **滚动**: 触摸滑动滚动终端内容
- **捏合缩放**: 调整字体大小

## PWA

作为渐进式 Web 应用，支持：

- **离线使用**: Service Worker 缓存静态资源
- **安装**: 可安装到主屏幕
- **全屏**: 支持全屏运行
- **图标**: 支持自定义应用图标

## 配置

通过环境变量配置：

```bash
PORT=43888                     # 服务器端口 (默认 43888)
NODE_ENV=development           # 运行环境
TERM=xterm-256color            # 终端类型
SHELL=/bin/bash                # 默认 shell
MAX_TERMINAL_SESSIONS=20       # 最大会话数
TERMINAL_IDLE_TIMEOUT=1800000  # 空闲超时 (毫秒)
ROWS=24                        # 默认行数
COLS=80                        # 默认列数
```

CLI 也支持以下参数：

```bash
--host <host>                  # 覆盖 HOST
--port <port>                  # 覆盖 PORT
--foreground                   # 前台运行
--status                       # 查看后台服务状态
--stop                         # 停止后台服务
```

## 发布 npm 包

```bash
npm publish
```

发布前会自动执行 `prepublishOnly`，即：

```bash
npm run build
```

建议在发布前确认：

- npm 包名可用
- `repository`、`homepage`、`bugs` 字段已替换为真实仓库地址

## 浏览器支持

- Chrome 88+
- Firefox 79+
- Safari 14+
- Edge 88+

## 许可证

MIT
