# Pinned Sidebar — IME 候选框位置偏移

## 现象

桌面端左侧边栏 Pin 固定后，中文输入时 IME 候选框位置向右偏移约等于侧边栏宽度
（~305px），用户感知为"双倍右移"。终端内容和 cursor 本身右移是预期行为，但 IME
窗口的偏移量似乎叠加了一层额外的 offset。

## 相关文件

| 文件 | 作用 |
|------|------|
| `src/App.tsx:2090-2130` | `showPinnedLeft` 判断 + pinned 布局渲染 |
| `src/lib/stores/useSidebarStore.ts:20-29` | `readLeftPinned()` / `writeLeftPinned()` |
| `src/lib/stores/useSidebarStore.ts:265-395` | `leftPinned` 状态 + actions |
| `src/lib/components/sidebar/LeftSidebar.tsx:411-461` | `pinned` 模式下 inline 渲染 logic |
| `src/lib/components/sidebar/LeftSidebar.tsx:455-469` | Pin/Unpin toggle 按钮 |

## 当前布局方案（1.4.17）

```
<div class="w-screen h-full flex flex-row">        ← outer flex-row
  <div style="width:300px flex-shrink:0">          ← Sidebar 300px
  <div class="w-[5px] shrink-0">                   ← Resize handle
  <div class="flex-1 min-w-0 overflow-hidden">     ← Content wrapper
    {body: original flex-col layout with w-full}
  </div>
</div>
```

flex 分配宽度，无 padding/margin，终端通过外层容器获得正确宽度。

## 尝试过的方案及结果

| 方案 | 结果 |
|------|------|
| `flex-row` root + main `flex-1` (无 `min-w-0`) | main 宽度 33M px，布局崩溃 |
| `margin-left` on root | 布局正确，IME 偏移 |
| `padding-left` on main | 布局正确，IME 偏移 |
| flex-row 外层 wrapper + body `w-full` | 布局正确，IME 偏移 |
| 侧边栏纯 overlay 不移动终端 | IME 正常（终端没移动），但 UX 不对 |

## 已排除的原因

- **xterm.js 内部定位**：textarea 使用 `cursorX × cellWidth`（terminal-local），
  不依赖 `getBoundingClientRect`。CSS `left: 99px` 在 pin 前后完全一致，说明
  xterm 内部坐标无双重计算。见 `node_modules/@xterm/xterm/src/browser/CoreBrowserTerminal.ts:350-356`
- **Swiper transform**：translateX 不影响 textarea 的绝对定位参考系
  （最近 positioned ancestor 是 `.xterm-screen`）
- **`readLeftPinned` 默认值**：已修正为 `false`（之前错误地返回
  `matchMedia("(min-width: 1024px)").matches`）

## 根因分析

Swiper 的 `.swiper-wrapper` 始终有 `transform: translateZ(0)`（来自
`swiper-bundle.min.css`），按 CSS Transforms 规范创建了一个新的 containing block。

桌面端 IME 覆盖层 textarea（`TerminalViewport.tsx:3865`）使用 `position: fixed`，
但其 `left`/`top` 值是通过 `containerRef.getBoundingClientRect().left/top +
imeAnchor.x/y` 计算的——这是 viewport 坐标。由于 containing block 已变成
Swiper wrapper 而非 viewport，textara 的 `left`/`top` 实际是相对于 Swiper
wrapper 的偏移。

当 sidebar pin 后 content area 左移 ~305px，`containerRect.left` = 305，
Swiper wrapper 也在 viewport x=305 处。textarea 最终 viewport x =
`305 (swiper wrapper) + 305 (containerRect.left) + imeAnchor.x` = 610 +
imeAnchor.x → 侧边栏宽度被算了两次（"双倍右移"）。

Overlay 模式不触发是因为 `containerRect.left` ≈ 0，双重叠加的效应为零。

## 修复

`TerminalViewport.tsx:3910-3922`：桌面端 IME 覆盖层 textarea 的坐标改为
直接使用 `imeAnchor.x` / `imeAnchor.y`（terminal 内部坐标），不再叠加
`containerRect.left/top`（viewport 坐标）。imeAnchor 的坐标天然以 terminal
元素为基准，在 Swiper wrapper 的 containing block 下直接可用。

## 待排查方向

1. ~~Chrome IME 含 transform 时的坐标计算~~ → 已确认：CSS `transform` 创建
   containing block 导致 `position:fixed` 坐标参照系改变
2. ~~`overflow: hidden` 祖先~~ → 非根因
3. ~~ResizeObserver 未触发 xterm refit~~ → 非根因
