# Ghostty external terminal module

默认实现为锁定的 **daiimus/ghostty fork** `ios-external-backend`、revision
`21c717340b62349d67124446c2447bf38796540b`，完整 Zig VT/font/Metal surface。
Rust 只维护 transport/replay/backpressure 和 AppKit 宿主生命周期。旧 Alacritty
parser 和自写 Metal renderer 已移除。上游 ghostty-org 的 embedded 库不等于这个
fork 的 external-feed API；本模块也不把它称为稳定官方 SDK。

源码交付不代表桌面壳已接入或 macOS 已验收。仅唯一 Mac 操作者执行后面的构建和
实机 gate；本轮不访问用户停止操作的 Mac、不安装稳定 App、不修改服务端 PTY/tmux。
Linux 实测与原 pin 的失败对照见 [ghostty/VERIFICATION.md](ghostty/VERIFICATION.md)。

## 锁定与构建

[lock.json](ghostty/lock.json) 固定源码 tar SHA、verbatim header SHA、Zig 0.15.2
发行包 SHA、全部仓库 `build.zig.zon` SHA、原始默认 MSL SHA、两份 patch SHA 和
修改后的逐文件 SHA。Zig package 内容 hash 由对应 zon 固定。完整第三方源码、字体、
Zig 缓存、`.a` 和诊断输出均在 Git 外。Rust 依赖以本目录 Cargo.lock 固定。

维护补丁 [termdock.patch](ghostty/termdock.patch) 包含 external-only guards、消费错误返回、
IO barrier、GUI yield、实际 geometry/history 预算、Metal damage 统计，以及下面的
viewer 禁用。`ghostty.h` 保持原 pin 原样；Rust 绑定 private scalar ABI，Objective-C
直接按真实 header 编译 Ghostty 结构体，不猜结构体大小。

CLT 没有 `metal` 离线编译器。补丁将 **同一份原始默认 shaders.metal** 嵌入完整库，
使用 `newLibraryWithSource:options:error:` 创建原来的所有 Metal pipelines；没有改用
OpenGL、自绘 renderer 或 shader fallback。原 pin 只对 postshader 走 runtime 编译，
这个区别落实在 SharedDeps/shaders patch。实际 MSL 编译、首次 surface 时延和 Metal
呈现仍需 Mac 验证，失败应关闭 native，不能假称已完成。

由 xq4272yk 在新的独立 revision checkout 根目录运行（不要复用早期壳构建目录）：

```sh
export td_cache=/Users/qiao/termdock-build/ghostty-21c7173-td2
td_zig_sdk=/Library/Developer/CommandLineTools/SDKs/MacOSX13.1.sdk
td_link_sdk=/Library/Developer/CommandLineTools/SDKs/MacOSX27.0.sdk
python3 desktop-rust/native-terminal/ghostty/build.py --cache "$td_cache" --sdk "$td_zig_sdk" --jobs 4
export SDKROOT="$td_link_sdk"
export TERMDOCK_GHOSTTY_PREFIX="$td_cache/prefix"
export CARGO_TARGET_DIR="$td_cache/rust-target"
export CARGO_PROFILE_RELEASE_STRIP=none
export MACOSX_DEPLOYMENT_TARGET=14.0
cargo build --manifest-path desktop-rust/native-terminal/Cargo.toml --locked --release --example metal_fixture
```

Python >=3.12、rg、patch、arm64 macOS CLT/SDK、Rust/Cargo 和网络下载是构建依赖；脚本
自行校验下载 Zig 0.15.2。可显式 `--zig /path/to/zig`，此 override 验证版本并记录二进制
SHA，操作者负责它的来源。默认目标 `aarch64-macos.14.0`、ReleaseFast，完整 static embedded
core/font/Metal，不生成 XCFramework，不需要下载 Xcode。不能将 Linux headless test
所用的 OpenGL/freetype 配置当作生产构建配置。

首轮真实 Mac（原 `8f6bc47`）SDK27 runner 链接失败；xq 核对 SDK27/26.5 的
libSystem.tbd 缺 arm64-macos，现有13.1有该目标。`--sdk` 明确选择现有SDK，通过仅构建
子进程的 xcrun wrapper 和 SDKROOT 生效，不改全局 xcode-select、不安装 SDK。wrapper
不会把 iphoneos/iphonesimulator 请求映射成 macOS。Zig0.15.2 的 SDK 探测用 PATH xcrun，
单设 SDKROOT 不足。Cargo/ObjC 后续命令如上另用现有SDK27.0（cc读取SDKROOT），
Zig runner仍选13.1。13.1 libc++.1.tbd缺锁定libc++的verbose_abort符号，
LLVM availability将其标注为macOS13.3引入；本模块min14包含该版本，
不伪造符号或改minimum。最终link实际SDK须单列，不从Zig库SDK推断。

第二轮 SDK13.1 已越过 runner，却因无条件 XCFramework init 探测 iOS SDK 失败。维护
patch 现在仅在 emit-xcframework 或 emit-macos-app=true 时初始化 XCFramework，仅
emit-macos-app=true 初始化 Xcodebuild，包括 `run` native 分支。上述两个 emit=false 的
`td-lib` 已由 xq 重试越过 iOS graph；真正Ghostty编译随后在 SDK13.1 ObjC-only CALayer.h
进入 C import 时失败。当前维护patch删除不需要的C header，layers仍由objc dispatch，
并保留Darwin genericCPU时不再覆盖显式CLI minOS。4e72450已由xq实际完成完整库和ObjC/Rust fixture链接；实际Mach-O arm64、
minos14.0、sdk27.0，库生成使用SDK13.1、最终链接使用SDK27.0。
fixture尚未执行，MSL/surface/Metal/GUI/IME/性能仍未验收，详见VERIFICATION。

生成 `prefix/lib/libghostty.a`、header、精确 lock provenance 和 artifact SHA/SDK/command。
失败前也记录 `termdock-build-attempt.json` 的真实 SDK路径/版本、SDKSettings/libSystem TBD
散列与工具链/command；成功 artifact provenance另外包含库SHA。Cargo build.rs 检查
provenance/header/实际 `.a` digest 后链接。脚本对复用缓存内所有原始
文件和 patched files 校验，不只信任 marker。最终 App 必须携带
`prefix/share/termdock-ghostty/licenses/**` 全部许可证和 notices（脚本收集原仓库及本次
隔离 Zig dependency cache）；fork 完整 MIT 在 [ghostty/LICENSE](ghostty/LICENSE)。
本模块 Apache-2.0 不改变 Ghostty/依赖许可证。

给 fixture 的 palette 必须从现有唯一 token 文件生成，而非复制另一套色板：

```sh
node --experimental-strip-types --input-type=module - "$td_cache/palette.json" <<'JS'
import { writeFileSync } from 'node:fs';
import { FLEXOKI_DARK as t } from './src/lib/terminal/theme.ts';
const rgb = value => [1,3,5].map(i => parseInt(value.slice(i,i+2),16));
const names = ['black','red','green','yellow','blue','magenta','cyan','white',
 'brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'];
writeFileSync(process.argv[2],JSON.stringify({ansi:names.map(n=>rgb(t[n])),
 foreground:rgb(t.foreground),background:rgb(t.background),cursor:rgb(t.cursor),selection:rgb(t.selectionBackground)}));
JS
"$td_cache/rust-target/release/examples/metal_fixture" "$td_cache/palette.json"
```

## 宿主接口和线程

`macos::NativePanel` 为 `!Send + !Sync`；create、全部 host methods、pump、close、Drop
都必须在 AppKit 主线程。`unsafe create(NonNull<NSView>, Options, Ownership, font_size)`
只用于真实 authoritative fresh epoch。parent 是 WKWebView 与 native view 的共同容器，
需要活到 panel close；NSView 指针不传页面。`view_handle()` 在关闭后返回 Closed。
单 panel 仅一套真实 Ghostty surface/Terminal/renderer；primary/alternate 是同一 VT 的
标准两个 screen，不是备用 parser。多 pane/分屏仍由产品 UI 管理其独立远端 VT。

`Options` 包含 Font、columns、rows、history（请求历史行数）、由页面 tokens 导入的 RGB
Palette。Font family/features 有长度和 config 注入检查。创建强制 EXTERNAL、非空
write/resize callbacks，拒绝 command/initial_input/default Exec；页面控制既有远端身份，
本模块没有本机 shell/PTY、网络、密钥或上传。

`write(sequence, raw_bytes)` 连续 seq 从 1，单批 <=256KiB：

- `Submission::Pending` 仅表示占用唯一 in-flight slot，**不是 ACK**。
- 唯一 feed worker 串行调用实际 `td_ghostty_feed`，等 resize/prior IO barrier、feed、GUI
  safe-point drain、消费后 IO barrier。主线程 `pump()` 才给 `HostEvent::Ack`。
- 已消费 duplicate 可立即 ACK；gap、pending duplicate、oversize、busy 拒绝且不消费。
  失败可能已部分消费，关闭 surface，无 ACK，禁止同批盲重试，要求同会话准确恢复。
- 普通主线程配置/输入也经 IO barrier；几何/focus/search 等可能暂时 Backpressure，
  宿主保留 pending action，持续 pump，再重试。不能以入队返回值推进服务端确认。

Ghostty IO callbacks 进入有界 Rust EventQueue（1MiB、4096 events），IO 满时等待 drain，
主线程 callback 不等待。AppKit 输入另外限定 1MiB/4096 events、单文本256KiB；满时发
InputRejected，不静默丢键。引擎 mailbox 64 slots。一次 feed 塞满 GUI mailbox 时，parser
释放 renderer mutex，显式 yield 给主线程 app tick；其他 feed 时刻不进入 Ghostty GUI
变更。pump 先 drain callbacks，预留输入/协议响应 headroom，再处理 GUI safe point。
宿主必须及时 pump，不在主线程等待 worker；safe-point/barrier 30s 超时关闭，不 ACK。

`HostEvent::Input` 包括键盘、paste 和 VT 查询响应，由页面现有 `secureSocket` 发送。
`Resize` 同样走既有安全通道。Selection/Title/Bell/SearchRequested/CloseRequested 由宿主
转页面对应 UI；不在 native 发业务请求。`Shortcut{key_code,modifiers,key}` 交给已有页面
快捷键 dispatcher（modifier bits SHIFT=1 CTRL=2 ALT=4 SUPER=8 CAPS=16）。文本 Cmd+C/V
和 Cmd+F 已接本地 selection、Ghostty paste、search 请求；图像/文件粘贴发 PasteRequested，
宿主通过现有只读本地桥取数据，当前页面上传。此跨层接线仍是最终集成工作。

`set_rect(Rect{x,y,width,height,scale})` 是 parent 左上角 AppKit points，scale=backing scale。
内部转换 parent flipped 坐标，校验 Ghostty 实际 prospective font metrics 和所有中间尺寸。
零尺寸仅隐藏，不把 terminal resize 成零。LayoutRequested 后由宿主重新测量并设置 rect。
`set_visible(false)` 真实隐藏 NSView、撤掉焦点/preedit，隐藏期间仍 parse/pump；overlay
关闭后显示、空闲时 focus。DOM z-index 不足以盖住 NSView，宿主须正确 hide/clip。

关闭顺序为禁止新操作、关闭 callback queue 唤醒等待者、cancel GUI/barrier、join feed
worker、Ghostty free（join IO/renderer）、移除 NSView、释放 stable callback context。
普通resign/window失焦和overlay隐藏都取消marked/selectedRange与候选，不提交旧IME文本。
实际C调度器保留clear直到feed空闲，先调用Ghostty preedit("",0)，再处理新输入/新marked；
忙时不进engine，取消发生在interpret过程中也不发送旧accumulator。左右修饰键按各自
设备mask判断press/release，不用aggregate flag猜另一侧状态；caps和未知keycode单列。
这些生产函数在Linux直接执行回归，AppKit/真实候选窗仍需Mac验收。

需要转发剩余 Input 时先 drain；close 后仍可 `drain_events()`，不能调用 view/engine API。

## 回放与资源

Replay v3 = 精确 engine ID + 七项 Ownership（service/target/session/device/window/view/epoch）
+ 初始 Options/font_size + 有序原始 output/physical resize/palette/font/FlushSync journal +
消费 seq/viewport offset。拒绝跨身份、旧 Alacritty replay、旧Ghostty td1预算语义、错误 epoch/order/预算。新维护engine ID为td2，拒绝以新历史策略冒充旧checkpoint精确状态。checkpoint
会规范化 synchronized-output timer 状态并记录 FlushSync；split UTF-8/ESC 仍保持原字节。

`export_replay(&mut self)` 仅空闲时；`create_from_replay` 对 **真实** engine 逐记录重建，
历史查询响应、resize、bell 不返远端，结束只报告最终尺寸和 Ready。重建失败关闭，不让
半恢复 surface 接新输出。初始化/重建达到稳定 IO 才 Ready，未布局时 view 隐藏。

journal <=8MiB/32768 records（另有固定身份/初始 metadata）；超限清掉 journal但 live
output 继续消费。ReplayUnavailable 后需产品提供同一 PTY 的 authoritative checkpoint；
不从 xterm 可见纯文本伪造 state，也不新建远端 PTY。原产品跨 renderer handoff 的完整
raw checkpoint/选择与搜索 UI 状态接线尚未在本模块范围内完成，不能宣称全体验替代。

每个 surface visible shape <=262144 cells、u16 dimensions；同时校验旧列×新行、
新列×旧行及 DPI/font 中间形状。历史请求仍为普通5000/tmux2000等原值：有效行数 <=min(requested,100000,1000000/columns)。
Ghostty 的 scrollback-limit 是 bytes；Packed Cell本身8 bytes，另有row/style/grapheme/
hyperlink/page overhead，不能用cell数冒充bytes。独立固定16MiB历史byte ceiling（history=0
则禁用），不预分配；普通80/120列的5000/2000行已用真实engine验证，宽度变化前后清理
实际pages/pins，alternate无scrollback。超出行/cell限额会裁剪最老行；极丰富metadata也
可能先达到独立byte ceiling而少留行，不保证任意复杂内容无限保留。

External surfaces 的PageList增加32MiB live-page上限，扩容前包括旧页+新页替换峰值，
超出在分配前拒绝，feed失败关闭且不ACK。clone/alternate继承；primary inactive时同样
裁剪。Page pool预热/arena、并存snapshot、字体/图片/GPU另有成本，这个上限不等于总RSS。
被裁掉的旧行不能凭收窄复活；收窄后新输出能重新填满请求容量。
Kitty image storage 配置每 screen 32MiB；只允许 inline image 数据，拒绝 remote file/temp/
shared-memory 读取本机资源。字体/GPU资源有独立成本，真实总 RSS/GPU/瞬时峰值需 Mac gate，
不是这些逻辑预算自动证明低占用。

禁用 blink/vsync/custom animation；pump 不每 tick 请求 draw/refresh。renderer 在实际 damage
时计 attempts，提交成功才清 damage 并计 submissions，失败保留 damage。可读 render_stats，
静态 idle/隐藏/切换屏幕/复现错误的真实 Metal gate 尚未运行。

## 不新增实验 viewer；保留普通远端 VT

本产物在固定库 `terminal/build_options.zig` 真正把 `tmux_control_mode=false`，Kitty/regex
仍开启。StreamHandler 中 viewer/observer 字段编译为 void，DCS hook 的 viewer init 是
comptime 排除。并修复 fork 原本全局 DCS transition overrides，使关闭 viewer 时标准
ESC\\、CAN/SUB/C1-ST 终止正常；后续普通 VT 不会被吞。

这表示本轮不新增 fork 实验 `tmux -CC` native pane viewer，不是豁免现有产品功能。
现有服务端 `tmux -C` 命令控制是另一路，未改动；普通远端 tmux/Vim/fullscreen/alternate
VT 仍通过原引擎。若最终验证发现旧路径依赖 -CC，须报告并修复，不以 scope 排除回归。
原 fork 的 3 个失败测试名称、仅编译修复对照 patch 和完整复现见验证记录。

## 最终 Mac gate（未执行）

完整库/Objective-C 链接、真实 Metal shader/surface 创建、WK sibling overlay、同会话
恢复/断线/seq 背压/取消、shell/普通 tmux/Vim、多 pane、滚动/选择/复制、快捷键转页面、
中文/Emoji/combining/连字、IME marked/commit/candidate DPI、Kitty 图片/产品图片粘贴、
搜索UI/跳转、跨屏scale、隐藏继续消费、close/replay故障、idle submissions/资源峰值。
输入 host 已接相关接口，但未将引擎能力冒充上述实机验收。左右 modifier、
其他非 Kitty 图片协议及产品现有协议需实机逐项对照；不能要求用户手动切回旧 terminal来
假装兼容。锁屏恢复未测。没有速度/占用优于旧版的实测结论。

静态库聚合以每成员唯一文件名提取完整原始objects，再由Apple libtool重建索引，
避免CLT忽略输入archive中未按8字节对齐的成员。构建必须同时生成并核对
`share/termdock-ghostty/archive-members.json`，保留重复成员名并验证所有object的
数量/SHA/对齐；artifact记录audit SHA。库文件存在及该audit通过仍需真实fixture
链接验真，不能代替后续Metal/GUI/IME验收。
