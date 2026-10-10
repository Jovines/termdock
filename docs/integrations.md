# TD 通用外部接入（协议 1）

最低 CLI / 运行服务版本：**termdock 1.4.300**，两者都必须升级并重启服务。
启动输入条件与保留凭据的策略更新要求 **CLI / 实际运行服务均至少 1.4.301**；协议仍为 1。
插件原生 ID 的前台 argv 回读及服务重启后的运行中 restore 核验修复要求
**实际运行服务至少 1.4.302**。退出后的重复原生会话检查修复要求
**实际运行服务至少 1.4.303**。没有 PTY 附着的已登记 tmux 的重复保护修复要求
**实际运行服务至少 1.4.304**。管理员恢复诊断要求 **CLI / 实际服务均至少 1.4.305**；
直接 exec 为 pane PID 的原生 argv 核验及可选 Linux 持锁身份要求 **实际服务至少 1.4.306**；
后台执行记录与用途迁移要求 **CLI / 实际服务均至少 1.4.307**；
普通消息身份发送、持久回复及消息历史要求 **CLI / 实际服务均至少 1.4.308**；
释放运行承载、稳定逻辑身份与恢复配置确认要求 **CLI / 实际服务均至少 1.4.309**；
建议 CLI 与服务同步安装 1.4.309（既有接入命令的 CLI 最低仍为 1.4.301，诊断 CLI 最低为 1.4.305）。
现有 `--session`、消息投递、任务报告与自动协作入口继续兼容；旧的
`task create --integration` 仍表示代码集成子任务，新身份使用 `--principal`。

TD 提供受限身份、持久事件推送、关联咨询回复，以及会话创建/精确恢复。
机器人、定时器、外部用户授权、业务幂等键、外部 inbox/outbox、业务校验由接入方实现。
`complete` 是执行成员的明确交付，`accepted` 是用户明确验收；投递成功、终端快照、
事件 ACK 都不表示已读、任务完成或业务校验通过。

## 普通消息接入（1.4.308，推荐用于机器人与报表）

触发 Agent、追问和回帖可使用普通消息：**无需创建 task，不产生任务看板或逐期用户验收**。
消息负责可靠投递与关联回复；业务周期、结果版本、机器校验、外部发布状态由接入方记录。
只有需要 TD 任务分派、交付物、评审或人工验收时才使用后文 task；1.4.307 的 automation
purpose 是可选任务能力，不是机器人接入的前置要求。已有 task/attempt/session 和外部根帖
保持原记录，不自动迁移、重建、重投或重跑。

管理员为现有身份补权限后用 `td integration update --file /private/policy.json`：

```json
"permissions": ["message.send", "message.read", "events.read", "session.create", "session.read", "session.restore"]
```

更新保留同一身份、组和凭据；保留实际需要的既有 task 权限以及原 launchProfiles。
`message.send` 授权 send/reply，`message.read` 授权组内 message get/list；它们不授予任务操作
或用户验收。events.read 可订阅授权组内事件。只允许该身份授权的一个本机组，拒绝跨服务目标、
组外成员、未授权操作与 task envelope。组中其他 principal 的消息可以按组授权读取，但不能
借其原消息 reply 或冒充其身份；只能向本组成员 send 新消息。

先回读实际运行服务，再检查三个能力均为 true：

```sh
export TERMDOCK_INTEGRATION_CREDENTIAL_FILE=/private/bridge-credential.json
td collab --principal report-bridge capabilities
# cli_version / server_version >= 1.4.308, integration_protocol = 1
# integration_message_send / integration_message_reply / integration_message_history = true

td collab --principal report-bridge send <TD成员ID> --file /private/prompt.txt --idempotency-key run:2026-10-10
# 保存输出 message_id、thread_id；status=pending 表示已持久入队
# 可附 --source feishu --external-actor '{"id":"external-user"}' --external-message-id <external-id>

td collab --principal report-bridge events subscribe --consumer bridge-inbox --jsonl
# 按 event_id 去重；先将事件落盘，再 ACK 已连续持久接收的位置
td collab --principal report-bridge events ack <cursor> --consumer bridge-inbox
```

CLI 在发送前检查运行服务 capability；旧服务返回 `INTEGRATION_MESSAGING_UNSUPPORTED`，
不会降级成用户或终端成员发送。凭据只通过私有文件注入；`--principal <id> --help` 不需要
凭据或运行服务。建议 CLI 与实际服务保持同一版本，版本号本身不能替代能力检测。

接收 Agent 在**原终端**使用明确回复（投递提示每次都附原消息 ID 与此用法）：

```sh
td collab --session <自己的TD成员ID> reply <原消息ID> "收到" --response-kind ack --idempotency-key run:ack
td collab --session <自己的TD成员ID> reply <原消息ID> --file /private/result.txt --response-kind result --idempotency-key run:result
# 进展也可 --response-kind progress；不推断 Agent 内部进度或整个会话忙闲
```

回复保存到同一消息历史，`status=stored`、`stored_at`、`delivery.stage=stored`、
`delivery_semantics=durable_storage`、`delivered_at=null`、`attempt_count=0`；
不进终端投递队列，不伪造“写入终端”。原 message get/list 记录的 toSessionId 使用内部保留
地址 principal:<id> 以兼容历史结构，实际接收方由 toPrincipalId 标识；不要把这个地址当作成员 ID。Agent CLI 立即返回这个保存事实，不等待不存在的接收终端。
原发送的 receipt.result_ids/reply_ids/ack_at 来自明确的关联回复，原消息投递状态独立保留。
原生会话、结果正文及外部校验仍由实际 Agent/业务方负责；result 不表示用户验收或外部发布成功。

`message.reply` 的 payload 包含 `message_id`、`thread_id`、`reply_to`（原消息 ID）、
`from_session_id`、`to_session_id`（后台回复为 null）、`to_principal_id`、
`integration_origin`、`response_kind`、`stored_at`、`content`、`metadata`。
普通消息没有 task_id/attempt_id；不要套用 task 的 to-event/respond。外部话题和结果版本
用 message_id/thread_id 与 reply_to 关联。外部追问可以回复自己的原发送或收到的 Agent 回复：

```sh
td collab --principal report-bridge reply <原发送ID或Agent回复ID> "解释一下" --idempotency-key followup:external-id
td collab --principal report-bridge message get <消息ID> --text
td collab --principal report-bridge message list --thread <话题ID> --limit 50
td collab --principal report-bridge message list --thread <话题ID> --after-id <上一页next_after_id> --limit 50
```

追问固定回原成员及原 thread，原成员不在授权组时返回 NO_REPLY_TARGET，不悄悄新建会话。
需要恢复时显式 session restore，仍保留原 native UUID、argv/cwd/包装器与 startupInput 条件。
命令变更必须给稳定 idempotency-key；同身份/组/key 且相同正文与参数返回同一消息 ID，
不同 payload 返回 IDEMPOTENCY_CONFLICT。原 Agent 回复另按 principal/成员/key 隔离。

消息/回复在成功返回前完成文件 fsync、原子替换和目录 fsync，事件从这些源记录持久生成。
订阅自动断线重连，从同 consumer 已 ACK 的连续位置重放；收到事件不自动 ACK，也不表示业务
已经处理。业务 inbox/outbox 按自身持久处理状态重试。事件保留缺口返回 EVENT_RETENTION_GAP
并停止；需结合仍保留的消息与业务数据库对账后建立新 consumer，不能声称任意历史均可重放。
message list 按本组 sequence 升序分页，返回 next_after_id/has_more，页还受 2 MiB 字节预算限制；
只覆盖仍保留的消息（常规历史最多保留 2000 条，pending 和未过期幂等记录另外保护，幂等保留 7 天）。
after-id 不在本组保留记录中返回 MESSAGE_NOT_FOUND；前缀不唯一返回 MESSAGE_ID_AMBIGUOUS。
鉴权撤销与权限更新沿用下文错误和重连契约。普通消息 delivered 仍只表示写入终端，不能从快照
缺少正文推断未消费，更不能因此自动重投已 delivered 消息。

## 管理员配置身份

接口只监听本机 Unix socket `~/.termdock/integration-<port>.sock`（0600），
不暴露 HTTP 业务接口，不使用网页转发。首版身份绑定**一个本机协作组**，
不支持跨服务组。先在 TD 建立本机组，再查询其 ID：

```sh
td integration groups
td integration list
```

管理员保存策略文件；实际可执行文件、插件 slug 和目录由本机管理员填写：

```json
{
  "id": "report-bridge",
  "groupId": "实际本机协作组ID",
  "permissions": [
    "task.read", "task.create", "task.assign", "task.comment", "task.revise",
    "task.answer", "events.read", "session.create", "session.read", "session.restore"
  ],
  "launchProfiles": [{
    "id": "report-agent",
    "agentSlug": "实际已安装的插件slug",
    "executable": "/absolute/path/to/private-launch-wrapper",
    "argv": ["-m", "model-name", "-C", "{cwd}"],
    "cwdRoots": ["/absolute/path/to/runs"],
    "resumeArgv": ["resume", "{sessionId}", "{launchArgs}"]
  }]
}
```

`launchProfiles` 可为空（只操作已有消息或任务）。创建会话时只能选择预配 profile 和
目录，不能传任意命令/参数。`cwd` 必须已存在，真实路径须位于 `cwdRoots` 内；
符号链接不能逃出目录边界。参数按独立 token 引号转义，控制字符禁止。
`{cwd}`、`{sessionId}`、`{launchArgs}` 必须是独立参数；恢复模板必须各包含一次
`{sessionId}` 与 `{launchArgs}`，禁止 `--last`。示例模板需按真实 Agent 的
命令语法调整；启动与恢复仍需安装并启用对应 Agent 插件，插件必须支持精确 ID 恢复。

包装器须原样透传参数，安静加载 Agent 登录环境，不打印密钥。TD 保存原始
profile（可执行文件/包装器路径、argv、模型参数、cwd、恢复模板）；恢复使用该
快照，并切回原 cwd 后启动。只有精确绑定且经进程前台组核验的空闲 shell 才能启动；
前台包装器或其他进程尚在运行时拒绝重复启动。包装器文件本身由管理员维护，TD 不备份其代码或密钥。

```sh
td integration create --file /private/policy.json --credential-file /private/bridge-credential.json
export TERMDOCK_INTEGRATION_CREDENTIAL_FILE=/private/bridge-credential.json
td collab --principal report-bridge capabilities
```

输出文件必须不存在；TD 创建 0600 文件，只打印身份及文件路径，不打印 token。
运行方只能通过 `TERMDOCK_INTEGRATION_CREDENTIAL_FILE` 注入同用户、私有、非符号链接
的文件。不要把 token 放入 argv、消息、日志或 profile。策略与凭据不入库。
管理员 `td integration revoke report-bridge` 会拒绝后续请求并关闭已有订阅；
恢复授权需新建身份，不会静默替换原凭据。

CLI 使用当前运行服务的端口，默认 9834。每个端口的身份、游标、事件、会话记录
分别保存在 `~/.termdock/integration-state/<port>/`，通过原子写入及 fsync 持久化。
这是 TD 接口的权限边界，不是同一操作系统用户下的进程沙箱。

### 启动输入条件与策略更新（1.4.301）

部分 Agent 在首次 prompt 后才产生原生 UUID，启动期间也可能丢弃提前写入的输入。
管理员可在对应 `launchProfiles` 项中增加 `startupInput`，让 TD 在原绑定 pane 的
**当前可见终端画面**满足条件后才首次投递。下面是使用方 TraeX 0.209.1 / GPT-5.5
(MAX) xhigh 的画面匹配示例；换模型、语言或 TUI 版本时须按实际画面调整：

```json
"startupInput": {
  "allOf": ["GPT-5.5 (MAX) xhigh", "❯"],
  "noneOf": ["model: loading"],
  "stableMs": 1000,
  "timeoutMs": 120000
}
```

TraeX 的恢复画面可能仅在 footer 显示模型，没有 `model:` 标题；因此示例不要求
该前缀。管理员须同时核对冷启动和恢复画面，条件不匹配时保持待投递。
模型 footer 可能被 Git 错误或键盘提示替换，此时含模型文字的 `allOf` 条件不会
匹配。请选择实际画面中稳定且能区分加载阶段的文字；TD 不用原生 UUID ready、
历史模型文字或推测的忙闲状态代替配置条件，超时也不会自动放宽。

`allOf` 的每个字面文本都须出现，`noneOf` 的每个文本都须缺席；区分大小写，
连续横向空白折叠为一个空格，不使用正则或终端历史。每组最多 16 项，每项
1–256 字符，禁止控制字符；`allOf` 不能为空。`stableMs` 默认 1000，允许
500–5000；`timeoutMs` 默认 120000，允许 1000–120000，均为整数毫秒。
TD 至少两次观察到匹配画面，间隔达到 `stableMs` 后放行；中途观察到不匹配就
重新计时，服务重启也清除尚未完成的匹配计时。这是终端画面条件，不证明 Agent
内部已就绪、已消费或持续空闲，不依赖 Agent hook。原生 ID 为空也可满足此条件。

在现有**完整策略文件**中加入条件，再由本机管理员执行：

```sh
td integration update --file /private/policy.json
```

`update` 替换完整权限/profile 策略，保留身份 ID、本机组、凭据和历史；不能改组，
不能重新激活已撤销身份。更新文件不要遗漏原权限/profile；无需重写凭据文件。
新建会话使用新策略。没有旧启动条件的既有会话，仅在下一次明确 `restore`
**实际启动 Agent 时**附加同 profile ID 的新安全条件；原 argv/model/cwd/包装器
和原生 UUID 不变。已有条件的原启动快照仍保留；对已经精确运行的会话调用 restore
不会重新启动或重设条件。更新不会重投已 `delivered` 的正文。

未配置 `startupInput` 的旧 profile 保留原投递方式；TD 不猜测各家 TUI 的加载画面。
管理员 CLI 会先读取运行服务能力，旧服务缺接口或能力时失败，不会忽略条件后继续配置。

## 版本与能力核验

```sh
td --version
td collab --principal report-bridge capabilities
```

第二条回读实际服务 `server_version`、本机 `cli_version`、`integration_protocol`、
`local_only`、支持的权限名称与功能布尔值；`principal` 回读本身份的组、实际授予权限
及允许的 profile ID / Agent slug / cwd roots，不返回完整启动配置。要求协议 1；缺 socket、鉴权失败或协议不兼容
会直接失败，不回退到旧会话身份/公开 HTTP。协议兼容是运行判断依据，不能只比较
已安装 npm 版本。普通 `td collab --session <id> capabilities` 同样返回 CLI/服务版本。

使用启动条件时，还须确认 `startup_input_conditions=true`、
`integration_policy_update=true`，以及
`principal.launch_profiles` 中目标 profile 的 `startup_input_condition=true`。
这些布尔值由实际服务回读；服务能力支持不等于身份已配置条件。

## 后台自动化执行记录（1.4.307）

`td automation` 是已有定时投递入口：`list/create/show/run/pause/resume/delete`。
它的 run `success` 只表示投递，记录不包含结果版本或关联咨询，最多保留 100 条；
它不是本节的后台执行记录。外部定时器继续由接入方管理。

后台工作复用可靠的 task/attempt/artifact/event 存储，显式使用
`purpose=automation`。旧记录缺少 purpose 时按 `interactive` 处理，新建也默认 interactive。
这是使用方式与记录契约，不是安全隔离或简单 CSS 隐藏：

- automation 是本机协作组内的独立记录；不加入人工目标、父子任务、依赖验收、协调者或自动评审。
- 继续通过原 session 投递、精确恢复，用原 attempt report、comment/respond 和持久事件关联。
- `complete` 是执行成员的明确结果交付，无需逐期 accepted。它不等于业务机械校验通过或外部发布成功。
  业务按 artifact_id 保存机械校验和外部 outbox；本版 `external_validation=false`。
- 用户任务生命周期 `status=open|accepted|closed` 保持既有含义；后台是否执行交付，读下面的 `execution`，
  不等待 `status=accepted`。不自动生成 accepted；principal 仍不能验收。已有用户验收历史保留。
- 人工工作台列表 API 默认只列 interactive，看板与“需要你”同样排除 automation，
  包括 complete、blocked、failed、预期测试超时和真实提问。业务负责在飞书分诊/提问，
  可使用 task ask/answer 持久关联。异常、问题原文、投递状态和失败重试并未删除或改成成功。
- Agent CLI 与 principal 的 task list 默认保留全部授权组记录；可用 `--purpose automation|interactive|all` 筛选。
  task get 不受用途过滤，原始正文与历史仍可回读。用途不代替组权限。

先核验实际服务 capabilities：
`background_task_records=true`、`task_purpose_configuration=true`、`explicit_execution_state=true`。
普通 collab 能力位在 `task_workflow` 内，principal 的在响应顶层。CLI 与实际服务均至少 1.4.307，协议仍是 1。
CLI 对带 purpose 的操作和 configure 会先探测能力，缺失返回
`BACKGROUND_TASK_RECORDS_UNSUPPORTED`，不会向旧服务提交变更或降级创建普通任务。

新建后台执行记录（使用既有私有凭据文件注入）：

```sh
td collab --principal report-bridge task create --group <本机组ID> \
  --purpose automation --title '本期报告' --content '完整执行要求' \
  --assignee <原TD-session-id> --idempotency-key <本次创建键>
td collab --principal report-bridge task list --purpose automation
td collab --principal report-bridge task get <task-id>
```

automation 的完整与摘要响应均提供 `execution`：

```json
{
  "status": "complete",
  "attemptId": "原执行尝试ID",
  "reportEventId": "原report事件ID",
  "artifactId": "本版本结果ID",
  "reportedAt": 1791636000000
}
```

`execution.status` 为 `unassigned`、`awaiting_report` 或明确成员报告的
`ack/working/blocked/complete/failed`。它只根据当前 attempt 的有序原始 report/revise 事件生成：
尚未报告及最新 revise 之后等待新报告时，reportEventId/artifactId/reportedAt 为 null；
只有当前明确 complete 的 artifactId 非 null。comment/respond 不改变 execution、结果或 attempt；
revise 使旧一轮 execution 失效，再次 complete 产生新 artifact。历史 attempt 的报告不会覆盖当前执行事实。
投递成功、终端快照、事件 ACK、其他会话忙闲均不能推导 execution 状态。
`reportedAt` 是原 report 事件时间，execution 为回读投影，不写回或伪造原报告。

已有普通任务原地迁移，不重跑：管理员先在原策略的 permissions 中**追加** `task.configure`，
保留 id/groupId/其他权限/profile/启动条件，用 `td integration update --file <原策略.json>` 更新。
该操作保留凭据；仍需核对 principal.permissions，不能把服务支持的 permissions 当实际授权。
然后读取原记录的最新 revision：

```sh
td collab --principal report-bridge task get <原task-id>
td collab --principal report-bridge task configure <原task-id> \
  --purpose automation --revision <刚回读的revision> \
  --idempotency-key <此记录的用途迁移键>
```

configure 在同一持久事务中更新 purpose、revision 并记录 `task.configured`（payload.event.purpose）。
创建事件也保留创建时 purpose。新配置事件沿用既有持久推送/重连/ACK 契约。
用途迁移保留原 task/group/attempt/session 关联、投递、artifact、原始事件和已验收/关闭历史，
不建立新 attempt/session，不投递正文、不恢复终端、不自动 accepted。
旧创建请求的同一幂等键仍绑定原请求体；不要把它改为带新 purpose 的 create，否则会正确报幂等冲突。
迁移后保持原业务键与 TD ID，只有未来新记录才使用 purpose=automation 的新创建请求。
测试记录也可配置为 automation，测试与正式业务组的分离仍由接入方完成，不自动替别人迁移任务。

configure 需要本机管理员（既有受权任务 API）或授权组内持有 `task.configure` 的 principal；
终端成员不能配置。拒绝无 grant、跨组、过期 revision；同一幂等请求返回原事件且不重复追加。
`TASK_CHANGED` 时重新读取并核对，不盲覆写。用途非法返回 `INVALID_TASK_PURPOSE`；
非独立记录返回 `AUTOMATION_STANDALONE_REQUIRED`，跨服务组返回 `BACKGROUND_TASK_LOCAL_ONLY`。
已关闭的记录只迁移用途仍保持关闭，不由 configure 隐式恢复咨询或执行。

## 任务与权限

| 操作 | 外部身份 | 会话成员 / 用户规则 |
| --- | --- | --- |
| list/get | `task.read`，只读授权组 | 保留现有组权限 |
| create | `task.create`，独立任务或后台执行记录 | 指定负责人另需 `task.assign`，必须在组内 |
| configure | `task.configure` | 显式配置用途，必须带 revision 与幂等键；会话成员不能配置 |
| assign | `task.assign` | 必须带当前 revision；新建 attempt，不隐式恢复会话 |
| comment | `task.comment` | open/accepted 可咨询，保留原结果、验收和 attempt |
| revise | `task.revise` | 带 revision，重开并使旧结果失去验收资格，沿用当前 attempt |
| answer | `task.answer` | 指定尚未回答且属于当前 attempt 的 decision ID |
| respond | 禁止 | 原咨询 attempt 的负责人，必须带 attempt 和 comment event ID |
| report | 禁止 | 只有该 attempt 的负责人；自动协作只接受当前 attempt |
| accept / approve-plan | 禁止 | 保留明确用户操作 |
| drive、成员/组管理、托管目标、任意启动参数 | 禁止 | 保留原有入口，不向外部身份开放 |

所有写入都有幂等键，重试必须使用同键同参数；换参数返回 `IDEMPOTENCY_CONFLICT`。
现有会话 CLI 可自动生成键；外部身份的任务/会话写入必须显式提供稳定键才能跨进程重试。
幂等键按身份隔离。`assign/revise` 的过期 revision 返回 `TASK_CHANGED`；
`comment` 追加到提交时的当前 attempt，并返回真实原事件和投递关联，不覆盖结果。

```sh
td collab --principal report-bridge task create --group <group-id> --title '报告' \
  --content '完整要求' --assignee <TD-session-id> --idempotency-key <business-key> \
  --source external --external-actor '{"id":"external-user-id"}' --external-message-id <external-message-id>
td collab --principal report-bridge task comment <task-id> --content '请解释结果' --idempotency-key <comment-key>
td collab --principal report-bridge task get <task-id>
td collab --principal report-bridge task revise <task-id> --revision <revision> --content '变更要求' --idempotency-key <revision-key>
td collab --principal report-bridge task answer <task-id> --decision <decision-id> --content '答复条件' --idempotency-key <answer-key>
```

来源同时记录 `source=integration`、`origin.integrationId` 和外部 actor / 消息 ID / metadata，
不会伪装为终端成员或用户验收。CLI `--metadata` 接收 JSON 对象，来源总大小限 16 KiB。
咨询消息关联 `replyToEventId`，执行成员收到命令提示：

```sh
td collab --session <original-assignee-id> task respond <task-id> \
  --attempt <original-attempt-id> --to-event <comment-event-id> --content '解释' --idempotency-key <response-key>
```

`respond` 只新增回复事件，不改 report、artifact 或 accepted。对咨询投递消息使用
普通 `td collab reply <message-id> ...`（不带任务 status）同样存为关联 `respond`；
明确带 status 才是任务报告。修改要求后，负责人需明确提交新的 `complete`，产生新
`artifact_id` 并重新验收。历史版本始终保留，外部业务校验按 artifact ID 存储。

负责人离线时，咨询仍进入原会话的持久消息队列，返回原 `attempt_id` / `delivery_id`；
用 task get 的 outbox、deliveries 或 message get 查询实际投递状态与失败原因。
不悄悄创建新 attempt/会话；会话恢复只能显式调用下节接口。已删除/脱组的负责人会
留下明确失败记录，接入方需交给用户处理，不能根据终端无输出猜测任务状态。

## 主动事件与 ACK

```sh
td collab --principal report-bridge events subscribe --consumer bridge-main --jsonl
td collab --principal report-bridge events ack <cursor> --consumer bridge-main
```

这是持续连接的主动推送，不是轮询收件箱。业务方读取 JSONL 调用自己的处理器。
TD 不提供任意 URL 的 HTTP webhook；首版使用本机 socket，进程重连时自动退避。
无 `--timeout` 时订阅持续运行；可显式加 `--timeout 60s` 结束本次订阅。

事件外层固定字段：`type=event,event_id,group_id,sequence,cursor,kind,created_at,payload`。
按情况包含 `task_id,attempt_id,artifact_id,message_id,reply_to_event_id,source,actor,external_actor`。
`sequence` 是组内持久顺序；`created_at` 是原事实时间，不用于顺序/去重。
task 事件 `event_id` 与任务内事件 ID 一致，`respond.reply_to_event_id` 指向原 comment。

| kind | payload |
| --- | --- |
| `task.created/assigned/scheduled/coordinator` | `{event}`：原事件、actor、content、attemptId、sequence、createdAt、origin 等 |
| `task.configured` | `{event}`：`purpose=interactive|automation`，原配置操作者、时间及 source/origin；没有终端投递 |
| `task.report` | `{event}`：另含明确 reportStatus（ack/working/blocked/complete/failed）、evidence；新 complete 含 artifactId |
| `task.comment/respond/revise` | `{event}`：咨询含 target/deliveryId，答复含 replyToEventId |
| `task.question/answer` | `{event}`；decision 的完整状态从 task get 回读 |
| `task.submit-plan/review/request-review/approve-plan/accepted` | `{event}`：相关 artifactId、target 或 evidence（依实际事件） |
| `task.close/reopen/coordinate/pause/resume/retry/child-update/automation-blocked/review-passed/review-blocked` | `{event}`：保留服务事件的 source 与原文 |
| `task.result` | `{artifact}`：结果 id、attemptId、actor、content、summary、evidence、createdAt |
| `task.delivery` | `{delivery}`：任务投递 id、attemptId、messageId、status、deliveredAt、error |
| `message.queued/message.reply` | `{message_id,thread_id,reply_to,from_session_id,to_session_id,to_principal_id,integration_origin,response_kind,stored_at,content,metadata}` |
| `message.delivery` | `{receipt}`：实际入队/远端接收/终端写入/后台回复保存阶段、失败、重试计数与时间，及明确回复 ID；不含快照或已读字段 |
| `session.starting/binding_pending/ready/restoring/releasing/released/failed` | `{session}`：下节公开会话记录，失败包含 error_code |

TD 在源记录提交后触发 journal 及订阅，journal 中的同一事件 ID 在重连重放时保持不变。
新 consumer 从最早保留事件开始；接入方按 `event_id` 去重，**先持久写入 inbox，
再 ACK 连续已持久接收前缀的 cursor**，之后自行按任务顺序处理和重试业务 outbox。
只读取/打印事件不会 ACK；ACK 也不意味着处理完成、机器人已发送或用户验收。
TD 检查 cursor 属于授权组、没有回退、已经发送，但无法替业务方证明其数据库已经落盘。
服务重启后先重新订阅再 ACK，发送窗口会重建。每个 consumer 保持一个逻辑接收者。

每组保留最近 10,000 个事件，journal 总大小上限 64 MiB。已存在 consumer 的确认
位置早于保留窗口会报错，不能静默跳过；接入方回读任务/会话快照，完成业务补偿后
启用新 consumer。保留期不是永久归档。源记录与 journal 分文件提交，重启会从仍保留
的源事实补齐事件；源历史也被管理性删除的事实无法重建。

错误格式（HTTP 请求直接返回 JSON；流内错误也以一行 JSON 返回）：

```json
{"type":"error","ok":false,"code":"EVENT_RETENTION_GAP","error":"...","retryable":false}
```

`heartbeat` 每 15 秒保持连接；`connection/state=reconnecting` 是 CLI 重连提示。
连接断开重连后从服务持久 ACK 位置重放，未 ACK 的事件可以重复。终止错误包括
`INTEGRATION_UNAUTHORIZED/REVOKED/PERMISSION_DENIED`、`EVENT_RETENTION_GAP`、
`INVALID_EVENT_CURSOR`、`INCOMPATIBLE_INTEGRATION_PROTOCOL`；修正配置或完成补偿再连。
`EVENT_CONSUMER_SLOW`、存储/连接暂时错误可重连；未发送的 cursor ACK 返回
`EVENT_ACK_NOT_SENT`。不会为了连通而降低鉴权或绕过权限。

## 会话创建、绑定与恢复

```sh
td collab --principal report-bridge session create --launch-profile report-agent \
  --cwd /absolute/path/to/runs/current --idempotency-key <session-create-key>
td collab --principal report-bridge session get <session-id>
td collab --principal report-bridge session restore <session-id> --idempotency-key <restore-key>
```

公开记录包含 `operation_id,session_id,group_id,principal_id,agent_slug,
agent_native_session_id,state,error_code,cwd,launch_profile,created_at,updated_at,terminal_binding`。
`terminal_binding` 是实际 tmux server/session/pane/PID 的固定身份。集成终端须保持单一 pane；
新增窗口/pane 会使原生身份核验失败，避免误用其它 pane 的 hook。完整原 profile
仅在服务私有持久记录中保存，不通过事件发送。配置启动条件时，公开记录及 session
事件另外包含 `startup_input={state,deadline,matched_since,observed_at}`，时间为 Unix 毫秒。

| state | 精确含义 |
| --- | --- |
| starting | 创建意图已持久化，命令提交尚未证明 Agent / 原生绑定就绪 |
| binding_pending | 实际观察到该 Agent，尚未捕获确切原生 ID |
| ready | 实际观察到该 Agent 和确切原生 ID；不表示任务空闲/完成 |
| restoring | 显式恢复意图持久化，等待原 ID 的运行证据 |
| releasing | 释放意图已落盘；不能接收新投递，尚未证明实际承载回收 |
| released | 实际进程/PTY/tmux/活动终端登记与本组活动成员已移除；恢复描述保留 |
| failed | 启动、绑定、身份核验、释放或运行观察失败，详见 error_code |

同键同请求返回原 TD ID；已记录但结果不明的启动不会自动重新执行。通常等
session 事件；get 也会现场核验。120 秒内未形成绑定返回 `SESSION_BINDING_TIMEOUT`。
服务重启会继续核验待绑定记录。未捕获真实原生 ID，restore 返回
`NATIVE_SESSION_ID_MISSING`，不能伪造 UUID 或选择“最近会话”。

启动输入条件独立于原生绑定状态：`ready` 不证明首条输入可写，`binding_pending`
也不禁止已经满足画面条件的输入。`startup_input.state=pending` 时消息保持 pending、
尚未写入终端，诊断码 `SESSION_STARTUP_INPUT_PENDING`；超过 deadline 后变为
`timed_out`，码 `SESSION_STARTUP_INPUT_TIMEOUT`，不会因超时盲投。终端身份核验或
采集失败也不会放行。持续投递重试/会话 get 可以再次核验；只有重新观察到符合条件
的画面并满足间隔才转为 `observed`，记录 `observed_at`。等待条件本身不增加实际
写入次数，不创建新 attempt/session。集成运行时不可用时，受管终端投递返回
`INTEGRATION_RUNTIME_UNAVAILABLE`。

`observed` 只表示本次启动的画面条件已观测；后续咨询保留通常的追加投递方式，
不以 Agent 忙闲门控。真正执行 restore 时重新等待启动条件。写入后的 `delivered`
仍只表示终端写入；`AGENT_CONSUME_UNCONFIRMED` 也不能解释为已消费或应自动重投。
任务完成继续以负责人明确 `report complete` 为准。

恢复保留原 TD ID、原生 ID、argv/model/cwd/包装器配置。原会话已经精确运行时直接
返回现状；发现其它 ID、未知进程或 pane 被复用则拒绝。原 tmux 已退出时，只有
显式精确恢复可以重建承载终端；这本身不证明 Agent 原生会话恢复成功。新参数/profile
不能覆盖原启动快照，尚未确定结果的恢复拒绝另一次恢复，防止重复 Agent。

1.4.302 起，绑定核验会读取原 pane 的实际前台进程 argv，即使
`pane_current_command` 已显示具体 Agent 程序名也不省略 argv。插件按已登记的
`resume.command` 模板回读精确 ID，支持位置参数及独立/内联 ID 标志；不使用
`--last`、缓存的 UUID 或画面内容替代进程证明。声明模板本身不证明恢复成功。
服务重启后，原 pane 中精确 UUID 已在运行时 get 应回读 ready，restore 返回原
operation/pane，不启动第二个 Agent；进程携带不同 UUID 时继续拒绝。

1.4.303 起，集成 restore 排除自己的已核验终端；其他已登记终端须用当前前台
进程证明同一个 UUID 才返回 `NATIVE_SESSION_ALREADY_RUNNING`。已退出到 shell、
已消失或实际运行另一 UUID 的终端，其缓存/last-known 记录不算运行中所有者。
可能持有原 UUID 的终端无法核验、或相同 Agent 正在运行但没有精确 ID 证据时，
返回 `NATIVE_SESSION_OWNER_UNCONFIRMED` 并停止恢复；应检查该终端，不绕过保护。
此检查覆盖服务已登记终端，不声称枚举其他应用中全部原生会话。

1.4.304 起，检查合并持久终端清单和当前 PTY backend；服务重启后无需网页挂接，
已登记 tmux 的每个 pane 都会现场核验。旧登记 UUID C 不会排除当前实际运行 UUID A
的终端，终端的协作路由为 recovering/offline 或绑定不匹配也不会跳过检查。
仅在确认 tmux 已消失或当前进程排除冲突时继续；未知进程、同 Agent 缺少精确 UUID、
观察失败均返回 `NATIVE_SESSION_OWNER_UNCONFIRMED`，不以旧 UUID 证明没有冲突。

### 可选的当前进程原生身份（1.4.306）

某些 Agent 首次启动的 argv 没有 UUID。支持以下所有权协议的 Agent 插件可以在
原 `manifest.json` 中增加一个可选字段；现有别名、恢复命令和其他配置保持原样：

```json
"nativeIdentity": {
  "kind": "linux-flock-owner",
  "directory": "~/.my-agent/native-writer-locks"
}
```

这是通用协议声明，TD 没有内置任何私有 Agent 名称或路径。锁目录须是当前用户
home 内的绝对目录或 `~/` 路径；运行时目录、文件须由当前 UID 拥有，且不能被
组或其他用户写入。目录/文件本身不能为软链接；目录的真实路径仍须在 home 内。
锁是 `<native-id>.lock` 普通文件，配套 `<native-id>.owner.json` 至少含
`{"pid":123,"process_start_id":"linux:456"}`；其他字段不用来证明身份。

插件配置在服务启动时载入。升级、保留原配置并加入声明后，重启实际服务一次；
Linux 服务 `capabilities.native_identity_linux_flock_owner=true` 表示支持此证据类型，
不能替代核验插件声明与真实持锁情况。其他平台返回 false，继续使用原 argv 证据。
不需要改 integration policy、凭据、原启动 argv/model/cwd/包装器或业务任务。

TD 从当前终端的真实前台进程取得 PID（包括直接 exec 后就是 pane PID 的进程），
再只读核验：该 PID 的 UID、前台进程组、当前 `/proc/<pid>/stat` 启动时间、owner
文件中的 PID/start_id、它实际打开的 FD 与目录内锁文件的 dev/inode、以及
`/proc/locks` 的同 PID 独占整文件 `FLOCK ADVISORY WRITE`。读取前后复核进程实例及 argv、
相关 FD 集合、inode、owner 和内核持锁，任一无法成立都不推导身份。
owner JSON 读取限 4096 字节、argv 比对限 16384 字节、进程 FD 数量限 4096；不会读会话正文/环境或尝试取得写锁。

仅一个完整匹配的原生 ID 才可用于当前身份：明确持有目标 ID 拒绝重复启动；明确
持有其他 ID 可以排除该进程。多个持锁 ID、argv 与锁身份矛盾、检查间进程变化
均继续拒绝。owner 文件存在、PID 存活、旧登记或 hook 历史均不能单独确认身份。
尚未建立可证明身份、协议不符或读权限不足时仍保留未确认保护；没有声明此字段的
旧插件继续使用原有 argv 路径。此证据仅支持本机 Linux tmux 进程，不宣称能覆盖
未登记外部进程、远端 Agent 或其他操作系统。

维护机已用真实隔离 tmux/内核 flock 验证首次启动的 UUID 捕获、直接 exec 的 pane
PID、同 ID 拒绝/不同 ID 排除、遗留 owner、错误 start_id/PID、inode 替换、没有真实
持锁、多个 ID 和 argv 冲突。**私有 TraeX 的 1.4.306 身份接入仍需使用方实机复验**。
原 `startupInput` 仍独立控制首次写入；核验 native ID 不表示输入初始化完成。

### 会话身份与运行承载的生命周期（1.4.309）

这项能力把稳定的会话记录与可回收的终端承载分开。TD 保留逻辑 `session_id`、
原生身份、授权归属、原启动配置和消息关联；terminal/backend/tmux/pane 是可重建的
运行承载。`released` 不进入活动终端列表，没有常驻 Agent、PTY 或 tmux。
它不是隐藏的终端，也不表示删除 Agent 原生历史。原生历史仍由 Agent 管理。

共享内核 `sessionLifecycle.ts` 提供操作串行、原生身份预留、代次和释放验证协议；
首批调用者为现有 IntegrationSession/受限 CLI。复用原有持久恢复记录，不新增
conversation/job/task 或裸 UUID 导入。现有用户关闭、最近关闭列表、任务执行归档
保持现有行为，本版尚未将它们迁入该协议。principal 是调用权限，不是业务类型。

```sh
# 管理员将 session.release 追加到原身份的 permissions，凭据保持不变。
td integration update --file /private/path/policy.json
# 后台从 get 获取当前 generation（不能硬编码，也不能仅沿用旧事件中的代次）。
td collab --principal report-bridge session get <session-id>
td collab --principal report-bridge session release <session-id> \
  --generation <current-generation> --idempotency-key <this-release-key>
# 下一条外部消息先持久接收，显式恢复，再 send/reply。
td collab --principal report-bridge session restore <session-id> \
  --idempotency-key <this-restore-key>
td collab --principal report-bridge reply <retained-original-message-id> \
  --file /private/path/followup.txt --idempotency-key <this-message-key>
```

权限：`session.release` 与 `session.restore` 分开授权，`session.read` 用于状态回读。
必须仍属于原 principal/本机组；没有 `session.release` 的旧身份不会获得该能力。
运行中 Agent 必须先由调用方明确正常退出；TD 不根据 result、快照、输出间隔或
忙闲推断代为终止。首版验证固定的单 pane、原 shell PID/前台进程组和纯交互 shell
参数，没有 Agent 或其它前台工作。shell 中人工输入的未执行文字不属于可靠观测，
调用方需保证不与人工输入同时操作。无原生 ID、未知进程、进行中的启动/恢复、
pending 消息或其它组的成员归属均拒绝；不取消 pending、不补投 delivered 正文。

新增公开字段：`generation`（旧记录初始为 1）、`runtime_present`（true/false/null）、
`operation_uncertain`（可选）、`resume_configuration_fingerprint`（可选）。
`runtime_present=null` 表示观测/操作结果不明，不能解释为零资源；shell 仍存在时
为 true。成功 `released` 必须 `runtime_present=false,terminal_binding=null,error_code=null`。
释放保存的原组角色在恢复时重建，组、消息、结果、旧任务不会随释放删除。

实际释放和实际恢复在执行前递增 generation；管理员兼容确认也递增，以使旧观察
失效。已经 released 的新键 release、精确运行中的新键 restore 为无动作回读，保持
原 operation/generation。release 必须携带 get 返回的当前代次，旧值报
`SESSION_GENERATION_MISMATCH`；代次不等于消息序号、任务 attempt 或业务周期。
从本版开始完成的 release/restore 幂等键重放返回**该操作原结果快照**，可能已不是
当前状态；使用 get 查当前状态。不同参数复用键返回 `IDEMPOTENCY_CONFLICT`，
下一次实际操作使用新键。若崩溃发生在结果快照提交前，且会话已经进入后续代次，
旧键返回 OPERATION_OUTCOME_UNCONFIRMED，不把新操作结果冒充旧结果。升级前的旧幂等
记录仍按兼容规则回读当前状态，不重复执行。

同 ID 的生命周期串行；同 Agent/native ID 的验证/启动使用服务内互斥预留，重启后
持久的未决启动意图也阻挡另一描述启动。同一键的并发请求共用原操作，不启动两份。
原生身份检查继续使用实际 argv/当前持锁证据；该预留不是独立程序之间的全局原子锁。
释放先保存意图，再阻断新投递、等待正在进行的投递，重新核验后销毁，最后保存结果。
落盘失败不先执行回收；回收失败保留描述并报告 failed，不宣称 released。

重启对 releasing/不确定记录核验实际承载：已经不存在时可以清理残留登记并收口，
仍存在时返回 `OPERATION_OUTCOME_UNCONFIRMED`，不会自动杀进程或再启动 Agent。
调用方读 get/诊断、明确处理现场后，可用当前 generation 和新键再次请求 release。
Released 记录若出现未授权重建的承载，同样拒绝静默接管。
`session.releasing/released/restoring/ready/failed` 推送原 operation_id/generation；
沿用现有 event_id 去重、连续持久接收 ACK、断线重放与保留缺口契约。

Released 上 send/reply 返回 `SESSION_RELEASED`，不入队、不隐式启动。恢复重建承载后
逻辑 ID 不变，原 retained 消息的 reply_to、thread_id 与 principal 关联不需要迁移。
恢复返回 ready 只证明原生身份，消息仍受本次 startupInput 保护。恢复失败不得静默
创建另一 UUID、使用 --last，或改走新的业务任务/会话。

**历史保留边界不变**：普通消息仍只覆盖保留记录（通常最近 2,000 条及待投递/近期
幂等保护记录），每组事件仍保留 10,000 条。释放不是无限历史锚点；原消息裁剪后
reply 返回 `MESSAGE_NOT_FOUND`，不能伪造旧 reply_to。是否用同恢复会话的新普通
消息作为新咨询锚点由业务方决定，并保留自己的外部历史。没有 forget 或删除原生
历史接口；用户放弃历史与释放承载是不同操作，原生历史删除不在本版范围。

#### 恢复配置兼容性与旧记录初始化

新建可精确恢复的记录在启动前保存配置指纹。指纹涵盖当前 launcher 的真实路径、
文件 SHA-256、原 argv/resumeArgv/cwd、Agent 别名、精确 resume 语义、插件 nativeIdentity
声明。它不是整个私有 Agent 安装包/包装器依赖/原生历史的备份，也不会检查私有
会话正文。包装器路径相同不能证明内容相同；文件超过 512 MiB 不支持指纹采集。
现有不能精确 resume 的插件仍可创建终端，但不因此获得安全释放能力。

旧记录未保存历史文件内容，升级时只初始化代次，不自动采集为“历史已验证”。
第一次 release 前，管理员先读取**当前**指纹，核对原模型/参数/cwd、包装器当前内容
和插件恢复语义，再明确授权当前配置用于原历史恢复：

```sh
td integration resume-configuration <session-id>
# 返回 generation, recorded_fingerprint（旧记录为 null）, current_fingerprint,
# confirmation_required。无 shell/PTY/状态改变，不返回文件正文或凭据。
td integration confirm-resume <session-id> \
  --generation <returned-generation> --fingerprint <current_fingerprint>
```

确认只证明管理员接受当前兼容性，**不证明未知的旧包装器内容**；不改 argv/profile/
cwd/native UUID/私有程序。后来指纹不一致时明确失败，管理员也可在核对后用上述
步骤确认新兼容指纹；TD 不暗中迁移模型或参数。正在执行生命周期操作时不允许确认。
恢复继续使用原 profile 快照；同时按当前授权的 profile/cwdRoots 复核 cwd，撤销或
缩小授权不被旧快照绕过。插件精确恢复能力消失或身份/启动条件失败仍会拒绝。

能力检测：CLI/实际服务均至少 1.4.309，协议 1；服务 capabilities 必须包含
`session_runtime_release=true,stable_session_identity=true,session_lifecycle_generation=true,
session_resume_configuration=true,session_lifecycle_min_version="1.4.309"`。
CLI 对旧服务先检查能力，失败为 `SESSION_RELEASE_UNSUPPORTED`，不发送回收请求。
本地管理员配置确认同样先探测服务能力。未知或不兼容错误不得转为新会话。

| 错误码 | 准确语义及处理 |
| --- | --- |
| SESSION_RELEASE_UNSUPPORTED | CLI/实际服务或运行适配器不支持本协议；升级两者 |
| INVALID_SESSION_GENERATION | 缺少或非法代次；从 get 获取正整数 |
| SESSION_GENERATION_MISMATCH | 观察已过时；重新读当前记录，不硬改旧请求 |
| SESSION_STILL_RUNNING | 实际 Agent 仍在运行；不能推断空闲后自动退出 |
| SESSION_PENDING_MESSAGES | 存在 pending 正文；先明确处理，不清空或重投 |
| SESSION_OPERATION_IN_PROGRESS | 同 ID 正在操作或原启动未决 |
| SESSION_NATIVE_OPERATION_IN_PROGRESS | 同原生身份有其它描述的在途/持久未决操作 |
| SESSION_SCOPE_CONFLICT | 终端还属于其它组；管理员先处理归属 |
| SESSION_IDENTITY_MISMATCH | 固定终端/pane/PID/布局或 shell 证明不符 |
| RESUME_CONFIGURATION_UNCONFIRMED | 旧记录缺少兼容确认；管理员核对当前指纹 |
| RESUME_CONFIGURATION_CHANGED | launcher 内容/路径或插件恢复语义变化；不自动采纳 |
| OPERATION_OUTCOME_UNCONFIRMED | 释放结果不明或承载重新出现；保留记录并核对 |
| SESSION_STORAGE_FULL | 恢复记录 journal 超过 64 MiB；停止新增操作并由管理员处理 |
| SESSION_RELEASE_FAILED | 未分类释放失败；不返回私有异常输出 |
| SESSION_RELEASED | 消息目标已释放；先显式精确 restore |

原有权限/组/目录、幂等、EXACT_RESUME_UNSUPPORTED、原生重复所有者、启动/绑定错误
继续适用；本节不改变这些错误的保护条件。

### 管理员恢复诊断（1.4.305）

`capabilities.session_restore_diagnostics=true` 表示服务支持持久恢复诊断。
遇到 `NATIVE_SESSION_OWNER_UNCONFIRMED` 或 `NATIVE_SESSION_ALREADY_RUNNING` 后，
本机管理员执行：

```sh
td integration diagnostics <TD-session-id>
```

命令经原私有 Unix socket 和本机管理员凭据读取报告，不使用 `--principal`。
服务能力缺失时返回 `SESSION_RESTORE_DIAGNOSTICS_UNSUPPORTED`，不会假装诊断成功。
命令仅读取已存记录，不重新扫描进程、不挂接 PTY、不试键、不创建恢复意图。
304 及更早的失败没有此报告；升级后应使用新的 restore 幂等键执行一次明确检查，
再读报告。旧键不会执行一次新检查。

响应包含当前 `session_id / operation_id / state / error_code`，以及可为空的
`diagnostics`。报告含其自身 `operation_id / checked_at / code`、`candidates`、
`total_blockers / truncated`；它是该次检查的历史事实，不能代表读取时的当前进程。
只有上一次**实际发起**的恢复检查会保存报告；下一次实际恢复清除旧报告，运行中
no-op restore 不创建新检查。报告跟随会话保存并可在服务重启后回读。

每个阻塞候选含 `session_id / backend_session_id / backend_attached`、
`tmux_session_name / tmux_session_id / pane_id / pane_pid`、`program / process_source`、
`arguments_observed / agent_slug / last_known_native_id / observed_native_id`、
`pgid / tpgid / reason / observed_at`；306 另含真实前台 `process_pid` 及
`native_identity_source`（argv / linux-flock-owner / null）。无法观测的值为 null。backend 不存在或仅有旧
登记仍可通过 tmux 核验；`pane_pid` 是承载 pane 的 PID，不冒充 Agent 前台 PID。
报告最多保存 128 个阻塞候选；`total_blockers` 保留总数，确定的同 UUID 所有者优先展示。

| reason | 实际证据缺口或冲突 |
| --- | --- |
| NATIVE_SESSION_MATCH | 当前前台进程的 argv 或完整持锁证据明确证明目标 UUID |
| NATIVE_SESSION_IDENTITY_CONFLICT | argv 与完整持锁证据指向不同 UUID |
| NATIVE_SESSION_IDENTITY_AMBIGUOUS | 当前进程持有多个可证明的原生 UUID |
| NATIVE_SESSION_PROCESS_CHANGED | 持锁检查间进程实例或所有权证据变化 |
| NATIVE_SESSION_OWNERSHIP_UNCONFIRMED | 当前打开了原生锁文件，但持锁/owner/inode 证据不能完整成立 |
| NATIVE_SESSION_ID_MISSING | 当前同 Agent 的进程已观测，但没有可回读的精确 UUID |
| PROCESS_ARGUMENTS_UNAVAILABLE | 无法取得可靠的当前进程 argv |
| FOREGROUND_PROCESS_UNCONFIRMED | 无法可靠核验前台进程 |
| SHELL_PROCESS_NOT_FOUND | shell 的 ps 输出未形成可解析记录 |
| SHELL_FOREGROUND_MISMATCH | shell 未持有有效前台进程组；记录 pgid/tpgid |
| SHELL_ARGUMENTS_UNSUPPORTED | 当前 shell 命令或启动参数未满足既有安全检查 |
| SHELL_OBSERVATION_FAILED | shell 的进程观察失败 |
| TERMINAL_OBSERVATION_FAILED | tmux 或终端观察失败，无法排除该候选 |

完整候选可能来自其他组，因此仅管理员接口返回；principal 的 session 响应与推送
事件只增加 `restore_diagnostics_available=true`，不含候选标识/UUID。报告不保存或
返回原始 argv、cwd、终端正文、包装器异常、凭据。诊断不自动放宽任何拒绝条件，
不能把旧 UUID、native ready 或 Agent 忙闲推测当作消除冲突的证据。

常见失败码（每项都是完整字符串）：

- 配置/权限：`LAUNCH_PROFILE_DENIED`, `LAUNCHER_UNAVAILABLE`, `COLLAB_AGENT_UNAVAILABLE`, `SESSION_CWD_MISSING`, `SESSION_CWD_DENIED`, `INTEGRATION_SESSION_NOT_FOUND`, `INTEGRATION_SESSION_LIMIT`, `SESSION_RESTORE_DIAGNOSTICS_UNSUPPORTED`。
- 终端/身份：`SESSION_BACKEND_UNAVAILABLE`, `SESSION_TARGET_NOT_SHELL`, `SESSION_IDENTITY_MISMATCH`, `NATIVE_SESSION_ID_MISMATCH`, `NATIVE_SESSION_ID_INVALID`, `NATIVE_SESSION_ID_MISSING`。
- 启动/恢复：`SESSION_CREATE_OUTCOME_UNKNOWN`, `SESSION_OPERATION_IN_PROGRESS`, `SESSION_BINDING_TIMEOUT`, `EXACT_RESUME_UNSUPPORTED`, `NATIVE_SESSION_ALREADY_RUNNING`, `NATIVE_SESSION_OWNER_UNCONFIRMED`, `AGENT_NOT_RUNNING`。
- 未分类异常：`SESSION_LAUNCH_FAILED`, `SESSION_OBSERVATION_FAILED`；错误不包含包装器输出、密钥或原始堆栈。

## 验收边界

本版维护机验证：共享释放协议、真实 Unix socket 权限/生命周期事件、零入队拒绝、
同键并发/旧代次/异常释放/重启对账、配置内容变化与旧记录显式确认、原消息关联；
隔离真实 tmux 的实际销毁与原逻辑 ID 重建。本机 fixture 不等于私有 TraeX 验收，
本版真实 TraeX 的零承载→同 UUID→真人原话题往返仍待使用方升级后验证。

维护机验证：真实 Unix socket 主动推送/断线重放/撤销、journal 重载与源记录补偿、
权限与幂等隔离、accepted 上咨询/关联答复、修订后的新结果、原 profile 恢复和
实际 shell 参数透传。适配器测试不冒充真实 Agent 的原生会话验收。

维护机未安装 TraeX；已用真实 tmux/终端程序复现加载期间丢弃输入，并验证配置条件
阻止早投、仅写一次，以及无原生 UUID 时仍可放行；这不冒充真实 TraeX 启动验收。
使用方已报告 1.4.300 开发机真实 TraeX UUID 捕获与精确恢复通过，原对话记忆、
原 UUID、TD ID、attempt 和 artifact 保持一致。使用方已报告 1.4.301 冷启动首条
仅写一次并收到明确 complete，超时保持 pending/0 次写入，策略更新保持凭据。
维护机另外用真实 tmux/native fixture 验证插件 argv 回读、记录重载后运行中恢复
不重复启动、不同 UUID 拒绝，以及进程退出后缓存 UUID 不再阻挡恢复。使用方已报告
1.4.302 真实 TraeX 服务重启回读、运行中恢复不重启、不同 UUID 拒绝通过；显式恢复
原 UUID 也已回读 ready，但配置的模型 footer 条件被暂态提示替换，输入仍保持待投递。
使用方已报告 1.4.303 退出后精确恢复通过，也发现未挂接 PTY 的已登记 tmux 重复保护
遗漏；维护机已用“旧 UUID C、实际运行 UUID A、无 PTY 附着”的真实隔离 tmux 复现，
并验证 1.4.304 编译后检查在该状态下拒绝再次启动。
使用方已报告 1.4.304 在未挂接网页/PTY、旧登记 UUID C 而实际运行 A 的场景下，
正确拒绝同 UUID 恢复且没有第二个进程。1.4.305 实机诊断已定位四个同 Agent
无 argv UUID 的候选，另一个候选主进程直接 exec 为 pane PID。使用方提供了当前
PID/start_id、实际 FD/inode 与内核 flock 一致的私有原生所有权证据；1.4.306 提供
上述可选通用插件声明，未修改私有 Agent 或放宽未确认保护。
**1.4.306 的私有 TraeX 持锁身份接入与稳定输入条件仍须使用方实机复验**。
回读 capabilities 后，应核对原 TD ID、真实 TraeX UUID 与原 argv/cwd/包装器快照，
并验证 Agent 真正加载原对话。
先完成测试环境的创建→追问→关联答复，再验重复键、追加咨询、断线重投和精确恢复。
业务定时器或正式群接入由使用方明确启用，TD 发版不会启用这些业务流程。
