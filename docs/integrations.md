# TD 通用外部接入（协议 1）

拟发布的最低 CLI / 运行服务版本：**termdock 1.4.300**，当前尚未正式发布。
正式发版后，两者都必须升级并重启服务。
现有 `--session`、消息投递、任务报告与自动协作入口继续兼容；旧的
`task create --integration` 仍表示代码集成子任务，新身份使用 `--principal`。

TD 提供受限身份、持久事件推送、关联咨询回复，以及会话创建/精确恢复。
机器人、定时器、外部用户授权、业务幂等键、外部 inbox/outbox、业务校验由接入方实现。
`complete` 是执行成员的明确交付，`accepted` 是用户明确验收；投递成功、终端快照、
事件 ACK 都不表示已读、任务完成或业务校验通过。

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

`launchProfiles` 可为空（只操作已有任务）。创建会话时只能选择预配 profile 和
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

## 任务与权限

| 操作 | 外部身份 | 会话成员 / 用户规则 |
| --- | --- | --- |
| list/get | `task.read`，只读授权组 | 保留现有组权限 |
| create | `task.create`，普通独立任务 | 指定负责人另需 `task.assign`，必须在组内 |
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
| `task.report` | `{event}`：另含明确 reportStatus（ack/working/blocked/complete/failed）、evidence；新 complete 含 artifactId |
| `task.comment/respond/revise` | `{event}`：咨询含 target/deliveryId，答复含 replyToEventId |
| `task.question/answer` | `{event}`；decision 的完整状态从 task get 回读 |
| `task.submit-plan/review/request-review/approve-plan/accepted` | `{event}`：相关 artifactId、target 或 evidence（依实际事件） |
| `task.close/reopen/coordinate/pause/resume/retry/child-update/automation-blocked/review-passed/review-blocked` | `{event}`：保留服务事件的 source 与原文 |
| `task.result` | `{artifact}`：结果 id、attemptId、actor、content、summary、evidence、createdAt |
| `task.delivery` | `{delivery}`：任务投递 id、attemptId、messageId、status、deliveredAt、error |
| `message.queued/message.reply` | `{message_id,thread_id,reply_to,from_session_id,to_session_id,content,metadata}` |
| `message.delivery` | `{receipt}`：实际入队/远端接收/终端写入阶段、失败、重试计数与时间，及明确回复 ID；不含快照或已读字段 |
| `session.starting/binding_pending/ready/restoring/failed` | `{session}`：下节公开会话记录，失败包含 error_code |

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
仅在服务私有持久记录中保存，不通过事件发送。

| state | 精确含义 |
| --- | --- |
| starting | 创建意图已持久化，命令提交尚未证明 Agent / 原生绑定就绪 |
| binding_pending | 实际观察到该 Agent，尚未捕获确切原生 ID |
| ready | 实际观察到该 Agent 和确切原生 ID；不表示任务空闲/完成 |
| restoring | 显式恢复意图持久化，等待原 ID 的运行证据 |
| failed | 启动、绑定、身份核验或运行观察失败，详见 error_code |

同键同请求返回原 TD ID；已记录但结果不明的启动不会自动重新执行。通常等
session 事件；get 也会现场核验。120 秒内未形成绑定返回 `SESSION_BINDING_TIMEOUT`。
服务重启会继续核验待绑定记录。未捕获真实原生 ID，restore 返回
`NATIVE_SESSION_ID_MISSING`，不能伪造 UUID 或选择“最近会话”。

恢复保留原 TD ID、原生 ID、argv/model/cwd/包装器配置。原会话已经精确运行时直接
返回现状；发现其它 ID、未知进程或 pane 被复用则拒绝。原 tmux 已退出时，只有
显式精确恢复可以重建承载终端；这本身不证明 Agent 原生会话恢复成功。新参数/profile
不能覆盖原启动快照，尚未确定结果的恢复拒绝另一次恢复，防止重复 Agent。

常见失败码（每项都是完整字符串）：

- 配置/权限：`LAUNCH_PROFILE_DENIED`, `LAUNCHER_UNAVAILABLE`, `COLLAB_AGENT_UNAVAILABLE`, `SESSION_CWD_MISSING`, `SESSION_CWD_DENIED`, `INTEGRATION_SESSION_NOT_FOUND`, `INTEGRATION_SESSION_LIMIT`。
- 终端/身份：`SESSION_BACKEND_UNAVAILABLE`, `SESSION_TARGET_NOT_SHELL`, `SESSION_IDENTITY_MISMATCH`, `NATIVE_SESSION_ID_MISMATCH`, `NATIVE_SESSION_ID_INVALID`, `NATIVE_SESSION_ID_MISSING`。
- 启动/恢复：`SESSION_CREATE_OUTCOME_UNKNOWN`, `SESSION_OPERATION_IN_PROGRESS`, `SESSION_BINDING_TIMEOUT`, `EXACT_RESUME_UNSUPPORTED`, `NATIVE_SESSION_ALREADY_RUNNING`, `AGENT_NOT_RUNNING`。
- 未分类异常：`SESSION_LAUNCH_FAILED`, `SESSION_OBSERVATION_FAILED`；错误不包含包装器输出、密钥或原始堆栈。

## 验收边界

维护机验证：真实 Unix socket 主动推送/断线重放/撤销、journal 重载与源记录补偿、
权限与幂等隔离、accepted 上咨询/关联答复、修订后的新结果、原 profile 恢复和
实际 shell 参数透传。适配器测试不冒充真实 Agent 的原生会话验收。

维护机未安装 TraeX；**真实 TraeX UUID 捕获及恢复尚待使用方开发机联调**。
使用方升级 CLI 和实际运行服务、回读 capabilities 后，应核对原 TD ID、真实
TraeX UUID 与原 argv/cwd/包装器快照，并验证 Agent 真正加载原对话。
先完成测试环境的创建→追问→关联答复，再验重复键、追加咨询、断线重投和精确恢复。
业务定时器或正式群接入由使用方明确启用，TD 发版不会启用这些业务流程。
