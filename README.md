# Termdock

<p align="center">
  <img src="public/pwa-192x192.png" alt="Termdock 图标" width="96" />
</p>

**把终端和 AI 编程工作区，带到你的手机、浏览器和 Mac。**

[![npm](https://img.shields.io/npm/v/termdock)](https://www.npmjs.com/package/termdock)
[![Downloads](https://img.shields.io/npm/dm/termdock)](https://www.npmjs.com/package/termdock)
[![macOS Download](https://img.shields.io/github/v/release/Jovines/termdock?label=macOS)](https://github.com/Jovines/termdock/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

简体中文 · [English](README.en.md)

Termdock 是一个可自托管的 Web 终端与 AI Agent 工作区。你可以在电脑上运行 Claude Code、Codex、Gemini CLI 等工具，再从手机继续操作同一个 tmux 会话；也可以连接多台机器，把任务、消息、代码审阅和文件预览放在同一工作区里。

终端与命令在运行 Termdock 服务的机器上执行。浏览器、PWA 和 macOS 客户端负责连接与交互；AI CLI 需要在服务所在机器上单独安装和登录。

[快速开始](#快速开始) · [功能特性](#功能特性) · [AI 与协作](#ai-与协作) · [常见问题](#常见问题) · [文档](#文档导航) · [参与贡献](#参与贡献)

## 为什么用 Termdock

- **离开电脑后继续工作**：手机打开同一服务，查看输出、补充指令、处理 Agent 提问；关闭页面后，tmux 会话继续运行。
- **给手机一个适合终端的界面**：可定制快捷键栏、触摸滚动、滑动切换会话，以及 iOS 软键盘适配。
- **把 AI 工作放在一起**：管理多个 Agent 会话，在协作组中分派任务、回答问题、审阅交付物和验收结果。
- **跨机器连接**：切换多个服务；经过配置的入口可以中转目标服务的加密流量，目标仍独立检查身份与权限。
- **直接查看工作成果**：浏览文件、查看 Git diff，预览 Markdown、图片、视频、HTML、3D 模型和 KiCad 文件，并把选中的内容引用给 Agent。

## 快速开始

### 运行环境

| 项目 | 要求 |
| --- | --- |
| 服务系统 | macOS 或 Linux；Windows 用户可在 WSL2 的 Linux 环境中尝试 |
| Node.js | **22 或更新版本**，并安装 npm |
| 持久会话 | `tmux`，需要能从 `PATH` 找到 |
| 客户端 | 当前版本的 Chrome、Edge、Firefox 或 Safari；手机可通过 HTTPS 安装 PWA |
| macOS 桌面安装包 | 当前打包目标为 Apple Silicon（arm64），见 [Releases](https://github.com/Jovines/termdock/releases) |

安装过程会检查原生终端模块和 tmux，并尝试修复依赖。手动准备 tmux：

```bash
# macOS（已安装 Homebrew）
brew install tmux

# Ubuntu / Debian
sudo apt-get update
sudo apt-get install -y tmux
```

如果 `node-pty` 需要本机编译，macOS 安装 `xcode-select --install`，Ubuntu / Debian 安装 `build-essential` 和 `python3`。WSL2、不同 Linux 发行版和手机系统的具体行为请以实际环境为准。

### 安装并启动

```bash
npm install -g termdock

# 先设置密码，再启动服务
td --set-password
td

# 查看实际访问地址和服务状态
td --status
```

`td` 和 `termdock` 是同一个 CLI 的两个名称。首次启动可能引导配置局域网名称与 HTTPS；打开启动日志或 `td --status` 给出的地址，登录后创建终端即可开始使用。

只想先在本机试用，也可以运行：

```bash
npx termdock --host 127.0.0.1
```

没有配置证书时，本机地址为 `http://localhost:9834`；配置证书后使用日志显示的 HTTPS 地址。默认监听地址为 `0.0.0.0:9834`，后台模式由 supervisor 监督运行。手机访问和 PWA 安装请继续阅读[局域网 HTTPS 配置](#局域网-https-访问手机--本机)。

### macOS 桌面版

从 [GitHub Releases](https://github.com/Jovines/termdock/releases) 下载 DMG，安装后打开连接中心。桌面版可以复用本机服务，也可以连接局域网或公网中的独立服务。

如果本机已有 Node.js 22+ 和 CLI，桌面版会检测并按需启动服务；缺少 CLI 时，可点击「安装并启动」安装到 `~/.termdock/cli`。缺少合适的 Node.js 时，连接中心提供官网下载入口。退出桌面版后，独立服务继续运行。

桌面版提供原生窗口、快捷键、Finder 文件交互和独立的应用更新。打包、签名与升级说明见 [Termdock for macOS](docs/macos-desktop.md)。

## 功能特性

### 终端能力

- **xterm.js + WebGL 渲染**：使用 `@xterm/addon-webgl` 加速绘制，自动处理上下文丢失与纹理刷新
- **tmux 持久会话**：tmux 模式下关闭页面或掉线后仍可恢复，支持分离、销毁和强制结束；持久运行需要 tmux 可用
- **加密双向通信**：通过 Noise 加密通道传输终端输入与输出，底层使用 WebSocket
- **自动重连**：网络或后端中断后会自动尝试 attach 回原会话
- **鼠标支持**：完整透传 SGR 鼠标协议，vim、htop、tmux copy-mode 内的滚动/点击都按预期工作
- **会话标题与目录**：结合终端标题、shell integration 与进程信息显示当前会话上下文

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

### 电脑控制

右侧边栏的「电脑」页支持 RDP 和 VNC，提供鼠标、触摸、键盘、仅查看、桌面展开和系统快捷键。
Ubuntu / Linux、Windows 默认选择 RDP，macOS 默认选择 VNC；目标系统与协议可以分别切换。
VNC 使用 [noVNC](https://github.com/novnc/noVNC)，RDP 使用 [Apache Guacamole](https://guacamole.apache.org/)。

1. 在 Mac 上打开「系统设置 → 通用 → 共享 → 屏幕共享」，允许用于登录的 Mac 账户。
2. 在「电脑」页填写当前 Termdock 服务能访问的电脑内网 IP 或主机名；VNC 端口固定为 5900，RDP 默认 3389，可按目标设置调整。
   可选择「连接服务所在电脑」，使用服务端本机地址；这里的本机是当前服务所在电脑。
3. 填写 Mac 用户名和账户密码；如果使用独立 VNC 密码，先在 Mac 的屏幕共享设置中
   开启「VNC 查看器可以使用密码控制屏幕」，用户名可留空，按服务器要求补充。

连接需要当前服务的全权授权。目标、协议、端口、账号和证书信任选择保存在当前服务。
默认勾选「记住登录」，成功连接后将密码加密保存到服务端，下次打开自动连接；高级设置可关闭自动连接，
「清除登录」可删除当前目标账号的凭据。密码不会进入浏览器存储或普通设置文件，服务端凭据文件及密钥仅供当前系统用户读取。
切换侧栏页面、关闭侧栏或离开服务工作区时会断开控制。浏览器到 Termdock 的画面和输入复用现有加密通道；服务到目标电脑的 VNC 段
应放在可信内网或 VPN 中。文字发送使用远程剪贴板，字符支持取决于服务器能力。
系统设置步骤可参考 [Apple 屏幕共享说明](https://support.apple.com/guide/mac-help/mh11848/mac)。

选择 VNC 时，Ubuntu / Linux 需要先启动兼容的 VNC 服务。共享现有 X11 桌面可使用
[x11vnc](https://github.com/LibVNC/x11vnc)，在桌面终端设置 VNC 密码，并以
`-localhost -usepw -forever -shared -rfbport 5900` 启动，随后连接服务所在电脑。
[Ubuntu 24.04 内置远程桌面](https://documentation.ubuntu.com/desktop/en/24.04/how-to/share-your-desktop-remotely/)
使用 RDP，可在此面板选择 RDP 连接。VNC 下的 Wayland 需要兼容该桌面的 VNC 服务。
TigerVNC 虚拟桌面是独立会话，不等同于当前屏幕。

使用 RDP 时，在目标电脑启用远程桌面并设置登录凭据。Ubuntu 的「桌面共享」与「远程登录」
可能使用不同会话和端口（3389 / 3390），填写设置界面中的实际端口、RDP 用户名和密码。
目标使用自签名证书时，确认电脑身份后可勾选「信任此电脑的 RDP 证书（跳过校验）」。
域可留空；连接服务所在电脑时使用 `127.0.0.1`。RDP 登录可能创建新会话，是否显示当前屏幕
由目标远程桌面服务决定。

RDP 需要在 **Termdock 服务电脑** 启动支持 RDP 的 `guacd`，仅监听回环地址 `127.0.0.1:4822`。
Linux Docker 示例（复用主机网络，使 `127.0.0.1` 指向服务电脑）：

```bash
docker run -d --name termdock-guacd --network host --restart unless-stopped \
  -e LOG_LEVEL=warning guacamole/guacd:1.6.0 -b 127.0.0.1
```

也可在服务电脑安装 Apache Guacamole 的 `guacd` 并绑定回环地址；自定义后端端口使用
`TERMDOCK_GUACD_PORT`。转换服务没有独立认证，不能暴露到局域网或公网。
浏览器通过当前 Termdock 服务的全权授权与加密通道连接；RDP 密码的传输与保存请求均通过该通道，
不写入 URL、日志或普通连接配置。无需部署 Guacamole 网页、数据库或另外开放业务 HTTP / WebSocket 端口。

### 安全与认证

- **密码登录**：通过 `td --set-password` 设置密码，浏览器使用 OPAQUE 密码证明授权设备，再建立 Noise 加密连接
- **设备邀请与撤销**：一次性邀请链接和二维码，可选择会话查看、操作或完整服务权限
- **加密中继**：已配置的入口转发密文，目标服务独立验证设备身份与权限
- **登录限流**：基于来源 IP 的指数退避，防暴力破解
- **CSRF 防护**：所有写入接口要求 CSRF token
- **WebSocket 升级鉴权**：未登录的 upgrade 请求会被 401 拒绝
- **路径校验**：内置 `pathValidator` 防止路径穿越

终端操作拥有服务所在系统账户的权限。公网部署需要强密码、可信 HTTPS 证书和明确的访问入口；配置方法与权限边界见[配置说明](docs/configuration.md#公网安全模式)和[加密连接文档](src/server/federation/README.md)。普通 PWA 仍依赖可信的前端代码来源。

### 文件、审阅与设备

- 文件树、上传、下载、图片粘贴和文件拖拽，方便给 Agent 提供上下文。
- Git diff 与代码审阅，支持把选中的内容引用到终端或上下文草稿。
- Markdown、图片、视频与沙箱 HTML 预览；HTML 的支持范围见[加密连接文档](src/server/federation/README.md)。
- STL / GLB / glTF 模型查看与位置引用；KiCad 原理图、PCB 和工程预览。部分转换需要服务机上的额外工具，见[电子设计预览](docs/electronics-preview.md)。
- Android 投屏与控制，需要服务机上的 adb、scrcpy 及已授权的设备；电脑桌面控制步骤见上文。

### PWA

- 自托管 JetBrains Mono NL + Symbols Nerd Font（含 Bold）
- 完整的 PWA 图标 / 启动屏 / manifest，可安装到主屏幕全屏运行
- Service Worker 缓存静态资源；离线时可打开缓存界面，终端操作仍需要连接服务
- 内置中英文界面与 Flexoki 深色、浅色主题

## 技术栈

- **前端**：React 18 + TypeScript + Vite 7
- **终端渲染**：`@xterm/xterm` + `@xterm/addon-webgl` + `@xterm/addon-fit`
- **状态管理**：Zustand
- **触摸滑动**：Swiper
- **拖拽排序**：dnd-kit
- **后端**：Express 5 + ws + node-pty + tmux
- **样式**:Tailwind CSS
- **图标**：Remix Icon + Nerd Fonts

## 服务管理与手机接入

### 常用命令与更新

全局安装后可使用：

```bash
termdock --host 127.0.0.1 --port 4000
termdock --foreground            # 前台运行
termdock --status                # 查看后台状态
termdock --stop                  # 停止后台服务
termdock --restart               # 请求 supervisor 重启服务
td --help                       # 完整 CLI 帮助
td update                        # 从 npm 官方源升级全局 CLI
```

`td update`（也可写作 `td upgrade`）会优先使用 npm 官方源
`https://registry.npmjs.org` 查询并安装最新正式版；仅当官方源查询或安装失败时，
才会回退到本机 `.npmrc` 配置的源（npm 命令不再传入 `--registry`）。
如果后台服务正在运行，升级不会打断现有终端会话；可在方便时执行
`td --stop && td`，让服务切换到新版本。

npm CLI 服务也会自动更新：启动 15 秒后检查一次，之后每 6 小时检查。
新版会在后台安装，但无论是否有网页连接都绝不会自动重启。更新状态会持久保存，
用户打开网页后可在左侧边栏“更多”按钮看到更新圆点和提醒；只有用户明确确认后
才会重启，未确认的提醒会一直保留。tmux 和由 PTY host 托管的会话可跨此次重启继续使用。
macOS 桌面版仍使用独立的签名更新机制，不运行 npm 自动更新器。

### 设置访问密码（强烈推荐）

如果服务暴露在 LAN 上，**务必先设置密码**，否则任何能访问到主机/端口的人都能执行 shell 命令：

```bash
# 交互式设置（输入隐藏）
termdock --set-password

# 通过管道设置（CI / 脚本场景；先在环境中设置 TERMDOCK_SETUP_PASSWORD）
printf '%s\n' "$TERMDOCK_SETUP_PASSWORD" | termdock --set-password

# 关闭鉴权
termdock --clear-password
```

密码状态存放在 `~/.termdock/auth.json`（mode 0600，scrypt 哈希，不可逆）。修改密码会使所有已登录会话失效。

服务在未设置密码时启动会打印醒目的安全警告。

### 局域网 HTTPS 访问（手机 / 本机）

Termdock 可以为当前机器发布一个产品化的局域网地址：

```text
https://<name>.termdock.local:9834
```

`<name>` 会在首次启动时自动生成一个 4 位默认值，也可以在设置抽屉里的「本地访问」中自定义。自定义名称不做人为长度限制，但必须是合法 hostname label。

第一版仍然保留 `:9834` 端口；无端口的 `https://<name>.termdock.local` 需要后续单独引入 443 代理/Helper。

第一次直接运行 `termdock` 时，CLI 会先引导你选择 `.termdock.local` 前缀，并询问是否立刻启用 HTTPS；选择启用后会自动安装/配置 mkcert、生成证书，然后继续启动服务。

使用建议：

```bash
# 1. 先启用密码，避免把 shell 暴露给同一内网其他人
termdock --set-password

# 2. 自动准备本地 HTTPS 证书
#    会检查 mkcert；macOS 可通过 Homebrew 自动安装
termdock --setup-local-https

# 3. 正常启动；如果 ~/.termdock/certs/ 下已有证书，会自动启用 HTTPS
termdock

# 4. 查看正式地址和手机首次接入地址
termdock --status
```

该命令会生成并保存：

```text
~/.termdock/certs/termdock-local.pem
~/.termdock/certs/termdock-local-key.pem
~/.termdock/certs/rootCA.pem
```

也可以手动覆盖证书路径：

```bash
termdock --https-cert <cert.pem> --https-key <key.pem> --https-ca <rootCA.pem>
```

手机首次接入时，先在同一 Wi‑Fi 下打开 `termdock --status` 或服务启动日志输出的 onboarding 地址，例如：

```text
http://192.168.1.23:52741/onboarding
```

该页面会提供 CA 证书下载和 iPhone / Android 安装步骤；如果只想直接下载证书，也可以打开更短的：

```text
http://192.168.1.23:52741/ca
```

安装并信任 CA 后，再打开正式地址：

```text
https://<name>.termdock.local:9834
```

注意：mDNS 依赖同一局域网的 `.local` 组播；访客 Wi‑Fi、客户端隔离、VPN 或部分企业网络可能会阻止解析。此时 `localhost` 访问仍然可用，但手机上的漂亮域名可能不可用。

在 iPhone 的 Safari 中使用「分享 → 添加到主屏幕」；Android 使用浏览器的安装应用入口。首次连接需完成证书信任和登录。手机锁屏或后台时系统可能暂停客户端，服务机上的 tmux 会话继续运行，返回前台后重新连接。

## AI 与协作

### 在同一个终端继续 AI 工作

在服务机上安装并登录你选择的 Agent CLI，然后在 Termdock 终端中启动，例如 `claude`、`codex` 或 `gemini`。项目内置多种 Agent 的识别与会话恢复适配，也支持通过插件添加适配。

Termdock 不提供模型账户或 API 额度，调用费用与权限由对应 CLI 和提供商决定。普通 shell、Vim、htop 等终端程序也可以使用。

### 工作组、任务与跨机器协作

创建协作组并添加 Agent 会话后，可以发送消息、建立目标与子任务、回答问题、确认方案、审阅结果和验收交付。自动协作支持协调者拆分目标、独立执行目录与独立评审，具体流程见[协作指南](docs/collaboration.md)。

在 Termdock 管理的终端内查看 CLI：

```bash
td collab --help
td collab status
td collab send <接收者会话ID> '请检查这次改动并回复结果'
td collab inbox --json
```

协作以终端和明确回复为依据，不要求各家 Agent 安装专用 hook。跨服务协作完成身份登记后，由服务后台通过加密通道继续投递与重试，不依赖网页一直打开。**写入终端不等于 Agent 已读或任务已完成**；任务报告保留原文与时间，最终结果需要明确评审或验收。

多个服务的授权、入口中继和网络路由配置见[加密连接与 CLI 中继](src/server/federation/README.md)。

### 分享和安装 Agent 插件

Agent 适配可以作为独立 Git 仓库分享。插件仓库根目录必须包含 `manifest.json`，可以同时携带 `icon.svg` 和标题生成等辅助脚本：

```text
my-agent-termdock-plugin/
├── manifest.json
├── icon.svg          # 可选
└── scripts/          # 可选；manifest 中用 {pluginDir} 引用
```

安装和维护命令：

```bash
td plugin-install https://github.com/owner/my-agent-termdock-plugin
td plugin-list --json
td plugin-check my-agent
td plugin-update my-agent
td plugin-doctor my-agent --json
td plugin-hooks my-agent install
td plugin-hooks my-agent uninstall
td plugin-remove my-agent
```

`plugin-install/update/remove` 管理完整插件包；`plugin-hooks` 只管理写入 Agent 原生配置文件的 Termdock hook 条目，两者生命周期互相独立。设置界面提供相同操作。

安全上，安装插件只会注册声明式能力，不会自动安装 hooks，也不会因打开设置页就执行插件的模型探测命令。只有用户启用该插件的自动标题后，才会调用它声明的 CLI。插件 hook 目标必须是用户目录内、不经过符号链接的 JSON 文件；实际 hook 命令由 Termdock 生成，插件不能注入任意 shell。仍应只安装你信任且审查过的仓库。

自动标题插件必须区分“始终传入的参数”和“选中模型后才传入的整组参数”。例如 TraeX 使用 `-c model="..."` 时：

```json
{
  "titleNamer": {
    "command": "traecli",
    "modelArgs": ["-c", "model=\"{model}\""],
    "args": ["-p", "{prompt}"],
    "models": {
      "command": "node",
      "args": ["{pluginDir}/scripts/list-models.mjs"]
    }
  }
}
```

`modelArgs` 是一个原子参数组：用户或 Termdock 选中模型时整组前置，没有模型时整组省略，此时明确使用 Agent CLI 默认模型。模型命令可输出 JSON 数组，也可输出 `{ "models": [...], "recommendedModel": "..." }`；模型 ID 字段支持 `id` / `name` / `model`，并可选提供 `displayName`、`description`、`isDefault` 和 `isEconomical`。原生 CLI 字段仍无法匹配时，用 `{pluginDir}` 内的脚本实时转换，禁止硬编码模型列表。

自动选择顺序是：插件顶层 `recommendedModel` → 第一个 `isEconomical: true` → 第一个 `isDefault: true` → 不传模型并使用 Agent CLI 默认值。Termdock 不再根据模型名称或说明猜测价格；用户手动选择始终优先于自动选择。

`td plugin-doctor <slug> --json` 会显式运行一次模型探测，报告 `titleNamer`、可用模型数、自动选择结果、被忽略字段和修复建议；它不会调用付费的标题生成命令。

开发本地插件时可直接传目录；旧的 manifest-only 命令仍可使用：

```bash
td plugin-install ./my-agent-termdock-plugin
td plugin-create ./manifest.json
```

插件作者和 Agent 可以运行 `td agent-plugin --json` 获取机器可读的当前协议、manifest schema、状态模型和全部公共命令。v1 manifest 会返回可直接交给 AI 修复的迁移说明。

## 源码开发

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
npm run dev:server   # tsx watch 后端：9835
```

开发期请访问 `http://localhost:9833`，Vite 会把 API/WebSocket 代理到后端开发端口 9835。正式/本地安装服务独立使用 9834。

### 构建

```bash
npm run build
```

类型检查使用 `npm run lint`，单次测试运行使用 `npm test -- --run`；贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

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

依赖与安装要求见[运行环境](#运行环境)。开发前请准备 Node.js 22+、tmux 及所需的原生模块编译工具。

### tmux 焦点跟踪

Termdock 复用系统默认 tmux server。每次创建、复用、切换或通过 CLI attach tmux 会话时，Termdock 会自动确保 shared tmux server 的 `focus-events` 为 `on`，并在浏览器焦点变化时把 focus in/out 事件按需转发给 tmux 内部请求了 focus tracking 的程序（例如 Claude Code、Vim、fzf 等）。这是单向增强项：Termdock 不会在会话关闭后把 `focus-events` 自动恢复为 `off`。如果你手动维护 `~/.tmux.conf`，也可以显式加入：

```tmux
set -g focus-events on
```

## 项目结构

```text
termdock/
├── src/
│   ├── App.tsx / main.tsx       # Web 应用入口
│   ├── index.css               # 主题与全局样式 token
│   ├── lib/
│   │   ├── terminal/           # xterm 适配、主题与终端 API
│   │   ├── components/         # 终端、侧栏、设置和审阅界面
│   │   ├── federation/         # 浏览器加密通信与多服务访问
│   │   ├── stores/             # 状态管理
│   │   └── i18n/               # 中英文界面
│   └── server/
│       ├── cli.ts / entry.ts   # CLI 与服务入口
│       ├── routes/             # 终端、文件与其他业务路由
│       ├── agent/              # Agent 适配、协作与定时任务
│       └── federation/         # 服务身份、加密传输与中继
├── desktop/                    # Electron macOS 客户端
├── public/                     # 图标、字体与 Service Worker
├── docs/                       # 功能与开发文档
├── scripts/                    # 构建与维护脚本
└── package.json
```

### 程序化接入

优先使用 `td collab`、`td automation`、`td notify` 和各命令的 `--help`，支持结构化 JSON 输出。页面业务请求必须使用应用的加密 `fetch` / `secureSocket`；直接 HTTP API 列表不能作为当前浏览器或远端接入方案。

本机自动化的认证示例见上文 `auth-login.sh`，传输与授权设计见[加密连接文档](src/server/federation/README.md)。

## 主题

内置 **Flexoki 深色与浅色主题**。界面颜色 token 在 `src/index.css`，终端 ANSI 配色在 `src/lib/terminal/theme.ts`；修改时请遵守仓库的色板约定。

## 配置

### CLI 参数

```
--host <host>        绑定地址（默认 0.0.0.0）
--port <port>        监听端口（默认 9834）
--foreground         前台运行
--status             查看后台服务状态
--restart            重启受监督的服务
--setup-local-https  准备局域网 HTTPS 证书
--stop               停止后台服务
--set-password       设置 / 修改访问密码（交互式）
--clear-password     清除密码并关闭鉴权
-h, --help           查看帮助
```

### 环境变量

```bash
PORT=9834                      # 正式/安装后服务端口；dev:server 使用 9835
HOST=0.0.0.0                   # 绑定地址
NODE_ENV=development           # 运行环境
TERM=xterm-256color            # 终端类型
SHELL=/bin/zsh                 # 默认 shell
MAX_TERMINAL_SESSIONS=20       # 最大会话数
TERMINAL_IDLE_TIMEOUT=21600000 # 空闲超时 (毫秒；生产默认 6 小时)
```

完整配置项、加载顺序与公网模式见[配置说明](docs/configuration.md)，环境变量示例见 [.env.example](.env.example)。

### 状态目录

```
~/.termdock/
├── auth.json        # 密码哈希（mode 0600，仅在启用鉴权时存在）
├── server.json      # 后台进程 PID / 端口
├── server.log       # 后台运行日志
├── crash.log        # 服务异常与 supervisor 记录
├── certs/           # 局域网 HTTPS 证书
└── federation/      # 服务身份、授权和路由配置
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

## 常见问题

### 手机应该打开哪个地址？

打开 `td --status` 输出的局域网 HTTPS 地址，并确保手机和服务机网络可达。手机上的 `localhost` 指手机本身；首次接入使用日志提供的 onboarding 地址安装并信任 CA，再访问正式地址。

### 关闭浏览器或 Mac 客户端会结束任务吗？

tmux 模式下，关闭客户端或暂时断网不会结束终端里的程序。主动销毁会话、关机或结束进程会终止任务。持久会话不是运行结果的备份。

### 安装成功，但创建终端失败？

先检查 `node --version`、`tmux -V` 与 `td --status`，再查看 `~/.termdock/server.log` 或前台运行输出。常见原因是 Node.js 版本过低、tmux 不在 PATH，或 `node-pty` 原生模块未正确安装。源码环境可在安装编译工具后运行 `npm rebuild node-pty --build-from-source`。

### HTTPS 证书已信任，`.termdock.local` 仍无法打开？

检查是否同一局域网、是否开启访客网络或客户端隔离，以及 VPN 是否阻断 mDNS。不要跳过证书验证；如果改用 IP 或其他域名，证书也需要覆盖该地址。

### 可以部署到公网吗？

可以，需要正确配置 HTTPS、强密码和 `TERMDOCK_PUBLIC_ORIGIN`，详见[公网安全模式](docs/configuration.md#公网安全模式)。终端拥有服务账户权限；应用的认证和路径检查不提供多租户系统隔离。

### 离线还能操作终端吗？

不能。PWA 可以缓存界面，操作终端、访问文件和控制设备仍需要服务连接。手机系统可能暂停后台页面，返回前台后会尝试恢复连接。

### 更新后仍看到旧界面？

CLI 服务更新与 macOS 应用更新相互独立。安装新 CLI 后需确认服务已重启，再接受页面更新并重新加载。手机 PWA 如仍使用旧资源，可彻底关闭后重新打开；不要因此销毁 tmux 会话。

### 浏览器和设备支持到什么程度？

建议使用当前版本的 Chrome、Edge、Firefox 或 Safari。WebGL、剪贴板、PWA 安装和软键盘行为取决于浏览器与系统；macOS / iOS 的特定路径需要实机验收，不能用浏览器模拟结果代替。已知 macOS beta 问题见[本地网络权限记录](docs/macos-27-local-network.md)。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [English README](README.en.md) | 英文介绍与上手指南 |
| [配置说明](docs/configuration.md) | 环境变量、服务监督、公网安全模式 |
| [macOS 桌面版](docs/macos-desktop.md) | 本机服务辅助、快捷键、打包、签名和升级 |
| [协作指南](docs/collaboration.md) | 消息 CLI、跨服务投递、目标、评审和验收 |
| [加密连接与中继](src/server/federation/README.md) | 密码证明、设备授权、入口路由与传输边界 |
| [电子设计预览](docs/electronics-preview.md) | KiCad 预览依赖与位置引用 |
| [模型特征](docs/model-features.md) | 3D 模型特征和坐标引用 |
| [参与贡献](CONTRIBUTING.md) | 开发准备、验证与提交说明 |

## 参与贡献

欢迎通过 [Issues](https://github.com/Jovines/termdock/issues) 反馈问题或讨论功能，也欢迎提交 [Pull Request](https://github.com/Jovines/termdock/pulls)。中文和英文都可以。

除了代码，文档修正、翻译、不同设备上的体验反馈、Agent 插件和真实使用案例都能帮助项目成长。开发流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

如果 Termdock 对你有用，欢迎给项目一个 Star，或把仓库链接分享给需要手机终端、自托管开发环境或多 Agent 协作的朋友。分享截图与复现日志时，请先隐藏密码、邀请链接、密钥与私人路径。

## 许可证与致谢

Termdock 使用 [MIT License](LICENSE)。打包的第三方组件和字体另有各自许可，见[第三方声明](public/third-party-notices.txt)。

感谢 [xterm.js](https://github.com/xtermjs/xterm.js)、[tmux](https://github.com/tmux/tmux)、[node-pty](https://github.com/microsoft/node-pty)、[noVNC](https://github.com/novnc/noVNC) 及其他开源项目；界面配色来自 [Flexoki](https://stephango.com/flexoki)。

<details>
<summary>项目命名备注</summary>

项目新名称暂定为 **Termcove**。目前仅记录改名意向，程序名称、CLI 命令和 npm 包名仍沿用 Termdock / `termdock`；未来正式决定后再统一迁移。

</details>

## CLI 使用示例

### AI 关键进展提醒

你只需对 Agent 说：**用 `td n` 提醒我，先运行 `td n` 看用法。**

`td n` 不带参数时显示帮助和 Agent 使用提示，不会发送提醒；`td n --prompt`
输出可直接复制的提示词。`td notify` 保留为完整名称，两者等价。
`n` 专用于提醒；创建 tmux 会话请用 `td nt` 或 `td --new-tmux`。
注意：1.4.224 的 `n` 存在别名冲突，仍会创建 tmux；该版本请用 `td notify`。

AI 在 Termdock 会话内运行以下命令，即可把关键进展推送到已连接的 TD 页面：

```bash
td n "测试通过，可以开始验收" --title "关键进展"
td notify "需要你确认数据库迁移方案"
td notify "后台任务已完成" --session <来源会话的完整Session-ID>
td notify --help
```

默认从当前终端或 tmux pane 识别来源 Session；脱离终端的后台进程可用
`--session` 指定来源。提醒显示 Session 名称和正文，点击“查看 Session”返回来源，
切换到其他服务工作区也可以看到。多条提醒排队，右上角紧凑卡片可整张点击返回，不会抢走终端焦点。
卡片不会自动消失，只有点击查看或手动关闭后才收起。
左侧 Session 显示未读进展数量，折叠目录组也显示汇总数量；关闭弹出提醒不会清除未读，
只有实际打开对应 Session 查看才会清除。当前可见 Session 收到提醒时不累积未读。

可在 AI 的项目指令中加入：**完成关键里程碑、遇到阻塞或需要我决策时，调用
`td notify "简短描述关键进展和需要我做的事"`；日常过程日志无需提醒。**

这是页面内提醒，不需要系统通知权限。正文最多 4000 字符，标题最多 120 字符。
CLI 输出 JSON；退出码 0 表示已向在线连接转发，不代表用户已阅读。没有在线页面时
返回 `NO_CONNECTED_CLIENT` 和非零退出码。提醒不在服务端离线存储，刷新页面会清空。

### 协作 CLI 的来源身份

后台工具进程无需位于 tmux pane 内，也可以显式指定自己的协作身份：

```bash
td collab --session <自己的完整会话ID> status
td collab --session <自己的完整会话ID> send <接收者ID> "消息"
td collab --session <自己的完整会话ID> reply <消息ID> "回复"
td collab --session <自己的完整会话ID> rebind --pane %173
```

`--session` 适用于所有 `collab` 子命令，指定来源成员；`rebind --pane` 单独指定绑定位置。
来源 ID 使用 `td collab status` 输出中的完整 Termdock 成员 `sessionId`，不是
`wt-…` tmux 名称、后端 ID 或 Claude 会话 ID。可从仍可用的同组会话查询成员列表。
也可设置 `TERMDOCK_COLLAB_SESSION_ID`，命令行参数优先。显式身份会跳过环境和
tmux 检测；无效 ID 由服务端拒绝，不回退到其他身份。现有本地 API 认证和组权限检查仍然生效。
此功能以同一系统用户下的进程彼此信任为前提；`--session` 是来源选择，不是身份认证，
不提供这些进程之间的防冒充隔离。
未指定时仍使用后端环境变量或明确的 `TMUX_PANE` 自动识别；缺少 pane 时不会猜测 tmux 的默认会话。

### 定时任务

`td automation --help` 提供与网页相同的定时任务管理功能。命令默认返回 JSON，成功退出码为 0，失败为 1；Agent 可以保存返回的 `automation.id`，继续管理自己的任务：

```bash
td automation create --name 'Review team progress' --every 30 --self \
  --prompt 'Review collaboration group progress and continue the work'
td automation list
td automation show <automation-id>
td automation pause <automation-id>
td automation resume <automation-id>
td automation run <automation-id>
td automation delete <automation-id>
```

`--self` 选择当前 Termdock 会话，包括服务重启后继续运行的 tmux 会话。其他本机会话使用 `--session <full-session-id>`；每次新建会话使用 `--command '<agent launch command>'`。向既有会话投递时，触发时刻必须已有 Agent 运行。新会话默认使用 CLI 当前目录，可通过 `--cwd` 指定；提示词也可以用 `--file <path>` 或 `--stdin` 提供。

支持 `--every <整分钟>`（1–43200），或 `--at HH:MM` 配合可选的 `--weekdays 1,2,3,4,5`（0 为周日，6 为周六；不填则每天），按服务端时区执行。任务启用且服务运行时会重复触发，`--disabled` 创建暂停状态的任务。运行成功表示已分派，不代表 Agent 已完成工作；定时任务属于当前服务。
