# 跨服务访问与加密中继架构

- 状态：本地架构草稿，待设计评审；不是已实现功能或发布承诺。
- 更新日期：2026-09-08。
- 正文权威源：[跨服务访问与加密中继架构](doc/跨服务访问与加密中继架构.lark.md)。
- 最终飞书链接：未导出。
- 已纳入：整服务/Session 多维授权；普通直连及中继统一端到端加密；HTTPS 解密代理与 PWA 代码来源边界。

## 目录

- `doc/`：标准 Markdown 正文。
- `diagrams/`：独立 Mermaid 架构及交互图源。
- `refs/diagram_facts.md`：需求、代码证据、安全依据及图表口径。
- `refs/style_facts.md`：图文风格。

## 图表清单

| 图源 | 正文位置 | 状态 |
| --- | --- | --- |
| [01_connection_topology.mmd](diagrams/01_connection_topology.mmd) | 第二节 | Mermaid 草稿；正文文字路径可独立阅读 |
| [02_encrypted_access.mmd](diagrams/02_encrypted_access.mmd) | 第五节 | Mermaid 草稿；非既有协议时序 |

## 预览及导出

普通 Markdown 预览器可阅读正文、表格与路径说明；图源使用支持 Mermaid 的工具单独预览。当前没有 SVG、位图或飞书 XML 扩展块。

仅在用户明确要求时新建飞书最终稿。导出前核对正文和图源；如需将 Mermaid 转成 SVG 画板，先读取官方画板与 XML 规范并完成渲染验收，在临时导出层处理转换。不得把飞书专用块写入正文。成功发布并回读校验后，只在此 README 更新飞书链接。
