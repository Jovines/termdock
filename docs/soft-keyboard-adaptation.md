# 移动端软键盘布局

2026-10-24：iOS 改为原生聚焦避让，聊天与 Terminal 统一使用实际页面位移稳定顶部和压缩内容。旧的 iOS “由 visualViewport.height 算 H，再整体上移 H”方式已停用。非 iOS 保留原共享兼容路径。

## 职责与结构

```text
根布局：CSS 100lvh，允许浏览器原生聚焦/平移
├── 顶部 chrome：补回实际页面位移
└── 工作面板：无作者添加的键盘平移
    ├── 内容：min-h-0 / flex-1，上边距补回实际页面位移
    └── 输入或工具栏：shrink-0，正常布局，由原生 focus 避让
```

输入框的最终位置由浏览器决定。若浏览器缩小布局，flex 自然收缩；若浏览器平移页面，读取根节点实际 getBoundingClientRect().top 的变化，向顶部和内容区补回该位移。设页面实际上移 P，顶部 chrome 的 transform 为 +P，内容上边距为 +P：顶部净位移为 0，中间可用高度缩小 P，输入栏没有作者平移。

`nativeKeyboardLayout.ts` 的 `measureNativePagePan` 不读取 visualViewport.height、offsetTop 或键盘高度。保留的同源服务工作区要叠加其 frame 的真实位移。根布局与保留 frame 使用 CSS viewport 单位，不使用可能错误的可视高度 API 决定输入位置。

`useViewportHeight` 仍负责共享视口状态与兼容路径，额外在原生滚动时更新 `--app-native-pan`；键盘开合状态不再是 iOS 输入位置的几何依据。不新增业务页面高度监听，不强制页面 scrollTo，不切换 viewport meta。

实际原生上移期间，根容器释放 Home 指示条的底部 padding，避免系统工具栏上方再留一份安全区空隙；实际位移回到 0 时恢复。顶部 chrome 使用局部 z-index 20，必须高于 Swiper 的 z-index 1 内容画布，否则位置已补回却仍会被背景盖住。对应回归同时检查真实命中层和安全区的释放/恢复。

## 公共入口

```tsx
const layout = getKeyboardPanelStyles(touchLayout && !ancestorOwnsKeyboardLayout);
return (
  <section className="flex h-full min-h-0 flex-col overflow-hidden" style={layout.rootStyle}>
    <div className="min-h-0 flex-1 overflow-y-auto" style={layout.contentStyle}>{content}</div>
    <div className="shrink-0">{composer}</div>
  </section>
);
```

`getKeyboardPanelStyles` 在 iOS 返回无 rootStyle 的原生路径，contentStyle 使用实际页面位移；桌面禁用时不添加样式，非 iOS 的兼容路径保留成对平移/上边距。导航 chrome 放在内容面板外，用 `data-termdock-window-header` 标记。

聚焦使用 `focusKeyboardInput`：iOS 不传 preventScroll，不把真实编辑器暂时设为 opacity:0。旧的 `useKeyboardFocusGuard` 仅保留给兼容路径，原生路径显式禁用，否则系统无法完成自己的聚焦避让。

## Terminal 与分屏

TerminalViewport 的真实 textarea 通过 nativeInputHost 放在底部工具栏边缘。文字与光标透明，但 opacity 为 1，让系统把它当作正常聚焦目标；画布另有触摸层处理终端滚动/长按。原有输入、IME、粘贴及权限处理仍绑定同一个输入 ref。

共享分屏的父内容层补偿一次，子终端关闭自身补偿。每个终端的工具栏输入宿主保持挂载；被抑制的工具栏只隐藏按钮区域。共享工具栏内宿主不创建独立定位块，所有输入对齐到共同底边，避免切换所有者时销毁或错位焦点节点。

## 输入框增高和滚动

聊天编辑器与 aria-hidden 文本副本共享 grid 单元。副本末尾追加空格以保留最后的空行，真实 textarea 随 grid 拉伸，达到最大高度后内部滚动。不要每次输入都先把真实输入高度改为 auto 再读取 scrollHeight。

空态按顶部定位，不随剩余空间重新居中，也不跟随消息末尾。已有消息仅在原本跟随末尾时保持最新消息可见；阅读旧消息时保持位置。

`useTouchScrollBoundary` 挂在聊天工作区/终端工具栏：内部 textarea 或列表能沿当前方向滚动时交给原生滚动，否则阻止纵向边界手势传到页面。点击、横向手势、多指动作不在 touchstart 阶段被阻止。不要全局禁止 touchmove。

键盘打开时浏览内容必须保留原来的聚焦节点，不做“先失焦，再 focus”的补救。聊天列表用 `usePreserveInputFocus` 拦截触摸合成的 mousedown 默认抢焦点动作，保留原生触摸滚动、控件点击、文本选区和草稿。终端画布采用真实 button 作为透明触摸层，和工具栏一样在 pointerdown 阻止默认抢焦点，滚动继续使用自定义指针手势。WebKit 的 shouldDismissKeyboardAfterTapAtPoint 会排除表单控件，但会收起点击大 div 时的键盘；这条 UIProcess 路径不能仅靠 DOM preventDefault 阻止。原生 Terminal 只由 pointerup 判断一次点击，旧 scroll-hook tap 回调不再重复处理。原生输入不切换 readonly、不延迟报告 blur，也不使用旧全屏 textarea 的重聚焦冷却逻辑。滚动手势只初始化一次，与键盘状态无关。

点击原生 Terminal 时同步调用同一 textarea 的 focus()，不能因为 activeElement 已相同就吞掉请求。WebKit 的 Element::focus 会把同节点请求转交 elementDidRefocus，WebPage 在输入视图已关闭时重新请求显示；不需要先 blur 或按视口高度猜测状态。系统文件菜单自行管理键盘，取消后也由下次真实点击请求输入，不另设手动结束/恢复流程。参见 [Element::focus](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/dom/Element.cpp)、[WebPage::elementDidRefocus](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/WebProcess/WebPage/WebPage.cpp)、[原生点击收键盘判断](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/WebProcess/WebPage/ios/WebPageIOS.mm)。

回归覆盖选择器取消、DOM 保持聚焦但模拟键盘已关闭、反复点击请求输入及 shell/tmux 两种手势路径。区分 focus() 方法调用与真实 focus/blur 事件：点击允许向同一节点请求输入，必须验证没有失焦、没有新的 focus 事件、草稿和选区不变；滑动则不发送 focus 请求。不能用“focus 方法不得被调用”的测试固化忽略点击的错误。

会话 Swiper 必须使用 `SESSION_SWIPER_FOCUSABLE_ELEMENTS`，将 Terminal 的输入锚点和聊天编辑器排除出 Swiper 的主动失焦策略。Swiper 在 pointerdown 与 pointermove 中直接对符合自身 focusableElements 的 activeElement 调用 blur；关闭 touchStartPreventDefault、禁用翻页或在内层 preventDefault 都不足以保护输入。保焦回归须带上真实 Swiper，验证点击、滚动、禁用翻页时均不触发 blur/focus 事件，同时保持聊天原生滚动。

## 回归与实机边界

```sh
npm run test:keyboard-layout
npm run test:terminal-geometry
npm run test:terminal-geometry:browser
npm run lint
npm run build
```

nativeChatViewport/nativeTerminalInput 浏览器用例挂载真实组件，故意提供错误的可视高度 API，再以浏览器原生 focus 滚动验证顶部、内容和输入位置，覆盖重复开合及输入框增高；另保留旧兼容路径回归。终端验证包含原生宿主中的输入和粘贴归属。CI 运行共享键盘布局测试。

这些是桌面浏览器对原生缩放/滚动模型的验证，不能代替 iOS Safari/PWA 的真实软键盘、系统辅助栏与中文候选栏验收。还需实机检查：反复开合、切换 Terminal/聊天/分屏、长草稿、选区、硬件键盘、横竖屏及保留的服务工作区。

## 持续异常诊断

`useInputViewportDiagnostics` 每次 iOS 编辑器聚焦最多采集三次数值快照，记录 INPUT_VIEWPORT_GEOMETRY：根/输入栏/输入框矩形、原生位移、视口 API、scrollY、安全区和真实根 padding。不记录草稿，不调整焦点或滚动。比较同一次 PWA 运行中的正常与异常状态，不能单凭截图就把原因归为动画迟到。

旧基准污染缺陷已有独立回归：原生页面偏移不再被当作高度缓存（原先 874 的基础高度可能被误写成 812）。这项修复与原生输入方案分别验收，不把它当成所有系统遮挡的解释。
