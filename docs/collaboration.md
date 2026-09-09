# 协作消息协议 v2

Termdock 跟踪消息传输；Agent 或其他接入方显式报告接手、进展和结果。无需专用 Agent hooks，也不从终端输出、`done`、工具活动推断任务完成。协作协议只交换消息、回执和成员信息，不提供远程文件读取、命令执行或凭据共享。

## CLI 快速使用

在 Termdock 管理的会话中运行 `td collab --help` 查看全部选项，`td collab capabilities` 查看服务实际支持的协议和限制。

```sh
td collab send <session-id> '请检查证据包' \
  --idempotency-key review-2026-09-08 \
  --wait-until delivered --timeout 30s

td collab message get <message-id> --receipt-only
td collab message watch <message-id> --wait-until read --timeout 2m

td collab reply <message-id> '收到，开始检查' --response-kind ack
td collab reply <message-id> '检查完成' \
  --task-envelope '{"task_id":"review-1","status":"complete","progress":100,"evidence":["检查报告编号 R1"]}'
```

`send`、`reply`、`handoff` 默认输出 JSON。`--text` 用于人工阅读，`--jsonl` 用于逐行处理；标准输出不混入 ANSI 装饰或日志。文本输出也显示消息 ID、线程和状态。`--file <path>`、`--stdin` 支持较大的正文；`--` 后的参数全部作为正文，避免正文里的 `--json` 等文本被解释为选项。

多个共享工作组之间发送时必须指定 `--group`。`send --thread` 可延续线程，`reply` 自动使用原线程。查询单条消息只允许发送方、接收方；标记读取和回复只允许接收方。

## 回执和退出码

返回字段包括 `message_id`、`thread_id`、`status`、`queued_at`、`delivered_at`、`read_at`、`failure_reason`、`ack_at`、`reply_ids`、`result_ids`、`idempotency_key` 和转发诊断。时间均为 Unix 毫秒，未观测到的时间是 `null`。消息正文对象延续旧接口的 camelCase 字段；回执与 CLI 选项使用 snake_case。

| 状态/事件 | 含义 |
| --- | --- |
| `pending` | 本地已持久化排队，尚未确认写入接收端终端或被主动读取。对应 `--wait-until queued`。 |
| `delivered` | Termdock 已写入接收端 PTY。大消息写入的是通知与读取命令。不能据此判断 Agent 接手。主动读取确认会跨过这一阶段，回执标注 `delivery_semantics=consumer_read`，不会冒充 PTY 写入。 |
| `read` | 接收方显式调用 `message read` 或成功回复。旧版服务产生的已读回执标注 `read_semantics=legacy_or_unspecified`。 |
| `failed` | 明确不能继续投递，例如接收服务版本不支持该消息；查看 `failure_reason`。 |
| `expired` | 指定的 `--expires-at` 已到且消息仍未提交；不再投递。没有指定期限时不会自动过期。 |
| `ack` | 接收方显式报告已收到/接手。不会自动产生任务结果。 |
| `progress` | 接收方报告进展或阻塞。 |
| `result` | 接收方提交结果；成功与否需检查 `task.status`、正文与证据。 |

退出码：`0` 达到请求的等待条件；`1` 参数、网络或 API 错误；`2` 等待超时；`3` 投递失败或过期。单纯 `message get` 是查询，即便查到失败消息也正常返回 `0`，等待操作才使用 `3`。

`--expect-reply ack|result|any` 在投递等待条件之外，再等待接收方直接回复当前消息的对应类型。`message watch` 按变化输出回执，默认等到已读；`--timeout` 接受 `30s`、`2m`、`500ms` 或毫秒整数。

超时只停止本次等待，不撤销消息，不代表远端任务失败。已取得回执时仍返回原 ID 和最后已知状态。网络中断导致发送结果不确定时，使用返回的幂等键和同一正文重试；不要自行换 key 重新触发任务。

## 本地路由恢复与后台投递

本地协作使用独立的持久化路由登记（`~/.termdock/collaboration-routing.json`）；global session state 是界面绑定的投影，搜索索引只负责搜索。创建、接管会话时登记后端绑定，后台发现投影为空或陈旧时从路由登记和存活会话重建。历史绑定本身不证明在线。

服务启动后自动检查协作成员和持久化待投递队列，不需要浏览器打开、调用 status 或产生新的 Agent hook。每个 peer 的恢复、投递和显式重绑串行执行，多个 peer 可独立推进。消息按接收方队列顺序提交；路由或写入失败保留消息，按 2 秒至 30 秒退避重试。回执中的 `last_error`、`next_retry_at` 解释阻塞原因；`attempt_count` 只统计真正进入终端写入的尝试，路由尚未就绪时为 0 是正常的。

tmux 存活而 TD 后端缺失时，只挂接现存会话，不新建 tmux 会话、不启动或恢复 Agent。目标首次定位后固定到 tmux server/session/pane 和 pane 进程身份，投递不跟随活动 pane，也不改变焦点。多个候选无法唯一定位、tmux 重建或 Agent 身份不符时保留队列；在目标会话内显式运行：

```sh
td collab rebind            # 当前会话只有一个可识别 Agent 时
td collab rebind --pane %3  # 明确指定当前 tmux 会话内的 Agent pane
```

重绑只作用于调用方 peer，成功后继续投递积压消息。它不会把 `delivered` 改回待投递，也不会启动新的 Agent。

`td collab status` 中的 `route_state` / `route_error` / `route_checked_at` 描述路由观测：`recovering`（等待或正在检查）、`detached`（tmux 后端尚未挂接成功）、`ready`（可投递）、`agent-exited`（未检测到目标 Agent）、`offline`（会话或后端已不存在）、`ambiguous`（多个候选）、`identity-mismatch`（目标身份变化）、`unavailable`（检查或恢复出错）。路由 ready 不表示 Agent 空闲；不能将其他活动 pane 的 turn 状态归给当前 peer。

**投递保证的边界：**提交结果仍是“已写入终端”，不等于应用 ACK。成功回执已保存的消息不会被后台重放；同一进程内，即使写入后的回执保存失败，也避免再次写入。但终端输入和本地文件不能组成原子事务：进程恰在写入之后、保存回执之前崩溃时，重启可能重复提交同一消息 ID。因此这是允许重复的重试传输，接收方应按消息 ID 去重；需要应用确认时使用 `read`、显式 ACK 和消费游标。TTL 在提交前检查；已开始但结果尚不确定的提交不会被中途标为 expired。

## 增量收件箱与消费游标

```sh
td collab inbox --consumer coordinator --limit 20 --json
# 处理成功后，使用这一页返回的 next_cursor：
td collab cursor commit <next_cursor> --consumer coordinator

# 显式确认某条消息已读取，和消费游标独立：
td collab message read <message-id>

td collab inbox --unread --from <session-id> --group <group-id> \
  --thread <thread-id> --response-kind result --limit 20 --jsonl

td collab inbox --consumer coordinator --follow --timeout 2m --jsonl
```

支持 `--since`（ISO 时间或 Unix 毫秒）、`--after-id`、`--cursor`、`--limit`、`--from`、`--group`、`--thread`、`--kind`、`--response-kind`。默认未读优先、最新优先，最多 50 条。游标/consumer 模式按本服务接收顺序取最早未消费的一页，因此远端时钟回拨或晚到消息不会使消费游标漏读。

`next_cursor` 与会话、过滤条件绑定；`--consumer` 命名独立的持久化消费位置。读取和 follow 都不会自动推进持久化消费位置，也不会标记消息已读。JSONL 输出 `type=message` 行和包含 `next_cursor`、`has_more` 的 `type=cursor` 行。follow 在当前调用内使用临时游标，不重复输出同一页；处理成功后仍需显式提交。

`--after-id` 不存在或已清理时返回 `CURSOR_GONE`，不能悄悄从错误位置继续。历史被清理且游标尚未追上时返回 `retention_gap=true`；调用方必须认识到结果不是完整历史。待投递消息不会因历史条数上限被裁掉。历史终态最多保留 2,000 条，幂等窗口内受保护的消息额外保留；删除会话/工作组仍沿用产品原有的删除历史行为。

人的协作记录页提供“收到确认 / 进展 / 结果与证据”筛选和“只看新记录”。“标记当前记录已看”只记录当前浏览器已看的可见消息，不代替 Agent 已读或 ACK，也不会把筛选隐藏的其他类型标记已看。

## 幂等、消息大小和跨服务转发

幂等作用域是工作组、发送会话和 key。相同 key、相同语义参数返回原消息 ID；改变正文、接收方、线程或 metadata 等参数返回 `IDEMPOTENCY_CONFLICT`。对象属性顺序不影响比较。记录持久化保留 7 天，重启不会失效；未指定 key 时 CLI 自动生成并返回一个。幂等保证消息提交去重，不能保证外部副作用恰好执行一次，执行方仍应依据 `task_id` 保存自己的执行结果。

正文上限为 **1 MiB UTF-8**，metadata 与 task envelope 等附加字段合计 **16 KiB JSON**，完整编码消息上限 **1.5 MiB JSON**。大量控制字符可能先触及编码限制。超限明确报错，不截断正文，保留原始换行和空白。

跨服务桥接按 32 KiB 分片，接收端持久化未完成分片；校验完整 SHA-256 后才产生一条可消费消息。重复、乱序分片和转发客户端/接收服务重启均可重试；不完整分片保留 24 小时，最多 32 个未完成消息，每条最多 64 个分片。发送端队列仍保留原消息，超过分片缓存期限后可以重新组装。

`relay_online`、`peer_reachable` 是最近一次转发观测，超过 15 秒变成 `null`（未知），不从 Agent turn 状态猜测。另有 `attempt_count`、`next_retry_at`、`last_error`、`transport_checked_at`、`fragments_sent`、`fragments_total`。断线保持 pending，失败退避重试最多间隔 30 秒；接收服务本身不可达时跟随每 2 秒的连接轮询。瞬时链路错误与明确不可投递分开表示。

跨服务转发可由 Mac 客户端或浏览器/PWA 运行，二者复用相同的同步、去重与分片协议。浏览器按已保存的服务身份分别建立加密连接，共用同源顶层页面的转发器；无需打开每个服务的工作区。所有写入都由页面的加密客户端完成，不回退到普通 HTTP。手机后台或网页关闭时转发会暂停，消息保存在服务端，恢复前台后继续同步。新分片和扩展消息需要桥接客户端及两端服务均支持 v2；普通短消息可以继续与旧服务通信。不支持扩展消息的旧服务会得到明确的 `PEER_UPGRADE_REQUIRED`，不能声称已投递。服务端单独升级不能替换正在运行的旧桌面桥。

## 会话状态与结构化任务

状态输出拆为 `session_state`（会话连接事实）、`turn_state`（可选适配器报告）、`task_state` 和 `tasks`（显式消息上报）。`done` 映射为 `turn_state=ended`；`idle` 表示适配器报告空闲；`working` 只表示适配器报告当前活跃；`offline` 表示本服务没有附着会话或远端连接不可达，不意味着远端后台任务已经结束。

一个会话可能同时处理多个任务，因此不从某条消息推断整个会话任务已完成；会话级 `task_state` 保持 `unknown`，每个任务的显式状态在 `tasks` 中携带报告时间与消息 ID。`last_heartbeat`、`last_tool_activity_at` 无通用可靠来源时返回 `null`，不拿终端输出时间冒充；`last_message_at` 来自消息记录。

`--task-envelope` 接受 `task_id`、`status=ack|working|blocked|complete|failed`、可选 `progress`（0–100）、`evidence` 和 `blocker`；自动映射 response_kind。显式指定的 response_kind 与任务状态冲突时拒绝。`--metadata` 接受任意 JSON 对象，正文仍然自由。字段中的路径和链接只是证据引用，不会触发 Termdock 读取另一台机器的文件或凭据。

## 会话目录与桌面兼容边界

当前服务是自身会话和协作组记录的权威来源。浏览器与 macOS 页面都通过页面的加密 `fetch` 读取 `/operations/collaboration-groups`；桌面端只补充其他已连接服务的会话，不用桌面缓存覆盖本服务的组、成员或删除结果。侧栏和工作台共用 `CollaborationDirectory` 的读取与订阅，切换服务或清除认证状态时丢弃旧目录，过期请求不能覆盖写入后的新状态。

本服务读取有 10 秒期限，独立于其他服务的发现。其他服务的发现有 5 秒期限，后台完成后发布增量目录，失败时保留本服务数据，并把缓存的远端成员标为不可达。已持久化的远端成员即使客户端未连接也保留其身份，不把旧在线快照当成当前在线证据。加载中、真正为空、本服务失败、跨服务部分不可达分别表达。

桌面 preload 显式声明 `collaboration: { protocolVersion: 2, peers: true, save: true }`。v2 `collaborationPeers()` 返回 `{ protocolVersion: 2, origin, sessions, services }`，必须与当前目标服务或接收 IPC 的实际窗口地址匹配（兼容 localhost、入口地址等别名）；它只发现会话，不执行消息转发。定时 relay 独立负责副本和消息同步。缺少能力声明的旧客户端通过适配层读取旧 `collaborationList()`，仅接受其中的远端会话；未知的新协议不会被猜测为兼容。旧桥接失败、超时或返回空不会阻止本服务组队。

| 操作 | 权威写入路径 |
| --- | --- |
| 创建本服务组、修改已有成员、删除已有组（含联邦副本） | 页面向当前服务写入；不优先走原生桥接。 |
| 添加新的跨服务成员 | 客户端确认各服务的新会话目录，将结果首先持久化在发起服务；后台再同步副本。 |
| 普通组转换为跨服务组 | v2 客户端调用当前服务的 `/:groupId/promote`，在一次文件替换内迁移组、消息和幂等记录；不分步复制和删除。 |
| 从一个组移动成员到另一个组 | 当前服务的 `/move-member` 原子更新两个组；失败时两边都保持原状态。 |

服务目录声明 `capabilities.groupRevision / groupPromotion / groupMove`。已有成员编辑携带开始编辑时的 `expectedUpdatedAt`；遇到并发修改返回 `409 GROUP_CHANGED`，遇到已删除组返回 `404 GROUP_NOT_FOUND`，不能隐式重建。新成员中任一项失效，整个保存返回 `409 MEMBERS_CHANGED`，不能过滤后部分保存。暂不可用的原成员由用户明确取消勾选才移出。跨组移动携带两组各自的版本。旧服务不支持原子转换或跨组移动时，拒绝该操作并保留原记录；单服务基本操作仍可使用。

成员创建、修改和删除失败后不会自动换传输重试，因为第一次写入可能已经成功。原生写入必须由拥有该 IPC 的服务窗口发起，允许 localhost 等窗口地址与目标显示地址不同；业务请求始终由该窗口的加密客户端发往固定服务身份。网页转发为每个已授权目标使用独立加密客户端，不更改当前页面目标。桌面发行包仍需在真实 macOS 客户端验证；浏览器夹具、协议测试和本机服务部署不能替代该验收。

回归覆盖位于 `src/lib/collaboration/directory.test.ts`、`src/lib/terminal/api.collaboration.test.ts`、`src/server/agent/collaborationGroupRoutes.test.ts`、`desktop/collaborationFederation.test.ts` 和 `src/server/agent/collaborationFederation.integration.test.ts`；加密入口同时由 `browserIntegration.routing.test.ts` 与 `transportBoundary.test.ts` 守卫。

本轮兼容修复和浏览器转发按用户要求未运行自动测试。Web、服务端和桌面构建分别检查，Mac 1.4.182 与真实 iOS PWA 的连接、跨服务建组、消息送达及后台恢复仍需实机验收。

### 1.4.186 设备识别信息

“服务与设备 → 设备”提供可展开的信息：设备标识、系统与客户端版本、打开方式、可读取的型号/主机名称/处理器/架构，以及最近连接路径和服务记录的首次、最近连接时间。中转入口从实际选中的加密连接读取；这些信息仅供展示，不参与授权。原生桥接仅读取本机信息，由页面通过现有加密设备名称请求上报，旧服务可忽略新增字段。旧设备重新连接后补齐详情，不覆盖用户重命名。

浏览器可能限制硬件型号、架构及系统版本（包括 User-Agent 简化）；缺失信息不推测。首次记录指首次上报详情，不代表首次授权。多窗口同一身份展示最近一次上报的连接路径。按用户要求未运行自动化/功能测试；已进行生产构建与桌面构建。macOS/iOS 的真实设备交互、首次加载、旧 preload、断线及仅中转场景仍待用户实机验收。
