# Termdock 架构功能验收与上游对照

对照源码：`oh-my-mermaid/oh-my-mermaid`，commit `38ccdb69298adec949177c92c88d6e3ddfb5bab7`，package 0.2.0。源码拉取在仓库外；Mermaid 差异算法沿用上游实现，格式和递归扫描约定按 MIT 许可证适配。许可证随 Termdock 包分发，见 `THIRD_PARTY_NOTICES.md`。

## 能力对照

| 上游已经实现的能力 | Termdock 中的承接 |
| --- | --- |
| `/omm-scan` 递归分析、12 类视角目录、每个节点的描述 | 内置生成指令要求逐节点读代码和递归细化；`td architecture prompt`；`setup` 安装项目内的 `/termdock-architecture` 技能。 |
| `.omm/<perspective>/<class>/...`、七类字段、YAML 元数据 | 直接读取和编辑 `.omm`；兼容已有原生 JSON；原生 JSON 可转换成 `.omm` 文档包并导入实际目录。 |
| 全部视角总图、嵌套模块、逐层浏览 | 「全部视角」总图和展开层级选择；原有面包屑与局部阅读保留。单次绘制超过 300 个模块时要求收敛层级或视角。 |
| 节点 Markdown、上下文、约束、问题、待办、备注 | 复用文件页的 Markdown 渲染器，阅读时关闭文件行引用轨道和重复标题；可逐字段编辑。 |
| 跨视角引用、入边与出边 | 节点说明中直接跳转；总图中阅读另一视角的文档时保留画布；连接关系与源码行引用保留。 |
| 元数据、上次关系图与 Mermaid diff | 保留创建/更新、计数、Git commit/branch、上一份 diagram；CLI diff；界面更新差异与最多 30 个历史版本。 |
| pan/zoom/fit、响应式查看器、导出 | 原生图支持平移、双指缩放、适配全图、全屏及 SVG；JSON 与 `.omm` 文档包导出。 |
| 目录导航与节点文档 | 使用现有文件树选择分析目录/文件；桌面目录在表单左侧，手机确认选择后回到表单；模块目录与视角文档在阅读工作区中展开。 |
| 文件变化通知 | 复用加密文件监听，订阅 `.omm` 文档目录及原生保存目录，300 ms 合并刷新；最多 128 个目录订阅，其余由 10 秒轮询覆盖。 |
| init/list/tree/read/write/show/delete/status/diff/refs/validate/view/config/setup | `td architecture` 原生命令；`arch` 是别名。删除保留历史；原生图结构编辑同步节点与连接；无变化时不写新版本。 |
| 上游账号、组织、云端同步与分享客户端 | 不连接上游托管 SaaS。登录和访问控制沿用 Termdock 的服务及设备授权；多端读取同一服务的文档，分享链接绑定服务身份并要求登录；跨服务用原生文档包导出/导入。此处是产品适配，并非复制 ohmymermaid.com 的闭源后端或账号/组织 API。 |

上游路线图中的增量扫描流水线、多 Agent 自动编排、查看器 AI 搜索、自动上手技能不属于此版本已经交付的能力。Termdock 的局部目录、功能分析和用户自写问题继续保留。

## 使用

1. 打开项目终端中的 Agent，进入「架构 → 生成」。选择整个项目、目录/模块或功能链路。目录不需要手输，可在左侧现有文件树引用；功能问题和依赖深度一起写进指令。
2. 检查提示词后发送。Agent 按约定读代码、写文档；界面观察保存结果，不推断 Agent 的工具活动或任务进度。
3. 已有 `.omm` 会出现在「已保存分析」中；「更新」使用 `.omm` 兼容扫描指令。新局部分析仍独立保存在 `.termdock/architectures/`。
4. 关系图中选模块阅读、沿引用跳转、打开源码或编辑；手机也可以使用模块卡片。编辑冲突时保留草稿，取消后重新编辑以读取最新版本。
5. 「历史、导入与分享」提供差异、导出、导入和私有查看链接。导入先展示文件和目标，确认时检查版本；取消不写入。`.omm` 导入合并显式字段，保留未包含的视角。

```sh
td architecture prompt --project . --language zh
td architecture setup codex --project .
td architecture save --project . --file .termdock/architecture.json -
td architecture tree --project . --format omm
td architecture read overall-architecture/server description --format omm
td architecture write overall-architecture/server note - --format omm
td architecture export --format omm --file .termdock/architecture.json > architecture.omm.json
td architecture import - < architecture.omm.json
td architecture validate --format omm
td architecture refs overall-architecture/server --format omm
td architecture diff overall-architecture/server --format omm
td architecture history --format omm
td architecture view --project . --file .omm
```

`view` 输出 Termdock 查看链接；不另外启动第二个查看器。`setup` 仅安装指定项目内的技能，并拒绝覆盖非本功能生成的技能。`--teardown` 只移除带自身标记的技能文件。

## 验收边界

- 用上游仓库自己的 `.omm` 数据验证实际兼容：3 个视角、68 个节点、74 条连接；没有把上游的样例内容写入用户项目。
- 浏览器验收覆盖 1440×900 桌面、1280×600 矮窗口、390×844 和 320×690 手机视口。检查嵌套模块、全部视角、阅读、引用、源码返回、编辑保存/取消/冲突、全屏、目录选取及导入预览。
- 自动化覆盖真实目录互导、目录越界/符号链接、无变化写入、并发修订冲突、版本历史、CLI、首次无 Service Worker 加载、断线不回退、文件树引用、完整阅读动线、色板及层级守卫。
- 实际加密 WebSocket 验证架构读写：未授权拒绝、只读设备无法修改、已授权编辑、撤销后拒绝，线上密文不出现文档正文；沿用现有入口中转机制。
- 当前 Linux 环境没有真实 macOS/iOS 设备，浏览器视口验收不代替实机触控、系统安全区或原生客户端验收。
- Agent 生成内容的准确性仍取决于实际读到的代码；提示词要求可验证的源码引用与不确定性说明，格式校验不能证明架构解释正确。
