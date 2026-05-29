# AI Agent 状态检测 — 添加新工具指引

## 概述

Termdock 可以在终端 tab 图标上显示 AI 编程工具的运行状态（图标颜色变化）。检测原理是用正则表达式匹配 PTY 输出内容，每条规则对应一个状态和颜色。

## 状态指示方式

AI 状态通过 tab 左侧的图标颜色表示：
- 无状态：图标为默认颜色
- 有状态：图标变为规则配置的颜色（如绿色=running）

当 AI 从运行变为停止，且用户不在该 tab 时，图标变黄提醒（needsReview）。

## 正则匹配规则

- 所有正则使用 **大小写不敏感** 匹配（`'i'` flag）
- 按规则顺序匹配，**第一个命中的规则决定当前状态**
- 没有规则命中则状态清空
- 代码不做任何额外判断，完全由正则控制匹配逻辑

## 添加新 AI 工具的步骤

### 1. 确认程序名

在终端中运行该 AI 工具，然后执行 `ps -o comm= -p $(ps -o ppid= -p $$)` 或在 termdock 的 debug overlay 中查看 `activeProgram` 字段。常见的程序名如 `claude`、`coco`、`opencode`、`aider`、`cursor` 等。

### 2. 抓取 spinner 字符和输出格式

启动该 AI 工具并让它开始思考/生成，然后查看 debug 日志：

```bash
cat ~/.termdock/agent-debug.log
```

日志格式：
```
[2026-05-29T12:00:00.000Z] program=coco tail="...· Thinking... (11s  ↓ 132 B)✢ Thinking... (11s  ↓ 132 B)❋ Thinking..."
```

**关键观察**：注意 spinner 字符和关键词的**组合关系**。例如 coco 的实际输出是 `✢ Thinking... (4s)`，spinner 字符后面紧跟空格和状态词。

如果日志为空，说明该工具的 spinner 字符不在已知字符集中。此时可以：
- 手动运行该工具，观察终端中出现的动画字符
- 用 `xxd` 或 `od` 抓取原始输出中的 Unicode 码点

### 3. 编写正则表达式

**推荐写法**：spinner 字符 + 关键词组合，避免单个常见字符误判。

```
[spinner字符] (关键词1|关键词2)
```

示例：
- coco: `[·✢❋❇✽] (thinking|working|generating)` — spinner 后跟关键词，精确匹配
- claude: `[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠁⠂⠃⠄⠅⠆⠉⠊] (Thinking|Generating|...)` — braille spinner + 关键词
- aider: `Thinking|Generating|Working` — 无 spinner，纯关键词匹配

**避免误判的技巧**：
- 不要用单独的字符类 `[·✢❋]` 匹配，`·` 等字符在普通文本中也会出现
- spinner 字符后面通常跟空格和状态词，利用这个组合特征
- 如果需要要求多个 spinner 字符出现，可以用 `([chars]).*\1` 等正则技巧
- 正则完全由用户控制，代码不做任何额外判断

### 4. 添加规则

**方式 A：通过 UI（推荐）**

Settings → AI agent detection → Add program，填入程序名、正则、状态名和颜色。

**方式 B：编辑配置文件**

编辑 `~/.termdock/agent-rules.json`：

```json
[
  {
    "program": "my-ai-tool",
    "rules": [
      { "pattern": "[·✢❋❇✽] (thinking|generating)", "status": "running", "color": "#4ade80" },
      { "pattern": "waiting for input|confirm", "status": "waiting", "color": "#facc15" }
    ]
  }
]
```

字段说明：
- `pattern`：正则表达式（大小写不敏感）
- `status`：状态名，自由文本
- `color`：CSS 颜色值，如 `#4ade80`、`red`、`rgb(74,222,128)`

规则按顺序匹配，第一个命中即生效。所以 `running` 规则放前面，`waiting` 规则放后面。

### 5. 验证

1. 启动该 AI 工具
2. 观察 tab 图标是否变为配置的颜色（如绿色=running）
3. AI 等待输入时图标是否变为对应颜色（如黄色=waiting）
4. AI 停止后图标是否恢复默认色
5. 切换到其他 tab 时，原 tab 图标是否变黄（needsReview）

如果状态不对，检查：
- `activeProgram` 是否正确识别（看 debug overlay）
- `~/.termdock/agent-debug.log` 中是否有该工具的日志
- 正则是否正确（可在浏览器控制台 `new RegExp('pattern', 'i').test('sample')` 测试）
- 规则顺序是否合理（更具体的规则放前面）

## 已知 Spinner 字符集

| 工具 | Spinner 字符 | 实际输出格式 | 来源 |
|------|-------------|-------------|------|
| claude / claude-code | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠁⠂⠃⠄⠅⠆⠉⠊` (braille) + `·✢✳✶✻✽` (flower) | `⠋ Thinking...` 或 `✢ Generating...` | Claude Code 源码 |
| coco | `·✢❋❇✽` (flower variant) | `✢ Thinking... (4s)` | 实测抓取 |
| opencode | 无 spinner | `thinking...` | 纯关键词匹配 |
| aider | 无 spinner | `Thinking...` | 纯关键词匹配 |

## Debug 日志

- 路径：`~/.termdock/agent-debug.log`
- 大小上限：512KB（超出自动清空）
- 仅当 PTY 输出包含已知 spinner 字符时才记录
- 用于排查新工具的 spinner 模式
