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
- 没有规则命中则启动 200ms debounce 定时器，到后清除状态
- 状态由最新到达的 PTY 数据块触发匹配（非全量缓冲区），确保即时退出

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
- `indicator`：图标样式，可选 `spinner` / `pulse` / `dot` / `ring` / `badge` / `terminal` / `question`
  - 推荐：`waiting` 用 `question`（黄色问号跳动）
  - `needsReview` 由前端状态控制，仍是黄色呼吸提醒

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
| opencode | `⬝■` + braille `⠦⠧⠇⠏⠋⠙⠹⠸⠼⠴`（进度条动画） | `⬝⬝⬝■■⬝⬝■⠦...` 进度条 + `Thought: 1.3s` | 实测抓取 |
| aider | 无 spinner | `Thinking...` | 纯关键词匹配 |

## 分析 Debug 日志与制定规则

### 从 debug 日志中提取时序和字符特征

```bash
cat ~/.termdock/agent-debug.log | python3 -c "
import sys, json, re
lines = sys.stdin.readlines()
prev_ts = None
for line in lines:
    m = re.match(r'\[([^\]]+)\] program=(\S+) tail=(.+)', line)
    if not m: continue
    ts, prog, tail = m.groups()
    tail = json.loads(tail)
    if prev_ts:
        from datetime import datetime
        dt1 = datetime.fromisoformat(prev_ts)
        dt2 = datetime.fromisoformat(ts)
        diff_ms = (dt2.timestamp() - dt1.timestamp()) * 1000
        has_pattern = bool(re.search(r'YOUR_REGEX', tail))
        print(f'{diff_ms:6.0f}ms | match={has_pattern} | tail[-120:]: {tail[-120:]}')
    prev_ts = ts
"
```

这段脚本输出每条日志的**帧间隔**、**是否命中正则**、**末尾 120 字符**。三条核心信息：
- **帧间隔**：动画每多少毫秒刷新一次，决定 debounce 超时该设多大
- **匹配状态**：跟踪正则何时命中、何时失配，找到状态转换点
- **尾部内容**：观察动画消失后被什么内容替换

### 时序分析 → 确定 debounce 安全值

以 opencode 进度条为例，分析结果：

| 指标 | 数值 |
|------|------|
| 帧间隔 | 15-64ms，中位数 ~25ms |
| 每帧字符数 | ~40-50 个 |
| 输出方式 | ANSI 光标回到行首重绘 |

**通用规则**：debounce 超时取帧间隔中位数的 **8-10 倍**。进度条 25ms × 8 = 200ms，足够覆盖任何网络/IO 抖动，又不会让用户感知到延迟。

### 为什么缓冲区匹配会有"退出延迟"

检测机制将 stripAnsi 后的文本追加到滚动缓冲区，取末尾 N 字节匹配正则。ANSI 光标重绘（回到行首覆盖）会被 stripAnsi 移除，旧帧的字符堆积在缓冲区。动画跑 3 秒后缓冲区中可能有 5000+ 个过期字符，动画结束后新输出只有几十字节，无法快速推出 1024 字节的检测窗口，导致状态清除滞后数秒。

**解决方法**：用最新到达的数据块（而非累积缓冲区）做匹配。动画活跃时每 25ms 就有新数据块命中正则；动画停止后，下一个不含动画字符的数据块立刻失配，触发 debounce 清除。

### 确定匹配策略

两种基础策略，根据输出特征选择：

| 策略 | 适用场景 | 优缺点 |
|------|---------|--------|
| **最新数据块匹配** | 高频动画（每帧 < 100ms），如 spinner、进度条 | 瞬时响应，无缓冲污染；需 debounce 防抖 |
| **缓冲区匹配** | 低频或跨行输出，如 `Thinking...` 这类状态文本 | 不漏检跨 chunk 的模式；可能有退出延迟 |

混合使用：优先用最新数据块匹配，检测到后立即置状态；失配时启动 debounce 定时器（200ms），定时器到后复查缓冲区尾部确认是否可以清除。

## 状态检测 debounce 机制

Termdock 内置 200ms debounce：当最新数据块不再匹配正则后，等待 200ms 再清除状态。在这 200ms 内如果再次命中，定时器取消，状态保持。这避免了：

- 进度条帧跨数据块边界导致的短暂失配（闪烁）
- 网络抖动导致的数据块间隔不均匀
- 动画结束后的延迟清除

200ms 对于帧间隔 ≤ 50ms 的动画足够安全；如果帧间隔更大（如某些工具的 spinner 每秒只刷新 2-3 次），可适当增大 debounce 值。当前 debounce 值硬编码在 `AGENT_STATUS_DEBOUNCE_MS` 常量中。

## Debug 日志

- 路径：`~/.termdock/agent-debug.log`
- 大小上限：512KB（超出自动清空）
- 仅当 PTY 输出包含已知 spinner 字符时才记录
- 用于排查新工具的 spinner 模式和动画时序分析

查看日志的帧间隔分布（快速评估 debounce 安全性）：
```bash
cat ~/.termdock/agent-debug.log | python3 -c "
import sys, re, json
lines = sys.stdin.readlines()
timestamps = []
for line in lines:
    m = re.match(r'\[([^\]]+)\]', line)
    if m: timestamps.append(m.group(1))
diffs = []
for i in range(1, len(timestamps)):
    from datetime import datetime
    d1 = datetime.fromisoformat(timestamps[i-1])
    d2 = datetime.fromisoformat(timestamps[i])
    diffs.append((d2.timestamp() - d1.timestamp()) * 1000)
if diffs:
    diffs.sort()
    n = len(diffs)
    print(f'帧数: {n}  |  最小: {diffs[0]:.0f}ms  |  中位: {diffs[n//2]:.0f}ms  |  最大: {diffs[-1]:.0f}ms')
    print(f'推荐 debounce: {diffs[n//2]*8:.0f}ms (中位数 × 8)')
"
```
