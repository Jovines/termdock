# 移动端软键盘布局（当前约定）

2026-10-24：聊天复用 Terminal 布局后，用户已在 iPhone 上确认体验正常。本次公共提取保留这套几何关系；后续改动的浏览器测试不能替代新的 iOS 实机验收。

## 适用范围与布局关系

适用于全高工作区中“固定顶部导航 + 可压缩内容 + 底部输入/工具栏”。键盘打开时，导航和内容区域的上沿保持原位，内容可用高度缩小，底部栏上移到键盘上方；列表按自身滚动策略保留阅读位置或跟随最新消息。

普通表单、弹窗优先使用原生焦点和正常文档流，不要全局套用工作区补偿。原生容器若已负责缩高，也不能再叠加本补偿。

```text
App（保持基础高度）
├── 导航（不在补偿容器内）
└── 面板 root：flex-col / min-h-0，应用 rootStyle
    ├── 内容：flex-1 / min-h-0，应用 contentStyle，内部滚动
    └── 输入或工具栏：shrink-0，正常布局流
```

`useViewportHeight` 是全应用唯一的视口计算来源，统一处理基础高度、可视视口、安全区与键盘状态，并同步写入 `--kb-translate-y` 和 `--kb-margin-top`。页面消费这些变量，不另监听键盘高度。

设归一化键盘补偿为 H，面板整体平移 -H，内容上边距 +H：内容上沿的净变化为 0，flex 内容高度减少 H，底部栏上移 H。两项必须配对，且都关闭 transition，避免不同动画使顶部漂移。根容器沿用 `--app-base-vh`；不是把整个页面改为键盘弹起后的可视高度。**内容高度确实会变化，旧文档的“终端永不 resize”已经不适用。** 终端网格变化仍交给 `TerminalGeometry`。

## 公共入口与用法

几何入口：`src/lib/components/layout/keyboardPanelLayout.ts`。

```tsx
const touchLayout = usesTouchTerminalLayout();
const layout = getKeyboardPanelStyles(touchLayout && !ancestorOwnsKeyboardLayout);

return (
  <div className="flex h-full min-h-0 flex-col overflow-hidden" style={layout.rootStyle}>
    <div className="min-h-0 flex-1 overflow-y-auto" style={layout.contentStyle}>
      {content}
    </div>
    <div className="shrink-0">{composer}</div>
  </div>
);
```

这是一个不创建 DOM、不注册事件的样式原语，适合保留已有 ref、语义标签、拖拽事件和终端宿主。桌面或祖先已接管时传 `false`，不会产生 transform/margin。不要把 input 本身再做 fixed/absolute 定位，不在子组件重复计算 H。

已接入：

- `TerminalView`：root/content 配对；共享分屏时禁用自身补偿。
- `SessionChatView`：root/content 配对；输入栏与列表处于同一 flex 布局。
- `MultiTerminalView` 的共享分屏：复用 rootStyle，**保留原有整体平移与工具栏 portal 的语义**，不在此次提取中新增内容补偿。不能把这个仅 rootStyle 的特殊用法抄到新的聊天/表单页面；需要改变分屏顶部行为时应单独验收。

## 可见 iOS 输入框的焦点保护

`src/lib/hooks/useKeyboardFocusGuard.ts` 可供同类工作区中的可见 input/textarea 显式使用。键盘状态传入应用已有的 `useViewportKeyboardState`，不要新建高度监听。

它在 iOS 焦点切换期间短暂令真实输入透明，减少系统自动平移页面；共享布局稳定后恢复。真实输入保留焦点、值、选区与 IME。返回 `true` 时，调用方必须显示同内容的视觉镜像，并设置 `aria-hidden` 和 `pointer-events-none`，避免文字闪空或重复朗读；见 `SessionChatView` 的 `inputMasked` 用法。已透明的终端输入无需额外套用。硬件键盘、失焦及取消打开均有恢复路径。

这是焦点保护，不是第二套定位逻辑。普通弹窗无需默认开启。

## 禁止重新引入的做法

- 业务页面单独监听 `visualViewport`，自行算 keyboardHeight，或再减一次键盘高度。
- 修改 viewport meta、切换根节点高度模式、冻结列表画布高度来补救局部布局。
- 在键盘动画中强制 `window.scrollTo(0, 0)`，与系统平移互相拉扯。
- 用 fixed/absolute 把输入栏覆盖在内容上，或让父子重复补偿。
- 把 CSS 几何公式复制到聊天、抽屉等业务文件，或给平移/上边距加不同步动画。

## 回归与验收

```sh
npm run test:keyboard-layout
# 影响 TerminalView / 公共终端入口时还要运行：
npm run test:terminal-geometry
npm run test:terminal-geometry:browser
npm run lint
npm run build
```

公共几何浏览器用例覆盖重复开合、多个高度、桌面禁用和祖先接管；聊天用例挂载真实聊天及共享视口控制器，覆盖安全区、临时 offsetTop、草稿、最新消息可见和旧消息阅读位置。边界测试阻止业务组件复制几何公式。

`terminal-geometry.yml` 的 Linux CI 同步运行 `test:keyboard-layout`，让后续改动自动经过这些检查。

实机仍需检查 iOS Safari/PWA 的系统输入辅助栏、中文候选栏、重复开合、切换会话、横竖屏及硬件键盘；Android 使用对应系统键盘验证。报告中区分自动化结果和实机结果。发布按 AGENTS.md 构建并部署 9834。
