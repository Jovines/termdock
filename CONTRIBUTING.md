# 参与贡献 / Contributing

欢迎帮助 Termdock 变得更好。问题反馈、文档、翻译、Agent 插件、设备体验报告与代码贡献都欢迎；中文和英文都可以。

Contributions of code, documentation, translations, Agent plugins, and device feedback are welcome. You can use Chinese or English in issues and pull requests.

## 报告问题 / Report a bug

先搜索 [Issues](https://github.com/Jovines/termdock/issues)，确认是否已有相同问题。提交时请提供：

- Termdock CLI 版本（`td --version`）、macOS 应用版本（如适用）。
- 服务机操作系统与 Node.js 版本，以及客户端浏览器、系统和打开方式（网页 / PWA / 桌面应用）。
- 最小复现步骤、预期行为、实际行为，以及相关日志或截图。
- 连接方式：本机、局域网、公网或入口中继；是否首次加载、后台恢复或升级后出现。

Search existing issues first. Include the service and client versions, a minimal reproduction, expected and actual behavior, relevant logs, and the connection route. Say whether this occurs on first load, after backgrounding, or after an upgrade.

日志与截图请隐藏密码、Cookie、令牌、私钥、邀请链接与私人数据。不要在公开 issue 中粘贴完整的 `~/.termdock` 配置目录。

Remove credentials, cookies, tokens, keys, invitations, and private data from logs and screenshots. Do not upload your full `~/.termdock` directory to a public issue.

## 功能建议 / Suggest a feature

描述具体使用场景、目前的阻碍和你希望完成的操作。涉及较大交互或架构变化时，先开 issue 讨论，再实现。真实的工作流程、设备型号和示例有助于判断方案。

Describe the workflow, the current obstacle, and the outcome you need. Discuss substantial UI or architecture changes in an issue before implementing them.

## 本地开发 / Local development

需要 Node.js 22+、npm 和 tmux。`node-pty` 编译依赖见 [README](README.md#运行环境)。Fork 仓库后克隆自己的副本，或克隆上游用于本地开发：

```bash
git clone https://github.com/Jovines/termdock.git
cd termdock
npm install
npm run dev
```

访问 `http://localhost:9833`；后端开发端口是 9835，正式服务端口是 9834。可用 `npm run dev:client` / `npm run dev:server` 单独运行前后端。

Use Node.js 22+, npm, and tmux. Open `http://localhost:9833`; the development backend uses 9835, while the installed service uses 9834. Your AI CLI is installed and authenticated separately.

## 改动与验证 / Changes and verification

阅读 [AGENTS.md](AGENTS.md) 中的项目约定。保留已有工作区改动，使用明确的文件路径暂存自己的内容。UI 改动遵循 Flexoki token 与 z-index 规则，同时检查桌面与窄屏流程；新增界面文案同步中英文。

Read the project conventions in [AGENTS.md](AGENTS.md). Preserve existing work, stage explicit file paths, use the shared color and z-index tokens, check desktop and narrow layouts, and update both UI languages when adding text.

根据改动执行相关检查：

```bash
npm run lint
# 示例：选择与你的改动相关的测试 / choose tests relevant to your change
npm test -- --run src/lib/flexokiPalette.test.ts
npm run build
```

需要完整回归时运行 `npm test -- --run`。仅文档改动检查相对链接、命令与实际行为即可；不要把模拟测试描述为实机验收。通信改动必须运行 `src/lib/federation/transportBoundary.test.ts` 和受影响入口回归，并覆盖首次加载、断线、旧客户端桥接及中继路径。

Run checks relevant to your change, including the production build for code changes. Documentation changes need link and command verification. Transport changes require the boundary test and affected entry-point regressions, covering first load, disconnection, old bridges, and relay access. Record actual macOS / iOS verification separately from simulation.

`AGENTS.md` 中的本机正式服务自动部署规则适用于维护者的共享工作区；外部贡献者无需部署维护者服务或发布 npm 包。

The shared-workspace deployment rule in `AGENTS.md` concerns the maintainer environment. External contributors do not need to deploy the maintainer's service or publish a package.

## 提交 Pull Request / Open a pull request

- 一次 PR 聚焦一个明确问题，说明触发条件与改动后的行为。
- 列出实际完成的检查；UI 变化附上隐藏私人信息的截图，说明设备与视口。
- 功能或配置变化同步文档，不提交密钥、机器专属配置、构建产物或大型非运行时资产。
- 如有已知限制、未做的实机验证或无关的既有检查失败，请明确说明。

Keep the PR focused on one problem. Describe the resulting behavior and checks actually completed, update affected documentation, and state known limits or unverified device paths. Keep credentials, machine-specific configuration, build output, and large non-runtime assets out of the PR.
