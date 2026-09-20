#!/usr/bin/env node
/**
 * 「被监督的服务」的替身：一棵自建端口的小 HTTP 服务，行为完全由控制文件驱动。
 *
 * 为什么不盯真服务：端到端要验的是 supervisor 的**判定与重启**，而真服务启动要几秒、
 * 还要读配置/开 pty/挂路由，5 个用例会被拖成分钟级。这里只保留 supervisor 真正依赖的
 * 三件事：IPC 就绪消息、`/health` 的应答、退出码。
 *
 * 控制文件是 JSON（缺失即全默认）：
 *   {
 *     serve: boolean,            // /health 是否应答（false = 卡死模拟）
 *     ready: boolean,            // 是否发 termdock-ready
 *     bootExitCode: number|null, // 启动即退出（崩溃循环模拟）
 *     announceIntent: 'restart-after-update' | 'stop' | null,
 *     announceAfterMs: number,   // ready 之后多久发 intent
 *     intentExitCode: number     // 发完 intent 的退出码
 *   }
 * 每 POLL_MS 重读一次，所以测试能中途把它翻成 serve:false 来模拟"跑着跑着卡住了"。
 *
 * 用 .mjs 而非 .ts：supervisor 是用 `process.execPath <entry>` 直接拉起子进程的，
 * 没有 tsx loader；写成 .ts 就得让测试专用的 loader 渗进生产 spawn 代码。
 */

import fs from 'node:fs';
import http from 'node:http';
import { exitWithStartupFailure } from '../utils/startupFailure.ts';

const POLL_MS = 50;

const args = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};

const controlPath = valueOf('--control');
const portFile = valueOf('--port-file');
const requestedPort = Number(valueOf('--port', '0'));

const DEFAULTS = {
  serve: true,
  ready: true,
  bootExitCode: null,
  announceIntent: null,
  announceAfterMs: 200,
  intentExitCode: 0,
};

function readControl() {
  if (!controlPath) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(controlPath, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

const boot = readControl();

// 启动即死：模拟"坏的版本"——supervisor 必须据此计数并最终放弃，
// 而不是无限重启或者什么都不做。
if (typeof boot.bootExitCode === 'number') {
  process.exit(boot.bootExitCode);
}

const send = (message) => {
  if (process.connected) process.send(message);
};

const server = http.createServer((req, res) => {
  // 卡死模拟：连接照收、永不应答。客户端看到的是一条 socket 超时——
  // 这正是真实 wedge（事件循环被占死）在探测侧的样子。
  if (!readControl().serve) return;
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.on('error', (error) => {
  exitWithStartupFailure(error.code === 'EADDRINUSE' ? 'port-conflict' : 'startup-failure', error.message);
});

server.listen(requestedPort, '127.0.0.1', () => {
  if (portFile) fs.writeFileSync(portFile, String(server.address().port));
  if (boot.ready !== false) send({ type: 'termdock-ready' });
});

if (boot.announceIntent) {
  // 「申请重启」是一次性条件：真实服务只在**刚应用完更新**时提这个要求，
  // 新世代重新读到同一个控制文件不该再申请一遍（否则测试里会无限重启）。
  // 标记文件就是那个条件的替身。
  const marker = controlPath ? `${controlPath}.announced` : null;
  const announced = marker ? fs.existsSync(marker) : false;
  if (marker && !announced) fs.writeFileSync(marker, '1');
  if (!announced) {
    setTimeout(() => {
      send({ type: 'termdock-intent', intent: boot.announceIntent });
      setTimeout(() => process.exit(boot.intentExitCode), 20);
    }, boot.announceAfterMs);
  }
}
