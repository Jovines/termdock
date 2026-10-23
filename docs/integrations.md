# TD 通用外部接入（协议 1）

principal 改名/显式关闭要求 **CLI / 实际服务均至少 1.4.315**（见文末契约）。

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

### 清除既有会话的屏幕启动条件（1.4.310）

从策略中删除 `startupInput` 只影响新会话，既有会话仍保留原启动快照。需要让指定
旧会话使用普通终端投递时，由本机管理员通过正式入口显式解除：

```sh
# 先由持有该会话的身份回读当前 generation
td collab --principal report-bridge session get <TD-session-id>
# 本机管理员执行，不使用 principal 凭据；generation 必须取当前实际值
td integration clear-startup-input <TD-session-id> --generation <N>
td collab --principal report-bridge session get <TD-session-id>
```

最低 CLI / 实际服务版本均为 **1.4.310**；先回读能力
`session_startup_input_clear=true`、`session_startup_input_clear_min_version=1.4.310`。
CLI 在旧服务上返回 `SESSION_STARTUP_INPUT_CLEAR_UNSUPPORTED`，不尝试修改私有文件。
本机认证接口为 `POST /admin/sessions/:id/startup-input/clear`，请求仅含
`{"generation":N}`，回复 `{session: …}`；集成 principal 无权调用这个管理员入口。

操作原子持久化删除该记录的 `profile.startupInput`、`startup_condition` 和
`startup_input`，设置公开字段 **`startup_input_disabled=true`**，generation 增加 1。
以后对该逻辑会话执行实际 restore 也不重新继承 profile 的屏幕条件；新创建的其它
会话仍按各自策略启动。此入口只支持显式禁用，不提供重新启用或更换启动配置。
原逻辑 ID / 原生 UUID / argv / model / cwd / 包装器 / 配置指纹 / operation ID /
终端绑定 / 消息历史及 reply 关联保持原状，不启动、退出或重建 Agent。
会话事件仍使用现有 `session.<state>`，payload 带更新后的 session / generation /
`startup_input_disabled`，沿原持久订阅与 ACK 机制推送。

管理员解除条件后，**已经 pending 的消息可能随下一次投递继续发送**；不重发
`delivered` 正文。它解除的是额外画面限制，不证明 Agent 输入已初始化、已读、空闲
或已消费，`delivered` 仍只表示终端写入，结果仍看明确回复。运行中亦可执行，
不需要修改窗口尺寸或等待模型/footer 文案。

原子保存失败不解除条件。代次不匹配返回 `SESSION_GENERATION_MISMATCH`，缺失或
非法代次返回 `INVALID_SESSION_GENERATION`；有启动/恢复/释放进行中或结果不明时
返回 `SESSION_OPERATION_IN_PROGRESS`；记录不存在返回 `INTEGRATION_SESSION_NOT_FOUND`。
用新 generation 对已禁用会话重复清除是 no-op，不再增加代次；旧 generation 仍
拒绝。若命令回执丢失，先 get 查证新代次与禁用字段，不盲重试旧参数。既有 release /
restore 幂等键的历史结果保持不变，以 get 为当前状态依据。

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
仍只表示终端写入。1.4.311 起，普通消息统一粘贴一次，间隔 50ms 后发送一次
不带括号粘贴包装的 CR（回车），适用于 tmux 与直接 PTY；不识别 Agent 粘贴提示、
不自动补回车、不根据终端文字确认消费。`delivered`/`pty_written` 是现有回执字段，
仅记录终端写入调用完成，不保证对方收到、提交、消费或执行。快照只作观测，明确回复单独关联。
旧回执中的 `AGENT_CONSUME_UNCONFIRMED` 保留历史，不触发补键或重投。

1.4.312 起，TD 实际启动/恢复 Agent 时持久记录一次进程检查意图。仅该次启动的
首次投递在原终端观察到目标 Agent 后放行；恢复还须匹配原 native UUID，冷启动
不要求首次输入前尚未生成的 UUID。已有会话和普通 Terminal 不新增检查；运行中
no-op restore 不重新开启检查。检查是运行/绑定事实，不表示 TUI 已完成输入初始化。
`startup_input_disabled` 仅清除画面条件，独立于该进程检查。capabilities 为
`agent_launch_process_check=true`，最低运行服务 1.4.312；建议 CLI 同升以取得新诊断文案。

未确认时普通消息保持 pending、实际写入次数不增加，诊断 `AGENT_LAUNCH_PENDING`；
120 秒后 `AGENT_LAUNCH_TIMEOUT`，不同 Agent/原 UUID 为 `AGENT_LAUNCH_IDENTITY_MISMATCH`。
不因超时盲投或重新启动，后续如果现场确实观察到正确进程可解除检查。检查随活动
终端登记持久化，服务重启保留；新的实际启动/恢复重新生成检查 ID，旧观察不能清除
新检查。一旦当前检查解除，后续普通消息沿原终端路由，不重复判断应用就绪/忙闲。
已正常 release 的承载登记被移除，下一次 restore 在新承载上重新记录检查。

1.4.313 起，定时发送、Agent 启动/恢复命令和普通消息复用实际终端的串行输入队列；
tmux 的显式 `drive keys/approve` 也在该队列中执行，不插进正文和回车之间。
定时发送等待实际写入调用结束后才记录成功。等待或排队中的输入绑定原承载和
TD 启动代次，代次检查解除后仍保留；承载替换、移除或再次启动时，旧操作报
`TERMINAL_INPUT_TARGET_CHANGED`（登记删除为 `SESSION_REMOVED`），不会跟随逻辑 ID
写入新的承载。该检查在正文写入前及发送回车前执行；如果承载在两步之间变化，
正文可能已写入旧终端，回车不会发给新承载。此错误不证明应用是否收到了正文，
也不自动补键或重发正文。持久消息 worker 仍沿已有回执/路由重试规则处理失败，
可能写入过的消息须由调用者核对。直接键盘输入不进入自动输入队列。
能力探测为 `terminal_input_runtime_fence=true`，最低运行服务 1.4.313；CLI 同升
可读取完整帮助和 `TERMINAL_INPUT_TARGET_CHANGED` 的诊断文案。

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

## 1.4.314：启动诊断与显式冷启动重试

最低 CLI 和实际运行服务均为 **1.4.314**，协议仍为 1。先回读两者版本及实际服务
`session_launch_diagnostics=true`、`session_cold_retry=true`；对应
`*_min_version` 均为 `1.4.314`。CLI 遇到不支持重试的服务返回
`SESSION_COLD_RETRY_UNSUPPORTED`，不发出重试请求。

管理员沿用 `td integration diagnostics <TD-session-id>`，同一响应新增
`launch_diagnostics`（可为 null）与 `launch_diagnostics_history`（最多 16 个此前实际
启动操作）。旧 `diagnostics` 原生所有者报告字段保持兼容；该入口仅回读持久记录，
不重新扫描进程、不挂接终端、不发送输入。313 及更早启动没有新增报告，不能从升级
反推旧失败原因。已有失败会话可以在满足下述检查后显式重试，产生新的诊断。

启动报告字段：

| 字段 | 含义 |
| --- | --- |
| `operation_id / generation / kind` | 此次操作和承载代次；kind 为 `cold_start / cold_retry / native_restore` |
| `phase / updated_at / steps` | 最后持久阶段和时间；steps 最多最近 24 个阶段，时间是 TD 记录时间 |
| `error_code / reason_code` | 公开失败码及已分类原因；无法分类为 `UNCLASSIFIED_LAUNCH_ERROR`，不保存原始错误文本 |
| `paste / submit` | 各自为 `not_attempted / attempted / write_returned`；attempted 在调用输入前持久保存，write_returned 表示调用返回 |
| `runtime_exists` | 最后观察是否存在原承载；没有观察时为 null，不代表读取时的实时进程 |
| `target_change` | 仅发生承载 fencing 冲突时可有：期望/当前 backend ID、期望/当前 launch ID、backend 实例是否相同 |

阶段清单：`configuration`、`runtime_prepare`、`binding_persist`、
`native_owner_check`（精确恢复）、`runtime_verify`、`launch_intent`、
`queue_wait`、`queue_acquired`、`paste_attempted`、`paste_written`、
`submit_attempted`、`submit_written`、`binding_observe`；中断冷重试回读到原 shell 时
另记 `reconciled_shell`。阶段只表示 TD 实际到达的步骤，不推断私有 CLI 根因。
崩溃在输入调用附近时，attempted 不能证明写入发生或未发生，不能据此补键。
write_returned 不证明原生程序消费、提交、成功执行或最终结果。正文仍按原机制
粘贴一次、等待至少 50ms、发送一次 CR；没有新的屏幕识别、启动 sleep 或额外 Enter。

完整报告仅管理员可读；principal 与主动 session 事件只返回
`launch_diagnostics_available=true`，不返回阶段、其他候选或结构证据。报告不保存
argv、命令正文、stdout/stderr、环境变量或凭据。报告历史受上述条数及原描述总存储
预算约束，不是无限保留的排查日志。

正式冷重试命令：

```sh
td collab --principal <id> session get <TD-session-id>
td integration diagnostics <TD-session-id>
td collab --principal <id> session retry-cold <TD-session-id> \
  --generation <get返回的generation> --idempotency-key <本次操作唯一键>
```

权限沿用 **session.create**，并核对记录所属 principal/本机组、原 profile 当前仍被授权、
原 cwd 同时符合旧快照和当前目录授权。使用原启动配置快照，不接受新 argv/cwd/profile
参数。它保留逻辑 TD ID、消息关联和旧操作证据；实际尝试递增 generation、建立新
operation_id，状态为 starting，可能随后 binding_pending/ready/failed。返回的操作
快照不是实时状态；用 session get 查询最新状态。

只允许 failed、尚未绑定 native UUID、无 TD 消息历史/待投递且没有进行中或未确认操作
的记录；还需核实原绑定的唯一承载仍存在、原前台 Agent 已退出、回到合格 shell。
TD 会在生命周期锁及 worker 承载变更屏障内复核，不终止 Agent，不删除旧记录，不重建
消失或身份不明的终端。shell 检查不声称可读取用户未提交的任意草稿，调用方仍须拥有
输入操作权限并避免其他手工输入。TD 消息入队前设置持久、单调的历史标记；即使稍后
入队失败也保守拒绝冷重试。314 起消息裁剪保留双方历史标记；升级前已裁剪且没有 sender 标记的
历史无法证明完整，没有已知消息也返回未确认。旧格式或不可读存储同样拒绝；此缺口
持久保留，不因一次正常写入而被误判已修复。

必须有可信的原 launcher/plugin 恢复语义指纹且当前仍匹配；缺少指纹时管理员沿用
resume-configuration / confirm-resume 明确核对确认，不能把路径相同当内容相同。
指纹只覆盖 TD 已记录的 launcher 文件、原配置和插件恢复语义，不声称验证包装器依赖
或私有 Agent 二进制全部内容。

**cold retry 不是 native restore。** 无已知 UUID 时不能保证延续之前未知的原生历史，
也不证明旧程序未创建过原生历史；重试可能创建新 UUID。已有 UUID 必须使用原
session restore 与原生身份/重复所有者保护。原 session create 同幂等键继续回读已有
记录，不会自动冷重试。

同键同参数回读原操作结果，不再次启动；同键不同参数返回 IDEMPOTENCY_CONFLICT。
同会话不同操作键不能并发启动。重试意图和新代次在输入前持久保存，重试期间 send/reply
拒绝且不入队。服务重启后不会自动再启动：session get 核实原程序与 UUID 后可以转为
ready；回读精确原 shell 则为 failed/SESSION_COLD_RETRY_INTERRUPTED，明确结束未确认
状态，后续需新键显式重试；承载消失或仍不能确认时保留 cold_retry_pending=true 并拒绝
发送/重试。旧操作结果未提交且出现后续代次时，同旧键返回 OPERATION_OUTCOME_UNCONFIRMED，
不能把当前代次伪装为旧操作结果。

| 拒绝码（HTTP 409，另有注明时除外） | 含义 |
| --- | --- |
| `INVALID_SESSION_GENERATION / SESSION_GENERATION_MISMATCH` | 未传有效数值代次 / 代次已变 |
| `SESSION_COLD_RETRY_UNSUPPORTED` | CLI 或运行服务/adapter 不支持 |
| `SESSION_COLD_RETRY_NATIVE_BOUND` | 已有 UUID，应走精确 restore |
| `SESSION_COLD_RETRY_NOT_FAILED` | 当前不是 failed 冷启动 |
| `SESSION_MESSAGE_HISTORY_PRESENT / SESSION_MESSAGE_HISTORY_UNCONFIRMED` | 有消息/入队尝试 / 无法可靠核实历史 |
| `SESSION_COLD_RETRY_RUNTIME_UNCONFIRMED` | 无法核实原承载和退出 shell |
| `SESSION_OPERATION_IN_PROGRESS / OPERATION_OUTCOME_UNCONFIRMED` | 操作在进行 / 前次结果须对账 |
| `RESUME_CONFIGURATION_UNCONFIRMED / RESUME_CONFIGURATION_CHANGED` | 指纹缺失 / launcher 或恢复语义变化 |
| `SESSION_SCOPE_CONFLICT / SESSION_IDENTITY_MISMATCH` | 跨组承载或逻辑所有权冲突 |
| `LAUNCH_PROFILE_DENIED / SESSION_CWD_DENIED`（403） | 原 profile 或 cwd 当前不再授权 |

其他启动错误仍沿用前述准确码；fencing 冲突可为
`TERMINAL_INPUT_TARGET_CHANGED`，观察失败为 `SESSION_OBSERVATION_FAILED`，未知启动异常
为 `SESSION_LAUNCH_FAILED`，原 shell 检查失败可为 `SESSION_TARGET_NOT_SHELL`。
新能力并未确认 DevBox 私有 TraeX 的间歇启动原因，也不代替业务明确回复验收。

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

## 1.4.315：后台身份改名与显式关闭

最低 **CLI 与实际运行服务均为 1.4.315**；协议仍为 1。回读能力
`session_rename=true / session_rename_min_version=1.4.315`、
`session_close=true / session_close_min_version=1.4.315`。CLI 对缺少对应能力的服务返回
`SESSION_RENAME_UNSUPPORTED / SESSION_CLOSE_UNSUPPORTED`，不降级借用终端身份。

管理员在原完整策略中按需追加独立权限 `session.rename`、`session.close`，通过
`td integration update --file <policy.json>` 更新；旧身份不会自动获得这两个权限。
同一凭据、组、profile 和其他权限保留。后台 principal 不需要绑定终端，已有未删除的
本机授权组允许零活动成员；创建、恢复也不要求额外保留空管理成员。组的首次创建与
授权仍由管理员完成。普通手动创建的管理终端不属于 principal，不纳入这两个权限。

```sh
td collab --principal <id> session get <sid>
td collab --principal <id> session rename <sid> \
  --generation <session-get-generation> --name 'Fast model' --idempotency-key <key>
td collab --principal <id> session close <sid> \
  --generation <session-get-generation> --idempotency-key <key>
# 每次新操作前回读当前generation；同一请求重试保持相同参数与key。
```

对应本机 integration Unix socket 路由为 `POST /sessions/:id/rename`（JSON
`{generation,name,idempotency_key}`）和 `POST /sessions/:id/close`（JSON
`{generation,idempotency_key}`）。凭据仍只通过私有 credential file 注入，不能放 argv、
消息或日志。授权必须同时命中持久记录 `principal_id + group_id + session_id`，
不能修改同组其他 principal 或手动创建的成员；越界返回 `INTEGRATION_SESSION_NOT_FOUND`。

### 名称与代次

rename 复用已有名称清洗规则：控制字符/空白折叠、去首尾空白，截取最多 80 个字符；
清洗后为空返回 `INVALID_NAME`。名称保存为逻辑记录的 `name`，同步活动终端登记、
网页清单和 tmux 友好名称，释放后仍保留，下一次 restore 使用该名称。
released/closed 可以仅改审计名称，不重建运行承载、不启动 Agent、不写终端正文。

每次实际 rename 递增 generation，**保留原 launch `operation_id`、native UUID、
argv/profile/cwd/配置指纹及启动诊断**。`name_updated_at / name_generation /
name_operation_id` 记录本次改名对应的时间、代次和原操作；不把改名当作一次新启动。
新 `session.renamed` 事件包含 `{session_id,name,generation,operation_id}`，
沿用既有 event_id 去重、持久 inbox/ACK/重放契约。

先持久保存名称意图，再同步显示。`rename_pending=true` 表示名称已落盘，但显示同步
尚未收口；`session get` 或服务重启会重试显示同步，不重新递增、不创建终端。
进行中的启动/恢复/释放/关闭或不确定结果拒绝改名；待同步名称必须先通过 get 对账。
操作返回仍为 `{session: ...}`；不要把返回同键的历史快照当作最新状态。

### close 与 release 的区别

| 操作 | 运行承载 | 逻辑记录 | 后续恢复 |
|---|---|---|---|
| release | 只回收已退出 Agent 的精确原 shell | 保留原生恢复描述及消息关联 | 显式 restore 原 UUID |
| close | 明确结束精确自有运行 Agent，或原失败冷启动 shell | 保留审计、诊断及仍在保留期的消息 | closed 终态，首版不提供 reopen/restore |

close 不依据快照文字、忙闲、结果或验收推断是否可以终止。调用者负责业务授权与关闭
时机；TD 负责机械范围和承载核验。开始关闭会生成独立 `operation_id`、generation+1，
**先持久 `closing` 意图与精确目标实例，再进入既有 worker 屏障**，避免与自动终端写入
交叉。原 launch 诊断保留，其 operation_id 仍属于原启动，不随 close 改写。

必须无 pending 消息、无进行中/不确定启动或生命周期操作。scope 必须唯一：拒绝跨组
共有运行承载、其他逻辑所有者、链接到其他会话的 pane、分屏/其他 pane、原 tmux/pane 绑定变化。运行 Agent
需要当前 tmux server 实例与前台进程 PID/start identity、正确 Agent 与可验证的精确原 native UUID；
未绑定 UUID 的失败冷启动仅可关闭已证明的原 foreground shell，不能杀未确认的 Agent。
Linux 用当前 `/proc` starttime；macOS 用当前 `ps lstart` 与前台关系，不采用历史 PID。
不可观测平台/权限或缺失身份失败关闭。这里只做运行身份验证，不表示应用输入就绪。

终止前再次回读并比对原进程实例，按精确 tmux **session ID** 终止自有会话，不对
进程组执行批量 kill，不删除 native 历史、工作目录、credential、授权组或其他业务。
终止后最多观察 2 秒确认原实例与 tmux 消失，不重复终止。确认之后才移除活动 PTY、
侧栏登记和组成员并提交 `closed`、`runtime_present=false`、`terminal_binding=null`。
TD 生命周期锁不排他控制外部 tmux 命令/手工进程替换，最终核验与系统操作之间仍存在
外部竞争窗口；不承诺对未受 TD 控制的外部操作提供原子事务或阻止所有派生后台进程。

### 失败、幂等与重启

同一逻辑会话复用生命周期协调器；同参数同键合并/回读原操作，不重复终止。不同键
并发返回 `SESSION_OPERATION_IN_PROGRESS`；旧代次返回 `SESSION_GENERATION_MISMATCH`。
同键的已保存失败或 pending 结果也保持原快照，最新事实须另外 get。

关闭意图未落盘时不终止承载。终止/清理/结果落盘失败时保留意图，报告 failed 与
`operation_uncertain=true / close_pending=true / runtime_present=null`，不宣称 closed。
重启及 get **只对账，不再发送终止**：确认原进程和 tmux 已不存在后，可以清理残留
登记并收口 closed；仍存活、被替换或身份不明则保持拒绝，不自动杀可能的新进程。
显式关闭过的记录即使出现异常新运行承载，也不会回到 ready。

`closed` 上新 send/reply/restore/retry-cold/release 返回 `SESSION_CLOSED`，不入队，
不隐式新建 native UUID。尚未收口的 close 拒绝新投递及其他生命周期操作，先 get 对账。
已保存的幂等操作结果可以回读，但不会执行新副作用。主动事件继续推送
`session.closing / session.closed / session.failed`，payload 为公开 `{session}`；
公开记录不暴露精确 close 进程目标，仅提供 `close_pending` 等状态。

| 错误 | 含义与处理 |
|---|---|
| INTEGRATION_PERMISSION_DENIED | 没有独立授权，不能借用成员身份绕过 |
| INTEGRATION_SESSION_NOT_FOUND | 记录不属于当前 principal/本机组或不存在 |
| INVALID_NAME / INVALID_SESSION_GENERATION / INVALID_IDEMPOTENCY_KEY | 修正参数后按正式契约调用 |
| SESSION_GENERATION_MISMATCH / IDEMPOTENCY_CONFLICT | 代次或同键参数不同，回读状态；不要自动改参数重试 |
| SESSION_OPERATION_IN_PROGRESS / SESSION_RENAME_SYNC_PENDING | 进行中或显示意图未收口，先 get |
| SESSION_PENDING_MESSAGES | 存在待投递消息，业务先明确处理，TD不自动丢弃 |
| SESSION_SCOPE_CONFLICT / SESSION_IDENTITY_MISMATCH | 共享归属、pane或原生身份冲突，管理员核对 |
| SESSION_CLOSE_TARGET_UNCONFIRMED / SESSION_CLOSE_TARGET_CHANGED | 当前前台实例无法证明或意图后已变化，不终止未知进程 |
| SESSION_CLOSE_FAILED / OPERATION_OUTCOME_UNCONFIRMED | 关闭/对账结果未确认，保留证据且不自动再次终止 |
| SESSION_CLOSED | 审计终态，不能当 released 恢复 |

关闭不是消息送达、消费或业务完成证明；历史保留额度/事件保留缺口仍按原契约，不是
永久审计存储。close 不增加 task、看板或 accepted。真实私有 TraeX 与 DevBox
共享升级/业务适配由接入方后续验收；维护侧验证仅覆盖隔离测试的真实 tmux/Linux
进程退出与源码回归。macOS 真实 close 路径尚未实机验收。

## 1.4.317 / 1.4.318：管理员幂等创建空本机组

最低 **CLI / 实际服务均为 1.4.318**，协议仍为 1。管理员回读
`admin_local_group_create=true`、`admin_local_group_create_min_version=1.4.318`；
旧服务缺少能力时 CLI 返回 `ADMIN_LOCAL_GROUP_CREATE_UNSUPPORTED`，不回退到终端
成员来源、网页裸 HTTP 或私有文件写入。

```sh
td integration group create --name 'Case A' --idempotency-key case-a:group
# 返回 {"group":{"id":"...","name":"Case A","sessionIds":[],
#              "federated":false,"createdAt":...,"updatedAt":...}}
td integration groups   # 回读现有本机组的id/name
# 使用返回的group.id填入新的独立policy.groupId：
td integration create --file case-a-policy.json --credential-file case-a-credential.json
```

本机 Unix socket 管理路由 `POST /admin/groups`，JSON 只接受
`{name,idempotency_key}`。沿用本机管理员 credential 的鉴权与协议版本检查，由正式
CLI 从服务状态读取管理员凭据；不要把它放在命令行、消息、日志，也不要发给 Agent。
principal 凭据不能调用此入口（`INTEGRATION_ADMIN_REQUIRED`），没有新增 principal
建组权限。请求不能携带成员/目标ID/federated/launchProfiles/principal 等字段，
即使 `sessionIds=[]` 也属于多余参数，返回 `INVALID_GROUP_CREATE_REQUEST`。

名称去除首尾空白，非空、最多 256 字符，沿用现有本机组的禁止字符规则（括号
`【】「」`、间隔号 `·`、C0 控制字符及 DEL）。名称不作为唯一标识；不同 key 同名可以
建立不同组。幂等 key 必须非空、最多 256 字符，按原字符串区分；存储中只保存其哈希。
API 名称非法返回 `INVALID_GROUP`，key 非法返回 `INVALID_IDEMPOTENCY_KEY`。

创建记录和空组写入同一个协作存储文件，以一次 durable 原子替换提交，包含文件与
父目录 fsync。服务内同步执行，无终端/tmux/Agent 启动和正文投递；不包含 principal
授权、业务调度或三模型创建。**组创建与后续 principal 授权是两步操作，不是一个事务**。
后者继续遵循已有凭据落盘、唯一 principal ID、固定授权组和拒绝静默替换规则。

key在同一服务的管理员入口范围内共享，宿主应使用稳定的业务前缀避免互相碰撞。
同服务存储中，同 key 同参数（名称规范化后）返回原创建快照，包括原 ID、空成员和
原时间；同 key 异参返回 `IDEMPOTENCY_CONFLICT`。之后给原组加入成员或改名，不会改变
创建快照，不能把重试响应的空 `sessionIds` 当作当前成员清单；当前名称可用 groups
回读，成员清单沿现有组管理读接口。HTTP 回执丢失或持久写入结果不明时，保留原 key
和名称重试对账，不要换新 key “再建一个”。

1.4.318 补齐异常重试：同键回读前再次 durable 提交当前组和原创建记录；目录
fsync 持续失败仍返回失败，不以缓存记录冒充成功。文件替换前失败不会提交半个组；替换后 fsync/回执异常可能已经创建，应同键对账。
服务重启保留 key→原快照映射。原组被明确删除、变成跨服务目标或原 ID 已不存在时，
同键返回 `GROUP_CREATE_TARGET_UNAVAILABLE`，不新建替代组；全局清理也保留该 key 的
保留记录。创建 journal 损坏、无法可靠读取或其完整性未确认返回
`GROUP_CREATION_STATE_UNCONFIRMED`，普通存储写入不会自动把这种情况改称“已确认”。
此时管理员先对账/修复可信存储，不能通过换 key 绕过。

每个服务存储最多保留 2,000 个此入口的创建记录（含已删除组的 key 保留记录），满时
新 key 返回 `GROUP_CREATE_LIMIT`；已有 key 仍可回读。首版无 TTL/forget，不为腾空间
静默删除幂等证据。这不增加会话、普通消息、事件 journal 的原保留额度；调用者负责
组/凭据/逻辑记录预算。保证范围是唯一运行服务写入同一持久存储；不提供多个独立
服务共享文件的分布式事务，不能降级到旧写入器后再假设幂等证据仍完整。

推荐外部宿主按自身业务创建独立本机组，再用现有 integration create 授权独立
principal，可复用相同的 launchProfiles 配置模板。已有组允许零活动成员，随后
principal create/restore 不要求保留空管理终端。此能力不创建业务 Case、定时器、
consumer、task 或看板任务；Case/组/principal/session/message 映射由宿主持久保存。

已有 principal 的 groupId 仍不可修改（`INTEGRATION_GROUP_IMMUTABLE`）；普通成员迁组
也不会迁移 IntegrationSession 的归属、旧消息/reply、事件或 ACK 游标。此入口不提供
旧 Case/原会话迁移。新组独立使用新授权，已有链路保持原归属完成/关闭。

事件订阅协议未改变：新 consumer 从该组保留窗口最早可见位置开始，并非“从现在”
开始；读取不自动 ACK。当前没有公开 ready/subscribed 帧，进程启动不能当订阅完成。
即使普通 send 早于实际订阅建立，保留期内的事实也可重放；宿主按 event_id 持久
去重/连续 ACK，并按原 message ID/reply_to 用历史对账明确回复。heartbeat 仅是连接
观测，不表示宿主 inbox 已落盘或业务已完成。

## 1.4.319：管理员查询与改名本机组

最低 **CLI / 实际服务均为 1.4.319**，协议仍为 1。回读
`admin_local_group_rename=true`、`admin_local_group_rename_min_version=1.4.319`；
该能力同时覆盖精确查询、改名及管理员列表的 `updatedAt` 回读。旧服务缺少能力时
CLI 返回 `ADMIN_LOCAL_GROUP_RENAME_UNSUPPORTED`，不回退到成员身份、网页接口或私有文件。

```sh
td integration group get <精确group-id>
# {"group":{"id":"...","name":"原名称","updatedAt":1790000000000}}
td integration group rename <精确group-id> --name '短标题' \
  --expected-updated-at 1790000000000 --idempotency-key stable-group-rename-key
td integration groups   # 列表保留id/name，追加updatedAt
```

沿用本机 Unix socket 管理员鉴权，无终端来源、无新 principal 权限。管理路由：
`GET /admin/groups/:id`；`POST /admin/groups/:id/rename`，只接受
`{name,expected_updated_at,idempotency_key}`。不接受成员、角色、principal、指定新ID、
federated 或启动配置。组 ID 必须精确匹配，不解析前缀/名称；仅存活本机组可用。
GET 返回最小显示元数据 `{id,name,updatedAt}`，不导出启动配置、成员创建请求或凭据。

名称与空组创建复用校验：首尾 trim、非空、最多 256 字符，禁止
`【】「」`、`·`、C0 控制字符及 DEL。key 非空、最多 256 字符，按原字符串区分并只存
哈希。改名 key 在同一管理员服务的 **rename 操作范围**共享，与 create key 独立；
建议使用稳定业务前缀。`expected_updated_at` 必须是非负安全整数。

复用现有组 `updatedAt` 作为并发版本。实际改名严格递增，只有名称相同时是持久记录的
no-op，不推进版本。网页或成员/配置变更也可能推进组版本；新请求不匹配当前值返回
`GROUP_CHANGED`（409）及 `currentUpdatedAt`，没有改动或成功回执。宿主重新 get、确认
当前内容后，再用新版本和新 key 作新的决定；不要静默覆盖刚发生的改动。

返回两个独立快照，均只有 `{id,name,updatedAt}`：

```json
{
  "group": {"id":"...","name":"当前名称","updatedAt":1790000000002},
  "applied": {"id":"...","name":"原操作改成的名称","updatedAt":1790000000001},
  "replayed": true
}
```

首次成功 `replayed=false`，`group` 与 `applied` 相同；同 key、同精确组ID、同规范化名称、
同原期望版本重试，`replayed=true`，返回原 `applied` 和 **当前** `group`。以后另有网页或
管理员改名，旧键回读不重新执行，不撤销后来的名称/版本。原参数任意改变返回
`IDEMPOTENCY_CONFLICT`（409）。原 create 的空组创建快照不变，也不因此创建新组。
回执丢失或 fsync 失败时保留原全部参数/key 重试，不换 key 掩盖不确定结果。

名称/版本与幂等回执在同一个协作存储中 durable 原子提交，包含文件及父目录 fsync。
替换前失败回滚；替换后 fsync 失败可能已改名，但不能宣称成功。同键重试再次 durable
提交当前存储以确认结果，持续失败仍返回错误；不会第二次推进版本。重启保留原回执。
rename journal 完整性不明返回 `GROUP_RENAME_STATE_UNCONFIRMED`，普通写入/全局清理不
解除该阻断。最多保留 2,000 条 rename 回执（删除目标的 key 也保留）；达到上限新 key
返回 `GROUP_RENAME_LIMIT`，已有 key 可回读。没有 TTL/forget；调用者管理保留预算。
保证范围仍是同持久存储唯一服务写入，不提供多进程共享文件事务，也不保证旧写入器
降级后能保留新 journal。

新请求目标不存在/删除返回 `GROUP_NOT_FOUND`（404），跨服务组 `GROUP_NOT_LOCAL`
（409）；已有成功 key 的目标删除/变跨服务后重试 `GROUP_RENAME_TARGET_UNAVAILABLE`
（409），不复活或新建替代。非法精确 ID `INVALID_GROUP_ID`，非法名称 `INVALID_GROUP`，
非法版本 `INVALID_GROUP_VERSION`，非法 key `INVALID_IDEMPOTENCY_KEY`，多余/错误请求参数
`INVALID_GROUP_RENAME_REQUEST`（以上 400）。当前组版本无法可靠读取/递增时
`GROUP_STATE_UNCONFIRMED`（409）。存储 IO 失败为 `INTEGRATION_INTERNAL_ERROR`（500），
不是成功回执；沿原键对账。

只修改 `name/updatedAt`；保留组 ID、成员/角色/配置、principal 归属及凭据、
TD/native session ID、消息/reply、事件/consumer 历史。没有 Agent 启动/恢复/终端写入、
迁组或业务 Case/裁判逻辑。网页组列表与管理员入口读同一个 store，名称通过现有侧栏
刷新（定时约 10 秒及焦点刷新）显示，不承诺瞬时推送，也不把名称更新当 Agent 状态。

验收包含真实临时文件原子替换、file/dir fsync 失败和同键恢复、重启、旧快照回读、
并发不同键竞争/同键重放、删除/跨服务、管理员 Unix 路由/CLI 权限及 JSON、网页列表
回读和旧网页表单版本冲突。DevBox 业务组及真实 macOS/iOS 显示尚待接入方实机验收，
不以源码/模拟回归代替其运行现场。

## 1.4.321：普通协作会话的承载变化、阻断诊断与恢复

最低 CLI/实际服务均为 **1.4.321**；普通协作协议仍为 2，integration protocol 仍为 1。
当前 CLI 版本不能替代实际服务版本；普通成员使用
`td collab --session <自身ID> capabilities --json` 回读 `server_version`、
`route_diagnostics=true`、`route_identity_recovery=true`、
`route_identity_recovery_min_version=1.4.321`。

```sh
td collab --session <自身ID> route get <精确本地目标ID> --json
td collab --session <自身ID> message get <原消息ID> --receipt-only --json
# 只有目标拥有者在自己的真实终端确认“当前承载就是目标”后执行：
td collab --session <目标自身ID> rebind --pane <当前pane-ID> --json
```

`route get` 为只读 `GET /operations/orchestration/route/:id`，只允许自身或共享组的本地
成员；不解析前缀/名称，不替远端拥有者查询其当前进程。旧服务缺能力时 CLI 明确拒绝。
返回 `route.session_id/binding/worker/observed_at/state/error/identity`：worker 包括
`started/tick_in_progress/recipient_in_progress/last_tick_at/route/pending_count`；identity
包括原 `expected`、当前 `observed`（最多 20 项、`truncated`）、`recovery/reason` 和
拥有者正式 `rebind_command`。只导出承载标识、Agent 类型及原生身份证据元数据，
没有终端正文、argv、环境或凭据。证据未知即未知，不使用旧缓存 UUID 替代当前身份。
只读查询不启动/恢复 Agent、改绑或补键，不把进程/身份正确称为输入已就绪。

已绑定的 tmux server/session/pane/PID 变化时，原物理身份保护仍拒绝直接写入。
消息维持 `status=pending`，诊断会给 `delivery.stage=blocked`、`error=TMUX_PANE_CHANGED`、
`route_state`、`requires_confirmation` 及 `route` 差异/建议；`attempt_count=0` 表示尚未
尝试写入，不等于失败后可重发。现有 `message.delivery` 主动事件携带该 receipt；
网页协作记录也展示绑定变化和投递暂停，保留原正文。跨服务交换在状态不变但错误变化
时仍同步错误，不因 pending 状态相同而隐去新的阻断。运行服务未采集过的历史差异
不能由新版本凭空补出；`worker.started` 等字段用于确认当前调度事实。

本地/远端目标依据稳定 `remote:` 地址区分，组是否 federated 不影响组内本地消息进入
本地 worker。后台 worker 在会话登记加载完成后启动，不等待额外 PTY adoption 或
tmux 元数据 backfill；订阅消息存储变化并保留定时重试。缺绑定/进程/权限时仍保留原
消息，诊断拒绝原因，不依赖网页维持投递。此加固不能替代旧现场的运行证据，也不能
从过去缺少 transport 条目推断唯一内部根因。

承载变化后的**自动**更新仅用于普通 tmux 会话，并同时要求：原生 ID/Agent 类型已知，
当前可信 provider 独立核验同一原生 ID、同一 Agent，唯一匹配且原逻辑记录/后端/pane
归属无冲突，没有原待投递消息的未确认写入尝试。对账前再次核验当前候选和登记，
首次继续写入前再次核验当前原生身份。只改绑定，不启动/恢复/切换原生 Agent。
当前独立证据 provider 是已配置的 Linux flock-owner 核验；核心不按 Agent 名称或
TUI 展示字符串分支。argv 的 resume ID 只能作为启动意图元数据，单独不满足自动更新。
因此没有可靠 provider 的 Mac 冷启动 Codex 等场景需要明确拥有者确认，不能宣称跨
平台自动身份恢复已通过。独立证据的能力/适用平台由 provider 决定。

原生身份缺失/不同、多匹配、归属不明或此前写入结果不明时，保留原消息并显示
`confirmation-required` 及对应原因（`NATIVE_IDENTITY_UNCONFIRMED`、
`MULTIPLE_NATIVE_IDENTITY_MATCHES`、`ROUTE_OWNERSHIP_UNCONFIRMED`、
`DELIVERY_OUTCOME_UNCONFIRMED`）。拥有者确认当前承载后可用现有 rebind 明确接受当前
Agent/原生身份；这不是承诺精确恢复旧原生历史，也不要求猜 UUID 或编辑私有记录。
无运行 tmux 的情况须先通过原会话恢复入口恢复承载，不能靠 rebind 新建。

重新绑定与投递按该逻辑成员的 worker 屏障串行，持久保存 `routeRevision` 和
`lastRecovery={kind,at,previousPane}`，后者只记录最近一次自动/显式绑定恢复。
绑定以 routing 文件原子替换提交；失败不采用新绑定。输入队列同时核验 routeRevision，
旧队列不能在新绑定上继续粘贴/提交。待处理消息已经记录尝试（`attempt_count>0`）而结果
未确认时，显式 rebind 返回 `ROUTE_DELIVERY_OUTCOME_UNCONFIRMED`，先对账，不能借修复
重发正文。记录不承诺永久审计或跨掉电的恰好一次输入；原终端传输的写入语义/保留
边界不变。

`IntegrationSession` 不通过普通 rebind 绕过其代次/精确 UUID/配置与所有者保护，须继续
用受限 principal 的 `session get/restore`；普通 rebind 对此返回
`INTEGRATION_SESSION_RESTORE_REQUIRED`。当前修复不改变业务任务、principal、组、
message/thread/幂等键或历史，不自动补 Enter、不用屏幕文字识别消费；delivered 仍只
表示终端写入，完成须明确回复。

回归覆盖同组本地消息处于 federated 组、存储变化唤醒/后台阻断、修复后原消息单次
投递、不同/缺失/弱原生证据、多匹配/归属/未知旧写入拒绝、绑定持久化和失败、
只读路由权限/CLI、网页暂停提示及加密传输边界。Mac 实际现场的当前原生身份尚未独立确认，原消息尚待拥有者确认及接入方实际服务
升级/回读后继续投递；不以维护机回归冒充该现场已恢复。


## 1.4.322：启动代次一致性与输入检查诊断

最低实际服务 **1.4.322**，配套 CLI 也升级至 1.4.322。`capabilities` 回读：
`agent_launch_generation_consistency=true`、
`agent_launch_generation_consistency_min_version=1.4.322`、
`terminal_input_check_diagnostics=true`。普通协作协议仍为 2，integration protocol 仍为 1；
不新增权限。只更新 CLI 不会改变正在运行的旧服务。

启动代次是 TD 服务生成的 `agentLaunchGeneration`，与原生 Agent UUID、
IntegrationSession 的数值 `generation` 分别记录。同一 backend 在启动准备时从 null
变为新的启动 UUID 是正常动作。名称、cwd、原生身份元数据等整记录更新过去可能
携带 await 之前的旧启动字段写回；本版将启动字段交由专门的比较后更新路径管理，
普通元数据更新继承当前启动代次与一次性检查，不能覆盖或复活旧值。

启动操作在写入本次代次后、持久化之前捕获自己的输入检查令牌，并在持久化返回、
承载解析、获取输入队列及粘贴/提交前持续使用它。冷启动、精确恢复、显式 cold retry
和普通启动共用这条保护；不会为了继续输入而采纳后来出现的启动代次。启动状态
落盘失败时不输入。真实 backend 对象/ID、绑定版本、tmux pane 或启动代次变化仍拒绝，
保留 `TERMINAL_INPUT_TARGET_CHANGED` / `TMUX_PANE_CHANGED` 等错误。

管理员沿现有入口读取已保存的诊断：

```sh
td integration diagnostics <TD-session-id>
```

`launch_diagnostics.steps` 追加可选阶段 `guard_captured / runtime_resolving / runtime_resolved`；
既有 `queue_wait / queue_acquired / paste_* / submit_*` 保留。拒绝时
`target_change` 可含 `check_phase / guard_captured_at / checked_at`，以及
`expected_launch_id / current_launch_id`、backend ID/实例比较、绑定版本比较。
`check_phase` 包含 `launch_state_commit / guard_capture / launch_persisted / runtime_resolve /
runtime_resolved / queue_acquired / before_paste / before_submit`。时间是 TD 检查时间，
不是内核首字节写入时间；不包含正文、argv、环境或凭据。旧记录不补造缺失的证据。

这次修复不增加自动重试：原 create 同键只回读原操作。失败现场保留，先用
`session get` 核对当前事实；明确授权后才按现有 `session retry-cold` 契约显式操作，
必须满足无原生 UUID、无 TD 消息历史或待投递、精确原 shell、配置指纹与代次等条件。
已有原生 UUID 的会话继续精确 restore，不能以 cold retry 替代。消息正文不因升级重发。

升级由现场唯一维护者协调：保留现有 HTTPS/鉴权参数，仅替换并重启 TD 服务；
核对在跑 tmux/Agent 完整身份没有变化，再回读实际服务版本和以上能力。
本版不要求重启、重建或重试业务 Agent，不更改 launch profile、sandbox 或业务调度。
终端动作仍是粘贴一次、50ms 后发送一次回车；TD 仍不保证应用提交、消费或执行完成。

确定性交错回归覆盖延迟改名/元数据回写、清除检查、持久化等待、输入队列等待、
真实第二次启动、backend 替换及重新绑定；发生真实换代时，旧输入及旧的延迟回车
仍被拒绝。测试证明 TD 一致性与终端写入边界，不代替私有 Agent 的实机消费验收。

## 1.4.323：归档与恢复本机协作组显示

最低 **CLI / 实际服务均为 1.4.323**，回读
`admin_local_group_archive=true`、`admin_local_group_archive_min_version=1.4.323`。
本机管理员可归档/恢复精确本机组；CLI 与服务均检查能力，旧服务返回
`ADMIN_LOCAL_GROUP_ARCHIVE_UNSUPPORTED`。

```sh
td integration group get <精确group-id>
td integration group archive <精确group-id> \
  --expected-updated-at <当前updatedAt> --idempotency-key case-archive:v1
td integration groups                         # 默认不列出归档组
td integration groups --include-archived       # 显式查看
td integration group unarchive <精确group-id> \
  --expected-updated-at <当前updatedAt> --idempotency-key case-restore:v1
```

`group get` 对归档组仍可用，并在归档时返回 `archivedAt`。归档/恢复仅修改
`archivedAt` 与组的 `updatedAt`，不改 `id`、名称、成员/角色、principal 固定组、
TD/native session、运行承载、消息/reply、consumer 游标或历史；不关闭、释放、恢复
会话，不停止业务调度，也不重放消息。Web 侧栏默认隐藏归档组，在“已归档协作组”
中可查看并恢复显示；恢复组显示不会重启已关闭的 session。

管理路由为 `POST /admin/groups/:id/archive` 与 `POST /admin/groups/:id/unarchive`，
请求仅接受 `{expected_updated_at,idempotency_key}`。`GET /admin/groups` 默认隐藏归档
组，传 `?include_archived=true` 显示归档组。归档/恢复 key 在同一操作范围内唯一，
参数改变返回 `IDEMPOTENCY_CONFLICT`。成功回执分开返回当前 `group`、本次提交的
`applied` 和 `replayed`；旧回执重放不会覆盖后来版本。并发版本过期返回
`GROUP_CHANGED` 与 `currentUpdatedAt`，应先重新 get，再由调用者决定是否用新 key
重试。同状态操作保留原 `archivedAt` 并记录幂等回执，不推进组版本。

归档 journal 与组状态原子持久化，保留上限为 2000 条。状态/journal 不完整时返回
`GROUP_ARCHIVE_STATE_UNCONFIRMED`，不会猜测或重建。只允许本机非 federated、未删除
组；删除组、跨服务组和不确定的目标分别返回 `GROUP_NOT_FOUND`、`GROUP_NOT_LOCAL`、
`GROUP_ARCHIVE_TARGET_UNAVAILABLE`。归档不延长消息历史保留期。

## 1.4.328：IntegrationSession 对账 tmux recovery 的新承载

最低 CLI / 实际服务 **1.4.328**，能力回读字段为
`session_recovery_binding_reconcile=true` 与
`session_recovery_binding_reconcile_min_version=1.4.328`。该自动对账目前只在 Linux
提供；其它平台返回 capability=false，因为没有同等的当前 writer-lock 身份证明。

所属 principal 调用现有 `session get` 时，如果 IntegrationSession 因
`SESSION_IDENTITY_MISMATCH` 指向旧 pane，而 TD 持久恢复 operation 已成功恢复该逻辑
session，服务会尝试受限对账。它要求当前唯一受管终端名严格为
`wt-integration-<session_id>`，IntegrationSession 与有效 principal/group 的持久归属唯一，
当前组和全局终端记录唯一，只有一个 tmux pane/backend，且该前台 Agent 的当前 Linux
flock-owner 身份独立核验出原 agent slug 与原生 UUID。目标元组会连续采样确认未变，
并在现有投递 worker 屏障内更新绑定。

成功后保留逻辑 `session_id`、group、principal、原生 UUID、消息与历史，只更新
`terminal_binding`、状态和 `generation`，并在 `binding_reconciliation` 记录旧绑定及
对应 `recovery_operation_id`。不会启动或恢复第二个 Agent，也不创建 task、发送正文或
重放已写入的消息。此前写入结果不明时不会自动改绑；已写入的消息保持原 receipt，
尚未写入的 pending 消息由原 worker 继续处理。

任一 owner 缺失/重复、tmux 名或 pane 不唯一、native UUID 不同、writer-lock 不可核验、
没有该 session 成功的恢复 operation，或绑定在双重采样间再次变化时，服务保持
fail-closed，旧绑定与原消息保留，`session get` 仍报告身份错误；不会按 tmux 名称、PID
缓存、cwd、argv 中的 resume 参数或显示名猜测认领。此 capability 不新增权限；仅通过
`session.read` 认证的所属 principal 可触发其自身记录的对账。

## 1.4.346：启动磁盘重载、原 shell 核验与独立原生目录

最低 CLI / 实际服务均为 **1.4.346**。通过所属 principal 的 `capabilities` 回读：

- `session_launch_reload_fence=true`：服务运行期间的磁盘重载保留当前服务生成的 launch token、已解除的一次性 check 和显式原生目录。读取期间新增的会话不会消失，已删除的会话不会由旧读盘复活；全局状态写入串行，并在执行写入时采集当前快照。服务首次启动仍加载磁盘记录。这修复了磁盘 watch 路径绕过元数据 upsert 保护的缺口，不把每一例历史 `TERMINAL_INPUT_TARGET_CHANGED` 都归因为此。
- `session_shell_startup_wait=true`：启动前先记录唯一原 pane 身份，再最多等待 5 秒核实该 shell 的前台关系和合格 shell 参数。只观察同一 tmux server/session/pane/PID，采样使用新鲜进程证据；承载改变、pane 不唯一或已有 Agent 时拒绝。不输入探针、不清理画面、不重建承载、不发送额外回车，也不把 shell 核验当成应用 input-ready。
- `session_profile_native_identity=true`：当前仅 Linux 支持 profile 级只读 writer-lock 目录，覆盖该受管会话的插件缺省目录，不改变共享插件配置。三个字段分别有同名 `_min_version` 字段，值为 `1.4.346`。能力支持不等于 principal 已被授予权限。

本机管理员可在现有完整 policy 的目标 `launchProfiles` 中加：

```json
"nativeIdentity": {
  "kind": "linux-flock-owner",
  "directory": "{cwd}/.agent-home/cli/thread-writer-locks"
}
```

目录是示例，必须按实际 Agent 的持锁协议填写。支持管理员指定的绝对目录、`~/` 目录，以及仅以前缀 `{cwd}/` 锚定的模板；模板不允许 `..` 或其它变量，解析后的目录须在 TD 服务用户 home 内。调用现有 `td integration update --file <完整policy.json>`，不增加权限、不重建 principal 或凭据。CLI 在旧服务/非 Linux 服务上拒绝该配置，不能静默忽略。原有不配置此项的 profile 保持插件缺省行为。

wrapper 负责实际设置 Agent 自己的数据目录、准备 hooks/参数，并最终运行真正的 Agent；这个字段只声明 TD 的核验目录，不设置环境、不执行脚本、不创建目录，不自动读取 `TRAECLI_HOME` 等私有变量。TD 仍检查目录与文件权限、进程 starttime、前台关系、实际 FD/inode 和当前内核 flock，要求唯一 native UUID。显式 profile 目录不可证明时不降级到 argv/hook/旧 UUID，多个持锁 UUID 仍拒绝。目录语义纳入恢复配置指纹，保存至启动代次；服务重启、metadata 更新、check 解除不会丢失它。

该配置只用于之后创建的 session；旧 session 保留原 profile 快照，policy update 不迁移旧记录或修改运行 Agent。不要为旧未知结果自动 create 新 ID 或 retry-cold。原 UUID 恢复、重复 owner 保护、关闭仍遵守现有身份/代次/幂等门禁；独立数据目录不构成对同 UID 进程的安全隔离。

启动失败管理员用 `td integration diagnostics <原TD-ID>` 回读；shell 等待失败新增 `shell_check={samples,waited_ms,reason,binding,pgid,tpgid}`，不包含 argv/env/终端正文。`SESSION_TARGET_NOT_SHELL` 表示有限核验未通过，不表示 wrapper 已执行；`paste/submit=not_attempted` 与后续 `runtime_present` 现场回读分开保存。失败不自动再次启动，只有符合原 `session retry-cold` 所有条件才可明确重试。

用 stdin 文件给启动命令附带业务 prompt 是接入方的 bootstrap：TD 不为其中业务副作用提供消息幂等或执行确认；无 TD message 历史也不等于没有业务执行。冷启动与精确 resume 应分开处理，恢复时不得重放初始业务文件。host 收取 final/hook receipt 是 host 侧证据，不伪造成 TD 明确 reply。仍只粘贴一次、等待 50ms、写一次 CR。

回归包含确定性交错的旧读盘覆盖/串行写入/删除不复活、同 pane shell 初始化等待与超时/换 pane/已有 Agent 拒绝、CLI 对旧服务拒绝，以及 Linux 真实 tmux/内核 flock 的独立目录核验。私有 TraeX/DevBox 的启动兼容仍需接入方维护窗实机验证；维护机合成测试不冒充该项通过。

## 1.4.347：无变化同步与后台观察的开销

这是服务运行时优化，不增加接口、权限或配置。需要更新实际运行服务到 **1.4.347**；仅安装新 CLI 不会更新已运行进程。

- 跨服务目录重复合并相同群内容时不写盘、不通知事件同步。比较包含内容而非仅时间戳；同时间戳的真实变化仍处理。合并独立群规/角色版本后如有效内容未变也不写盘；有效群更新与保留的新上下文一次持久化。
- 空事件追加及 source/version 全重复的追加在克隆事件历史之前返回。真实更新继续持久提交，失败保留可重试源版本，不改变事件 ID、顺序、ACK 或保留策略。
- 事件同步按消息、任务、会话三个变化来源分别扫描；会话通知不再复制消息历史和生成全部消息回执。新授权组及服务重启仍对保留事实完整对账；失败来源继续重试。消息变化时一次建立回复索引，避免每条回执重扫历史；回执仍核验双方身份，并省去事件中不包含的终端快照格式化。这是按来源增量同步，真实变化仍会扫描该来源的保留记录。
- 终端输出触发的后台会话观察按 250ms 窗口合并；一轮观察期间的新通知安排到后续一轮，不连续抢占。显式 `session get`、生命周期操作及投递前核验保留原路径，不以此窗口判断 Agent 可输入；不延迟业务输入来猜测应用状态。同一次 integration 观察复用其新鲜 tmux layout，下一次观察重新读取，不把缓存用作身份写入凭据。

无删除消息/事件、缩短历史、停用消费者、额外 Enter 或正文重发。`pty_written` 仍只代表终端写入调用完成，不代表应用提交或任务完成。回归包含约 26 MB journal 的空/重复追加零克隆、相同群同步零写入、真实变化/持久化失败重试、授权后历史补收、通知洪峰合并、换 pane/原生身份冲突拒绝。生产 CPU、事件循环延迟和 health 改善须在实际维护窗升级后对比采样，不能用隔离基准代替实机验收。

## 1.4.348：真实提交、事件推送与 tmux 查询

本轮透明性能优化不改变现有接口、JSON journal 格式、保留策略、权限、消息/ACK 语义或默认交互。实际运行服务需升级到 **1.4.348**；不是仅替换 CLI 文件。性能修复无新增权限或配置。

- 真实事件/ACK/授权变更采用 copy-on-write，仅复制发生变化的容器与新事件，不再深拷贝整个 journal。内部已提交事实由 store 独占且不修改，公共 page/policy 返回独立副本；调用者修改输入或返回值不影响历史或编码缓存。
- 未变化事件与元数据复用 UTF-8 编码，按有界向量写入临时文件，不再为大小检查和落盘重复生成全库 JSON，也避免临时巨型 UTF-16 字符串。64 MiB 上限检查覆盖实际待写全部字节。短写、Unicode 字节边界与 EINTR 均保留位置；文件 fsync → 原子 rename → 目录 fsync 后才发布提交结果。中途失败不推进内存 source/consumer 状态，不向订阅者报告成功；重试仍沿原来源/游标。
- 同 cursor 重复 ACK 在权限、consumer、cursor、rewind、retention 检查后 no-op；HTTP 的已发送连续前缀检查仍先执行。此前已持久确认的进度不再次克隆/写盘/fsync，不能借相等游标绕过撤权或保留缺口。重复 revoke 也不重写未变化状态。
- 事件按组建引用索引，并按 sequence 二分定位 page；仅公开 page 复制最多 100 条返回事实。主动推送复用已编码事实，不为每个 consumer 重复制/重编码历史 payload，保留原 NDJSON 字段、顺序、背压、授权复核及断线重放边界。
- 新鲜 session layout 由一次只读 `list-panes -s` 获取 server/session/window/pane 元数据；常见单窗口的 integration 观察从 5 次 tmux 命令降到 1 次，另行原生进程/锁核验保持。侧栏原有多会话 layout 缓存的数据获取也由 3 次全局查询改为 1 次；缓存仍只服务原有发现用途。没有启用持久 attach/control client，不新增 client、改尺寸、焦点、copy-mode 或发送输入。
- 同轮已关闭/释放且已确认零承载的后台存在性观察用一次新鲜会话名查询合并。结果仅用于该轮、且 descriptor 完整快照不变时才复用；批量查询失败、记录改变、操作不确定或进行中的生命周期走原逐项核验。显式 get、close/release/restore、实际投递前身份核验不使用该后台结果。

仍是兼容的全量 JSON 快照落盘：真实提交的物理写入量和同步 fsync 等待未变为增量日志或异步存储，慢磁盘仍可能阻塞。不能把隔离基准解释为所有 HTTPS 长尾已解决。服务重启会重建内存索引/编码缓存，首次提交需编码保留事实；不会删除历史换取速度，也不会暂停业务消费者。

回归覆盖重复 ACK 零克隆/编码/写入、真实持久提交与中途写入/fsync 失败后重试、短写与 Unicode、64 MiB 精确字节上限、输入/输出不可修改历史、分页/保留缺口/撤权、推送事实等价，以及隔离真实 tmux 的多窗口/分屏/激活 pane/copy-mode 与 client/PID/尺寸不变。Linux 维护机验证不代替 macOS 实机或私有 Agent 的业务验收。生产升级须与共享服务的在途任务和维护窗协调，不能因为收到版本通知就自动重启别人的实验。

同时修复独立 profile 目录的 home 别名误拒：当逻辑 home 指向真实 home，规范化 cwd 下的 `{cwd}` 路径可匹配逻辑 home 或 `realpath(home)` 的严格子目录；不会将同名前缀兄弟目录视为 home，不创建尚不存在的锁目录。实际 provider 继续核验 canonicalHome、目录权限、精确进程实例、FD/inode 和内核持锁关系。Linux capabilities 新增 `session_profile_native_identity_home_aliases=true` 及 `session_profile_native_identity_home_aliases_min_version="1.4.348"`。旧 profile 快照不迁移，不自动 retry/create；347 的 `~/` 每 job 精确路径声明仍可沿原契约使用，更新同一 profile 与捕获快照需要由接入方串行协调。

## 1.4.349：活动终端登记缺失时的受限关闭与只读诊断

问题是三个不同的事实层可能不一致：持久 IntegrationSession 仍有原 native UUID 与完整 pane 绑定，tmux/Agent 仍存在，但全局活动终端登记已经缺失。348 的 close 先依赖该登记，因而在真实身份核验之前拒绝；inspect 也可能将登记缺失表现为 `AGENT_NOT_RUNNING`。349 对仍存在 tmux 的缺登记观察改报 `SESSION_TERMINAL_REGISTRATION_MISSING`，不据此推断程序退出。这不解释或修复所有登记丢失的起因，也不自动重建 UI 记录、恢复会话或认领未知进程。

最低 CLI / 实际服务 **1.4.349**，管理员和所属 principal capabilities：

- `session_close_diagnostics=true`、`session_close_diagnostics_min_version="1.4.349"`。
- Linux 上 `session_close_detached_registration=true`、`session_close_detached_registration_min_version="1.4.349"`；其它平台 false。没有新增 principal 权限，关闭仍需原 `session.close`，诊断仅管理员。

管理员正式只读入口：

```sh
td integration close-diagnostics <原TD-session-id>
```

走原本机管理员 Unix socket，`GET /admin/sessions/:id/close-diagnostics`，返回：

```json
{
  "session_id": "原逻辑ID",
  "operation_id": "当前operation",
  "generation": 2,
  "close_diagnostics": {
    "checked_at": 1790000000000,
    "terminal_registration_present": false,
    "binding_present": true,
    "runtime_present": true,
    "pending_messages": 0,
    "target_confirmed": true,
    "code": null,
    "target": {
      "binding": {"serverPid": 101, "sessionId": "$2", "paneId": "%2", "panePid": 102, "agentSlug": "已登记Agent", "nativeSessionId": "原UUID"},
      "tmux_server_start_id": "linux:1000",
      "kind": "agent",
      "process_pid": 103,
      "process_start_id": "linux:1001",
      "native_id": "原UUID"
    }
  }
}
```

这是字段示例，不代表某一现场已核验。诊断不调用 session get/refresh、不改变 descriptor/代次/路由/组，不启动或终止进程、不输入按键。`target` 只包含原 pane、当前进程实例和已证明 UUID，不读/返回 argv、环境或终端正文。记录在异步观察期间变化时丢弃 target，返回 `SESSION_CLOSE_TARGET_CHANGED`。`target_confirmed` 只表示本次目标核验通过，不等于后续关闭授权/成功；pending、进行中生命周期、当前代次等仍由真正 close 独立检查。观察失败保留 `target=null` 和准确 code；无法观察运行存在性时为 null，不假装已消失。已有 `td integration diagnostics` 仍只读原 launch/restore 持久诊断。

缺活动登记时，现有显式 `session close` 只在以下证据全部满足后工作：

1. 全机持久 IntegrationSession 只有一个 descriptor 声明该 session/principal/组；principal 未撤销且归属唯一；当前本机组仍存在且该成员只归属此组。组的 archived 显示元数据不影响此核验；缺组、跨服务组、重复/跨组归属拒绝。
2. 无其它全局终端声明该逻辑 ID 或保留 tmux 名，无重复 backend、其它逻辑 owner 或冲突 route/pane owner；routing 不可读也拒绝。
3. 保留名精确为 `wt-integration-<原ID>`，实时 server/session/pane/PID 全部等于持久原绑定，只有一个 pane，且未链接到其它 tmux session。不是仅凭名称、cwd、显示名、短 pane ID 或 PID 存在认领。
4. 当前实际前台是原 Agent 类型，当前 Linux `linux-flock-owner` provider 独立证明原 UUID，并核验进程 starttime、FD/inode、权限及 kernel flock。argv/resume UUID、旧缓存或单纯 shell 观察不能给缺登记会话授权关闭；未安装相应只读身份 provider 时继续拒绝，不扩大为任意 Agent 黑盒支持。
5. 沿原生命周期串行、worker 屏障、pending 检查、generation/CAS 和稳定幂等键，先持久化 close intent，再重新核验完整目标与进程实例，使用不可变 tmux session ID 终止一次。失败/重启结果不明沿现有 close 对账，不重复终止。并发外部 tmux 操作仍有系统级竞争边界，连续核验不能宣称绝对原子。

无活动登记不再单独阻止已充分证明的目标关闭；未提供 force/裸 UUID/按名清理入口。没有补建 active terminal、backend 或网页客户端，没有修改旧 profile/启动配置、投递正文、重放消息或重新打开归档组。`closed` 仍保留逻辑记录、诊断、消息、工作目录和原生历史并拒绝 send/reply/restore；不是 release。

现场接入先升级并核验 **实际服务** 两项 capability，再对原 ID 运行管理员 close-diagnostics。确认归属与 `target_confirmed` 后，由原 principal 正式 get 读当前 generation；若仍与原请求一致，沿原 generation/原 key 重试原 close。若 generation 已改变，先对账原请求，不擅自换 key；无历史 intent 的新关闭需据新代次明确生成新操作键。最终 get 必须确认 `closed/runtime_present=false/terminal_binding=null/close_pending=false`，并核对旧 pane/进程确已消失；诊断通过或 API 请求成功本身不代替回收验证。

错误包括 `SESSION_CLOSE_OWNERSHIP_UNCONFIRMED`（持久 owner/本机组不唯一或缺失）、`SESSION_IDENTITY_MISMATCH`（其它声明或实际 native 冲突）、`SESSION_CLOSE_TARGET_UNCONFIRMED`（原绑定/实时 writer-lock/前台实例不足）、`SESSION_CLOSE_TARGET_CHANGED`、`SESSION_PENDING_MESSAGES` 及原有代次/权限/生命周期错误。管理员报告不能越过这些检查。

回归包含唯一及重复/撤销/跨组/跨服务归属、缺登记精确关闭、argv-only/错误 UUID/换 pane/换进程拒绝、缺登记准确错误、诊断无副作用及代次变化丢弃、Unix 管理权限与 CLI capability 门控、原关闭意图/幂等/重启和失败 shell 兼容；隔离真实 tmux 验证只终止精确目标并保留邻接会话。该 tmux 测试用可控身份夹具，Linux 原生 writer-lock provider 另有真实内核/FD/starttime 回归；私有 TraeX 和上述远端目标仍须由接入方在维护窗实机验收，不以合成测试冒充。

## 1.4.350：通过已连接入口读取中转目录

客户端修复，不增加服务端协议、principal 权限或授权配置。原问题：服务 B 已可经入口 A 打开，但“可中转的服务”列表又只枚举 B 的直接地址建立 WSS；手机无法直达 B 的公司/VPN 地址时，即使原终端通道可用也会显示“暂时连不上中转入口”。这不是 health 可达或服务器协作 serviceConnected 能单独证明的浏览器权限问题。

目录读取与入口操作现在共用受限连接获取：优先借用 `targetPeerId` 精确匹配、未关闭的 active/entry secure client；不关闭借来的原终端通道、不切换 active service/workspace。没有可借通道时，建立自己持有的临时 Noise 通道，允许同 pin 直连备用地址和服务目录中已经保存的 relay 路线。临时通道由本次调用关闭，底层已借入口保持；不借用其它服务身份。

只读连接获取不进行反向路由发现或自动 route-grant，不写服务目录、登录或邀请，不以列表为空/连接失败为由扩大授权、换 pin、使用原生 fetch 或回退 HTTP。目标服务自己的 route-targets 仍按当前设备主体过滤。已撤销、无授权、pin 不匹配和中断错误保留原 name/message；UNKNOWN/UNSUPPORTED 的旧服务提示保留原 cause。相等目标可以经不同地址成功验证，但任何成功通道都必须通过同一目标 pin。

后续 prepareRelayConnection/inspectEntryRoute 也复用同一获取方式，防止目录已能读取而点选时又强制直连。显式授权、撤销和生成邀请沿用该通道获取，但其业务写操作仍只由原用户动作触发，服务端检查保持；目录读取本身不会调用这些动作。没有新增任意多跳协议：保存 routes 是既有替代入口，不被解释为任意有序链；读到 B 的目录不承诺其每个下游目标都可从手机建立新数据路径，实际目标访问仍须逐层可达且有权。

需要更新的是**提供页面资源的入口服务**到 npm **1.4.350**，并让浏览器/PWA 实际加载新 bundle；CLI 文件版本或远端目标已经升级不能修复仍在运行的旧前端。正式包通过 `pinBundledRuntimeClientDist` 为当前运行进程固定页面快照，单独安装新包不会热替换旧进程提供的页面；按原 HTTPS/auth/supervisor 方式在维护窗重启该入口的 TD 服务，再核验资源，不手改快照。实际目标可保持原兼容版本（本轮场景349），无需为了此目录读取重启目标 Agent/DevBox。没有新 capability：这属于页面逻辑修复，以入口 /api/meta 版本与所服务主 JS 字节/手机实际脚本版本核验。已安装旧 SW 的 iPhone PWA 需等待更新后完全关闭重开；不清除配对/设备身份/授权数据作为修复。

回归包含已接入 relay 的 active/entry 复用、点选复核、同 pin 备用地址、无活动通道时既有 relay 临时连接、借用与自有连接清理、不同目标/已关闭通道拒借、权限错误/pin 错误保留、不自动反向授权、不切服务、首次无 Service Worker 与断线不回退边界。另运行完整加密传输、拖放/预览/取消/通知桥接相关现有发布回归。维护机验证不冒充真实 iPhone/macOS 私有网络：正式手机原窗口“工作服务→可中转服务列表→原终端继续可用”仍由现场验收，不操作或重启 Arena。


## 1.4.351：授权恢复与自中转防护

授权与网络失败分开处理。`ConnectionAccessError.code` 只使用固定值：`RELAY_AUTHORIZATION_REQUIRED` 表示认证入口没有给当前设备有效中转授权，`TARGET_AUTHORIZATION_REQUIRED` 表示目标 permissions 没有有效访问授权，`PERMISSION_DENIED` 表示权限范围不足，`TARGET_IDENTITY_MISMATCH` 表示实际身份不匹配，`RELAY_SELF_TARGET` 表示入口被用作自身的中转目标。安全上下文仅含原目标、原入口 pin 与规范化入口 origin，不含 ticket、凭据或正文。没有确证时不显示“已撤销/已过期”；超时、失联和旧版模糊的 `Route unavailable or denied` 不推断成授权失效。

入口 `route-ticket` 的明确权限拒绝会绑定原入口与最终目标。中转 close 帧新增可选稳定 `code`；浏览器在 WebSocket 建连、Noise、已建立通道断开及权限检查路径保留它，不再全部吞成普通连接错误。旧客户端忽略新增字段；新客户端也识别旧入口明确的 `Authorization revoked`，但只显示中性“没有有效中转授权”。旧入口未提供确证的失败继续显示网络问题，不能承诺能精确分类所有旧版错误。没有扩大任意 HTTP/WS 代理或增加多跳。

同一目标会先尝试其它已保存、已有授权的路线；某一入口缺权限不立即阻断其它入口，但目标自身的明确拒绝不能借另一入口绕过。所有候选失败后保留身份/授权原因，暂停该目标自动重试。目标按自己的 pin 绑定，别的服务和工作空间不因此阻断。暂停为当前页面内存状态，重新打开页面会重新核对；不删除服务、路线、原终端或草稿，不重放业务写入。已打开的终端组件保留并在恢复提示期间失去输入焦点，避免隐藏界面继续输入。

恢复界面说明哪一个入口到哪一个目标需要处理，提供“重新授权”或“登录目标服务”、“查看连接设置”和“取消”。取消不写权限，也可以返回恢复选项。中转恢复进入原目标/原入口的专用核对页：打开页只读，入口管理权限不足时仅说明需要该入口管理员或对应备用连接邀请；不会借入口密码自动换取广泛权限。已有管理权限者必须明确点击“授权此设备并重新连接”才调用原有目标限定 route-grant，然后重新读取同一设备的有效中转权限；仅写入成功不足以续连。目标登录使用既有目标登录页，不要求登录错误的入口。最终再读目标 permissions 才续接；晚到的旧页面/旧目标/旧 client 结果拒绝成为恢复成功。身份不匹配及范围不足只提供核对设置/联系管理员，不提供扩大授权的捷径。

自动连接、后台重连、登录预连中的反向路线发现不再隐式 route-grant。发现地址不是授权，管理员权限也不是用户恢复被撤销路线的同意。用户明确点击已有授权/邀请入口时仍沿原契约执行。相关恢复过程不创建 Agent、任务或替代业务会话，不自动补 Enter。

“可中转的服务”按实际握手入口的 `targetPeerId` 过滤同身份候选，并按候选 `serviceId` 去重；不按名称、IP、页面 origin 或 BOOT_SERVICE_ID 推断身份。同名不同身份仍保留，同身份的其它地址仍可作为直连备用地址。prepare/inspect/grant/invitation、历史自入口 intent 以及新连接保存均拒绝自中转，不删除用户历史。服务端保留目录过滤，并在 route-grant/ticket/invite-create 与实际 relay open 再拒绝自己的真实身份。另一个服务发布它自身给本入口的合法 self-relay 保持不变。这个防御不代表已证明某台手机曾收到后端自项。

前端恢复界面和中性错误保留最低为 **1.4.351**。入口服务 1.4.351 支持完整稳定错误码与服务端自目标防护；最终目标服务可保持原兼容版本。本次实际 PWA 页面来自维护 Linux，不能把“工作=Mac”或 npm CLI 文件版本当成静态来源。发布后按原维护流程核对页面主 JS、实际服务版本和当前入口能力；不要为此重启目标 Agent/DevBox/Arena。需要入口新协议时，由入口所有者协调该入口的维护窗；不改运行快照或清 PWA 身份存储。

能力探测：`/api/meta.capabilities` 含 `relay-access-recovery-v1`、`relay-self-target-guard-v1`；`td collab --session <自身ID> capabilities --json` 回读 `relay_authorization_errors=true`、`relay_self_target_guard=true`，两者 `_min_version=1.4.351`。认证 Noise `permissions` 同时返回 `relayAuthorizationErrors` 与 `relaySelfTargetGuard` 布尔。它们只描述此服务端能力，不证明手机已加载新页面或当前设备获授权。

回归包括真实 Noise/中转授权撤回后的错误传播、网络与授权区分、其它合法路线成功、目标拒绝不绕过、零权限写入的展示/取消、窄中转授权明确确认及写后重读、管理员拒绝、精确目标登录、原终端/草稿保留、旧 client/目标/页面晚回执、同身份多地址/重复项/同名不同身份及 self-relay 兼容。发布工作流纳入相关服务管理组件与工作空间测试。原有总路由预算测试曾在未改动 350 基线复现计时器提前触发导致多试备用 provider；本版按原绝对 deadline 重核，不放宽超时预算或修改断言。

维护机浏览器在 390×844 和 1280×800 的隔离夹具复核恢复选择、取消、无管理权限、指定目标登录与成功后的界面；夹具只记录读/写计数、不连接真实业务。真实 iPhone PWA/macOS 的授权失效交互仍由现场在安全夹具或自然失败中验收，不为测试撤销已恢复手机的正式授权。全仓前端 tsc 若被既有测试文件语法阻断应单列，生产源码类型检查、完整构建和发布回归独立报告，不修改无关测试。
