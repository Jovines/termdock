---
name: termdock-deploy
description: >-
  Termdock 部署到 9834 正式服务与可访问性验证。两类触发：(1) 改动需要用户验收——尤其
  手机/PWA 可感知的 UI/交互变化，交付验收前必须先部署 9834，不能只验证 dev 端口就收工；
  (2) 用户明确要安装/升级/重装/发布本机全局 termdock CLI。日常代码改动走快速路径
  (build + install -g + 重启)，依赖/原生模块/首次安装走 install-local.sh 完整路径。
  重启后须验证 prod 端口 9834、资产新鲜度(线上 bundle = 本地 dist)、HTTPS/CA、onboarding。
user-invocable: true
allowed-tools: Bash, Read
---

# Termdock 部署 9834 与验收

## 触发场景

- **改动需要用户验收**：UI/交互/PWA 可感知的变化完成后，用户验收走手机 PWA = 9834 正式服务。交付验收**之前**必须走本 skill 部署并验证，禁止只在 dev 端口(9833/9835)验证完就让用户去测——dev 端口和 9834 是两套产物（9834 服务的是全局 npm 安装的包，不装不重启就一直发旧包）。
- 用户明确说“安装本地版本 / 正式部署 / 重新安装 termdock / 验证安装后的服务 / 发版部署”。

不要在纯代码阅读、单元测试、仅 dev server 调试时触发。

## 端口与产物约定

- 开发前端：`9833`(vite dev)；开发后端：`9835`(tsx watch)
- 正式服务：`9834`（全局 `termdock` CLI，`npm install -g .` 安装到 `$(npm root -g)/termdock`，`td`/`termdock` 命令管理）
- **关键认知**：改仓库代码 ≠ 9834 生效。9834 只发全局安装位置的包；必须 `npm install -g .` 把新 dist 装过去再重启。
- HTTPS URL：`https://localhost:9834`；curl 验证加 `--cacert ~/.termdock/certs/rootCA.pem`。
- 用户手机 PWA 通过 `https://<prefix>.termdock.local:9834` 或 LAN IP 访问，同一服务。

## 路径选择

- **快速路径（默认）**：仅仓库代码变动（src/、i18n、样式），依赖未变。
- **完整路径**：`package.json` 依赖变化、`node-pty` 原生模块问题、首次安装、快速路径失败时。

## 快速路径（日常改动验收）

```bash
cd "$(git rev-parse --show-toplevel)"
npm run lint          # 类型检查，有错先修
npm run build         # client + server
npm install -g .
```

重启（CLI 内部已处理：`--stop` 等进程退出再返回，`termdock` 等 /health 就绪再返回）：

```bash
termdock --stop 2>&1 || true
termdock              # 自身 daemonize，不要用 run_in_background
```

## 完整路径（依赖/原生/首次）

```bash
cd "$(git rev-parse --show-toplevel)"
node -v               # 必须 >= 20，不够先切 nvm/fnm 等
bash install-local.sh # npm install → rebuild node-pty → build → install -g .；timeout >= 1200000ms
```

重启（CLI 内部已处理——同上）：

```bash
termdock --stop 2>&1 || true
termdock              # 自身 daemonize，不要用 run_in_background
```

## 部署后验证（两条路径都要做）

部署时 `termdock` 已内部等待 /health 就绪。以下验证资产新鲜度和 CA：

### 1. 提取服务 URL

```bash
STATUS_OUTPUT="$(termdock --status)"; printf '%s\n' "$STATUS_OUTPUT"
BASE_URL="$(printf '%s\n' "$STATUS_OUTPUT" | sed -n 's/.*URL:[[:space:]]*\(.*\)$/\1/p' | head -n 1)"
CURL_TLS=(); printf '%s' "$BASE_URL" | rg -q '^https:' && CURL_TLS=(--cacert "$HOME/.termdock/certs/rootCA.pem")
# 健康检查已在部署脚本末尾完成，此处直接进入新鲜度验证
```

### 2. 资产新鲜度（最关键——证明线上是新包）

```bash
LOCAL_JS=$(rg -o 'assets/index-[^"]+\.js' dist/client/index.html -N -m1)
SERVED_HTML=$(curl -sS "${CURL_TLS[@]}" "$BASE_URL")
SERVED_JS=$(printf '%s' "$SERVED_HTML" | rg -o 'assets/index-[^"]+\.js' -N -m1)
[ -n "$LOCAL_JS" ] && [ "$LOCAL_JS" = "$SERVED_JS" ] && echo "FRESH: $SERVED_JS" || { echo "STALE: local=$LOCAL_JS served=$SERVED_JS"; exit 1; }
```

若改动含用户可见文案，再 grep 一句新文案坐实新代码上线（i18n 字符串会进 bundle）：

```bash
curl -sS "${CURL_TLS[@]}" "$BASE_URL/$SERVED_JS" | rg -c '新文案片段'
```

### 3. CA 稳定性（用户手机已装 CA，换 CA = 手机全部失联）

```bash
openssl x509 -in ~/.termdock/certs/rootCA.pem -noout -dates -fingerprint
```

`notBefore` 应保持历史日期（当前基线 `Apr 6 2026`,mkcert CA 十年有效）。重启可能重新签发**服务器证书**（同一 CA 签发，无影响），但 `rootCA.pem` 内容不能变。若 CA 真换了，必须告知用户手机要重新安装 CA（onboarding 页），并确认后再继续。

### 4. 完整路径追加验证（正式安装/升级时）

- 登录：`bash auth-login.sh --url "$BASE_URL" ${CURL_TLS:+--cacert "$HOME/.termdock/certs/rootCA.pem"}`（复用 automation cookie；失效则要 `TERMDOCK_PASSWORD`，不得绕过鉴权）
- 页面：`curl -b ~/.termdock/automation.cookies` 取 `$BASE_URL`，HTTP 200 且 size > 5000
- 静态资源：上一步 HTML 里的 JS + `/manifest.webmanifest` 均 200
- onboarding：`termdock --status` 的 `Setup:` URL 200，含 `Termdock Local Access`、二维码 `data:image/png`；`{Setup 去 /onboarding}/ca` 返回 `-----BEGIN CERTIFICATE-----`
- Settings API：`/api/terminal/settings` 的 `localAccess.interfaces` 含当前网卡且 `qrDataUrl=true`
- 证书 SAN：`openssl x509 -in ~/.termdock/certs/termdock-local.pem -noout -ext subjectAltName` 含 `*.termdock.local`、当前前缀域名、`localhost`、当前 LAN IP、`127.0.0.1`

## 交付验收话术（发给用户前）

部署验证通过后，告知用户：

1. 已部署到 9834，附上 served 资产 hash（如 `index-BSuMMXNw.js`）和时间。
2. **iOS PWA 必须彻底划掉重开**——SW 有旧包缓存，"改了没生效"先彻底重启 PWA 再反馈（参见 memory: ios-pwa-sw-stale-cache）。
3. 需要 CA 重装的（仅当 CA 真变了）单独强调。

## 失败时的处理

- **Node 版本错误**：切到 Node >=20 重来。
- **`npm run lint` 失败**：先修 TypeScript 错误。
- **install-local.sh 失败**：多半是 `node-pty` 编译或 Node 版本。
- **`Empty reply from server`**：协议用错，9834 是 HTTPS，加 `--cacert`。
- **STALE（资产新鲜度不过）**：确认 `npm install -g .` 真的执行了、重启的是 9834 对应的全局包；检查 `$(npm root -g)/termdock/dist` 的 mtime。
- **onboarding 不通**：以 `termdock --status` 的 `Setup:` 为准，不要猜 `:9834/onboarding`。
- **手机 mDNS 不通**：路由器组播限制，用 onboarding 页里的 IP fallback 二维码。
- **`Port 9834 is already in use`**：极端情况（SIGKILL 后端口未释放）。`lsof -tiTCP:9834 -sTCP:LISTEN | xargs kill -9` 清端口后重来。`--stop` 已内置 5s 优雅退出，正常情况下不应出现。
- **资源 404 / HTML 很小**：`tail -80 ~/.termdock/server.log`，检查 `dist/client/` 是否最新。

## 不可省略的原则

1. 用户要验收 → 先部署 9834 再交付；dev 端口验证不能替代。
2. 不要只跑 `npm run build` 就收工；必须 `npm install -g .` + 重启 + 验证。
3. 资产新鲜度必须过：served `index-*.js` == 本地 `dist/client/index.html` 引用的。
4. HTTPS 验证用 HTTPS + CA，不要用 HTTP 打 9834。
5. 失败必须继续调试直到通过，不要把未验证结果交给用户。
6. 服务保持后台运行，不要 foreground 阻塞会话。
