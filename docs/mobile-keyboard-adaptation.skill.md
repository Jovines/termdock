# Mobile Keyboard Adaptation — 开发检查表

权威规则与示例见 [移动端软键盘布局](soft-keyboard-adaptation.md)。

1. iOS 的输入位置由原生 focus 决定；不要加键盘高度平移，也不要启用透明焦点保护或 preventScroll。
2. root/内容/工具栏使用共享布局；系统缩小布局时自然收缩，系统平移时只补偿顶部与内容。
3. 位置来源是 DOM 实际位移，不是 visualViewport.height；业务组件不另建高度监听。
4. 同一祖先链只补偿一次；分屏在父内容层补偿，子终端退出。原生输入宿主保持挂载。
5. grid 副本撑高输入框，避免重置真实高度。空态顶部锚定，旧消息阅读位置稳定。
6. 保留内部原生滚动，用触摸边界阻止拖动页面，不在事后 scrollTo 纠偏。
7. 跑 test:keyboard-layout；涉及终端再跑两组 geometry 检查。浏览器测试不代表实机验收。
