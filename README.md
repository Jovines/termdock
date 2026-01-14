# Web Terminal

一个完整的、功能丰富的Web终端应用程序，基于现代技术栈构建。

## 功能特性

- **完整的终端模拟器**: 使用 Ghostty WebAssembly 渲染引擎
- **实时数据流**: 通过 Server-Sent Events (SSE) 实现实时数据流
- **多主题支持**: 5种内置主题（Dark, Light, Solarized, Dracula, Nord）
- **移动端支持**: 完整的触摸滚动和移动端键盘控制
- **会话管理**: 支持创建、重启、强杀终端会话
- **自动重连**: 网络断开时自动尝试重连
- **现代UI设计**: 简洁美观的界面，支持明暗主题切换

## 技术栈

- **前端**: React 18 + TypeScript + Vite
- **终端渲染**: ghostty-web (WebAssembly)
- **状态管理**: Zustand
- **后端**: Express + bun-pty/node-pty
- **样式**: Tailwind CSS
- **图标**: Remix Icon

## 快速开始

### 安装依赖

```bash
npm install --include=dev
```

### 开发模式

```bash
# 启动前端开发服务器 (端口 5173)
npm run dev:client

# 启动后端服务器 (端口 3001)
npm run dev:server

# 或者同时启动前后端
npm run dev
```

### 构建生产版本

```bash
npm run build
```

### 预览生产版本

```bash
npm run preview
```

## 项目结构

```
web-terminal/
├── src/
│   ├── main.tsx                 # 应用入口
│   ├── App.tsx                  # 根组件
│   ├── index.css                # 全局样式
│   ├── lib/
│   │   ├── terminal/
│   │   │   ├── types.ts         # 类型定义
│   │   │   ├── theme.ts         # 主题系统
│   │   │   ├── api.ts           # 核心API函数
│   │   │   ├── factory.ts       # API工厂函数
│   │   │   └── index.ts         # 导出入口
│   │   ├── stores/
│   │   │   └── useTerminalStore.ts  # 状态管理
│   │   └── components/
│   │       ├── terminal/
│   │       │   └── TerminalViewport.tsx  # 终端视图组件
│   │       └── views/
│   │           └── TerminalView.tsx      # 主终端视图
│   └── server/
│       └── index.ts             # Express服务器
├── dist/                        # 构建输出
├── package.json
├── vite.config.ts
├── tailwind.config.js
└── tsconfig.json
```

## API 端点

| 方法 | 端点 | 描述 |
|------|------|------|
| POST | `/api/terminal/create` | 创建新终端会话 |
| GET | `/api/terminal/:sessionId/stream` | SSE流式输出 |
| POST | `/api/terminal/:sessionId/input` | 发送输入 |
| POST | `/api/terminal/:sessionId/resize` | 调整终端大小 |
| DELETE | `/api/terminal/:sessionId` | 关闭会话 |
| POST | `/api/terminal/:sessionId/restart` | 重启会话 |
| POST | `/api/terminal/force-kill` | 强制结束会话 |

## 主题

内置5种终端主题：

1. **Dark** - GitHub Dark 风格
2. **Light** - GitHub Light 风格
3. **Solarized** - Solarized Dark 风格
4. **Dracula** - Dracula 风格
5. **Nord** - Nord 风格

## 移动端控制

移动端提供以下虚拟按键：

- **Esc** - 退出键
- **Tab** - 制表符
- **Ctrl** - Ctrl 修饰符
- **Cmd** - Cmd 修饰符
- **↑ ↓ ← →** - 方向键
- **Enter** - 回车键

## 配置

通过环境变量配置：

```bash
PORT=3001              # 服务器端口
NODE_ENV=development   # 运行环境
TERM=xterm-256color    # 终端类型
SHELL=/bin/zsh         # 默认shell
MAX_TERMINAL_SESSIONS=20  # 最大会话数
TERMINAL_IDLE_TIMEOUT=1800000  # 空闲超时(ms)
```

## 许可证

MIT
