# 移动键盘工具栏定位

当前规则统一到 [移动端软键盘布局](soft-keyboard-adaptation.md)。

- iOS 的原生 textarea 位于底部工具栏宿主；系统负责避让，工具栏不按键盘高度平移。
- 顶部与内容根据页面实际位移补偿；内容 flex 收缩，工具栏是 shrink-0 兄弟。
- 分屏的输入宿主保持挂载，共同对齐到共享工具栏底边；父内容层只补偿一次。
- 不重复补偿键盘/安全区，不用 scrollTo 复位。

排障可启用 ?debug=keyboard,viewport,terminal；INPUT_VIEWPORT_GEOMETRY 数值日志记录正常/异常时的实际位置，不含输入内容。验证命令与实机范围见主文档。
