# 实际验证记录（2026-10-14，Linux）

这些是作者实测，独立评审另行复验。生产 macOS full embedded/Metal library、Objective-C 尚未构建成功（两轮失败见末尾），
真实 GUI/IME/性能未验收；Rust `check-native-api` 只 typecheck 宿主 API，不是 Mac link。

| 运行集合 | 结果 | 含义 |
|---|---|---|
| 原 fork pin + baseline-test.patch，Debug/freetype/OpenGL/noSIMD/none | 2677/2709 pass，3 fail，29 skip，exit 1 | 原 viewer 失败对照，未禁用 viewer |
| 产品 termdock.patch，同 Linux 配置的完整测试集合 | 2448/2490 pass，0 fail，42 skip，exit 0 | viewer feature 编译排除；不是完整原上游测试全通过 |
| 产品 `-Dtest-filter=Termdock` | 68/68 pass，exit 0 | 含 real Termio/External 测试和依赖 unnamed decl tests |
| Rust `cargo test --locked` | 10 pass | seq/ACK/gaps/failure/queue/close/replay/预算/注入 |
| Rust `check --features check-native-api --all-targets`、release build | pass | Linux API typecheck/transport 编译，无 Mac symbols |
| C pinned header `abi_check.c` | pass | C API 参数/enums 编译，不是完整 ObjC/Metal链接 |
| build.py `--prepare-only` + 故意篡改缓存未改源文件检测 | pass（篡改拒绝，恢复后通过） | 全 tar/header/zon/MSL/patch/逐文件完整性复核 |
| 单独 real External 契约 + strace | pass，flags=0 | 没有子 exec/clone/PTY；详见下文口径 |

## 原 pin 的失败对照

只在完整原 tar 上应用 [baseline-test.patch](baseline-test.patch)：Parser/OSC 对
`std.valgrind` 的 comptime 调用守卫；External 原测试把 undefined ThreadData 换为带真实
external tag 的夹具，避免 Debug assertion 读 undefined。没有改 viewer production 行为、
测试名称或 expected actions。生产 patch 包含同样的必要修复，但另有明确维护变更。

三个失败均 `expected 0, found 1`，保持原 viewer.zig 不改：

| 完整名称 | 原 pin 失败定位/步骤 |
|---|---|
| `terminal.tmux.viewer.test.initial flow` | viewer.zig:2695 `actions.len`，step i=14；测试入口2535 |
| `terminal.tmux.viewer.test.split CSI across output messages persists parser state` | viewer.zig:4274 `actions.len`，step i=11；入口4227 |
| `terminal.tmux.viewer.test.flow control: extended output feeds terminal` | viewer.zig:5589 `actions.len`，step i=11；入口5537 |

这些已在指定 fork pin 对照实证复现；不能据此归因 ghostty-org 主线，也没有修好原
viewer。这次用户允许不新增实验 -CC viewer；产品把 feature 真关掉，不能拿测试少了来
证明没有回归。普通 VT 的单独真实 feed 和完整变体测试结果另列。

## 重现命令

从仓库根设置仓库外 cache，Zig 必须恰好 0.15.2（官方分发散列在 lock）：

```sh
export td_cache=/home/qiao/.cache/termdock-ghostty/repro-final
python3 desktop-rust/native-terminal/ghostty/build.py --cache "$td_cache" --prepare-only
export td_engine="$td_cache/source/daiimus-ghostty-21c7173"
cd "$td_engine"
zig build test -Dapp-runtime=none -Demit-docs=false -Demit-xcframework=false -Dsentry=false -Di18n=false -Dfont-backend=freetype -Drenderer=opengl -Dsimd=false -j2 --global-cache-dir "$td_cache/zig-global" --summary all
zig build test -Dtest-filter=Termdock -Dapp-runtime=none -Demit-docs=false -Demit-xcframework=false -Dsentry=false -Di18n=false -Dfont-backend=freetype -Drenderer=opengl -Dsimd=false -j2 --global-cache-dir "$td_cache/zig-global" --summary all
```

原 pin 对照使用同一已验 tar、**另一个全新目录**，不要把产品 patch 再叠 baseline patch。
`td_module` 是交付 checkout 的绝对路径，随后运行上面同一完整 `zig build test` 命令：

```sh
export td_module=/absolute/checkout/desktop-rust/native-terminal
export td_baseline="$td_cache/baseline"
mkdir -p "$td_baseline"
tar -xf "$td_cache/source.tar.gz" --strip-components=1 -C "$td_baseline"
cd "$td_baseline"
patch -p1 --batch --fuzz=0 < "$td_module/ghostty/baseline-test.patch"
zig build test -Dapp-runtime=none -Demit-docs=false -Demit-xcframework=false -Dsentry=false -Di18n=false -Dfont-backend=freetype -Drenderer=opengl -Dsimd=false -j2 --global-cache-dir "$td_cache/zig-global" --summary all
```

Rust/ABI 命令（checkout 根）：

```sh
cargo test --manifest-path desktop-rust/native-terminal/Cargo.toml --locked
cargo check --manifest-path desktop-rust/native-terminal/Cargo.toml --locked --features check-native-api --all-targets
cargo build --manifest-path desktop-rust/native-terminal/Cargo.toml --locked --release
clang -std=c11 -Wall -Wextra -Werror -fsyntax-only desktop-rust/native-terminal/ghostty/abi_check.c
```

## 禁用依据和真实 feed 口径

固定 pin 的 terminal/build_options.zig 原来从 oniguruma 推导 tmux_control_mode；生产 patch
保持 regex/Kitty，而强制该 viewer feature=false。StreamHandler.tmux_enabled 为 false，
tmux_viewer 字段实际为 void，DCS hook 内 viewer init 的 comptime branch 不存在。
原 fork parse_table 的全局 ESC/CAN/SUB/C1-ST passthrough overrides 只在 true 生效。
使用 EXTERNAL Surface + private checked feed，不经过 Exec/init local shell。

新 `src/termio/td_contract.zig` **真实** Termio.init、External backend、StreamHandler/VT
parser、64-slot实际 mailboxes；GUI 只有 test callback，没有 AppKit surface/renderer/thread。
生产 private `td_ghostty_feed` 调用同一个 `Termio.tdProcessOutput` checked 入口。

重复 10,000 次下列一个完整 feed，初始化完成后读取 std.testing.FailingAllocator：

```text
ESC P1000p%begin 1 1 0 CR LF
%output %1 evil-pane CR LF
%window-add @1 CR LF
%end 1 1 0 CR LF
ESC \
```

累计 requested `allocated_bytes` 增量=0、累计 allocations 增量=0（不是 RSS、不是只看最终
free 数）；同一真实 Terminal 的 screens.all.count=1、80x24、external tag、没有 input
response，parser 最终 ground。不是 10,000 个 surface，也没启动 renderer，不能外推 Mac
RSS。随后同一 engine 喂 split Chinese UTF-8/SGR、application cursor/bracketed paste、
1049 alternate TUI 进入/退出，primary 中文内容保留；DSR response 恰好 ESC[1;5R；原生
输入 callback 输出 native-key；132x40 resize 回调计数从1变2；超预算 resize 拒绝且不变。
一次 feed 的 5,000 BEL 实际挤满 GUI mailbox；yield callback 排空次数>0且处理5000条，
不阻塞 renderer mutex。Screen history 与远端 Kitty file拒绝也有 real engine tests。

单独 syscall 核验通过 Zig 0.15.2 test server 协议（metadata 查完整名字，再 run_test该
index，不运行其它 tests）调用 real External 契约。只有测试二进制自身的 execve，
没有 clone/fork/vfork/子 execve，没有 /dev/ptmx、/dev/pts 或 TIOCGPT* ioctl。夹具自己
不初始化 Surface，也不启动IO/renderer线程；Mac生产surface的external-only guards另需
实机核验。整套68测试里的 unnamed `pty.test_0` 会打开通用PTY夹具，因此整套集合的
strace不是本模块runtime无PTY的证据。保留该观测，不隐瞒也不混淆统计口径。

## 原始证据（仓库外）

实际路径根 `/home/qiao/.cache/termdock-ghostty`，交叉评审可直接读取。direct logs 重跑完整
原 pin/产品 binary，用于逐项 skip 名称；与 Zig build 输出同结果。diagnostic脚本不入Git。

| 证据 | SHA256 |
|---|---|
| `test-baseline.log` | `1db965b1975fdbc863aa94993e3a05652d688fb491ae7eb3f6c91b9df8e9bbe5` |
| `baseline-direct.log` | `bfae00cff4af03a8d3c2d5c99cb273ea85fc78d8e377fa3a03ce49d48f1dfaf1` |
| `test-contract.log` | `df4b8da20add94fe9b7b3aa5f0066f09d22fb0e1a9f8a428fed91cfa65dc4dd9` |
| `test-product.log` | `60b3808ca7293cbc41b2c79da9ae91e1193cdde2e141409b60c41e6e428eb9a6` |
| `product-direct.log` | `868eae8c172607ee2f805c57db3ae4a5b51b26bb7baff22ec130f24912227130` |
| `external-only.strace` | `c06b334695131cba08fd62770a4bc4306ffb4b0cd4d36b8a6552d308f1fc1393` |
| `run-one-contract.py` | `7615a62bec1b92eb73e1c2a24b6d2aa671aadde7918457dc62d8203d3cb0d5e9` |

首次8f6bc47 的生产 patch SHA256 `0eb1bb054f47e491493b1c808857150b49f4f5cd06fc5f96fcda1f7661953b05`。

SDK/build-graph 修复后的当前生产 patch SHA256 `275b8cc14d216e179e9f5967ff5a2e86931c2ecaa2eef74de23287e1ea194168`；新增的变化仅 build.zig guard，未改 VT/输入/资源路径。上述完整 Linux 集合为首版结果，当前另重跑 Termdock filter 核验 build graph：68/68通过（45/45 build steps），日志 `/home/qiao/.cache/termdock-ghostty/test-sdk-graph.log`。

仅修复对照 patch SHA256 `88d4acad62e116c131ee1d777c316428de1bef35c4a9189c3c096bb83d6258cb`。

实际 Linux Zig 为 0.15.2 的 ziglang Python 分发二进制，路径
`/home/qiao/.cache/termdock-ghostty/zig-python/ziglang/zig`，全局dependencycache为同根
`zig-global`。Mac默认build.py下载官方已验发行包，此Linux工具来源差异如实记录。
完整生产测试 binary：patched/.zig-cache/o/9004b89411fcedc3688a7f9d29db4415/ghostty-test；
68测试 binary：patched/.zig-cache/o/38a6a1c0ce0c8e2b40f7ec677f66c1b3/ghostty-test。
单独strace重现命令（此helper为仓库外Zig test-server driver；内容和SHA可核验）：

```sh
python3 /home/qiao/.cache/termdock-ghostty/run-one-contract.py /home/qiao/.cache/termdock-ghostty/patched/.zig-cache/o/38a6a1c0ce0c8e2b40f7ec677f66c1b3/ghostty-test /home/qiao/.cache/termdock-ghostty/external-only.strace
```

## 跳过明细

两组共有29个未运行项如下。原因包括 Darwin 专属、fontconfig/coretext不可用、未提供
字体/环境、SIMD禁用，以及源测试自身skip；跳过不当作通过，字体整形/IME必须Mac补验。

- `input.key_mods.Mods.test.translation macos-option-as-alt`
- `font.discovery.test.fontconfig`
- `font.discovery.test.fontconfig codepoint`
- `font.discovery.test.coretext`
- `font.discovery.test.coretext codepoint`
- `font.discovery.test.coretext sorting`
- `font.Collection.test.hasCodepoint emoji default graphical`
- `font.Collection.test.face metrics`
- `font.DeferredFace.test.fontconfig`
- `font.DeferredFace.test.coretext`
- `font.shaper.harfbuzz.test.shape Devanagari string`
- `font.shaper.harfbuzz.test.shape Tai Tham vowels (position differs from advance)`
- `font.shaper.harfbuzz.test.shape Tibetan characters`
- `font.shaper.harfbuzz.test.shape Tai Tham letters (run_offset.y differs from zero)`
- `font.shaper.harfbuzz.test.shape Javanese ligatures`
- `font.shaper.harfbuzz.test.shape Chakma vowel sign with ligature (vowel sign renders first)`
- `font.shaper.harfbuzz.test.shape Bengali ligatures with out of order vowels`
- `termio.Exec.test.execCommand darwin: shell command`
- `termio.Exec.test.execCommand darwin: direct command`
- `input.key_encode.test.kitty: report associated with alt text on macOS with option`
- `input.key_encode.test.kitty: report associated with alt text on macOS with alt`
- `input.key_encode.test.legacy: alt+x macos`
- `input.key_encode.test.legacy: shift+alt+. macos`
- `input.key_encode.test.legacy: alt+digit with modify other state 2 and macos-option-as-alt = false`
- `input.key_encode.test.legacy: super-only on macOS with text`
- `input.key_encode.test.legacy: super and other mods on macOS with text`
- `simd.codepoint_width.test.codepointWidth matches uucode`
- `terminal.osc.parsers.iterm2.test.OSC: 1337: test Copy with non-empty value that is invalid base64`
- `os.i18n.test.canonicalizeLocale darwin`

产品另有13项 viewer-enabled 专属预期 skip（3 DCS + 10 fork transition）；原预期保持，未改 expect。

- `terminal.dcs.test.tmux enter and implicit exit`
- `terminal.dcs.test.tmux: ESC in block content does not cause exit`
- `terminal.dcs.test.tmux: 7-bit ST exits tmux control mode`
- `terminal.parse_table.test.dcs_passthrough: ESC stays in dcs_passthrough with put`
- `terminal.parse_table.test.dcs_passthrough: CAN stays in dcs_passthrough with put`
- `terminal.parse_table.test.dcs_passthrough: SUB stays in dcs_passthrough with put`
- `terminal.parse_table.test.dcs_passthrough: C1 0x80 stays in dcs_passthrough with put`
- `terminal.parse_table.test.dcs_passthrough: C1 0x9B (CSI) stays in dcs_passthrough with put`
- `terminal.parse_table.test.dcs_passthrough: C1 0x9D (OSC) stays in dcs_passthrough with put`
- `terminal.parse_table.test.dcs_passthrough: C1 ST (0x9C) stays in dcs_passthrough with put`
- `terminal.parse_table.test.dcs_passthrough: UTF-8 start bytes (0xC0-0xF4) produce put`
- `terminal.parse_table.test.dcs_passthrough: UTF-8 continuation bytes 0xA0-0xBF produce put`
- `terminal.parse_table.test.dcs_passthrough: all bytes 0xA0-0xFF stay in dcs_passthrough with put`


Viewer 模块本身的测试因实际 feature=false不再进入产品测试集合，所以总数不同；三个
原始失败保留在上面对照结果，不称“修复通过”。

macOS尚未执行：真实静态库/Objective-C build、shader/surface/Metal健康、同会话PTY/产品UI
接入、GUI性能与资源、IME/候选窗/连字/图片/搜索/overlay/DPI/生命周期、锁屏。只改
native-terminal/**，没有修改server/session/tmux/页面通信或其他成员WIP。


## 首轮真实 Mac 构建失败及源码修复

唯一操作者 xq4272yk 的新隔离root：
`/Users/qiao/termdock-build/ghostty-native-8f6bc47-xq4272yk`。
原始源码归档 SHA256 `77bcf8adfc0467727dc249ce12afa3d1903dfecef82de4823b4884df6b94845c`。
作者只读取操作者回传的本机日志，不执行 Mac 命令：

- `/tmp/termdock-ghostty-mac-8f6bc47/build-sdk27-failed.log`：SDK27/Zig0.15.2 runner
  链接 libSystem undefined，未到Ghostty编译。操作者核对SDK27/26.5 TBD只有arm64e-macos，
  现有SDK13.1有arm64-macos。
- `/tmp/termdock-ghostty-mac-8f6bc47/build-sdk13.log`：仓库外 SDK13.1 xcrun wrapper
  越过runner，但 build.zig:159 无条件 GhosttyXCFramework.init → iOS target →
  freetype/apple-sdk → DarwinSdkNotFound；关闭 emit 只控制安装，未控制初始化。

两轮均失败，未产生libghostty.a，ObjC fixture尚未编译，shader/surface/GUI无通过。
现在维护 patch 对 XCFramework 初始化加 emit-xcframework || emit-macos-app 条件；
Xcodebuild artifact 和 run-native 分支均加 emit-macos-app 条件。不能用macOS SDK伪充
iOS SDK或安装Xcode绕过。build.py新增 --sdk现有目录，进程作用域选择及真实 SDK
attempt/artifact provenance。Linux验证包含shell参数引用（路径空格/单引号）、父环境不变、
wrapper退出清理、missing SDK拒绝，以及iOS selector保持原样；这些是helper/源码检查，
不代表修复后真实Mac库已编译。继续由xq独立root重测。

首轮Mac日志 SHA256：

- `build-sdk27-failed.log`：`04412f22162bda50a381364e0dee0ae99882065baa11202799b95e495babac29`
- `build-sdk13.log`：`4adaeb02e115aaaf31107f28d39e63b5219f93d33d551aa74b9fe864444ae25e`

修复后 Linux filter 日志 SHA256：`b7161d07504cc9d33fb8173de3adebf6ba38057f0defb9ff04f222041af940d0`。


4391a55 已由唯一 xq 真实复跑：SDK13.1/emit graph 均越过，50/54 steps成功，
仍无库。pkg/macos/main.zig 的 C import 包含 SDK13.1 ObjC-only QuartzCore/CALayer.h，
引入 Foundation `@class`/NSObject 等21项C解析错误。维护补丁删除这个不需要的 C header；
层调用使用 objc dispatch，animation gravity constants本来就是显式 extern。

实际 compile target 13.0 原因经源码实查为 Config.init 在 Darwin 主机用
genericMacOSTarget 覆盖CLI并恢复默认13.0。修复保留genericCPU兼容措施，同时恢复显式
CLI os_version_min；真实新compile target及最终Mach-O minOS继续由xq核对，SDK13.1
存在不等于已验证min14兼容。header/minOS中间patch SHA256
`085cf437d55c71b25a82e94d08b23d7b51ff8c1b62eb5a5721779b02279e70e3`。

原日志 `/tmp/termdock-ghostty-mac-8f6bc47/build-4391a55-lib.log` SHA256 `31aeb48421e7bbcd5d54685a67b6f0eaac09bf1cefd04fdcf43c29e982013668`。


## 独立评审四项返工（td2，新源码）

独立评审对固定8f6bc47指出：80x24/requested5000的真实External夹具用当前400000 bytes
仅留1124行（仓库外 `/tmp/termdock-ghostty-review-4guuy0az`），断言>=5000失败。这是实际
体验回归，旧行/cell与bytes混用不可保留；不是调低Options.history或改viewer expected。

1. 真实行数仍用requested5000/tmux2000，effective上限为
   min(requested,100000,1000000/columns)。独立16MiB scrollback byte ceiling（0行则禁用），
   Packed Cell=8B还有row/style/grapheme/hyperlink/page slack，因此不等于logical cells。
   不预分配，不从initial width算一个偏小的bytes导致后续普通变宽失去容量。
   真实External新回归包含普通行、300行不同RGB/combining样式（触发页扩容）、primary
   inactive时宽到4096列前后裁剪、ALT恢复、收窄新输出重新填满5000/2000；被剪旧行不会
   复活。PageList另有32MiB live-page cap，createPageExt在任何节点/页分配前检查新页+
   旧页替换峰值；clone及ALT继承。rich-grapheme 64MiB capacity/替换峰值拒绝且
   FailingAllocator累计allocations不增长的实际PageList测试通过。这不是总RSS/GPU上限。
2. 普通resign/window失焦也取消marked/selectedRange/候选。生产实际使用
   native/TDHostState.c的cancel/mark/step调度，忙时保留clear，空闲先清Ghostty preedit，
   再运行新输入/新marked。overlay hide同一路径。discardMarkedText期间阻止commit/marked
   callback，interpret中的取消不发送旧accumulator。Linux直接执行生产调度器覆盖仍可见
   blur、busy blur、hide、refocus/新marked；不是另写mock状态机。真实Mac IME未验收。
3. 同一生产C转换分别使用左/右设备mask，覆盖四对modifier按下、另一侧仍按住时释放、
   最后释放、caps和未知keycode。Ghostty modifier ABI/页面Shortcut位值保持。纯C无
   AppKit/网络符号，Cargo也在Linux编译并执行；Mac physical keyboard未验收。
4. SDK/emit graph/CALayer/Config minOS前述干净中间commit已交唯一xq。64b5ab2真实重跑
   越过C-import错误且core compile target是14.0，但SDK13.1缺少
   kCVPixelFormatType_30RGB_r210声明，仍50/54 steps，无.a/ObjC/Metal通过。
   xq只读核对Apple SDK27 CVPixelBuffer.h:65为'r210'=0x72323130，SDK13.1:64旧30RGB为
   'R10k'=0x5231306b（padding/range不同，不能互换）。当前@hasDecl fallback仅补精确
   r210同值，保留新SDK声明优先，不改SDK、不替换像素格式。还需xq在当前新快照真实编译。

历史策略影响checkpoint含义，engine维护ID改td2（仍同fork pin、Replay v3），拒绝旧td1
replay，避免新历史容量重建成另一state却假称旧快照精确。恢复必须取同一PTY准确状态，
不重建本机shell或要求用户手动回切旧renderer。

新实际作者结果：Rust12/12、Linux release/API check、pureC和原header clang检查通过；
过滤集合70/70；最终完整产品集合2450/2492通过、42 skip、0 fail，45/45 build steps。
完整集合包括最终DCS production bytes/page cap和clone继承检查。原pin viewer3 fail/29
skip原日志及对照patch原SHA继续保留；旧产品2448/2490为首版，不拿新集合冒称原上游全绿。

真实普通行历史采样（Linux，与byte pool/runtime差异不能外推Mac RSS）：

| columns | requested | actual | live page bytes |
|---|---|---|---|
| 80 | 5000 | 5000 | 4546560 |
| 80 | 2000 | 2000 | 1818624 |
| 120 | 5000 | 5000 | 6365184 |
| 120 | 2000 | 2000 | 2727936 |

最终source lock/prepare重建通过，新的真实External单测试strace仍只有binary自己execve，
无child exec/clone/PTY。最终完整测试binary：
`patched/.zig-cache/o/5dd7e0f6155d343321eee56988fdcc5e/ghostty-test`。
原始证据都在 `/home/qiao/.cache/termdock-ghostty`（另注明的Mac回传在/tmp）：

| 证据 | SHA256 |
|---|---|
| `test-history-revision.log` | `0f030164fb57c6103e79651dba34e086b9c69e5db68e126b4f206505fd535f92` |
| `test-review-product.log` | `8c23b343dd859ac76ce2959b3eb61b549fdaa7f11292752e500c6ff968d6273a` |
| `test-review-rust.log` | `d2d75f52d7b572edb2fc03660f82d300f01559b7725140d848dcfebf0d2b3957` |
| `review-external-only.strace` | `e874d1e82cca4326a39a67d91467aa4e3c49e0035f218d387dcedaf5433c10fc` |

Mac64b5原日志 `/tmp/termdock-ghostty-mac-8f6bc47/build-64b5ab2-lib.log` SHA256 `c6651490a6a585415d3ecf83570dfbf830e344270b51affb440b02a83168db88`。

当前维护patch SHA256 `f8a9208441d31053de15b4bc6ec2615819fa57fae94972483da9ee2fa3af7e76`，engine ID `ghostty-21c717340b62349d67124446c2447bf38796540b-td2`。


0a535ab唯一xq精准Mac重试仍未出库：r210已经越过，真实target仍14.0，
剩 kCVPixelFormatType_4444AYpCbCrFloat 缺声明。操作者把 pixel_format.zig 全83个CV引用
与SDK13.1真实cimport对账，仅r210/r4fl两项缺失；SDK27 CVPixelBuffer.h:71 r4fl声明
fourCC为0x7234666c（AY'CbCr single precision floating-point 4:4:4:4），SDK13.1没有。
新维护patch与r210一样@hasDecl优先真实声明，旧SDK补同一r4fl数值，不替代格式。
该兼容只影响Darwin旧SDK编译，不改已通过Linux的VT/history/host调度；新patchSHA
`fc02c68a955e1475b35a9f8910ba779d70441f6c5fb06d150dcf86fbe2ac9cfc`。
未声称此修复已生成真实库，继续交xq固定新快照。

只读回传 `/tmp/termdock-ghostty-mac-8f6bc47/cv-enums-evidence.txt` SHA256 `2444da9e27600c29dd0d1cd6fd4bdebe3470d9da929a5d02e8ca0efe5248ef6b`。

只读回传 `/tmp/termdock-ghostty-mac-8f6bc47/build-0a535ab-lib.log` SHA256 `ff502a8ae7b3b962807427ecd80c2d1c59b50d1710d51b2a0c7aeb726c871ebc`。


3555584由唯一xq真实build.py exit0，产 `libghostty.a` 87031656 bytes；实际SDK13.1、
Zig0.15.2、target14，library SHA256
`b1de19adcf1b13378cda8ee05251589c799197f4822f7b76cd94006b79a8c4c3`。
libtool有 Mach-O archive member not8bytealigned/ignoring警告，**实际链接尚未验真**，
不把生成文件等同完整可链接库。随后真实cargo/ObjC只有TDGhostty.m parent cast的ARC
编译错误；本次仅把借用parent改(__bridge NSView*)，不retain/CFBridgingRelease parent、
不关闭ARC。引擎lock/patch/td2不变，xq可复用同provenance库重编crate/fixture。
还无fixture link/run/Metal通过。

原证据 `/tmp/termdock-ghostty-mac-8f6bc47/termdock-artifacts.json` SHA256 `f57b6aeebd2c10af86be09b99f8029abfd57e66873e9b6b8917d7b8729b1ef98`。

原证据 `/tmp/termdock-ghostty-mac-8f6bc47/build-3555584-lib.log` SHA256 `8a288e75eb161fd15d6a3ba8529c79866360274ebc116686c315a5dc1d61887b`。

原证据 `/tmp/termdock-ghostty-mac-8f6bc47/build-3555584-fixture.log` SHA256 `150b7017f42bb3638fc96fa53f2d1bca1f37d35e69df957639e695f14b939e21`。


99b4d38真实Mac ObjC/Rust compile已越过ARC，但fixture **link失败**，
FT/Oniguruma/ImGui/glslang/spirv_cross/SIMD/zig_os_log等arm64符号缺失。
原始日志 `/tmp/termdock-ghostty-mac-8f6bc47/build-99b4d38-fixture.log` SHA256 `6a55ac98facdf0c24cf3a3f92152504be7e03c4e0ba9e2e8ab6367e0d01e3c1b`。
355.a只代表生成文件，libtool ignoring unaligned members确实导致不完整归档，
不能将该产物记为可链接库。本次patch `f1ddcdabc2c1c4b04447fe950664026860ea61e06b92b2693578db4588ffb8c9` 修复聚合/索引，保留所有依赖：

- LibtoolStep读取每个GNU/BSD/Darwin regular ar物理成员，跳过旧符号/名字表，
  以顺序唯一m########.o提取，重复原成员名不覆盖，输入object内容原样不改。
- Apple libtool -static -filelist只接收独立原始Mach-O .o，重建归档与符号索引。
  不把旧archive直接交给CLT27，未移除font/Metal/SIMD/其它依赖。
- 合并后验证BSD符号表存在、每个唯一object恰好一次、数量一致、逐成员SHA256
  一致（只允许Darwin末尾<=7个zero padding）、实际object起点8-byte aligned。
  静默丢失/损坏/额外对象或unaligned一律失败，不发布新结果。
- td-lib安装share/termdock-ghostty/archive-members.json（每成员原名/索引/输入偏移、
  unique名/SHA/输出偏移/padding）；build.py验证其库SHA，并在artifact provenance
  记录audit SHA与object数量。Python采用build.py自身解释器，仍不改全局环境。

Linux `python3 /home/qiao/.cache/termdock-ghostty/test-archive-merge.py` 真实clang
arm64-apple-macos14对象：GNU/BSD/Darwin各3个同名long-name对象，合并9个对象
全部SHA/数量/对齐通过；故意丢1个对象、截断archive均被拒绝。
Linux合并测试使用Zig0.15.2 ar --format=darwin代替Apple libtool，**不冒充Apple链接验收**。
日志 `/home/qiao/.cache/termdock-ghostty/test-archive-merge.log`。
原理参照[LLVM ArchiveWriter Darwin alignment](https://www.llvm.org/doxygen/ArchiveWriter_8cpp_source.html)
（64-bit member8-byte；GNU仅2-byte）；Mac实际CLT行为以原始日志为准。
仅构建聚合改动，无终端runtime语义变化；新锁重新交唯一xq实际td-lib/fixture link。
尚无fixture运行、实际Mach-O minOS、shader/surface/GUI/IME/性能通过；用户Mac零操作。


4e72450由唯一xq在真实CLT/SDK13.1构建exit0，无旧libtool ignoring警告。
实际聚合审计230个objects、13个source archives；原始112个object起点未8对齐，
新起点全部8对齐；ext.o同名2个全部以unique名保留。作者只读核对回传manifest
与artifact数量、唯一名、偏移/padding和audit/library hash一致；原始object逐字节
验证由Mac实际执行锁定td_libtool.py产生，作者未在Linux拿到.a重做字节审计。
library SHA256 `ddf291ba920223d582c5f0913566f48f65f618ddd9628c330a42b489629329fa`，
audit SHA256 `533e25ba552b8970bbaf5bf2d4527420ddd7b8b499513937c7c2400b6fefa491`。
完整新库恢复先前FT/Onig/ImGui/glslang/spirv/SIMD等缺失符号；
随后SDK13.1 fixture link只剩__libcpp_verbose_abort（m00000171.o），仍是失败。
xq实查13.1 libc++.1.tbd无符号、SDK27有。固定Zig0.15.2自身
lib/libcxx/include/__configuration/availability.h 167-182/318-319将LLVM15的
VERBOSE_ABORT标注macOS13.3引入，要求min14未改变；不是通过升min27掩盖。
最终Cargo/ObjC改用现有SDK27，Zig库构建保持SDK13.1，README显式分开两个变量。
无fake verbose_abort shim、未禁用C++异常或删除依赖。SDK27实际link/Mach-O待回传。

4e原证据 `/tmp/termdock-ghostty-mac-8f6bc47/build-4e72450-lib.log` SHA256 `1a7656828523c494991850fdfdcd7475931bc7c8ce1e0fac938440ecca8357cb`。

4e原证据 `/tmp/termdock-ghostty-mac-8f6bc47/build-4e72450-fixture.log` SHA256 `c4dffdc07375fdbf6fcb8b8da66527050317816bb5a5506c6a883bd75851a529`。

4e原证据 `/tmp/termdock-ghostty-mac-8f6bc47/archive-members.json` SHA256 `533e25ba552b8970bbaf5bf2d4527420ddd7b8b499513937c7c2400b6fefa491`。

4e原证据 `/tmp/termdock-ghostty-mac-8f6bc47/termdock-artifacts.json` SHA256 `cb4a4e94bd4a0bb76929cd1947abeb2ec8466e432287634c9acfd5ba38267a80`。

4e原证据 `/tmp/termdock-ghostty-mac-8f6bc47/termdock-build-attempt.json` SHA256 `afe5e55b382e1d115a98e4162a8a60ddd45174544159bc6e5aae4921ead1e111`。


唯一xq真实4e72450最终link gate通过：Zig td-lib SDK13.1，Cargo/ObjC最终
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX27.0.sdk，
MACOSX_DEPLOYMENT_TARGET=14.0、CARGO_PROFILE_RELEASE_STRIP=none；
cargo build --locked --release --example metal_fixture exit0。
实际otool LC_BUILD_VERSION platform1/minos14.0/sdk27.0、arch arm64；
fixture SHA256 `ac31a26b79a60cffac1d0fa0101082951f579e6907990b81cad1e9336b0c5959`。
固定library SHA仍为 `ddf291ba920223d582c5f0913566f48f65f618ddd9628c330a42b489629329fa`；
所有前述archive/ObjC/C++链接阻断已真实越过，无假符号/删依赖/改minOS。
当前最终交付相对4e72450只更新README和VERIFICATION，生产代码/lock完全相同，
因此Mac证据明确对应被编译的4e72450，绝不把文档新HEAD说成另跑过。
完整失败及成功日志均保留。fixture **未运行**，runtime/MSL/surface/Metal呈现、
锁屏路径、GUI/IME/图片/搜索/普通tmux/Vim产品体验及RSS/GPU/idle仍未验收；
用户Mac零访问，不等于全体验替代完成。

实际link原证据 `/tmp/termdock-ghostty-mac-8f6bc47/build-4e72450-fixture-sdk27.log` SHA256 `fc4909c6e01d119bd949422e455ed274413cc4c0bf2120b8524a2d2be421bc7d`。

实际link原证据 `/tmp/termdock-ghostty-mac-8f6bc47/fixture-sdk27-libraries.txt` SHA256 `0432fbfc07411b4e22c2eebd4a1fe88d1aeb956257caad25fdea918415baedb1`。

实际link原证据 `/tmp/termdock-ghostty-mac-8f6bc47/link-success-evidence.json` SHA256 `2b59c9c382001270f58321480a79c91e17f231833269201989a02aa017d6290a`。
