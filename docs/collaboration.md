# 协作消息协议 v2

工作组的协作区与全局 Agent 工作台分开。左侧点击工作组名称打开该组协作区，桌面默认在终端右侧，初始目标宽度约 360px（小屏限制在可用宽度的 45% 以内），手机默认在下方；可拖动分割线调整空间，关闭后从组入口重新打开。侧栏顶部的 Agent 工作台负责创建、管理协作组，以及自动任务、历史搜索和服务连接管理，创建组后直接进入该组协作区。

已打开的协作区会跟随侧栏或组内终端按钮切换到本地组成员，切换组外会话时不会附到无关终端上。协作内容使用稳定的挂载容器，成员切换保留当前任务、问题回答、消息及创建草稿的编辑视图。同名成员按组内顺序标记为 Codex 1、Codex 2 等，并在终端切换、负责人选择和任务记录中使用一致名称；编号用于组内辨识，不修改终端名称。远端终端继续使用现有跨服务打开流程。

组协作区只展示组名、任务和消息页签、成员终端入口及组设置；自动任务、历史搜索和连接管理不在组内显示或加载。任务为空时显示简短说明和创建入口。有任务后显示列表和待处理数，回答问题、审阅当前交付物、要求修改与验收都在协作区完成。窄面板点任务进入详情并可返回，宽面板选中任务后才显示双栏；布局按面板实际宽度决定。新建任务使用独立编辑视图，返回保留本机草稿；组设置也有独立视图。长任务说明、历史交付版本、完整时间线与导出入口折叠展示。

“消息与成员”页保留成员消息、引用、文件插入和成员管理；查看消息时任务待处理数仍更新。展开查看与小浮窗是布局菜单中的可选方式，不承担默认的日常协作路径。

Termdock 跟踪消息传输；Agent 或其他接入方显式报告接手、进展和结果。无需专用 Agent hooks，也不从终端输出、`done`、工具活动推断任务完成。协作协议只交换消息、回执和成员信息，不提供远程文件读取、命令执行或凭据共享。

## CLI 快速使用

### 任务、问题与验收

工作组协作区的「目标与任务」页保存完整任务记录；「消息与成员」保留原有消息入口。任务记录包括目标、约束、完成标准、负责人、协调者、父任务和依赖。`ack / working / blocked / complete / failed` 是成员报告，保留原文和时间，不能推导整个终端会话的忙闲。手动任务和自动协作的最终目标由用户验收对应版本；自动子任务的 `accepted` 来自指定独立评审者对该版本明确报告 `pass`，同时保存 `completionMode=reviewed`，界面显示「独立评审通过」，不会冒充用户验收。

### 自动协作：从目标到最终交付

打开工作组，点击「开始协作 / 新目标」，写目标并选择协调者。其他 Agent 成员作为执行模板；协调者负责拆分和汇总，代码子任务创建独立 Agent 终端，原成员会话保留。默认最多同时分派与执行模板数量相同的子任务，上限 4；这个数量是系统控制的任务额度，不表示观察到了成员空闲。旧任务保留手动分派模式。

1. 服务原子保存目标、协调者分派和发送队列，协调者读取完整目标、组内成员及子任务记录。
2. 协调者创建带负责人和完成标准的子任务；子任务继承目标约束、协调者、评审策略与隔离设置。依赖尚未完成时保留待安排记录，服务在依赖评审通过后接续。
3. `report --status complete` 创建交付版本。代码任务同时由执行服务读取实际 Git 提交，要求独立目录无未提交改动；不代替成员提交代码。
4. 服务为最新交付选择另一位成员评审。`review --verdict pass|changes|blocked` 是明确结论；`changes` 自动交回执行者并等待新版本，`pass` 接续子任务，`blocked` 保留原因。每轮最多自动返工 3 次，之后交给协调者调整方案。旧版本评审不能推动当前分派。
5. 代码目标需要 `--integration` 子任务，依赖全部未关闭的实施任务。服务把已评审提交合入独立集成目录，集成交付通过评审后，协调者才能汇总最终结果。最终结果再次独立评审，用户决定验收或要求修改。

必要问题、方案确认、异常和最终验收集中在侧栏「需要你处理」，点击直接进入对应任务。协调者用 `task coordinate --revision ... --content ...` 保存本次安排；子任务的明确事件会持久化唤起下一次协调。通知之后 15 分钟未收到协调说明时显示事实提示，不推断 Agent 卡死。页面关闭不影响服务端推进。

```sh
td collab task create --group <组ID> --managed --coordinator <协调成员ID> \
  --reviewers <执行模板ID,执行模板ID> --title '目标' --content '完整目标'
# 协调者拆分；依赖可在完成前登记。
td collab task create --group <组ID> --parent <目标ID> --assignee <执行模板ID> \
  --title '子任务' --content '完整要求' --acceptance '交付标准'
td collab task create --group <组ID> --parent <目标ID> --assignee <执行模板ID> \
  --integration --depends-on <实施任务ID,实施任务ID> --title '集成' --content '集成全部交付'
td collab task review <任务ID> --artifact <版本ID> --verdict pass --content '结论及证据'
td collab task coordinate <目标ID> --revision <当前版本> --content '本次安排与下一步'
```

独立 worktree 和执行记录放在 `~/.termdock/task-workspaces`，以目标启动后的已提交 HEAD 固定基线，原目录未提交改动不进入任务目录。成员提交、评审和集成都不自动改写原分支，不自动发布。依赖提交不在执行机器时，通过既有 Noise RPC 分片传递已评审版本的 Git bundle，校验提交、基线、长度与 SHA-256 后导入；每个提交包最多 128 MiB。基线缺失、合并冲突、非 Git 目录、Agent 不可用等均保留具体原因和现场；非代码任务可关闭独立目录选项。仅有会话范围授权的远端不能自动创建新成员，需要完整协作授权或使用现有会话。

「暂停安排」停止后续服务安排，已入队或写入终端的工作仍保留；继续或重试使用最新 revision。关闭目标暂停其子任务自动接续，保留所有终端、分支和工作目录。取消不需要的子任务后，协调者须明确处理依赖和最终交付，不自动清理成员进程或用户文件。

本轮按仓库规则未执行单元、回归、浏览器交互或实机测试；构建与部署健康检查不代表自动协作、跨机器提交接续或桌面/手机动线已经实测验收。

```sh
# 组 ID 可使用唯一前缀；负责人使用完整会话 ID。
td collab task create --group <group-id> --title '改善协作入口' \
  --content '现状、目标与预期交付物' --constraints '遵守项目约束' \
  --acceptance '用户可以找到待回答问题并完成结果验收' \
  --assignee <session-id> --coordinator <coordinator-session-id>

td collab task list --group <group-id> --text
td collab task get <task-id> --text
td collab task report <task-id> --attempt <attempt-id> \
  --status ack --content '确认接手，先梳理现有流程'
td collab task ask <task-id> --attempt <attempt-id> \
  --content '需要优先处理哪一类入口？' --options '["桌面工作台","手机入口"]'
td collab task plan <task-id> --attempt <attempt-id> --file plan.txt
td collab task report <task-id> --attempt <attempt-id> \
  --status complete --file result.txt
td collab task review <task-id> --artifact <artifact-id> --file review.txt
```

用户在工作台回答问题、确认方案、请求独立评审、提出修改要求和验收。选项只填入回答草稿，点击「保存并回复」才提交；回答与后续投递在一个存储事务内保存，客户端关闭后仍由服务端继续投递。修改要求之后须提交新结果才能验收，待回答的问题须先处理。评审绑定明确的方案或结果版本，不能自评；方案确认会通知提交者，但不会替代各 Agent 自己的工具权限审批。

每次分派产生独立 `attempt-id` 与消息线程。成员须使用收到的尝试 ID，不能猜当前分派。改派后的旧问题不可再回答；迟到的报告仍保留在原尝试里，旧结果不会进入新分派的验收入口。关闭任务不会终止终端，也不会撤回已经写入终端的内容。任务关联的用户消息可用 `td collab reply` 回复：明确的状态报告或普通补充会保存到任务，返回 `task_recorded=true / status=stored`，这不是写入另一个终端的回执。普通用户消息仍没有 Agent 回复目标。

用户或当前协调者可以分派、修改要求和归档，回答、方案确认及验收由用户操作。协调者会收到任务上下文和 CLI 使用入口；明确的问题、报告、方案、评审与用户决策也会持久化通知协调者，不依赖对终端输出的猜测。子任务继承父任务的协调者。分派须等依赖任务验收，并提交最新 `revision`：

```sh
td collab task create --group <group-id> --parent <task-id> \
  --title '子任务' --content '独立目标' --assignee <session-id>
td collab task assign <task-id> --assignee <session-id> --revision <revision>
td collab task revise <task-id> --revision <revision> --content '请补充证据'
td collab task close <task-id> --revision <revision> --content '保留历史，结束此任务'
```

任务修改支持 `--idempotency-key`；不提供时 CLI 生成随机键，并在成功结果或失败诊断里返回 `idempotency_key`。网络结果不明确时，应保留同一键与相同内容重试。网页保留未确认请求的键以及本机草稿。列表只传输摘要，选中任务才取完整记录；跨服务后台先对比版本，再拉取变化的任务。

每个任务有唯一来源服务；远端副本可查看，变更送回来源服务保存，来源服务离线时变更明确失败，记录保留。父任务与依赖必须有同一来源；从另一节点创建子任务也送回父任务来源。任务消息沿已配对服务的 Noise 通道发送，并复用本机终端投递队列，不依赖浏览器在线。服务范围和组成员检查仍有效，不增加远程文件读取或通用 HTTP 接口。

任务文件位于 `~/.termdock/collaboration-tasks.json`，按原子替换方式写入，权限为 `0600`。每个服务最多 2000 个任务、总文件 64 MiB，单任务最多 500 KiB、100 轮分派、200 个交付物、1000 条事件；达到上限时拒绝新增记录，保留已有历史。工作台支持复制当前上下文与导出单任务 JSON。删除协作组不会删除任务文件，但该组任务不再出现在原工作区；需要保留可查看的归档时请保留协作组，删除前可导出记录。

在 Termdock 管理的会话中运行 `td collab --help` 查看全部选项，`td collab capabilities` 查看服务实际支持的协议和限制。

```sh
td collab send <session-id> '请检查证据包' \
  --idempotency-key review-2026-09-08 \
  --wait-until delivered --timeout 30s

td collab message get <message-id> --receipt-only
td collab message watch <message-id> --wait-until delivered --timeout 2m

td collab reply <message-id> '收到，开始检查' --response-kind ack
td collab reply <message-id> '检查完成' \
  --task-envelope '{"task_id":"review-1","status":"complete","progress":100,"evidence":["检查报告编号 R1"]}'
```

`send`、`reply`、`handoff` 默认输出 JSON。`--text` 用于人工阅读，`--jsonl` 用于逐行处理；标准输出不混入 ANSI 装饰或日志。文本输出也显示消息 ID、线程和状态。`--file <path>`、`--stdin` 支持较大的正文；`--` 后的参数全部作为正文，避免正文里的 `--json` 等文本被解释为选项。

多个共享工作组之间发送时必须指定 `--group`。`send --thread` 可延续线程，`reply` 自动使用原线程。查询单条消息只允许发送方、接收方；回复只允许接收方。

## 回执和退出码

返回字段包括 `message_id`、`thread_id`、`status`、`queued_at`、`delivered_at`、`failure_reason`、`ack_at`、`reply_ids`、`result_ids`、`idempotency_key` 和转发诊断。时间均为 Unix 毫秒，未观测到的时间是 `null`。消息正文对象延续旧接口的 camelCase 字段；回执与 CLI 选项使用 snake_case。

| 状态/事件 | 含义 |
| --- | --- |
| `pending` | 本地已持久化排队，尚未确认写入接收端终端或被主动读取。对应 `--wait-until queued`。 |
| `delivered` | Termdock 已写入接收端 PTY。大消息写入的是通知与读取命令。不能据此判断 Agent 接手。读取正文不改变投递状态。 |
| `failed` | 明确不能继续投递，例如接收服务版本不支持该消息；查看 `failure_reason`。 |
| `expired` | 指定的 `--expires-at` 已到且消息仍未提交；不再投递。没有指定期限时不会自动过期。 |
| `ack` | 接收方显式报告已收到/接手。不会自动产生任务结果。 |
| `progress` | 接收方报告进展或阻塞。 |
| `result` | 接收方提交结果；成功与否需检查 `task.status`、正文与证据。 |

退出码：`0` 达到请求的等待条件；`1` 参数、网络或 API 错误；`2` 等待超时；`3` 投递失败或过期。单纯 `message get` 是查询，即便查到失败消息也正常返回 `0`，等待操作才使用 `3`。

查不到消息与无权查询分开报：`MESSAGE_NOT_FOUND` 表示 id 不存在、前缀无匹配或历史已过期/被清理（不足 4 位的前缀不做前缀搜索，正文会说明）；`MESSAGE_NOT_YOURS` 表示消息确实存在，但当前会话既不是发送方也不是接收方（`reply` 只允许接收方，发送方查自己的消息用 `message get`）。两者 HTTP 状态都是 `404`，正文都不回显消息内容。

## 消息、线程与协作组 id

消息 id、线程 id、协作组 id 生成时就是 **10 位小写 base36**（如 `u3fn1vfhr2`），终端里显示什么就存什么，不再有「存长 id、显示时截断」两层。升级前创建的长 id 不迁移、不重写，仍按其前 10 位显示（如 `83384cd8-1`），照抄可用。

所有接受 id 的命令（`message get`、`reply`、`--group`、`--thread`、`role`、`spawn` 等）都接受完整 id，或至少 4 位的唯一前缀；前缀匹配到多个对象时返回 `MESSAGE_ID_AMBIGUOUS`/`GROUP_ID_AMBIGUOUS`（正文只报匹配条数，不回显匹配到的 id），要求写更长或写全。生成时会避开在用 id 及其显示形态，因此新旧 id 不会互相遮蔽。

为什么是 10 位而不是更短的 8 位：uuid 的第 9 位必是连字符，而 base36 不含连字符，所以 10 位下「新生成的 id 恰好等于某个老 uuid 的显示形态」在构造上就不可能发生——本地生成会避开在用 id，跨机则会撞上一类更严重的故障。id 在多机之间合并时按 id 相等归并（联邦不能改写 id），一旦两台机器各自生成了同一个 id，两条消息会被并成一条，且**回执会被更高状态覆盖**：一条从未投递的消息可以被标成「已读」，发送方看到假回执，待投递队列同时丢弃它。10 位把这种情况的概率压到约 36¹⁰ 分之一（两端各满 2000 条时约 9 亿分之一），比 8 位低 1296 倍。

例外：跨服务工作组 id 形如 `cross-<uuid>`，保持完整。它靠 `cross-` 前缀做结构判定，且该 id 是多机之间「这是同一个组」的唯一凭据，合并冲突代价高、而组数量远少于消息；远端会话地址 `remote:<origin>:<id>` 同理保持原样。存储、JSON/jsonl 输出、回执与联邦线格式始终是完整 id——缩短只影响显示与生成，不影响线格式。

`--expect-reply ack|result|any` 在投递等待条件之外，再等待接收方直接回复当前消息的对应类型。`message watch` 按变化输出回执，默认等到写入终端；`--timeout` 接受 `30s`、`2m`、`500ms` 或毫秒整数。

超时只停止本次等待，不撤销消息，不代表远端任务失败。已取得回执时仍返回原 ID 和最后已知状态。网络中断导致发送结果不确定时，使用返回的幂等键和同一正文重试；不要自行换 key 重新触发任务。

## 本地路由恢复与后台投递

终端连接与协作投递路由分别观测。尚未加入协作组、没有待投递消息的会话可能未被投递 worker 检查：此时 `route_state=unchecked / route_error=ROUTE_NOT_CHECKED`，不能标为正在恢复连接。如果服务持有该会话的 live backend，列表显示「终端已连接」；否则显示「投递目标未检查」。实际检查过程中显示「正在检查投递目标」。已有 live backend 不意味着已核验固定 Agent pane，也不意味着 Agent 忙闲或已读。

本地协作使用独立的持久化路由登记（`~/.termdock/collaboration-routing.json`）；global session state 是界面绑定的投影，搜索索引只负责搜索。创建、接管会话时登记后端绑定，后台发现投影为空或陈旧时从路由登记和存活会话重建。历史绑定本身不证明在线。

服务启动后自动检查协作成员和持久化待投递队列，不需要浏览器打开、调用 status 或产生新的 Agent hook。每个 peer 的恢复、投递和显式重绑串行执行，多个 peer 可独立推进。消息按接收方队列顺序提交；路由或写入失败保留消息，按 2 秒至 30 秒退避重试。回执中的 `last_error`、`next_retry_at` 解释阻塞原因；`attempt_count` 只统计真正进入终端写入的尝试，路由尚未就绪时为 0 是正常的。

tmux 存活而 TD 后端缺失时，只挂接现存会话，不新建 tmux 会话、不启动或恢复 Agent。目标首次定位后固定到 tmux server/session/pane 和 pane 进程身份，投递不跟随活动 pane，也不改变焦点。多个候选无法唯一定位或 tmux 重建时保留队列；在目标会话内显式运行：

```sh
td collab rebind            # 当前会话只有一个可识别 Agent 时
td collab rebind --pane %3  # 明确指定当前 tmux 会话内的 Agent pane
```

重绑只作用于调用方 peer，成功后继续投递积压消息。它不会把 `delivered` 改回待投递，也不会启动新的 Agent。

`td collab status` 中的 `route_state` / `route_error` / `route_checked_at` 描述路由观测：`recovering`（等待或正在检查）、`detached`（tmux 后端尚未挂接成功）、`ready`（可投递）、`shell`（目标处于 shell，发送需确认；未知程序不会被认定为 Agent 退出）、`offline`（会话或后端已不存在）、`ambiguous`（多个候选）、`identity-mismatch`（目标身份变化）、`unavailable`（检查或恢复出错）。路由 ready 不表示 Agent 空闲；不能将其他活动 pane 的 turn 状态归给当前 peer。

**投递保证的边界：**提交结果仍是“已写入终端”，不等于应用 ACK。成功回执已保存的消息不会被后台重放；同一进程内，即使写入后的回执保存失败，也避免再次写入。但终端输入和本地文件不能组成原子事务：进程恰在写入之后、保存回执之前崩溃时，重启可能重复提交同一消息 ID。因此这是允许重复的重试传输，接收方应按消息 ID 去重；需要应用确认时使用显式 ACK 和消费游标。TTL 在提交前检查；已开始但结果尚不确定的提交不会被中途标为 expired。

## 增量收件箱与消费游标

```sh
td collab inbox --consumer coordinator --limit 20 --json
# 处理成功后，使用这一页返回的 next_cursor：
td collab cursor commit <next_cursor> --consumer coordinator


td collab inbox --from <session-id> --group <group-id> \
  --thread <thread-id> --response-kind result --limit 20 --jsonl

td collab inbox --consumer coordinator --follow --timeout 2m --jsonl
```

支持 `--since`（ISO 时间或 Unix 毫秒）、`--after-id`、`--cursor`、`--limit`、`--from`、`--group`、`--thread`、`--kind`、`--response-kind`。默认最新优先，最多 50 条。游标/consumer 模式按本服务接收顺序取最早未消费的一页，因此远端时钟回拨或晚到消息不会使消费游标漏读。

`next_cursor` 与会话、过滤条件绑定；`--consumer` 命名独立的持久化消费位置。读取和 follow 都不会自动推进持久化消费位置，也不会标记消息已读。JSONL 输出 `type=message` 行和包含 `next_cursor`、`has_more` 的 `type=cursor` 行。follow 在当前调用内使用临时游标，不重复输出同一页；处理成功后仍需显式提交。

`--after-id` 不存在或已清理时返回 `CURSOR_GONE`，不能悄悄从错误位置继续。历史被清理且游标尚未追上时返回 `retention_gap=true`；调用方必须认识到结果不是完整历史。待投递消息不会因历史条数上限被裁掉。历史终态最多保留 2,000 条，幂等窗口内受保护的消息额外保留；删除会话/工作组仍沿用产品原有的删除历史行为。

人的协作记录页提供“收到确认 / 进展 / 结果与证据”筛选和“只看新记录”。“标记当前记录已看”只记录当前浏览器已看的可见消息，不代替 Agent 已读或 ACK，也不会把筛选隐藏的其他类型标记已看。

## 幂等、消息大小和跨服务转发

幂等作用域是工作组、发送会话和 key。相同 key、相同语义参数返回原消息 ID；改变正文、接收方、线程或 metadata 等参数返回 `IDEMPOTENCY_CONFLICT`。对象属性顺序不影响比较。记录持久化保留 7 天，重启不会失效；未指定 key 时 CLI 自动生成并返回一个。幂等保证消息提交去重，不能保证外部副作用恰好执行一次，执行方仍应依据 `task_id` 保存自己的执行结果。

正文上限为 **1 MiB UTF-8**，metadata 与 task envelope 等附加字段合计 **16 KiB JSON**，完整编码消息上限 **1.5 MiB JSON**。大量控制字符可能先触及编码限制。超限明确报错，不截断正文，保留原始换行和空白。

跨服务桥接按 32 KiB 分片，接收端持久化未完成分片；校验完整 SHA-256 后才产生一条可消费消息。重复、乱序分片和转发客户端/接收服务重启均可重试；不完整分片保留 24 小时，最多 32 个未完成消息，每条最多 64 个分片。发送端队列仍保留原消息，超过分片缓存期限后可以重新组装。

`relay_online`、`peer_reachable` 是最近一次转发观测，超过 15 秒变成 `null`（未知），不从 Agent turn 状态猜测。另有 `attempt_count`、`next_retry_at`、`last_error`、`transport_checked_at`、`fragments_sent`、`fragments_total`。断线保持 pending，失败退避重试最多间隔 30 秒；接收服务本身不可达时跟随每 2 秒的连接轮询。瞬时链路错误与明确不可投递分开表示。

旧版兼容转发可由 Mac 客户端或浏览器/PWA 运行，二者复用相同的同步、去重与分片协议。浏览器按已保存的服务身份分别建立加密连接，共用同源顶层页面的转发器；无需打开每个服务的工作区。所有写入都由页面的加密客户端完成，不回退到普通 HTTP。手机后台或网页关闭时转发会暂停，消息保存在服务端，恢复前台后继续同步。新分片和扩展消息需要桥接客户端及两端服务均支持 v2；普通短消息可以继续与旧服务通信。不支持扩展消息的旧服务会得到明确的 `PEER_UPGRADE_REQUIRED`，不能声称已投递。服务端单独升级不能替换正在运行的旧桌面桥。

## 服务后台跨节点投递

新版两端服务使用自己的 Ed25519 身份建立 Noise 加密 RPC。消息入队立即唤醒后台工作器，已建立连接可复用；CLI 退出后由服务继续投递、退避重试和同步回执，不依赖网页或桌面客户端保持运行。接收端按消息 ID 去重；收到正文后后续查询只传回执，避免重复发送大正文。快照与终端送达时间同步，迟到快照也可补齐。

授权限定在已存在的协作组及登记服务的成员之间；登记不授予远端服务完整业务 API 权限。删群或移除该服务全部成员后，旧连接的组内请求立即失效。TLS 校验及 Noise 服务身份固定均保留，不回退到直接 HTTP 业务请求。可经同组已登记入口使用管理员已配置的服务路由，入口只转发密文。

### 首次登记与旧群迁移

两端均升级后，新版已授权网页可以自动交换服务公开身份并完成一次登记；它只承担配置，不承担登记后的消息投递。旧客户端保留旧同步行为，但不能代替首次登记。完全通过 CLI 配置时，在双方受管会话分别运行：

```sh
td collab transport info
```

通过可信方式收集输出中的 `node`（仅服务公钥身份及 CA 指纹），为每项添加与该协作组使用地址一致的 `origin`，组成 `nodes.json` 数组，在两端执行：

```sh
td collab transport register <group-id> --file nodes.json
```

数组必须包含本服务。登记持久化在本机 `~/.termdock/federation/collaboration-peers.json`，重启后保留；不能用未经核实的远端公钥替换固定身份。未登记时回执明确显示 `PEER_REGISTRATION_REQUIRED`；连接失败显示错误及下次重试时间。

`fragments_sent=0` 不能用于判断是否发送：服务 RPC 的完整消息和旧桥接的非分片消息都不增加此计数。以 `status`、送达时间及回执为准。`--wait-until delivered` 等待终端投递，`--expect-reply ack` 另外等待对方确认；CLI 超时不取消队列。

## 会话状态与结构化任务

状态输出只提供终端和传输事实，不提供已读、Agent 内部 turn/task_state、工具活动或心跳占位字段。终端输出时间不代表任务进度；明确回复及任务报告保留原始消息和时间，不推断会话忙闲。旧版 `message read` 返回 `READ_RECEIPTS_UNSUPPORTED`；使用 `message get` 查看正文和快照，用显式回复确认。消费游标仅记录调用者明确提交的位置。

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

## Shell 投递确认

投递按绑定终端定位，不再要求程序名匹配已知 Agent，也不因 Agent 类型或原生会话 ID 变化而拦截同一 pane。投递后的终端快照用于发送方判断结果。

仅在明确检测到目标处于 shell 时暂停该消息，回执返回 `SHELL_CONFIRMATION_REQUIRED` 和确认命令。发送方确认内容可以写入 shell 后执行 `td collab message confirm-shell <message-id>`，继续原消息，不创建副本；确认持久化并通过协作同步传递。跨机双方及运行同步的客户端需更新到支持此确认的新版本。

## 长消息、群规与观察能力

- 超过 4096 UTF-8 字节的正文不再直接灌入终端；信封携带 `td collab message get <id> --text`。完整正文及该消息当时的群规版本一并返回，读取和回复都不产生已读回执。
- `td collab rules get <group> --text` 查看群规；`rules set <group> --file rules.md` 保存（最多 8192 UTF-8 字节）；`rules clear <group>` 清空。可用 `--if-version <version>` 防止覆盖已更新版本。每次修改产生新版本，跨节点独立同步；短规则自动注入信封，长规则随 message get 获取。
- `td collab traits set <group> <member> "深度评审，不接急单"` 是 role 的别名，成员定位在 status/role list 可见。不推断实时排队长度，不自动拦截派单。
- `td collab capture <member> --lines 200 --text` 读取最多指定数量的 tmux 历史行加当前屏幕，范围 1..10000；仍限定同组本机 tmux。它不提供精确时间索引，也不保证重绘式 TUI 的完整历史。
- capture、inbox、message get 的快照默认清理终端控制序列；`--raw` 请求未清理的捕获或已存快照。正文原样保留。
- status 提供最后终端输出时间、观测时间和来源。跨节点由服务后台同步；最后输出不是最后工具调用，长时间无输出不是卡死证据。
- 回执新增 `delivery` 与 `reply` 对象。等待 ACK 超时时 reply 标记 timeout，已送达的 delivery 仍保持 delivered；旧的顶层字段及退出码保留兼容。
- inbox 的 `--from` 支持同组远端会话的唯一短 ID；有歧义时要求完整 ID。

## 1.4.232 发布范围与验证记录

服务之间持久化群级公开身份绑定，通过 TLS + Noise 加密通道投递、重试和同步终端回执；CLI 提交后无需客户端持续转发。首次绑定可由 `transport register` 或新版已授权页面完成。未绑定明确返回 `PEER_REGISTRATION_REQUIRED`。双方服务升级后生效，旧客户端/旧服务仍保留原有兼容路径。

本次不加入历史画面归档、临时 resize 或固定终端尺寸；保留当前屏快照、纯文本清理及显式历史行读取。

按用户 2026-09-16 明确指示，最终收尾后不再运行回归测试，发布执行生产构建。此前测试曾发现仓库既有的 9 个失败测试文件与 lint 错误；本次最终版本不能声称回归全通过。跨电脑升级后双向收发、真实 macOS/iOS 及完整加密入口实机矩阵尚未验收。

## 统一服务端协作（1.4.234）

macOS 页面、浏览器和 CLI 共用服务端协作目录、建组、投递及回执。页面不再调用 preload 的 collaborationPeers/collaborationSave；新桌面端和浏览器不再启动客户端协作轮询。旧客户端后台调用的转发接口返回 410，不再处理数据。旧 macOS 安装包可继续承载新页面：升级其实际连接的 CLI 服务并重启、重新加载页面即可，不要求更新客户端安装包；这一兼容路径尚未做 macOS 实机验证。

服务端持续查询已配对服务的会话目录、复制群成员关系并配置群级加密投递。UI 通过 `/operations/collaboration-directory` 读目录、`/operations/collaboration-groups` 建组；CLI 的 `transport list` 和 `group save --file group.json` 使用相同服务。远端失败不会阻塞本机会话列表，目录展示实际错误。群保存返回后台同步状态，不冒充已在每个远端保存成功。

### 没有可迁移服务授权的旧群

旧版只在服务端保存客户端授权，不能据此冒用客户端身份。双方服务升级后，用 CLI 做一次服务配对：

```sh
# A：origin 必须是 B 可以访问、且与旧群地址一致的 HTTPS 根地址。
umask 077
td collab transport invite --origin https://A:9834 > invitation.json
# 私下把 invitation.json 交给 B；邀请 10 分钟有效，只能绑定一个服务身份。
# B：保存邀请文件后执行。
td collab transport accept --origin https://B:9834 --file invitation.json
td collab transport list
```

邀请授予协作目录和群管理权限，不授予任意 HTTP、文件访问或客户端私钥。双方通过 TLS 验证和 Noise 身份固定建立通信，授权持久保存在服务端；已有共同群自动同步并补齐投递绑定，无需逐群重新登记。更改服务地址/证书/身份不会静默覆盖已有信任。

本次按用户要求不运行回归测试，仅进行发布构建、部署与健康检查；旧 macOS 客户端、跨电脑双向收发及完整加密入口矩阵仍待实机验收。
