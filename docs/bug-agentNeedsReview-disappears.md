# Bug: `agentNeedsReview` (yellow dot) disappears ~1.2s after agent completes

## Symptom

Agent 任务完成后，tab 栏图标短暂显示黄色脉冲圆点（表示"未 review"），约 1~2 秒后消失，直接回到 agent 品牌 icon，用户无法感知有未查看的结果。

## Expected Behavior（预期逻辑）

`reviewed` 是 server-authoritative 的布尔标记，语义为"当前这一轮 agent 结果是否已被用户查看/确认"。它必须**贯穿整个 session 存活**，不因 agent 进程退出而丢失，也不因页面刷新而重置。

### 状态机全生命周期

```
                  prompt-submit        stop
  ┌──────┐       ┌──────────┐       ┌───────┐
  │ idle │ ───→  │ working  │ ───→  │ done  │   reviewed = false（黄点亮）
  └──────┘       └──────────┘       └───────┘
       ↑                                │
       │                                │
       │         session-end            │
       └────────────────────────────────┘   reviewed 保持 false（不重置，用户仍需 ack）
                                                    │
                                                    ▼
                                            ┌────────────┐
                                            │ user views │  → sendAgentReviewAck()
                                            │  the tab   │
                                            └────────────┘
                                                    │
                                                    ▼
                                            reviewed = true（黄点灭）
```

### 关键属性

| 属性 | 说明 |
|------|------|
| **server-authoritative** | 状态由 server 控制，client 只消费。WS 重连时 server 通过 `buildAgentStatusPayload` 重新推送当前值，确保刷新后不丢状态 |
| **贯穿 agentSession 生命周期** | `reviewed` 不随着 `agentSession` 被 null 化而消失。agent 进程退出后、直到用户 ack 之前，`reviewed: false` 必须持续有效 |
| **`stop` → `reviewed = false`** | agent 产出结果时标记"待查看" |
| **`session-end` 不重置** | agent 对话结束回到 idle 时，`reviewed` 保持 `false`，等待用户切到该 tab 触发 ack |
| **`prompt-submit` → `reviewed = true`** | 用户发新 prompt 即视为已查看上一轮结果 |
| **`agent-review-ack` → `reviewed = true`** | 用户切换到该 session 的 tab 时，前端发送 ack，服务端确认已查看 |
| **agentSession 销毁 ≠ reviewed 消失** | `syncAgentIdentity` 清空 `agentSession` 是"agent 进程不在前台"的实现细节，不应影响 `reviewed` 的语义 |

## Root Cause

**竞态**：server 端两个路径互相抵消 `reviewed` 状态。

### Step 1 — 状态正确设置
```
Agent 进程结束
  → OSC 'stop' 信号 → applyAgentEvent → reviewed = false
  → OSC 'session-end' 信号 → applyAgentEvent → status = 'idle', reviewed 保持 false（设计意图：等待用户 ack）
  → broadcastAgentStatus → 客户端收到 { agentStatus: 'idle', reviewed: false }
  → store: agentNeedsReview = true  ✓ 黄点显示
```

### Step 2 — 轮询覆盖状态
```
~1.2s 后 activeProgram 轮询触发
  → syncAgentIdentity() 检测到 agent 进程已不在前台
  → 执行 session.agentSession = null   ← 销毁整个 agentSession，包括 reviewed: false
  → broadcastAgentStatus → 客户端收到 { agentStatus: null, reviewed: null }
  → store fallback 逻辑：
      wasActive = existing.agentStatus === 'working' || ... || 'done'  ← 'idle' 不在列表里
      agentNeedsReview = ... || (... && wasActive && ...)
      因为 wasActive = false，fallback 不触发 → agentNeedsReview = false  ✗ 黄点消失
```

### 关键代码位置
- `src/server/routes/terminal.ts:2690` — `syncAgentIdentity()` 无条件 `session.agentSession = null`
- `src/server/routes/terminal.ts:2637` — `buildAgentStatusPayload()` 在 state 为 null 时返回 `reviewed: null`
- `src/lib/stores/useTerminalStore.ts:449` — `wasActive` 计算不包含 `'idle'` 状态
- `src/server/agent/session.ts:163-167` — `session-end` 事件故意不重置 `reviewed`（设计意图正确，但被 Step 2 覆盖）

## Related

- 引入 `reviewed` 的 commit: `563d1ef`（"fix: session-end should not reset reviewed flag"）
- `syncAgentIdentity` 的设计背景：注释于 line 2684-2687, `src/server/routes/terminal.ts`
