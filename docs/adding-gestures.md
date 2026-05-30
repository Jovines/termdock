# 新增手势指引

面向在自己项目中加入新手势 handler 的开发者。读完约 3 分钟。

## 快速理解

`GestureManager` 是一个全局单例，替换了原来分散在 4 个文件里各自注册的 DOM 事件监听器。现在**所有手势都注册到 GestureManager**，由它统一派发、统一管理认领/释放。

```
GestureManager (一个 document capture 监听)
  ├── edge-swipe    (priority 100)      侧栏边缘滑动  【边缘覆盖条隔离】
  ├── long-press    (priority 90)       长按方向键 + 双击Tab
  ├── tmux-scroll   (priority 80)       tmux内滑动 → SGR序列
  └── normal-scroll (priority 70)       普通终端滑动 → xterm.js
```

## 三分钟写一个新手势

### 1. 选一个优先级

在现有优先级之间选空位：

```
 100  edge-swipe        ← 可放 95~99
  90  long-press        ← 可放 85~89
  80  tmux-scroll       ← 可放 75~79
  70  normal-scroll     ← 可放 65~69  (60 及以下)
```

选好后在 `src/lib/gesture/types.ts` 加一个常量，或者直接写数字。

### 2. 定义一个 handler

把它放在合适的 hooks 或组件附近。例如 `src/lib/hooks/useMyGesture.ts`：

```typescript
import { useRef, useCallback } from 'react';
import { useGesture } from './useGesture';
import type { GestureAction, GesturePointerState } from '../gesture/types';

export function useMyGesture(
  containerRef: React.RefObject<HTMLElement>,
  onActivate: () => void,
) {
  // 持久状态——用 ref，避免闭包过期
  const stateRef = useRef({ /* 你的状态 */ });

  const onPointerDown = useCallback(
    (e: PointerEvent, gs: GesturePointerState): boolean => {
      if (/* 触摸位置/条件不满足 */) return false;

      // 初始化你的状态
      stateRef.current = { startX: gs.startX, startY: gs.startY };
      return true;   // true = "我要认领这个 pointer"
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent, isClaimed: boolean): GestureAction => {
      const s = stateRef.current;

      // 追踪：无论是否认领都要更新状态
      // s.delta = e.clientX - s.startX …

      if (!isClaimed) {
        // 别人认领了 → 只追踪不做事
        return 'neutral';
      }

      // 我认领了 → 执行你的手势动作
      // if (手势确认) onActivate();

      return 'claim';    // 继续独占
      // return 'release';  放弃，让别人认领
      // return 'neutral';  只追踪，不改变认领状态
    },
    [onActivate],
  );

  const onPointerUp   = useCallback((e: PointerEvent) => { /* 清理 */ }, []);
  const onPointerCancel = useCallback((e: PointerEvent) => { /* 清理 */ }, []);

  useGesture({
    name: 'my-gesture',   // 唯一名称，调试用
    priority: 85,          // 你选的优先级
    container: () => containerRef.current,   // 惰性求值
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  });
}
```

### 3. 在组件里使用

```typescript
const MyComponent = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  useMyGesture(containerRef, () => console.log('手势触发'));
  return <div ref={containerRef}>...</div>;
};
```

完成了。不需要注册 DOM 监听器，不需要考虑 capture/bubble 阶段。

## 三种返回值的含义

| 返回值 | 框架动作 | 何时用 |
|--------|---------|--------|
| `'claim'` | 锁定 pointerId 到这个 handler<br>`e.preventDefault()` | 手势确认中/执行中 |
| `'release'` | 放弃认领权，下一个优先级的 handler 可以认领 | 确定这个手势不匹配 |
| `'neutral'` | 不改变认领状态 | 只追踪（还没确定是哪个手势） |

**同一次 move 事件，只有第一个返回 `'claim'` 的 handler 生效。**后续 handler 的 `'claim'` 被忽略，直到当前持有者返回 `'release'`。

## `isClaimed` 的作用

`onPointerMove(e, isClaimed)` 的第二个参数：

- `isClaimed === true`  → **你持有认领权**。执行你的动作（滚动、发送序列...）
- `isClaimed === false` → **别人持有认领权**。只追踪状态（距离、速度、`didMove`...），**不要执行动作**

**为什么需要这个？** 所有 handler 都会收到每一个事件。如果 tmux-scroll 在认领状态下发了 SGR 序列，normal-scroll 就不能再去调 `scrollLines`。

## 急认领 vs 懒认领

**急认领**（`onPointerDown` 返回 `true`）：
适合一摸就知道是它的手势（边缘滑动、长按）。pointerDown 时就锁定。

**懒认领**（`onPointerDown` 返回 `false`，在 `onPointerMove` 里返回 `'claim'`）：
适合需要滑一段才能确定的手势（纵向滚动）。初始只追踪，等轴确定后再认领。

## `container` 参数

```typescript
container: () => containerRef.current,   // 不写括号 → 取不到最新 ref
```

必须用箭头函数（惰性求值），因为 `useRef` 在第一次 render 时是 `null`，DOM 挂载后才赋值。直接传 `containerRef.current` 会在 ref 还是 `null` 时注册，导致 handler 匹配页面上所有 touch。

## 全局手势 vs 区域手势

### 区域手势（推荐）

指定 `container` 后，handler **只在 container 内的触摸上触发**。这是构建手势的首选方式——GesturManager 会自动跳过不匹配 container 的 handler。

```typescript
useGesture({
  container: () => containerRef.current,  // 只在这个元素内生效
  ...
});
```

### 全局手势 + 覆盖条

如果需要响应屏幕边缘等全局区域的触摸，而又不希望影响区域内其他手势（如 Swiper 的翻页），用覆盖条隔离：

```
┌─ 25px 覆盖条 ───┐               ┌── 25px 覆盖条 ──┐
│  z-index: 30    │   主内容区域    │    z-index: 30   │
│  pointer-events │  (Swiper/终端)  │                  │
│  : auto         │                │                  │
└─────────────────┘               └──────────────────┘
```

覆盖条是主内容区域的**平级兄弟节点**，不处于 Swiper 的 DOM 子树中。根据 DOM 事件传播路径，Swiper 从根本上收不到覆盖条上的触摸事件。不需要在 GestureManager 层面拦截。

参考实现：`src/App.tsx` 中的 `edgeWrapperRef` 和边缘覆盖条。

## 调试

在控制台执行：

```javascript
// 打开日志
window.__TERMDOCK_GESTURE_DEBUG__ = true;

// 查看所有已注册的 handler
GestureManager.getHandlers();
// [{ name: 'edge-swipe', priority: 100, hasContainer: true }, …]

// 订阅认领/释放事件
GestureManager.onChange(({ type, pointerId, handler }) => {
  console.log(type, pointerId, handler);
  // type: 'claim' | 'release' | 'complete'
});

// 查询当前状态
GestureManager.isAnyPointerClaimed();
GestureManager.getClaimedHandler(pointerId);
```

## 常见问题

| 问题 | 排查方向 |
|------|---------|
| 我的手势认领不到 | 打开 `__TERMDOCK_GESTURE_DEBUG__`，看是不是更高优先级的 handler 认领了。检查 `container` 参数是否生效 |
| 点击软键盘没反应 | `container` 写了 `containerRef.current`（非惰性求值）→ 匹配了全局 → 改成 `() => containerRef.current` |
| 两个手势同时触发 | 检查在 `isClaimed === false` 时是否还在执行动作 → 只改状态、不执行动作 |
| tmux 里滚不动 | 确认 tmux-scroll（80）能否正常认领。若被长按（90）抢了，检查长按是否在 `isClaimed=false` 时取消了 hold timer |
| 侧边栏拉不开/翻页不工作 | 边缘覆盖条是否正常渲染？`z-index` 是否高于 Swiper 低于侧边栏？`pointer-events` 是否正确切换？ |
