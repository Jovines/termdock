# Client Log — 手机端日志收集

Termdock 运行在用户手机上（浏览器 / PWA），无法直接查看开发者工具。
通过 `clientLog` 工具函数，可以将手机端的日志实时转发到服务端，
方便问题排查。

## 使用方式

```typescript
import { clientLog } from '../utils/clientLog';

clientLog('info', 'something happened', { key: 'value' });
clientLog('debug', 'state changed', { oldValue, newValue });
clientLog('error', 'unexpected condition', { stack: e.stack });
```

## 在服务端查看

服务端启动后会打印在 `stdout`：

```bash
tail -f /tmp/termdock-dev.log | grep "client-log"
```

每一行格式：

```
[client-log 2026-05-30T08:00:00.000Z] [info] something happened {"key":"value"}
```

## 原理

1. `src/lib/utils/clientLog.ts` — 前端工具函数，支持 `info` / `debug` / `warn` / `error` 四个级别。
   每个调用同时输出到浏览器 Console（方便本地调试）和 `POST /api/client-log`。

2. `src/server/entry.ts` — `POST /api/client-log` 端点，接收日志转写到 Node.js `console.log`。

3. 服务端 `console.log` 由进程管理器（如 systemd / concurrently）重定向到日志文件。

## 注意事项

- 日志端点**不走 CSRF 校验**（手机上抓包都难，没必要）。
- 线上环境建议增加最小限流，避免恶意灌日志。
- 不在循环或高频路径中使用 `clientLog('debug', ...)`，每条都会触发 HTTP 请求。
