# 共享会话目录

保留现有主会话清单最完整的链路：服务端库存与控制 WebSocket → useSessionPersistence 的版本归并、删除保护和冷启动缓存 → useTerminalStore 的实时元数据 → 共享展示投影。功能组件不再拉另一份库存。

## 功能入口

从 `src/lib/stores/useSessionDirectory.ts` 使用 `useSessionDirectory()`；事件处理等非渲染代码使用 `getSessionDirectorySnapshot()`。返回的 `SessionOption` 包含 `sessionId`、`displayName`、`displaySubtitle`、`cwd`、`agent`、`lastActivity`，不暴露持久化名称。只有主清单归并器可以替换目录数据。名称变化和删除沿同一控制链推送，打开的选择器同步更新，不覆盖用户填写的业务草稿。

目录读取实时标题、程序、目录、prompt state 和 Agent，保留现有标题/Agent 浏览器缓存。旧 backend 的实时元数据不覆盖新 backend 的记录。目录只订阅元数据变化，终端正文输出不触发选择器重新渲染。用户自定义的 shell 检测配置沿用主界面的配置加载链。

## 统一投影

纯规则位于 `src/server/utils/sessionDisplayName.ts` 的 `getSessionPresentation`。前端 `terminal/display.ts` 导出同一规则；原来的 `getSessionDisplayLines`、`getSessionDisplayName` 和协作兼容入口共用这套优先级：已命名会话 → 有意义的实时标题 → 非 shell 程序 → 目录 → 可读存储名或 Agent 通用名称。目录标题不会被误当作任务标题，自动生成的 tmux/路由标识不会落到默认 UI 标签中。

侧栏、标签、分屏与对话名称、会话通知、待办选择器和关联会话标签使用该投影。服务端库存暴露 `displayName` / `displaySubtitle`，保留原始 `name` 给持久化和路由；协作接口的兼容 `name` 与交接记录也取该投影。不能把某处的短名修正作为新的独立名称来源。

## 验证与边界

### 展示快照与新增入口

`getSessionPresentation` 的输入是原始会话记录。服务端已解析的快照由 `getSessionSnapshotPresentation` 读取 `displayName` / `displaySubtitle`；旧服务只返回兼容 `name` 时保留其展示标题，不允许再次按 `cwd` 计算，否则目录会覆盖自定义/自动标题。

新增功能若只有会话选择需求，直接使用 `useSessionDirectory()` 的 `SessionOption`。若还需要协作状态等专用事实，使用 `useSessionPresentations(snapshots)` 关联标题：本机会话取共享目录当前投影，远端或离线快照保留所属服务的投影；该入口不拉库存、不改事实、不写目录。渲染只读 `displayName` / `displaySubtitle`，用 `sessionId` 操作目标。协作成员、创建组、自动任务目标、看板、分屏和通知沿用这条链路，打开的界面随目录标题更新。

边界测试禁止协作组件直接显示 `session.name` 或重新调用原始投影。回归覆盖同目录多个不同标题、旧服务快照、实时标题与重命名同步、保留选择和草稿，以及通知和分屏与目录一致。`.browser.*` 是测试夹具，不计入生产目录写入者扫描。

`sessionDirectoryBoundary.test.ts` 禁止功能组件自行读取库存，并限定共享目录的生产写入者；共享目录测试覆盖实时标题、命名、删除、旧 backend 隔离、缓存及程序检测配置。待办测试验证打开的选择器在名称变化时更新且保留补充要求。

初始恢复遮罩由 `useInitialRestoreGate` 管理，一旦进入前台工作区即释放首次恢复阶段；待办和协作页面使用局部加载，不因后台终端尚未完成首帧而重新覆盖整页。

实际浏览器验证包含 1440×960、390×844 与 320×720。隔离服务中新建真实 Codex 会话后，选择器显示的名称与侧栏一致；重命名通过主控制链同步，删除目标后禁用发送并保留补充草稿。桌面和手机各反复进入/退出待办三次，未观测到全屏恢复遮罩再次出现。该验证不代表真实 macOS/iOS 原生实机验收。

本轮 21 个测试文件共 146 项回归通过，完整生产构建通过。前端类型检查剩余一处任务范围外的既有测试类型诊断（`SessionChatView.test.tsx:311`），本轮改动无类型诊断。已部署到 9834，健康状态、受管进程与实际前端资源核对通过；正式库存的 24 个会话均返回有效展示名，其中 21 个从底层名称派生了展示标题，正式待办数据逐字未变。隔离浏览器、服务及两个测试终端已清理。

自动收集来源使用可选的 `collectionRunId`：服务端从 TodoStore 持久化的 collect 执行记录投影到 inventory，由现有 `useSessionPersistence` 同步缓存并送入 `useSessionDirectory`。侧栏据此归类已有/新增会话，不能另拉库存或按「收集」名称前缀推断。协作组与分屏中的显式安排优先，折叠展示不代表进程退出或已回收。
