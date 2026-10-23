# 移动键盘工具栏定位

当前布局规则已统一到 [移动端软键盘布局](soft-keyboard-adaptation.md)。本文件保留工具栏排障入口，避免旧定位公式继续作为开发依据。

- 工具栏和内容在同一个 flex 流，工具栏是 `shrink-0` 的底部兄弟节点。
- 布局使用 `getKeyboardPanelStyles`；内容变矮，顶部保持原位，工具栏上移。
- 可见性状态与位置职责分开；不要仅因工具栏隐藏就折叠其占位造成额外 resize。
- 共享分屏只有父容器接管平移，子终端禁用自己的补偿，工具栏 portal 到共享宿主。
- 不额外重复添加键盘高度、安全区补偿或 scrollTo。

排查时启用 `?debug=keyboard,viewport,terminal`，或设置：

```js
localStorage.setItem('termdock:debug', 'keyboard,viewport,terminal');
```

刷新后观察共享视口、焦点与终端尺寸日志。工具栏位置异常先检查补偿是否重复、root/content 是否配对、flex 内容是否缺少 `min-h-0`，再排查平台视口数据。验证命令和实机检查范围见主文档。
