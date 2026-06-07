---
name: termdock-install
description: >-
  Termdock 正式本地安装/升级部署与可访问性验证。仅当用户要安装、升级、重装、发布到本机全局
  termdock CLI，或明确要求验证正式安装后的服务时使用；不要把它当成日常开发调试 skill。执行
  install-local.sh 重新构建并全局安装，重启正式服务，并验证 prod 端口 9834、HTTPS/HTTP、Local
  Access、onboarding/CA、静态资源完整性。
user-invocable: true
allowed-tools: Bash, Read
---

# Termdock 正式本地安装部署验证

## 触发场景

当用户要把当前仓库构建后安装成全局 `termdock` CLI、升级/重装本机正式服务、验证正式安装后的访问能力，或明确说“安装本地版本 / 正式部署 / 重新安装 termdock / 验证安装后的服务”时使用本 skill。

不要在普通开发调试、只运行 dev server、只做单元测试、只查看代码时触发。开发态验证应使用项目常规命令；本 skill 的定位是“安装到本机并验证正式服务”。

目标不是只证明能编译，而是证明全局安装后的 `termdock` 真正运行在当前机器上，并且浏览器、手机引导、证书/CA、静态资源都能访问。

## 当前端口约定

- 开发前端：`9833`
- 开发后端：`9835`
- 正式/本地安装服务：`9834`
- HTTPS 开启后，正式服务 URL 是 `https://localhost:9834`；未配置证书时是 `http://localhost:9834`。
- onboarding 是独立 HTTP 临时端口，由 `termdock --status` 输出，例如 `http://<LAN-IP>:<port>/onboarding`。

## 执行步骤（严格按顺序）

### 0. 确认 Node >= 20

部署命令必须在 Node >=20 的环境里运行。不要假设某个版本管理器一定存在；如果当前 shell 不是 Node 20+，先按用户机器上的工具切换（nvm/fnm/asdf/volta/Homebrew 均可）。

```bash
cd "$(git rev-parse --show-toplevel)" && \
  node -v && npm -v
```

若 `node -v` 小于 20，切换到任意可用的 Node 20+ 环境后重试，例如 `nvm use 20`、`fnm use 20`、`asdf shell nodejs 20` 或项目约定的 Node 安装路径。

要求：`node -v` 至少是 20。若失败，先修 Node 环境再继续。

### 1. 类型检查（快速失败）

```bash
cd "$(git rev-parse --show-toplevel)" && \
  npm run lint
```

无 TypeScript 错误表示通过。

### 2. 重新构建并全局安装

```bash
cd "$(git rev-parse --show-toplevel)" && \
  bash install-local.sh
```

该脚本会执行 `npm install` → `npm rebuild node-pty` → `npm run build` → `npm install -g .`。timeout 至少给 1200000ms。

成功标志：输出 `Done. Termdock installed globally.`

### 3. 重启正式服务

```bash
termdock --stop 2>&1 || true
termdock
```

成功标志：输出 `Termdock started in background.`，并显示 `URL:`。如果存在 `~/.termdock/certs/termdock-local.pem` 和 key，会自动启用 HTTPS。

### 4. 等待健康检查

根据当前协议选择 health URL：

```bash
STATUS_OUTPUT="$(termdock --status)"
printf '%s\n' "$STATUS_OUTPUT"
BASE_URL="$(printf '%s\n' "$STATUS_OUTPUT" | sed -n 's/.*URL:[[:space:]]*\(.*\)$/\1/p' | head -n 1)"

if printf '%s' "$BASE_URL" | rg -q '^https:'; then
  CURL_TLS=(--cacert "$HOME/.termdock/certs/rootCA.pem")
else
  CURL_TLS=()
fi

timeout=20
until curl -sS "${CURL_TLS[@]}" "$BASE_URL/health" >/tmp/termdock-health.json; do
  timeout=$((timeout-1))
  if [ "$timeout" -le 0 ]; then
    echo "Timed out waiting for $BASE_URL/health" >&2
    tail -80 ~/.termdock/server.log >&2 || true
    exit 1
  fi
  sleep 1
done
cat /tmp/termdock-health.json
```

通过条件：返回 JSON 且包含 `"status":"ok"`。

### 5. 自动化登录（先尝试复用 cookie）

```bash
cd "$(git rev-parse --show-toplevel)" && \
  bash auth-login.sh --url "$BASE_URL" ${CURL_TLS:+--cacert "$HOME/.termdock/certs/rootCA.pem"}
```

成功标志：输出以下其一：

- `Existing automation cookie is still valid; skip login.`
- `Login succeeded. Cookie jar saved to ...`

若 cookie 失效，需要用户提供 `TERMDOCK_PASSWORD`。不要通过 `--clear-password` 或删除 `~/.termdock/auth.json` 绕过鉴权。

### 6. 正式页面可访问性验证

```bash
curl -sS "${CURL_TLS[@]}" -b ~/.termdock/automation.cookies \
  -o /tmp/termdock-resp.html \
  -w "HTTP %{http_code} | size=%{size_download} | time=%{time_total}s\n" \
  "$BASE_URL"
```

通过条件：

- `HTTP 200`
- `size > 5000`

### 7. 静态资源完整性验证

```bash
JS=$(rg -o 'assets/[A-Za-z0-9_-]+\.js' /tmp/termdock-resp.html -N -m 1)
curl -sS "${CURL_TLS[@]}" -b ~/.termdock/automation.cookies \
  -o /dev/null -w "JS %{http_code}\n" "$BASE_URL/$JS"
curl -sS "${CURL_TLS[@]}" -b ~/.termdock/automation.cookies \
  -o /dev/null -w "MANIFEST %{http_code}\n" "$BASE_URL/manifest.webmanifest"
```

通过条件：两条全部 `200`。

### 8. Local Access / onboarding / CA 验证

```bash
STATUS_OUTPUT="$(termdock --status)"
printf '%s\n' "$STATUS_OUTPUT"
SETUP_URL="$(printf '%s\n' "$STATUS_OUTPUT" | sed -n 's/.*Setup:[[:space:]]*\([^[:space:]]*\).*/\1/p' | head -n 1)"

if [ -n "$SETUP_URL" ]; then
  BASE_SETUP="${SETUP_URL%/onboarding}"
  curl -sS -o /tmp/termdock-onboarding.html \
    -w "ONBOARDING %{http_code} size=%{size_download}\n" "$SETUP_URL"
  rg -n 'Termdock Local Access|Download CA certificate|data:image/png|Wi-Fi|Network adapter' /tmp/termdock-onboarding.html

  curl -sS -o /tmp/termdock-ca.pem \
    -w "CA %{http_code} size=%{size_download}\n" "$BASE_SETUP/ca"
  head -n 1 /tmp/termdock-ca.pem
fi
```

通过条件：

- onboarding `HTTP 200`
- 页面包含 `Termdock Local Access`
- 页面包含二维码 `data:image/png`
- 页面按适配器列出地址（例如 `Wi-Fi` / `Network adapter`）
- `/ca` 返回 `HTTP 200`，首行是 `-----BEGIN CERTIFICATE-----`

### 9. Settings API 验证本地访问数据

```bash
curl -sS "${CURL_TLS[@]}" -b ~/.termdock/automation.cookies \
  "$BASE_URL/api/terminal/settings" | python3 -c '
import sys,json
j=json.load(sys.stdin)["localAccess"]
print("url=", j.get("url"))
print("fallbackUrl=", j.get("fallbackUrl"))
print("onboardingUrl=", j.get("onboardingUrl"))
print("interfaces=", [(i.get("name"), i.get("address"), bool(i.get("qrDataUrl")), i.get("url")) for i in j.get("interfaces", [])])
'
```

通过条件：

- `url` 是 `https://<name>.termdock.local:9834` 或 HTTP fallback
- `onboardingUrl` 与 `termdock --status` 的 Setup 一致
- `interfaces` 至少包含当前可用 IPv4 网卡
- 每个 interface 都有 `qrDataUrl=true` 和对应 IP URL

### 10. 证书 SAN 验证（HTTPS 模式）

```bash
if printf '%s' "$BASE_URL" | rg -q '^https:'; then
  openssl x509 -in ~/.termdock/certs/termdock-local.pem -noout -ext subjectAltName
fi
```

通过条件：SAN 包含：

- `DNS:*.termdock.local`
- 当前前缀的精确域名，例如 `DNS:9yq4.termdock.local`
- `DNS:localhost`
- 当前非 loopback、非 `169.254.*` 的 LAN IP
- `IP Address:127.0.0.1`

### 11. 开发/正式端口分离检查

```bash
rg -n '9833|9834|9835|PORT\.frontend|PORT\.backend|PORT\.devBackend' \
  src/server/config.ts vite.config.ts package.json restart-dev.sh README.md
```

确认语义：

- Vite dev frontend: `9833`
- dev backend: `9835`
- prod/local installed service: `9834`
- Vite proxy 指向 `PORT.devBackend`

## 失败时的处理

- **Node 版本错误 / Vite 报 Node 版本**：回到第 0 步，确保 PATH 使用 Node >=20。
- **`npm run lint` 失败**：先修 TypeScript 错误。
- **install-local.sh 失败**：多半是 `node-pty` 编译或 Node 版本；检查输出并修复。
- **HTTP 访问 HTTPS 端口出现 `Empty reply from server`**：说明服务当前是 HTTPS，改用 `https://localhost:9834` 和 `--cacert ~/.termdock/certs/rootCA.pem`。
- **onboarding 不通**：以 `termdock --status` 的 `Setup:` 为准，不要猜 `:9834/onboarding`。
- **手机 mDNS 不通**：这是网络/路由器组播限制；使用 onboarding 页面里的 IP fallback 二维码。
- **证书风险**：重新运行 `termdock --setup-local-https`，确保证书 SAN 包含当前域名前缀和当前 LAN IP，然后重启服务。
- **资源 404 / HTML 很小**：查看 `tail -80 ~/.termdock/server.log`，并检查 `dist/client/` 是否是最新 build。

## 不可省略的原则

1. 先确保 Node >=20。
2. 不要只跑 `npm run build` 就结束；必须 `install-local.sh` 全局安装。
3. 必须重启 `termdock` 后验证真实后台服务。
4. HTTPS 模式下验证要使用 HTTPS + CA，不要用 HTTP 打 9834。
5. 必须验证 onboarding、`/ca`、Settings API、静态资源。
6. 失败必须继续调试直到通过，不要把未验证结果交给用户。
7. 服务保持后台运行，不要 foreground 阻塞会话。
