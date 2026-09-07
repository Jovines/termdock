# Termdock 配置体系

## 配置加载链（优先级从高到低）

```
CLI 参数 (--port / --host)
    ↓ 覆盖
系统环境变量 (export PORT=xxx)
    ↓ 覆盖
CWD .env （项目级，开发用）
    ↓ 覆盖
~/.termdock/.env （用户级，npm i -g 后推荐放这里）
    ↓ 覆盖
config.ts 默认值
```

关键规则：**dotenv 不会覆盖已存在的环境变量**，因此高优先级天然不会被低优先级覆盖。

---

## 配置文件位置

| 文件 | 用途 | 何时生效 |
|------|------|---------|
| `src/server/config.ts` | 定义默认值 + 环境变量映射 | 编译时，运行期 lazily 读 env |
| `~/.termdock/.env` | 用户级持久配置 | 每次 `td start` |
| `CWD/.env` | 开发者本地覆盖 | 开发时 `npm run dev` |
| `~/.termdock/settings.json` | 运行时状态（自动管理） | 程序自动读写 |
| `~/.termdock/.boot-check-ok` | 启动检查 marker（自动管理） | CLI 启动 + postinstall |

---

## 启动自检系统 (Boot Check)

Termdock 在每次 CLI 启动时会自动检查系统依赖。通过后写入
`~/.termdock/.boot-check-ok` marker 避免重复检查。

**检查项目：**

| 检查项 | 失败行为 |
|--------|---------|
| node-pty spawn | 自动从源码重编译 |
| tmux 可用性 | 自动尝试通过包管理器安装 |

**适用场景：**
- npm 全局安装 (`npm i -g termdock`)：npm 10+ 默认不运行 lifecycle scripts，postinstall 被跳过。Boot check 在首次 `td` 启动时补做检查。
- 系统环境变化后：删除 `~/.termdock/.boot-check-ok` 可强制下次启动时重新检查。

---

## 如何新增一个可配置值

### 模式：三步法

假设要新增一个 `MAX_FILE_SIZE`（上传文件大小限制，默认 50MB）。

#### Step 1：在 `config.ts` 选择合适的加载方式

根据类型选择函数，然后在对应命名空间对象上加 getter：

```ts
// src/server/config.ts

// —— 值类型：数字 ——
export const FILESYSTEM = {
  get maxFileSize(): number { return envInt('TERMDOCK_FS_MAX_FILE_SIZE', 50 * 1024 * 1024); },
};

// —— 值类型：字符串 ——
export const PATHS = {
  get uploadDir(): string { return envStr('TERMDOCK_UPLOAD_DIR', '/tmp/termdock'); },
};

// —— 值类型：布尔 ——
export const FEATURES = {
  get enableExperimental(): boolean { return envBool('TERMDOCK_FEATURE_EXPERIMENTAL', false); },
};
```

可用辅助函数（已在 `config.ts` 顶部定义）：

| 函数 | 签名 | 用途 |
|------|------|------|
| `envInt(key, fallback)` | 读整数，NaN/非正数 → fallback | 端口、超时、大小 |
| `envStr(key, fallback)` | 读字符串，空串 → fallback | 路径、域名、URL |
| `envBool(key, fallback)` | 读布尔 | 开关类 |

#### Step 2：命名规则

环境变量命名：`TERMDOCK_<CATEGORY>_<PROPERTY>`，全大写蛇形。

| 类别 | 前缀 | 示例 |
|------|------|------|
| 核心服务 | `TERMDOCK_` 或 `PORT`/`HOST` | `PORT`, `HOST` |
| 端口 | `TERMDOCK_PORT_` | `TERMDOCK_PORT_FRONTEND` |
| 安全/认证 | `TERMDOCK_AUTH_` | `TERMDOCK_AUTH_TOKEN_EXPIRY` |
| 终端行为 | `TERMINAL_` | `TERMINAL_IDLE_TIMEOUT` |
| Tmux | `TERMDOCK_TMUX_` | `TERMDOCK_TMUX_HISTORY_LIMIT` |
| Local Access | `TERMDOCK_LOCAL_ACCESS_` | `TERMDOCK_LOCAL_ACCESS_DOMAIN_SUFFIX` |
| 文件系统 | `TERMDOCK_FS_` | `TERMDOCK_FS_MAX_FILE_SIZE` |
| 功能开关 | `TERMDOCK_FEATURE_` | `TERMDOCK_FEATURE_ENABLE_X` |

#### Step 3：在 `.env.example` 和本文档补充

- `.env.example`：加注释示例
- 本文档「现有配置速查表」：加一行

---

## 为什么用 getter 而不是直接读 env

ESM 的 `import` 是 **hoisted**（提升）的——所有静态 import 在模块体执行前就已解析完毕。

```ts
// cli.ts
import { PORT } from './config.js';  // ← 此时 dotenv 还没执行！
loadDotenv(...);                      // ← dotenv 在这之后才加载
```

如果 `config.ts` 在模块加载时就读取 `process.env.PORT`，读到的是 dotenv 加载前的值（空）。

**getter 解决这个问题**：`PORT.backend` 不是存值，而是每次访问时才调用 `envInt('PORT', 9834)`。这意味着无论何时访问，都能读到 dotenv 加载后的正确值。

```ts
export const PORT = {
  // ✅ getter：每次访问时读 env，永远是最新值
  get backend(): number { return envInt('PORT', 9834); },

  // ❌ 不要这样写——env 值在 import 时就固化了
  // backend: envInt('PORT', 9834),
};
```

---

## 现有配置速查表

### 端口

| 配置项 | 环境变量 | 默认值 | 定义位置 |
|--------|---------|--------|---------|
| 正式服务端口 | `PORT` | 9834 | `config.ts` PORT.backend |
| 前端开发端口 | `TERMDOCK_PORT_FRONTEND` | 9833 | `config.ts` PORT.frontend |
| 后端开发端口 | `TERMDOCK_PORT_DEV_BACKEND` | 9835 | `config.ts` PORT.devBackend |

### 网络

| 配置项 | 环境变量 | 默认值 | 定义位置 |
|--------|---------|--------|---------|
| 监听地址 | `HOST` | 0.0.0.0 | `config.ts` DEFAULT_HOST |
| 公网严格模式 | `TERMDOCK_PUBLIC_ORIGIN` | 未启用 | `utils/publicSecurity.ts` |
| 登录密码（覆盖文件） | `TERMDOCK_PASSWORD` | 未设置 | `utils/authProtection.ts` |
| 域名白名单 | `TERMDOCK_ALLOWED_HOSTS` | — | 多个文件读 env |
| mDNS 域名后缀 | `TERMDOCK_LOCAL_ACCESS_DOMAIN_SUFFIX` | termdock.local | `config.ts` LOCAL_ACCESS |
| mDNS 名称长度 | `TERMDOCK_LOCAL_ACCESS_NAME_LENGTH` | 4 | `config.ts` LOCAL_ACCESS |
| mDNS 字母表 | `TERMDOCK_LOCAL_ACCESS_NAME_ALPHABET` | a-z0-9 | `config.ts` LOCAL_ACCESS |
| mDNS TTL | `TERMDOCK_LOCAL_ACCESS_MDNS_TTL` | 120s | `config.ts` LOCAL_ACCESS |

### 终端行为

| 配置项 | 环境变量 | 默认值（dev/prod） | 定义位置 |
|--------|---------|--------|---------|
| 空闲超时 | `TERMINAL_IDLE_TIMEOUT` | 30min / 6h | `config.ts` TERMINAL.idleTimeout |
| 清理间隔 | — | 1min / 5min | `config.ts` TERMINAL.cleanupInterval |
| 重连回传行数 | `TERMINAL_RECONNECT_SCROLLBACK` | 200 | `config.ts` TERMINAL.reconnectScrollback |
| 流控暂停租赁 | `TERMINAL_FLOW_CONTROL_PAUSE_LEASE_MS` | 15s | `config.ts` TERMINAL.flowControlPauseLeaseMs |

### Tmux

| 配置项 | 环境变量 | 默认值 | 定义位置 |
|--------|---------|--------|---------|
| 历史限制 | `TERMDOCK_TMUX_HISTORY_LIMIT` | 10000 | `config.ts` TMUX.historyLimit |
| 轮询间隔 | `TMUX_POLL_INTERVAL` | 500ms | terminal.ts 直接读 env |
| 活跃程序轮询 | `TERMINAL_ACTIVE_PROGRAM_POLL_INTERVAL` | 1200ms | terminal.ts 直接读 env |

### 其他

| 配置项 | 环境变量 | 默认值 | 定义位置 |
|--------|---------|--------|---------|
| Shell | `SHELL` | 继承当前 | 多个文件读 env |
| 额外路径 | `ALLOWED_PATHS` | — | pathValidator 读 env |
| 开发模式 | `NODE_ENV` | — | 影响多个默认值 |


## 公网安全模式

Termdock 的登录用户拥有运行服务的系统账户权限，终端可以执行任意命令。
Host 白名单、CSRF 和文件路径检查不能代替认证，也不是操作系统沙箱。

先运行 `td --set-password` 设置至少 16 位、唯一的高强度密码，再配置：

```dotenv
TERMDOCK_PUBLIC_ORIGIN=https://term.example.com:9834
```

该值是浏览器访问的完整 HTTPS origin，端口映射时填写外部端口。
程序自动加入对应 Host 白名单，并只接受这个精确的浏览器 Origin（协议、主机、端口都匹配）；
WebSocket 在此模式下不能省略 Origin。HTTP CLI 可不带 Origin，但私有接口仍要求认证。

端口映射应指向 Termdock 的 HTTPS 监听器。程序在公网模式下拒绝无 TLS 的非回环监听。
已有 TLS 反向代理可以连接仅监听 `127.0.0.1` / `::1` 的 HTTP 后端；程序不会自动信任
`X-Forwarded-For` 或 `X-Forwarded-Proto`。此配置不会申请证书、配置路由器或开放防火墙。
公网访问需要客户端可验证、与访问域名匹配的证书。

公网模式同时强制 Secure Cookie 和 HSTS。所有认证会话采用 30 天滑动有效期：已认证访问同时续期服务端会话与浏览器 Cookie，
连续 30 天未访问才需要重新登录，不另设 12 小时或 30 分钟上限。页面切回前台及可见时每小时
会检查登录状态并续期，续期结果会持久化；改密码和主动退出仍立即撤销会话。
旧版本存储的密码如果没有长度元数据，需要重新运行 `td --set-password`。
建议使用文件保存密码哈希；环境变量密码会被子进程继承，并且对应会话在重启后失效。
本次会话存储升级会使旧格式会话失效，需要重新登录。

所有模式下均有以下应用防护：

- `/api` 默认要求认证（已设置密码时），认证发生在解析请求体之前；公开端点和带作用域的预览另行验证。
- scrypt 密码验证使用异步工作线程，最多并发 2 次、全局每分钟 30 次，并保留逐来源 IP 的指数退避。
- 会话令牌只保存 SHA-256 摘要，绑定当前密码版本；退出登录同步落盘并立即断开关联 WebSocket。
- WebSocket 每次输入前及每秒检查会话，消息上限 1 MiB、全局连接上限 256；HTTP 有连接、头部和读取超时上限。
- HTML / SVG 文件预览的响应携带 CSP sandbox，顶层直接打开同样不能取得应用来源权限。
- 预览令牌绑定登录会话与目录，30 分钟绝对过期，不会因不断加载资源无限续期；访问日志隐藏令牌。
- 应用页面限制内联脚本和事件处理器，禁止对象插件及跨来源嵌入；客户端日志接口需要认证并校验 Origin。
- 本机 CLI 特权调用同时要求回环地址、专用令牌，且拒绝浏览器来源头。

这些措施不提供抗大流量 DDoS 或多租户隔离。需要更强身份保证时，应在入口增加 MFA / VPN，
并以独立、最小权限的系统账户运行服务。程序本身的回归测试不替代公网链路的实际验收。
