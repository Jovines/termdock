# macOS 终端输入法与焦点

用户报告：在 macOS 27 的最新客户端中，启动后可使用系统拼音，使用一段时间后输入源停留在 ABC，无法切回拼音；客户端所有输入框一起失效，重启客户端恢复。另一位用户未遇到。该现象尚未在 macOS 实机复现，不能把浏览器组合输入成功当成问题已解决。

所有输入框一起失效提示需要检查原生输入上下文，而不只是终端组合事件。[WebKit 的 `WebViewImpl::updateSecureInputState`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/WebViewImpl.mm) 中，同一个 WKView 的编辑区共享输入上下文；密码字段通过 `setAllowedInputSourceLocales` 限制输入源，普通字段应清除此限制。它提供了可检查的机制，并不能证明本次故障就是密码状态残留。还需区分输入源限制、Secure Input 与原生焦点状态。

## 已确认的焦点缺陷与修改

桌面终端使用自有 textarea 接收输入。xterm 的 helper textarea 原本只读，但仍可被其鼠标处理器聚焦；旧 focus 监听器再把焦点转回真实输入框。这次往返会触发真实 blur，取消正在进行的组合输入。mousedown 的 rAF 与 mouseup 的 timer 还会再次请求聚焦。

现在仅将 xterm helper 标记为 inert，使其无法获得原生焦点。画布仍接收选区、鼠标协议与滚轮事件；容器在 mousedown capture 阶段直接聚焦真实输入框，覆盖 xterm 强制选区会停止冒泡的路径。已聚焦时保持当前节点，移除延迟聚焦；终端内浮层控件沿用自身焦点行为。移动端保留原有输入路径。

## 自动化证据

`src/lib/components/terminal/desktopTerminalInput.browser.tsx` 使用真实 xterm、Swiper、浏览器鼠标事件与 CDP 组合输入。旧实现连续点击 5 次产生 5 次 helper 的真实 focus 事件；修改后组合输入期间点击不再触发真实输入框 blur。覆盖中文提交、右键、拖选复制、SGR 滚轮、普通搜索框往返与再次组合输入。该回归包含在 `npm run test:keyboard-layout`。

## 尚需 macOS 实机验收

在用户实际使用的签名客户端与 macOS 版本中，用系统拼音反复切换输入源、点击和拖选终端、打开右键菜单、切换会话/分屏、切换应用、最小化后返回，并长时间使用。确认菜单栏输入源能切换到拼音，候选窗出现且候选字只提交一次。

若再次锁定 ABC，在重启前记录客户端及 macOS 的精确版本，并比较当前终端、客户端普通搜索框、其他原生应用的输入源切换结果；检查当前 DOM 聚焦节点及其 readonly/inert/inputMode、原生输入上下文的 allowedInputSourceLocales，以及系统 Secure Input 的持有进程。不要通过自动强切系统输入源、周期性 blur/focus 或刷新整个客户端掩盖故障。

本次远程只读检查可连接的 Mac 为 macOS 27.2，但处于锁屏状态（`CGSSessionScreenIsLocked=Yes`），Secure Input 持有者是 loginwindow；这不是反馈用户的故障现场，不能当作 Termdock 导致安全输入残留的证据。未替换安装包或验收签名客户端的新行为。
