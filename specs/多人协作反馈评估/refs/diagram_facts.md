# 事实与证据口径

核查日期：2026-09-15。以下源码事实来自本会话的只读检查，不代表现场运行版本已核对，也不代表问题已复现或测试已通过。

## 反馈来源

用户转交的协调者完整版反馈，消息 ID：k98mdv47ri；补充反馈 ID：at640so0t6。反馈描述 4 个 Agent 与 1 个用户高强度协作一个工作日。完整版合计 8 项问题、2 项功能建议；此前“10 条吐槽＋2 条建议”为计数误差。

6.6 KB 长消息、远端已收到但源端 pending、read_at 全为空、ANSI 残留均为现场报告，尚无本地复现。需索取具体故障消息 ID；上述反馈消息 ID 不自动等于故障样本 ID。

## 源码证据

路径相对仓库根目录。

| 讨论编号 | 路径与定位符 | 已观察事实 | 不能据此得出的结论 |
|---|---|---|---|
| 1、2 | src/server/agent/collaborationStore.ts：receipt、mergeFederatedMessages | 有传输诊断字段和联合消息状态合并逻辑 | 尚未核查完整跨节点链路，不能确认卡在哪个环节 |
| 3 | src/server/agent/collaborationRoutes.ts：POST /reply、POST /message/:id/read | 成功保存回复后会 markRead；提供显式已读接口 | 不代表远端回执一定已返回源端；普通 send 不能等同于 reply |
| 4 | src/server/agent/collaborationCli.ts：WAIT_TIMEOUT 分支 | 返回 ok:false、code:WAIT_TIMEOUT、stage_reached、delivery_continues，退出码 2；有投递完成但等待回复超时的文字提示 | 不能说当前完全没有区分超时与投递失败 |
| 5 | src/server/agent/collaborationTmuxDelivery.ts：writeCollaborationTmuxPane | 通过 stdin 加载 tmux buffer，再 paste-buffer -p 注入，正文与提交按序执行 | 不能认定现场正在使用此版本；不能凭显示碎片认定正文损坏 |
| 6 | 同文件：captureTmuxPaneText、captureTmuxPaneHistory | 使用 capture-pane -p -J，另清理部分 OSC/CSI 转义 | 不保证所有快照来源和转义类型已覆盖 |
| 7 | 同文件：captureTmuxPaneHistory；collaborationCli.ts：capture 参数解析 | 底层支持历史行数，默认 800；CLI capture 目前仅公开当前屏幕 | 不保证完整 TUI 历史，也没有精确时间索引 |
| 8 | src/server/agent/collaborationStore.ts：sessionFacts | last_heartbeat、last_tool_activity_at 固定 null；有 last_message_at；task_state 基于显式任务消息计算 | 现场 task_state:unknown 与当前源码差异未解释，不能当作已确认根因 |
| 9、10 | src/server/agent/collaborationStore.ts：CollaborationGroup、roles；collaborationPrompt.ts | 群内已有成员角色描述及信封渲染能力；已读到的群结构没有群规正文专用字段 | 不能认定已有完整共享记忆或结构化 traits 功能 |

## 验证边界

本次仅创建文档，没有执行故障复现、运行回归测试或部署。后续验收建议是拟议标准，尚未完成。跨节点问题需覆盖直连与经页面入口中转两类路径，并记录双方版本及中转客户端状态。

## 第 1 项实测补充（2026-09-15）

- 本机 inbox 中两条初版反馈 `1zgx0gzoup`、`4eg6n1fnvt` 正文 SHA-256 前 12 位均为 `6628255b3a81`，消息 ID 与幂等键不同，分别约 63.7 秒、152.0 秒后 delivered。证明是两条独立消息记录，尚不能判断发送方为何重新创建请求；未发现同一 ID 重复注入的证据。
- 补充 `at640so0t6` 和完整版 `k98mdv47ri` 分别约 390.9 秒、150.3 秒后 delivered。四条记录在接收端均有 snapshot。延迟按该记录 deliveredAt 减 createdAt 计算，跨节点时钟误差未单独校准。
- `desktop/collaborationFederation.ts` 的 FRAGMENT_BYTES 为 32768，非分片发送成功也可以 fragments_sent=0、fragments_total=0。不能据此推断消息未发出。
- `src/server/agent/collaborationStore.ts` 的 mergeFederatedMessages 更新已有记录时只合并状态、时间、失败原因及语义字段，不合并 snapshot；desktop 桥也主要按状态升阶同步消息。接收端有快照不保证源端能获得。
- `src/lib/collaboration/browserFederation.ts` 的 synchronize 在 document.hidden、离线或无 savedConnection 时直接返回，服务少于两个时也不刷新。循环约 2 秒，并监听恢复可见事件。现场是否属于此条件尚未确认。
- `src/server/routes/terminal.ts` 实际投递 snapshot 使用 captureTmuxPane，而非已清理的 captureTmuxPaneText。本机完整版 snapshot 实际含 ANSI；已确认第 6 项存在真实样本。
- 经用户授权仅发送一条测试 `bnsb3xnx47`，标识 TD-DIAG-20260915-A，479 字节，固定幂等键 td-diag-20260915-a；目标为协调者 24alez66。15 秒等待送达超时，后续复查仍 pending、attempt_count=0、诊断为空，无 ACK。尚不能确认协调者已收到；未重复发送，原消息仍可继续投递。
- 已运行 collaborationFederation.integration.test.ts 与 desktop/collaborationFederation.test.ts：2 个文件、15 项测试通过。它们覆盖模拟服务与真实本地 store，不代替现场浏览器或桌面客户端链路验收。

### 测试最终回执与协调者回复

协调者 ACK 消息 gtv1wy7yff 确认 bnsb3xnx47 只出现一次。再次查询源端：status=read，queued_at=1789484545356，delivered_at=1789484753570，read_at=1789484777417，ack_at=1789484777343，snapshot=null，fragments_sent=0，fragments_total=0。约 208 秒延迟按记录计算，不证明网页隐藏为现场根因。

本机查询 4eg6n1fnvt：receipt-only delivered_at、get 顶层 delivered_at、get 内嵌 message.deliveredAt 均为 1789483376974。协调者所报差异尚未复现，需远端原始数据与字段路径。短 ID inbox 过滤为新反馈，尚未核查实现。at640so0t6 在本机会话及 inbox 均已出现。

用户讨论方向：CLI 投递应不依赖客户端转发；服务承接后台重试为维护者建议，尚未实施。
