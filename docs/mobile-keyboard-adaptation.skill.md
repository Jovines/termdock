# Mobile Keyboard Adaptation — 仓库开发检查表

本文件是仓库开发说明。当前权威设计与示例见 [移动端软键盘布局](soft-keyboard-adaptation.md)，不要沿用旧版“根节点随键盘缩高 / 强制 scrollTo / resizes-content”的建议。

新增或修改移动输入工作区时：

1. 确认属于全高工作区；普通弹窗先保持系统默认行为。
2. 使用 `getKeyboardPanelStyles`，导航在外，内容和底部栏处于同一 flex 流。
3. rootStyle 与 contentStyle 配对，内容 `min-h-0 flex-1`，底部栏 `shrink-0`。
4. 确认只有一层负责补偿；共享分屏遵循文档的现有 portal 例外。
5. 只消费应用已有视口变量与键盘状态，不添加业务页面高度监听。
6. 同类 iOS 可见编辑器需要时使用 `useKeyboardFocusGuard`，配无障碍隐藏的草稿镜像。
7. 运行 `npm run test:keyboard-layout`，涉及终端再跑两组终端 geometry 测试。
8. 检查桌面、移动端、重复开合、草稿/选区/中文输入、阅读位置。浏览器模拟不作为实机通过。

几何机制、适用边界和排障入口统一维护在上述设计文档中。
