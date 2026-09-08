# 架构事实与证据

核对日期：2026-09-08。本文区分需求、已核对代码、设计提案，不将提案视为产品已有能力。

## 用户需求

- 手机 PWA 连接一个入口服务，在当前窗口访问其他已授权服务的 Session，不局限于工作组。
- 连接配置入口包括 macOS 和 CLI；“COI”按前文理解为 CLI，具体命令尚未确定。
- 必须覆盖 A 同时连接 B、C，但 B、C 无法互通的情况；手机连接 B 时，经 A 访问 C。
- Termdock 内部提供加密能力；端到端加密是建议方案，协议与实现尚未选定。

## 已核对代码

- `desktop/collaborationFederation.ts`：`CollaborationFederation.synchronize` 通过每个服务的 `request('/collaboration-federation')` 同步工作组快照及消息；`qualifySession` 当前按 origin 和 Session ID 编码远端身份。该模块处理协作同步，不是通用终端中继。
- `src/server/agent/collaborationStore.ts`：存在 `federationSnapshot`、远端成员与副本合并逻辑。已有副本不等于已有终端数据代理，也不证明现有消息具有端到端加密。
- 核对范围限上述文件；本文不宣称已完成全库安全审计。

## 安全依据

- [IETF TLS 1.3 文档](https://www.rfc-editor.org/rfc/rfc8446)：TLS 保护通信端点之间的数据。本文据此区分逐段 TLS 与应用端到端保护；此链接作为协议背景，不作为最新实现选型依据。
- [W3C Web Cryptography](https://www.w3.org/TR/webcrypto/)：浏览器密码 API 及安全注意事项。不可导出密钥不等于恶意同源脚本无法调用密钥；本文据此明确 PWA 代码来源的信任边界。
- 未选定应用层握手协议、算法套件或密码库。浏览器兼容性、维护状态、协议审计和重连语义须在实施前验证。

## 图表口径

- 01_connection_topology.mmd：实线标明谁主动建立连接；不表示数据只能单向流动。A 为 Mac 或常驻中继，不是手机所访问的 B。
- 02_encrypted_access.mmd：手机与 C 是加密会话端点；B、A 是转发节点。消息名为设计说明，不是既有 API。
- “一个中继 A”为第一版范围建议，不是测得的网络能力上限；无吞吐量、延迟或并发承诺。

## 后续明确需求（2026-09-08）

- 授权必须按维度表达：整服务完整授权覆盖服务所有能力；也支持一个或多个 Session 的授权，并区分读与写。
- 应用端到端加密适用于 Termdock 本身，包括没有中继的普通直连；要防御已安装并受设备信任的 HTTPS 解密证书所支持的传输拦截。
- 从 Web Crypto 代码信任边界推导：应用层加密可保护可信客户端运行时的内容，但不能独自抵抗经 TLS 解密代理替换的 PWA 脚本。需独立认证目标身份，且客户端代码不能依赖同一受拦截链路建立首次信任；此项是架构要求，不是现有产品保证。
