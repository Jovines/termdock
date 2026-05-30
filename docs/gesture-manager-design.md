# GestureManager 统一手势调度设计

## 1. 现状问题

当前 4 个 pointer 手势子系统各自独立注册事件监听，分散在 3 个文件，无统一收口：

| 优先级 | 子系统 | 文件 | 注册层 |
|--------|--------|------|--------|
| 1 (最高) | 边缘滑动开侧栏 | `useEdgeSwipe.ts` | `document` capture, 模块 import 时 |
| 2 | 长按方向键 + 双击 Tab | `TerminalViewport.tsx:914` | `document` capture, React useEffect |
| 3 | Tmux 触控滚动 | `TerminalViewport.tsx:656` | container capture, React useEffect |
| 4 (最低) | 普通触控滚动 | `useTouchScroll.ts` | container bubble, React useEffect |

冲突处理全靠 **capture-phase 注册先后顺序 + `stopImmediatePropagation()` 抢占**，没有显式的调停者。

**痛点**：
- 加新手势需要理解 4 层间的隐式优先级链，容易引入 bug
- 调试困难：事件被哪一层吃掉了不直观
- 现在连优先级都是靠"模块 import 时机"和"React child-first mount"保证的，脆弱
- 跨子系统协调靠 CustomEvent（`termdock:gesture-lock`），无法统一管理状态

## 2. 设计目标

| 目标 | 说明 |
|------|------|
| 单入口 | 所有 pointer 手势经过同一个 dispatch 流程 |
| 显式优先级 | 用数字代替现在的隐式注册顺序 |
| 每指针隔离 | 按 `pointerId` 隔离状态，多指不互扰 |
| 独占模型不变 | 一个手指的手势只能被一个识别器认领 |
| 行为零变化 | 现有所有手势行为完全不变 |
| 不影响非 pointer 事件 | compat mouse block / wheel / textarea 保持原位 |

## 3. 核心不是"收口成一个大文件"

正确方向：**收口调度逻辑**，不合并业务逻辑。

改造前后对比：

```
之前：                         之后：
  useEdgeSwipe 自己注册事件       → GestureManager 统一注册事件
  TerminalViewport useEff-1      → 4 个识别器注册到 GestureManager
  TerminalViewport useEff-2      → 每个识别器只写"命中条件 + 命中后干什么"
  useTouchScroll 自己注册事件    → 不再各自直接 addEventListener
```

识别器只需要关心三个问题：
1. 这个手指我能不能管？（`canStart`）
2. 这手势是不是冲我来的？（`shouldClaim`）
3. 认领之后，move/up 时我该干什么？（`onMove`/`onEnd`）

冲突和优先级交给中间层。

## 4. 核心类型

```typescript
// ---- 触摸会话（每指针一个） ----

interface TouchSession {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startTime: number;
  /** 当前坐标，随 pointermove 更新 */
  currentX: number;
  currentY: number;
  /** 总位移 */
  dx: number;
  dy: number;
  /** 已认领的识别器名，null 表示至今没有认领 */
  claimedBy: string | null;
  /** 识别器自定义状态（闭包内用） */
  meta: Record<string, unknown>;
}

// ---- 手势识别器 ----

type PointerEventType = PointerEvent;

interface GestureRecognizer {
  /** 唯一标识，用于 claimedBy 和 debug */
  readonly name: string;
  /** 优先级，数字越小越高（1-100），同优先级别由注册顺序决定 */
  readonly priority: number;

  /**
   * 首次接触：这个触点我能管吗？
   * 返回 false = 直接跳过，后续 move/up 都不给这个识别器。
   * 此时不应调用 preventDefault/stopPropagation。
   */
  canStart(session: TouchSession, event: PointerEventType): boolean;

  /**
   * 每次 move 调用。返回 true = 认领该手势。
   * 同一会话第一个返回 true 的识别器独占后续所有事件。
   * 认领前允许多个识别器同时"观看"move 事件。
   */
  shouldClaim(session: TouchSession, event: PointerEventType): boolean;

  /**
   * 认领后的 move（只调已认领识别器的此方法）。
   * 此时已由 GestureManager 统一调用 preventDefault + stopPropagation。
   */
  onMove(session: TouchSession, event: PointerEventType): void;

  /** 认领后的 up/cancel */
  onEnd(session: TouchSession, event: PointerEventType): void;
}

// ---- 管理器 ----

interface GestureManager {
  /** 注册识别器，返回取消注册函数 */
  register(recognizer: GestureRecognizer): () => void;
}
```

## 5. GestureManager 实现要点

```
                   pointerdown
                       │
                       ▼
   for each recognizer (priority asc):
       canStart(session, e) → false → 跳过（不再参与本次 touch）
                            → true  → 加入 activeRecognizers[]
                       │
                       ▼
                   pointermove
                       │
                       ▼
   若已有 claimedBy → 调该识别器的 onMove() → 结束
                       │
   若无 claimedBy   → for each activeRecognizer (priority asc):
       shouldClaim(session, e) → true  → 记 claimedBy，后续只给它
                                → false → 下一个
                       │
                       ▼
                   pointerup/cancel
                       │
                       ▼
   调 claimedBy 识别器的 onEnd()
   清理 session 和所有 activeRecognizers
```

**唯一文档级监听点**：`document` 上注册一套 `pointerdown/move/up/cancel` capture 事件，`passive: false`。

**preventDefault 策略**：只在认领后才统一调用 `preventDefault()`。认领前保留所有事件的原生行为，让未被认领的手势能正常触发浏览器默认行为（如滚动、Swiper 翻页）。

**主动释放 `canStart` 中已识别为"不归我管"** 的触点完全跳过。

## 6. 四个识别器迁移对照

### 6.1 EdgeSwipeRecognizer（priority: 1）

**当前逻辑**：手指落在屏幕左/右 25px 边缘，横向朝中心滑动。

```typescript
const edgeSwipeRecognizer: GestureRecognizer = {
  name: 'edge-swipe',
  priority: 1,

  canStart(session, e) {
    if (e.pointerType !== 'touch') return false;
    const vw = window.innerWidth;
    const x = e.clientX;
    // 必须在边缘区域
    if (x >= 25 && x <= vw - 25) return false;
    // 侧栏已打开就不触发
    const side = x < 25 ? 'left' : 'right';
    if (document.querySelector(`[data-sidebar="${side}"]`)) return false;
    return true;
  },

  shouldClaim(session, e) {
    const dx = session.dx;
    const dy = session.dy;
    // 纵向为主 → 不算
    if (Math.abs(dy) > Math.abs(dx) * 1.5) return false;
    // 必须朝中心方向
    const side = session.startX < 25 ? 'left' : 'right';
    const towardCenter = side === 'left' ? dx > 15 : dx < -15;
    return towardCenter;
  },

  onMove(session, e) { /* 更新进度，和现在一样 */ },
  onEnd(session, e)   { /* 判断 open/close 阈值，和现在一样 */ },
};
```

**差异关注**：当前 `canStart` 成功后立即调了 `preventDefault()` 阻止 Swiper。新方案在 `shouldClaim` 返回 true 后才 preventDefault。由于 edge-swipe 的 canStart 会在 pointerdown 立刻返回 true，但 shouldClaim 要到 pointermove 才返回 true → Swiper 会在 pointermove 之前看到第一个 pointermove 事件。需要验证 Swiper 是否在第一个 move 就开始追踪。

**缓解**：如果 Swiper 确实依赖 pointerdown 被 preventDefault，可以在 `canStart` 中让用户选择"激进抢占"标志，该标志为 true 时 canStart 立即也会 preventDefault。但这会破坏"统一在认领后才 prevent"的原则。折中方案：给 `canStart` 返回一个 `{ accepted: true, preemptive: true }` 对象而非纯布尔。

→ 实际上 Swiper 是通过自己的内部 pointer 事件 handler 来追踪的。当前 edge-swipe 在模块级注册，所以它的 pointerdown handler 先于 Swiper 的内部 handler 执行，它调用 `preventDefault()` 阻止 Swiper 启动。在新方案中，GestureManager 的单一 handler 也是文档级 capture，同样会先于 Swiper 的内部 handler（如果 Swiper 使用 Swiper 组件，它内部的事件处理也应该是）。只要 GestureManager 的 listener 注册时机和当前 edge-swipe 一样（模块 import 时），preventDefault 的效果就一样。

总结：如果 Swiper 需要通过 preventDefault 在 pointerdown 阶段被阻断 → GestureManager 用同样的机制（模块级注册 + 最高优先识别器在 canStart 返回 true 时同时 preventDefault）。

→ 更好的方案：为识别器增加 `preemptive: boolean` 选项。

### 6.2 LongPressRecognizer（priority: 2）

**当前逻辑**：手指落在终端区域内，350ms 不动 → 进入摇杆方向键模式；150ms 内同位置双击 → Tab。

```typescript
const longPressRecognizer: GestureRecognizer = {
  name: 'long-press-arrows',
  priority: 2,

  canStart(session, e) {
    if (e.pointerType !== 'touch') return false;
    // 必须在容器内
    if (!container.contains(e.target)) return false;
    // 不在键盘区域
    if (e.target.closest('[data-mobile-keyboard="true"]')) return false;
    return true;
  },

  /** 识别器内部状态 */
  holdTimer: null,
  mode: 'idle',      // 'idle' | 'holding' | 'arrow'
  lastTap: { time: 0, x: 0, y: 0 },

  shouldClaim(session, e) {
    // 双击检测在 pointerdown 就触发（当前也是）
    // 但在新模型里 shouldClaim 每次 move 才调 —— 这不行
    // → 需要增加 onPointerDown 回调
  },
};
```

**关键差异**：当前长按和双击的判断在 `pointerdown` 阶段就做了（双击立即认领，长按立即进入 holding）。`shouldClaim` 在当前设计中是每次 `pointermove` 才调的，错过了 `pointerdown` 时的双击。

**修正**：给识别器增加一个 `onPointerDown` 回调，在这里可以做立即认领：

```typescript
interface GestureRecognizer {
  // ... 原有字段 ...
  /**
   * pointerdown 时立即调（在 canStart 之后）。
   * 返回 true = 立即认领（不等 move）。
   * 用于需要在 down 阶段就抢占的手势（如双击检测）。
   */
  onPointerDown?(session: TouchSession, event: PointerEventType): boolean;
}
```

对于双击：
- canStart → 见上次 tap 时间和位置 → 如果匹配，在 onPointerDown 返回 true 立即认领
- 如果不是双击，开始 hold timer

对于长按 hold timer：
- 当前用 `setTimeout(350ms)` 实现
- 在新模型中：识别器需要能在非事件驱动的时刻认领手势（timer 到了后）
- → 增加 `session.claim(name)` 方法允许异步认领

```typescript
interface TouchSession {
  // ... 原有字段 ...
  /** 识别器调用以认领当前手势。仅未认领时有效。 */
  claim(name: string): boolean;
}
```

### 6.3 TmuxScrollRecognizer（priority: 3）

**当前逻辑**：tmux 模式下，手指垂直滚动 → 发送 SGR 序列给 PTY。

```typescript
const tmuxScrollRecognizer: GestureRecognizer = {
  name: 'tmux-scroll',
  priority: 3,

  canStart(session, e) {
    if (e.pointerType !== 'touch') return false;
    if (!isTmuxMode) return false;
    if (!container.contains(e.target)) return false;
    return true;
  },

  shouldClaim(session, e) {
    // 确定垂直方向后认领
    if (Math.abs(session.dx) > Math.abs(session.dy) * 1.06) return false; // 横轴
    if (Math.abs(session.dy) > Math.abs(session.dx) * 1.06) return true;  // 竖轴
    return false; // 方向未定
  },

  onMove(session, e) { /* 累积 remainder，SGR 发送，和现在一样 */ },
  onEnd(session, e)   { /* 惯性处理，和现在一样 */ },
};
```

**无特殊差异**，标准流程即可。

### 6.4 NormalScrollRecognizer（priority: 4）

**当前逻辑**：兜底滚动，传递给 xterm.js `scrollLines` 或服务端 tmux copy-mode 命令。

```typescript
const normalScrollRecognizer: GestureRecognizer = {
  name: 'normal-scroll',
  priority: 4,

  canStart(session, e) {
    if (e.pointerType !== 'touch') return false;
    if (!container.contains(e.target)) return false;
    return true;
  },

  shouldClaim(session, e) {
    // 和 tmux-scroll 同样的轴判断，但优先级更低
    if (Math.abs(session.dx) > Math.abs(session.dy) * 1.06) return false;
    if (Math.abs(session.dy) > Math.abs(session.dx) * 1.06) return true;
    return false;
  },

  onMove(session, e) { /* useTouchScroll 当前逻辑 */ },
  onEnd(session, e)   { /* tap/click 检测 + 惯性滚动，和现在一样 */ },
};
```

**注意**：当前 `useTouchScroll` 还做了 tap 检测和 click-to-coordinate。这些逻辑在 `onEnd` 中保留。

## 7. 不纳入 GestureManager 的子系统

这些与 pointer gesture 不同事件类型，保持原位不变：

| 子系统 | 原因 | 位置 |
|--------|------|------|
| Compat mouse blocking | 事件类型是 `mousedown/mouseup/click`，不是 pointer 事件 | `TerminalViewport.tsx` 不变 |
| Pinch-to-zoom (wheel) | 事件类型是 `wheel`，仅 `ctrlKey/metaKey` 时触发 | `TerminalViewport.tsx` 不变 |
| Blur guard (React 合成) | 纯副作用，不涉及 preventDefault/争抢 | container JSX props 不变 |
| Textarea keyboard | 输入层面，不走 pointer 事件 | `TerminalViewport.tsx` 不变 |
| Keyboard shortcuts (App.tsx) | `keydown` 事件，不冲突 | `App.tsx` 不变 |
| Swiper 内部触控 | 第三方库内部逻辑 | 通过 `allowTouchMove` 和 gesture-lock 控制 |

## 8. gesture-lock 替代方案

当前用 `termdock:gesture-lock` CustomEvent 协调 edge-swipe/long-press 和 Swiper。

新方案：GestureManager 提供状态查询和事件回调：

```typescript
interface GestureManager {
  // ... 原有字段 ...
  /** 是否有手势正在认领中 */
  readonly isGestureActive: boolean;
  /** 手势状态变化回调 */
  onGestureStateChange(callback: (active: boolean) => void): () => void;
}
```

`MultiTerminalView` 监听这个回调，替代 CustomEvent：

```typescript
// 之前：document.addEventListener('termdock:gesture-lock', ...)
// 之后：manager.onGestureStateChange((active) => {
//   swiperRef.current.allowTouchMove = !active;
// });
```

## 9. 文件结构

```
src/lib/gesture/
  GestureManager.ts          -- 调度核心 + TouchSession + 类型定义
  recognizers/
    EdgeSwipeRecognizer.ts   -- 边缘滑动
    LongPressRecognizer.ts   -- 长按方向键 + 双击 Tab
    TmuxScrollRecognizer.ts  -- Tmux 触控滚动
    NormalScrollRecognizer.ts-- 普通触控滚动
  index.ts                   -- 导出 GestureManager + createDefaultManager()
```

## 10. 迁移步骤

| 步骤 | 内容 | 风险 |
|------|------|------|
| 1 | 实现 `GestureManager` 核心 + 4 个空白识别器（只收口不干活） | 低 |
| 2 | 迁移 `EdgeSwipeRecognizer`，替换 `useEdgeSwipe` 内部逻辑 | 中 |
| 3 | 迁移 `NormalScrollRecognizer`，替换 `useTouchScroll` 内部逻辑 | 中 |
| 4 | 迁移 `TmuxScrollRecognizer`，替换 TerminalViewport 对应 useEffect | 中 |
| 5 | 迁移 `LongPressRecognizer`，替换 TerminalViewport 对应 useEffect | 中 |
| 6 | 去掉 `useEdgeSwipe` module-level 注册，改为 GestureManager 入口 | 低 |
| 7 | 用 `onGestureStateChange` 替代 `termdock:gesture-lock` CustomEvent | 低 |
| 8 | 清理死代码 + 删掉已被替代的 useEffect | 低 |

每个步骤可独立提交验证，不影响其他子系统。

## 11. 新增手势的成本对比

**之前**：
1. 分析 4 层 capture/bubble 优先级链
2. 决定自己的 handler 注册在哪一层、哪个 phase
3. 分析是否和现有的 stopImmediatePropagation 冲突
4. 可能需要调 useEdgeSwipe 的代码（module-level singleton 难改）
5. 测试各种手指 sequence 验证不被别人抢走

**之后**：
1. 写一个 GestureRecognizer，指定 `priority` 和 `name`
2. 实现 `canStart` / `shouldClaim` / `onMove` / `onEnd`
3. 调用 `manager.register(recognizer)`
4. 验证优先级是否正确即可
