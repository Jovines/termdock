# Termdock Agent 规则

仓库存在多人/多 Agent 并行改动。

## 只对自己的改动负责

- `tsc` / 构建报错时,只修自己 diff 内的错。**不在自己 diff 内的错 → 停下,
  告知用户,等指示**,不要"顺手"清理。
- 提交时只 `git add` 自己改过的文件路径;**禁止** `git add -A` / `.` /
  `commit -a`。
- 别人 WIP 的文件保持 unstaged,不 stage / 不 reset / 不 checkout / 不修改。
- commit message 只描述自己的改动。

## 工具

- 搜索用 `rg`(ripgrep),不要 `grep -r`;查文件用 `Glob`,不要 `find`。
- 改完 `src/` 用 `termdock-deploy` skill 验证;若编译错属他人 WIP,先停。
