# Preview native integration contract

This tree integrates the accepted bc52 Preview shell and 24ad Ghostty backend.
The integration changes the private engine patch to **td4**, with raw replay v4
and an independent version-1 durable cache. The Node/PTY/tmux and server protocols,
OPAQUE/Noise authorization, stable Electron and port 9834 are unchanged.

## Ownership and consumption

`view` is the frontend panel key; `session` is its **actual backend PTY ID**.
Service, target peer, window label and page epoch come from the trusted Rust shell;
the page supplies its public device ID as metadata, not authentication proof.
The connection stream epoch is distinct from the host page epoch. A token binds a
single main-thread NativePanel to that host context. Stale tokens, ACKs, decoder
bytes, queued controls and pending snapshots cannot cross a backend identity.
Geometry/UI readiness precedes backend creation; engine Ready is separate and is
required before streaming or claiming consumption. There is one active parser,
renderer, selection and history per native panel, with no xterm instance alongside.

Output batches are at most 256KiB, with one in-flight slot and 4MiB page backlog.
Only actual IO consumption ACK advances the native and server applied cursor.
An optional stream cursor on the final fragment is saved by Rust only on that ACK.
Pending means accepted, not consumed. Explicit unconsumed Backpressure alone is
retried at 16ms for at most 10s; idle panels have no polling timer or draw loop.
Event wakeups coalesce into one queued AppKit pump. Normalized input, query output,
resize, paste upload and file transfers use the page's existing encrypted transport.

## Recovery capability and limits

| Situation | Behavior |
| --- | --- |
| Same owner and complete consumed stream boundary | Rebind the living surface; full parser, image, selection and scrollback state remain, including after the raw journal exceeds 8MiB. |
| Raw journal within 8MiB and 32768 records | Exact ordered replay with whole-replay query/input suppression. Exhaustion releases the journal, never the living VT. |
| Fresh page / destroyed renderer | Restore only a validated durable entry with matching engine, public identity, dimensions, font and palette, then consume the original stream tail after its barrier. |
| Lost page during a partial event / no complete cursor | Cannot invent a stream cursor for intermediate native bytes. Recreate only the receiver from the previous durable entry if usable; otherwise request original same-PTY authoritative recovery with since=0. No remote PTY is created or cleared. |
| Damaged, expired, mismatched, absent or denied cache | Original same-PTY recovery. Bad asynchronous metadata restore retires its private receiver before recovery; it does not fail the whole client. |
| Stream epoch change, stale since, authoritative tmux replacement | Replace the rendering surface, including the unfinished parser/decoder, then consume the existing authoritative transaction. RIS inside unfinished OSC/DCS is not treated as a reset. |
| Native engine/host failure | Original renderer becomes available automatically only after a matching main-thread detach receipt. Clear native pending baseline and page buffer; preserve the original browser/Electron cache and service PTY. Failed detach remains an explicit error, never two active renderers. |

The old durable guarantee is shell SerializeAddon history **100** rows, a 256KiB
entry, 4MiB total, 32 entries, 24h and service-profile scope. It is not the entire
5000/2000 construction history. The final existing runtime policy is shell1000 /
tmux0; native follows that effect. The new cache independently retains primary tail
100 plus visible primary/alternate cells and necessary scalar metadata. The entire
entry including both screens, metadata, identity, options and header has one
256KiB limit. Capture uses fixed writers before formatting; outer serialization
also stops at a bound. No full-screen clone, second active parser, pointer snapshot
or formatter pin map is created.

Capture holds the actual IO renderer mutex after the native worker barrier while
checking parser ground, UTF8 decoder state, DCS/APC handlers and supported state.
ACK/idle alone is insufficient. Unsafe, Unsupported and TooLarge are distinct host
results and retain the previous durable entry. No CAN/ST/RIS is injected to obtain
a capture boundary. Loaded/loading Kitty images, cell OSC8 links,
status display and unsupported protection/shift states reject compact capture;
living-surface rebind retains them. Fixed scalar Kitty keyboard stacks and bounded
OSC133 cursor/row/cell semantic marks, redraw flags and click metadata are restored
within the same entry budget. Durable selection, image heaps and unlimited old
scrollback are not claimed. Original since=0 ring/tmux
capture/redraw is an authoritative protocol recovery, not a complete Ghostty
checkpoint. If a prior durable entry's tail is outside the server ring, original
protocol limits still apply; this is an explicit cold-recovery boundary.

Restoration writes both screen contents into a neutral private receiver, then
applies typed current/saved cursors, styles, charset, pending wrap, modes/saved
modes, effective mouse flags, previous character, region, row wrap flags, BCE
background cells and dynamic colors/palette reset state. It does not replay
1049/47/DECCOLM side effects as metadata. Historical query/input/resize/bell/title
remain suppressed until metadata and IO barrier complete. Real live DSR output
through the external IO callback is a Mac gate; Linux readonly VT tests ignore DSR.

## Layout, overlays and user actions

WK bounds and backing scale are read from the actual common NSView parent on the
AppKit thread. CSS rects and logical 6–100 font size convert using measured viewport
zoom. Engine dimensions are returned on living rebind, so unchanged rects cannot
leave the page at an artificial 80x24. Font family/features, regular/bold face,
spacing, line height, contrast, bright bold, palette and actual runtime history
follow existing settings. Exact pixel/face/ligature equivalence remains a real
visual gate; numeric weights select the available Regular/Bold faces.

DOM portals are CSS-gated before first paint until a real hide receipt. New overlay
geometry invalidates the gate synchronously in MutationObserver; it is not ACK.
Animating overlays keep native views hidden; settled overlays use host-clipped,
disjoint rectangle unions and hit-test holes. Closing resumes only after a new
host receipt. A failed hide requires actual detach before revealing overlays.
Hiding keeps output consumption and cancels AppKit composition; engine preedit
clearing remains ordered through its barrier. There are no privileged page pointer,
NSView, path, target, service or window overrides.

Original AppKit menu roles dispatch before terminal key handling. Shortcut commands,
search, user copy/select-all, file/image paste and close use existing page actions.
Title uses the existing coalesced shell-title store. Bell is delivered as a page
terminal event; the old viewport has no separate configured bell UI/sound action.
Native plain-path clicks reuse the original path matcher for soft/hard wraps,
wide/combining text and line suffixes, using only an explicit bounded read-only
engine cell slice (4096 cells / 256KiB) at click time. URLs permit only http/https/
mailto; file URLs route to the service explorer, never a local OS path insertion.
Actual modifier/IME/menu focus and clipboard behavior remain Mac checks.

## Build, resources and evidence

Install `scripts/native-resources-requirements.txt` in an isolated build Python
before `npm run prepare:native`. Conversion uses exactly seven existing whole
WOFF2 faces, verifies unchanged cmap and advance widths, registers SFNTs only in the
process and produces an exact path/size/hash/source manifest. CJK and symbol faces
are explicit fallback families. No new fonts, .a, source checkout or target output
enter Git. Runtime notices include pinned NerdFonts3.4/JetBrains and Noto licenses.
Symbols2's original subset lacks version/name/license metadata; its exact upstream
asset version remains unresolved and is stated in sources.json. Menlo-derived
StarSymbol is not duplicated into native font resources; system fallback visual
parity is pending.

Mac builds require the **new td4** lock; the old td2 prefix cannot be reused solely
because a marker exists. The build verifies source tar, patch, header, every patched
file, dependency hashes, complete archive membership and final library digest.
The packaging script checks prefix provenance and every license-index hash, copying
all `share/termdock-ghostty/licenses/**` notices including fork MIT. Fonts, embedded
engine renderer/shaper resources and CoreText system fallback serve the external
surface; shell-integration/PTY launch resources are not executed by this client.

Linux verification is a frontend/transport/engine contract check, not AppKit proof.
Original browser/Electron serialization path is retained in TerminalViewportInner,
TerminalView's nonnative startup/snapshot branches and unchanged cache utility.
The actual old79 router Chromium fixtures cover direct first URL and entry-only
relay, encrypted Rust chunk-reader upload and isolated HTML preview, with OS IPC
explicitly adapted by a harness. They are not Mac native integration acceptance.

Only xq4272yk operates Mac. The candidate handoff must include immutable full HEAD,
base merge list, source archive SHA, lock/patch/header hashes, bridge hash, runtime
resource manifest, measured source-tree hashes and original evidence paths. Build
Zig library with SDK13.1/Zig0.15.2, then Cargo/AppKit with SDK27/min14/strip=none.
Sign only the isolated Preview App with local Developer ID, verify arm64/min14 and
same-source App/DMGZIP/resources; do not publish/notarize/install on the user Mac.

The Mac product gate must verify actual WK sibling attachment/main-thread owner,
real feed consumption ACK, host epoch rejection, hide/clip/detach completion and
restore barrier/query suppression using controlled test data and normal production
capabilities. Standalone NativePanel fixtures do not substitute for this product
gate. If locked GUI prevents a safe actual-WK driver, record the concrete unavailable
step. Four-focus shortcuts, visuals, IME, effective clipboard, native notifications,
menus, tmux/Vim/fullscreen, downloads/media/background/update paths and 1/4/8-window
CPU/RAM/startup/latency comparisons remain pending until actual observation. This
source handoff does not claim complete UX/native/performance acceptance.

The follow-up uses engine **td4**. Before each screen's contents it resets SGR
and ASCII G0–G3/invocation; final typed metadata restores both screen pens and
charsets. Primary history now changes `no_scrollback` and the actual PageList
budget and trims immediately; alternate remains without history. Snapshot
metadata is a journalled stage followed by a real IO barrier, including the
LNM mailbox mirror, before replay suppression ends. Cursor comes directly from
the locked engine cell coordinates. Rejected/duplicate output never changes
replay flags. The previously added, unused `clear_screen` typed action is
rejected; the existing page Clear command still sends its journalled reset.

`layout` reports current dimensions only after `confirm_checkpoint` proves the
actual host idle/barrier complete; it submits no work. Preparation queries it
after creation, rect and restore. No-op rect and unrelated Ready/focus events
cannot fabricate layout completion. All DOM editable focus, including native
search, disables native first responder until it leaves that input.

A page-owned lease retains the CSS guard until a hide receipt or matching
main-thread detach. Temporary unmount keeps a confirmed hidden living surface;
explicit inventory removal/bulk clear and window destruction retire it.
Backend exit while the panel remains open retains its final live VT for viewing
and selection/copy, matching the existing renderer; a later backend identity
change replaces that surface before any new output. Failed cleanup
retains protection and provides safe retry, including a separate Connection
Center notice/retry so an unconfirmed sibling cannot cover the recovery UI.
Role-only overlay changes invalidate the gate; a double failure latches until
retry instead of spinning hide requests.

An actual product WK gate is now executable on the **build Mac** only:

1. Start the supplied external controlled fixture with Node. It prints a fresh
   `http://127.0.0.1:<port>` origin and implements discovery/auth-status only;
   it has no PTY or business implementation. Keep its stdout request audit.
2. Run the signed candidate's actual `Contents/MacOS/termdock-preview` with
   `--native-workspace-gate NEW_ABSOLUTE_DIRECTORY FIXTURE_ORIGIN`. The directory
   must not exist; startup creates it private, uses fresh configuration and a
   random WK data-store profile, skips stable bookmark/certificate discovery,
   and never overrides HOME. Port 9834, non-loopback hosts and existing
   directories are rejected. No production IPC permission/check is relaxed.
3. The ordinary bundled workspace loads in WK and the driver calls the existing
   origin/token-bound bridge. `native-workspace-gate.json` records each actual
   scalar/ACK/result and source revision, then exits 0 on pass or 1 on failure.
   A 120-second deadline produces a failure report. It reads terminal viewport
   text through the engine callback, never the system clipboard.

The gate covers actual WK/native sibling ordering and main thread, real feed
ACK, duplicate/gap/oversize replay hold, legal end barrier, durable ALT charset
and suffix/DSR equality, restored External CRLF, no-op and changed rect, stale
capability, actual hide/clip/show/detach, dynamic history, 36 close/create cycles,
and actual WK reload/new-page epoch with exact living baseline. `inspect` is a
read-only ordinary surface capability; it exposes scalars, never NSView pointers.
The driver is bounded once per host page epoch and once per actual document.

This is a **host/engine production IPC gate**, not a mounted React
NativeViewport/TerminalView flow or lifecycle observer/GUI acceptance. Linux
React/lifecycle regressions and build-Mac WK results remain separate. Real
focus keys, IME, shortcuts, visual/font equivalence, clipboard/media,
notifications, macOS14 runtime and performance are still pending until actually
measured. A compiled or signed candidate alone is not a replacement approval.

The dynamic history setter keeps the accepted **16MiB** effective scrollback
PageList ceiling; **32MiB** remains the separate total-page/replacement admission
guard. Zero/alternate history keeps active rows and disables scrollback. Those
page budgets do not describe total App RSS, font caches or allocator pools.
The real engine budget regression checks 80/120 columns with 5000/2000 retained
rows, nonzero/zero transitions, immediate shrink and resize, alternate exclusion,
and actual 120-column history clipped by the one-million-logical-cell ceiling.

The WK requester uses the exact global-action set without adding surface tokens;
explicit invalid fields are passed through and rejected by the production
`denyUnknown` contract. The actual Mac gate includes that negative request.
Successful consumption ACKs are recorded from the observed event with original
sequence/token/epoch, controlled stream cursor and step; Pending never creates
an ACK record. Failed reports and reload keep those existing records, bounded to
128 ACKs / 64 steps / 4096 observed events. Old 9d partial results have no raw ACK
rows and are retained as originally reported.


The diagnostic follow-up preserves the fixed f35 library and package evidence,
including its actual WK timeout. No f35 runtime steps or ACKs were recorded, and
none are reconstructed from older samples. Only the existing opt-in CLI driver
emits bounded progress: actual host page-start/epoch, page-finished/script
preparation and eval submission; JS entry, bridge wait, each request start,
return/error, consumption-ACK wait and observed ACK, completed steps and reload.
Title progress uses the gate nonce and is accepted only for the actual current
host page epoch, with monotonically increasing indices within that epoch.

The private `native-workspace-progress.json` atomically retains the latest stage,
source/nonce, original recorded ACKs, the latest 128 action/stage events with
a dropped-stage count, and at most 16 host page events. It is capped
at 80KiB, with 64KiB incoming title messages and at most 2048 progress updates;
request bodies, output/base64, snapshots and system data are not logged. Progress
retains the existing 128-ACK/64-step/4096-event limits. Reload restores existing
steps/ACKs before waiting for its new bridge. The unchanged 120-second process
deadline merges the latest actual evidence into its failure report; a missing
script start remains visible as host-only evidence rather than fabricated steps.

Each driver request has a 12-second Promise deadline. A timed-out request records
its action/capability/sequence and reports consumption unknown, then ends the run
without resubmission. Only explicit unconsumed Backpressure is retried with the
same payload/capability/sequence. A timeout in a negative test is not accepted as
proof of a production rejection. Pending receipts never create ACK records. This
instrumentation is inactive in ordinary startup and changes no normal IPC schema,
origin/context permissions, production capability or Ghostty library source.
New product compilation/signing and actual WK execution are required at the new
source revision even when the verified f35 library provenance is reused.


The next diagnostic revision keeps a840's failure evidence unchanged. It records
sanitized URLs at the ordinary WK navigation-policy and page-load hooks, showing
which hook observed the URL without guessing a user/JS navigation cause. URL
userinfo/query/fragment are removed, paths are bounded to 256 characters and
non-HTTP(S)/Tauri opaque URLs (including data/file/blob) reveal no payload/path.
Script eval submission and its actual `eval_with_callback` return are separate.
A synchronous wrapper reports its eval return, prior document driver epoch and
finished/cancelled status, IPC/invoke presence and bounded pathname. An empty
callback is recorded as empty: pinned Wry discards NSError and this gate does not
pretend to recover it or prove the asynchronous driver finished.

Native dispatch trace is active only in the opt-in gate. It records a host request
ID, action, window/page stamps, caller rejection or return, context validation,
main-thread host scheduling/entry/return, font registration and engine create
start/return. It logs no request bodies or output. The latest 128 native events
with a dropped count join at most 32 host events within the same 80KiB private
progress file. Normal schema, caller/context/capability checks, rendering and
library code are unchanged; these hooks do not grant an extra operation.

The document guard distinguishes same-epoch duplicate eval, an ended driver and
an old pending driver in a reused JS context. Crossing an unexpected host epoch
records the old request as unknown and stops without another create. A cancelled
old driver's late result cannot publish new progress or produce a new ACK. A fresh
document also receives the old evidence and stops on unexpected navigation.
For the planned controlled reload only, Rust confirms receipt of the bounded
reload-intent stage before JS reloads. That diagnostic receipt is never a feed
consumption ACK or a stream baseline; normal rebind still proves the consumed
checkpoint. This makes planned reload distinguishable even when WK coalesces title
notifications. All actual native/WK outcomes require the new immutable Mac run.


The delivery follow-up does not infer missing fa73 steps/ACKs from its 239 host
requests. Large JSON titles were an unreliable evidence channel: the previous
receiver silently ignored parse failures. The exact WK failure cause is not
claimed from that observation. Titles now carry only a nonce/actual epoch/index
notification, at most 512 UTF8 bytes. The driver preloads an immutable JSON wire
snapshot separately, bounds steps/ACKs/stages before serialization and UTF8 bytes
to 64KiB after serialization. Final results use a distinct monotonic signal index
so unchanged-title deduplication cannot hide the final state.

The opt-in receiver evaluates one fixed expression reading only that driver's
preloaded wire snapshot. It checks the string/UTF8 bound before parsing and the
callback byte bound, version, nonce, current actual window/epoch, index and entry
counts after serialization. It accepts a newer cumulative snapshot when title
notifications coalesce, treats identical reads idempotently, and rejects late old
epoch/read callbacks. No page-supplied JavaScript or arbitrary-global reader is
accepted. At most one read is in flight with one pending latest request; at most
2048 reads are issued. A 12-second read timeout ends the run, never queues a
parallel replacement or resubmits a native write. Existing native invoke 12s and
whole-process 120s deadlines remain unchanged.

Receipt/rejection reasons and bounded lengths/nonce/epoch/index metadata are
recorded explicitly in stderr and the private atomic
`native-workspace-delivery.json` (latest 64 events, 32KiB, 4096 total events).
Progress and final reports use complete compact JSON capped at 80KiB including
the native ring and host events. Oversize produces an explicit failure while
retaining the previous valid stage file; JSON bytes are never truncated into a
success. The producer limit leaves old valid evidence intact on rejection.

A successful native checkpoint dispatch schedules just one opt-in fixed producer
read after 20ms, using the same single-read/coalescing policy. This is a bounded
critical-boundary fallback when notification delivery is lost, not an idle poll
or a read on every native trace. Only the actual producer phase, original recorded
ACKs and step results are saved; the checkpoint response creates no ACK. Planned
reload waits for a nonce/old-epoch/index diagnostic receipt from the persisted
producer snapshot before navigation. That receipt never advances the stream
cursor. The new immutable App still requires actual Mac execution and signing;
all earlier fa73/a840/f35 failed runtime evidence remains unchanged.


The text-free follow-up fixes a source ABI defect confirmed against the pinned
header and the owned 1c App crash: `ghostty_surface_free_text` now accepts
`(surface, text)` as declared in the unchanged public header. It ignores only the
context argument and releases the second argument with the original
`global.alloc`, exactly once per successful read. A compile-time check on the
actual export type accompanies the patch; the C ABI probe also covers the header
function pointer. All four ObjC read/copy/selection-release sites already pass
these two arguments and remain unchanged. Read failures do not free an output
that was never allocated; the existing oversized-text rejection still releases
the successfully allocated buffer. Text deinitialization does not become
idempotent, and callers must never free the same nonempty result twice.

This changes the engine patch and patched embedded source digest and requires a
new actual library build/audit/provenance. The f35 library cannot be reused as the
fixed artifact. Raw replay v4, durable v1, and engine state format td4 remain
unchanged: this repair changes the C ABI implementation, not the serialized state
schema. The frozen 1c run only passed two recorded steps and four original ACKs
before its SIGABRT; no final gate JSON was produced.

The new opt-in product driver performs repeated empty viewport reads, missing
selection fallback, Unicode viewport reads and nonempty selection reads before
and after durable restoration. It checks continued feed/resize after reading,
using ordinary production capabilities and no OS clipboard. Its selection
callback matcher binds the original token and epoch. A separate driver regression
also reaches the reloaded document's completion branch and prevents the local
inspection result from shadowing driver lifecycle state. Actual new Mac execution
is still required for these assertions. AppKit menu/CmdC/mouse interaction,
clipboard, real React/UI and performance remain separate pending gates.

The next React candidate adds `--native-react-workspace-gate NEW_ABSOLUTE_DIR
LOOPBACK_FIXTURE_ORIGIN OWN_FIXTURE_DESCRIPTOR`. It loads the ordinary packaged
App, submits its normal password/invitation DOM, and automatically mounts
TerminalView → TerminalViewport → NativeViewport. The fixture is the existing
fixed 79feaf2442dd71a06806cc652252e9a7db4b54fb OPAQUE/Noise router with an isolated
bounded inventory/LogicalSocket terminal protocol model; it creates no PTY.
Start it with `TD_PREVIEW_OLD_SERVER_ROOT=<fixed-source> node --import tsx
desktop-rust/scripts/browser-server-fixture.ts --native-react`, adding `--relay`
for entry-only. Save its first stdout JSON verbatim to an owned absolute file and
pass that descriptor as the fourth gate argument. The process accepts `done` on
stdin and emits its actual original flow-control/inventory events at shutdown.

`controlledTargetPeerId` is a private diagnostic descriptor field. Direct startup
still has no normal target peer pin. The ordinary validated saveConnection hook
can record a single unpaired → exact owned target handoff, only for the current
owner window/old page epoch, canonical fixture URL, persisted login-submit-ready
stage and zero native calls/steps/ACKs. The driver waits for that diagnostic stage
receipt before requestSubmit; it does not mark authorization successful early.
Only the following document can consume the pending handoff, and it checks the
actual saved page target. Prior stages retain their original epoch. Unexpected
navigation, wrong target and repeated handoffs remain rejected. Receipts grant
no IPC capability and are never output-consumption ACKs.

The component driver verifies actual native Ready/attachment and stream ACKs,
input through the normal encrypted socket, same-backend reconnect, real settings
DOM overlay hide/resume, existing session-menu rename editable focus release,
stream epoch/backend identity replacement, actual WK reload, backend exit retaining
final text, normal DOM user close and external inventory deletion. It uses the
existing production menu/controller events and DOM controls; it neither imports
React internals nor emits fabricated native events. Read-only Inspect.focused
reports the instantaneous actual NSView firstResponder identity, not physical
keyboard/IME behavior. Search lacks a safe current command entry and stays pending.

Accepted inventory membership removals now retire missing frontend IDs. Loading,
failed GET, rejected/stale snapshots, same-ID backend exit/rename and temporary
remount do not destroy receivers. JS retry checks captured target/bridge/lease and
current absence. The host captures bounded pointer-free window/service/target/view/
token metadata before queuing AppKit close work; actual drop checks the captured
per-view generation. Bulk close drops only captured matching tokens and returns
the actual retired list. A new/rebound/restored receiver is preserved. NSView and
engine remain exclusively in main-thread TLS.

The two new Chromium tests use browser eval with a bounded awaited polling loop,
not agent-browser wait with an async expression (that CLI accepts the Promise
before its condition becomes true). Both assert original second-open incremental
since, actual flowSeq/applied since/stream epoch and zero public business requests.
These browser tests exercise the ordinary xterm renderer/production bundle and
real encrypted transport; they do not validate a Mac NativeViewport. The first two
failed wait variants remain external immutable evidence.

The repaired 9e actual Mac host gate passed 16 recorded steps/14 original ACKs and
natural exit0. This candidate keeps every Ghostty library build input and lock
exactly identical to 9e, allowing strict reuse of its verified d7048503 library /
c093aadf audit after all source/header/provenance checks. The AppKit wrapper,
product Rust and opt-in driver changed, so new actual product C/link/sign/WK
component tests are mandatory. Real React/WK results have not yet been obtained.
Actual keys, IME, visual review, OS clipboard/notifications, performance, damaged
cache after a fresh process and real shell/tmux remain separate pending gates;
no user Mac, TCC or production listener is used by this fixture.

The b976 actual Mac React run failed before native mounting in both routes and
remains frozen: direct wrote a 120s timeout final but needed an owned 135s
SIGKILL/-9; relay naturally exited1 after its form-acceptance deadline. Both had
zero native dispatch/steps/ACKs and zero terminal model events. The direct pairing
diagnostic was called while saveConnection held the window registry mutex, then
page_epoch tried to acquire that same mutex. The follow-up returns plain old/new
connection metadata from the registry update, releases window/config locks,
persists the normal store successfully, and only then invokes the opt-in hook.
A production-update regression checks the actual registry/profile/port transition
and both mutexes available for the subsequent page-epoch read; no production
caller/identity validation is bypassed.

The relay driver previously waited for an enabled input but filled the document's
first password input, and its explicit `[type=submit]` selector omitted the normal
invitation form's default-submit button. It now retains the same visible enabled
input, its own form and an enabled submitter identified by the DOM `type` property;
hidden/inert/disabled background login controls are excluded. It checks that the
form has not been replaced before submitting that form with its actual submitter.
DOM regressions cover the disabled background/default-submit invitation shape,
hidden/inert controls, disabled submitters and stale replaced forms. These are
Linux DOM/registry tests, not evidence that either new Mac route has passed.
Ghostty inputs and normal auth/schema/epoch policies remain identical to b976.

The 090 Mac React runs passed authorization and called the actual component
native host, but failed the first stream-cursor condition: each recorded one
native ACK sequence1, while the fixture reached stream sequence2 with no remote
output-ack. Those partial observations remain frozen and do not identify whether
WK animation frames actually stopped. A constrained regression mounts the real
TerminalView/store/NativeViewport/NativeOutputQueue/API, isolating only socket and
host receipts, and deliberately never dispatches requestAnimationFrame. The old
code leaves live data pending after the synchronous initial replay flush.

Native engine-Ready live output now schedules one coalesced microtask per turn,
after the API records received sequence metadata. Both scheduling and execution
check the actual renderer, plus captured frontend/backend/stream generation;
stale microtasks cannot flush a replaced connection. The existing browser and
Electron frame scheduling is unchanged. A native watermark resume uses the same
bounded scheduling. This flush transfers store data only: the parser's matching
native consumption ACK still controls progress and the remote applied cursor.
The regression proves ACK1/ACK2 do not confirm stream sequence3; only ACK3 sends
the original output-ack flowSeq3/since3/epochA with applied cursor3 and matching
native batch cursor. Existing early-ACK/owner/replacement queue tests remain valid.

The same component regression also exposed the final exit marker being discarded
by clearTerminalSession's pending-batch cleanup. Only an actual native-Ready path
flushes that final store message before clearing the backend connection, retaining
the living VT/token. Its fourth actual test write contains Process exited and its
ACK cannot send another remote ACK on the already closed stream. This is not a
new renderer or backend recreation. Linux regression/build evidence still needs a
new immutable candidate's actual Mac direct and entry-only component runs.

The dcda actual Mac React candidate recorded three completed steps and five
original native ACKs per route, with remote flowSeq/since2,3,5, controlled input
and same-backend incremental reconnect. Both then failed the ordinary settings
overlay condition. Its report did not capture overlayReady/moving, so neither
animation state nor a stopped WK frame is asserted as that Mac failure cause.
The hidden=true/focused=false attachment values remain separate from visible or
physical-focus acceptance.

A constrained lifecycle regression independently stops all presentation frames:
ordinary DOM observation gates CSS but the old notify did not submit hide until a
frame arrived. Safety transitions now use one coalesced DOM-turn microtask and
one pending hide/detach transaction. Frame observation still follows geometry and
motion; no running animation is relabeled settled. Overlay CSS stays protected
until a matching actual main-thread hide or detach receipt. Superseded generations
cannot release a newer overlay. Resume waits for its actual generation/epoch
receipt, malformed resume retains protection and accessible recovery, and an old
resume cannot clear a new overlay. The jobs are invalidated on lifecycle teardown.
The driver never directly hides views or changes ready/motion state.

The ordinary snapshot adds bounded read-only gate status/pending/resuming/queued/
frame/acknowledged/count/failed fields. The opt-in driver preserves at most 16
changed settings-gate observations and includes actual overlayReady/moving/hidden/
focused/generation/overlay-count/gate state in a failure result. It records no DOM
text, terminal data or arbitrary page globals. The strict overlayReady && !moving
condition, normal capabilities and process/invoke deadlines are unchanged.
Linux lifecycle13 + existing form3 regressions passed; a new signed product and
actual Mac direct/entry-only runs are still required, with no repeat of dcda or
the earlier direct-bridge host gate.

### Settings close after the 5386140 React sample

The two signed Mac routes for 5386140 recorded four steps and five original native ACKs. Normal `hideAll` completed: the settings observation was generation 2, `overlayReady=true`, `moving=false`, and two overlays; the failure snapshot was generation 3 with the same ready/motion/count values. The recorded focus step sampled `overlayReady=false` at a different instant, and the initial attachment remained hidden and unfocused. These values are kept separately. Both routes naturally exited 1 with `Normal settings overlay did not close`; the original files do not identify the clicked control or remaining overlay nodes.

The opt-in driver now selects the visible enabled header close button inside the normal dialog labelled by `settings-dialog-title`. It does not select an unrelated dialog's generic Close button or the settings backdrop. The normal App close handler remains unchanged, including its `history.back()` / `popstate` path. Up to eight semantic overlay identities and finite geometry scalars are sampled; arbitrary IDs, text, history payloads and URLs are excluded. Close intent, click return and at most sixteen changed close observations retain settings presence/visibility, the known history overlay marker, actual popstate count (capped at sixteen), lifecycle state and the selected fixed control identity. Failed final reports retain these observed values. No synthetic popstate, direct state mutation, force-close, native visibility override or capability change is introduced.

The affected Node helper tests cover an earlier unrelated dialog, disabled/hidden/ambiguous controls, bounded metadata without user text, and the existing three password form cases. Their results describe Linux DOM logic, not the cause of the old Mac failure or actual GUI input. New signed production React direct/entry-only runs are required; the source, normal bridge/schema, lifecycle and Ghostty build inputs otherwise remain unchanged. Physical visibility/focus/keys/IME and the remaining product paths stay unaccepted.

### Global layer discovery and visible presentation prerequisites

The signed 5b94bf4 samples confirm that the selected settings header button invoked the normal close path: one actual popstate, settings DOM absent and the known history marker cleared. Two non-settings layers already existed before settings opened and remained afterwards. The old literal settings-close error describes a broader zero-global-layer condition; it does not mean the settings button failed. The original metadata lacks their startup/sidebar identities and opacity, so it cannot establish their runtime owner or the cause of retained presentation.

Layer discovery now excludes only opacity-zero, pointer-events-none candidates with readable animation/subtree state, no running or pending animations, and no positive-geometry interactive descendants. More than 64 descendants or unknown reads remain conservatively gated. Opening opacity-zero backdrops with pointer-events-auto, active transitions, interactive children (even hidden by our own first-paint CSS), and opaque startup surfaces retain normal hide/detach protection. Visibility is not used as an exemption. The original DOM-turn scheduler, real receipts, generation checks and strict motion/visibility rules are unchanged.

## Trial feedback: update confirmation and geometry baseline

The Preview bridge explicitly advertises `confirmationUI: page-v1`. Only that
runtime uses the ordinary page dialog; browser/Electron keep their existing
confirm/alert behavior. Its Cancel, Escape, backdrop and service/page expiration
resolve false. The App owns one pending confirmation and binds it to the current
secure client, target, page lifetime and offered version. The normal page API
checks that binding before and after CSRF, then uses the existing encrypted fetch.
Failures have a visible page alert. There is no native business HTTP, restart
permission, automatic approval, or retry. The production Tailwind scan includes
the bridge's registered modal classes. Native hide/detach receipts still govern
first paint; focus initializes once rather than on every lifecycle update.

Protected, main-thread `inspect` adds bounded scalar geometry. `created` is taken
after attachment inside create; `firstRect` is the first successful rect setter
sample, before its subsequent barrier. `live` is read only while the panel is
idle. Create/firstRect belong to the living surface and can predate a rebind's
page epoch; they are not relabeled as newly created measurements. They
distinguish requested/configured font points from actual engine pixel
and cell sizes, NSView/layer bounds, layer contentsScale and window backing scale.
These samples do not assert that config font size is the current rasterized font.
Standard button frames are converted to the WK view's coordinate system, with
top coordinates normalized for WK's flippedness. The driver records DOM header
geometry and host zoom in the same measurement. No font number, traffic inset,
Metal scale, dependency, engine patch or restoration schema is corrected in this
baseline candidate; the actual measurements determine the following narrow fix.

For the owned fixed-79 router fixture only, add `--user-fixes` to the existing
`--native-react` invocation (and `--relay` for entry-only). It models ready update
state, CSRF and restart responses without any restart/install implementation.
The fixed runtime's actual WeakSet encrypted-request verifier guards the owned
CSRF/restart stubs. That runtime deliberately omits X-XSRF-TOKEN when forwarding
an authorized request; the stub preserves that contract rather than requiring a
header the router cannot forward. App/API tests separately verify the normal
page's CSRF header before transport, while actual fixture records distinguish
authenticated inner requests, CSRF reads and omitted forwarded headers.
The normal signed App still performs real password/Noise authorization, mounts
TerminalView/NativeViewport and waits for the real output consumption cursor.
The opt-in driver records fresh create/firstRect/live, fonts-ready and later
normal-layout measurements; probes legacy window.confirm with an inert question;
clicks the real Settings update button; checks Cancel zero requests, explicit
Confirm one CSRF request with a controlled failure and visible alert, then a
second explicit confirmation with an inert successful response. A receipt-bound
real WK reload records the changed page epoch, old/new tokens, actual stream open
and new first/live samples. The CSS canvas sample is a same-page font reference,
not an actual xterm renderer or proof of matching glyph output. Target-change
rejection is covered by affected App/API tests; a real target-switch GUI test is
separate. Hidden documents are recorded as such and do not establish visual,
physical focus, keys, clipboard or IME acceptance. Never run this against a real
service update endpoint or automatically replace the user's running trial App.

### Corrections after the actual 63d baseline

Both owned Mac runs measured CSS13/zoom1/backing2: create used scale1 and
cell9x18, then firstRect/live used scale2/cell17x36 while the layer remained1.
Creation now uses the actual parent window backing scale for engine setup and
initial point dimensions. Successful validated resize and replay update layer
contentsScale to that same scale. Backing notifications never advance the layer
to a new DPI before the engine's validated resize path; they retain the normal
layout notification and synchronize only an already matching engine scale.
Existing size limits, IO/barrier, input suppression and font settings are kept.

The actual traffic-light center was14 WK points against the header center23.
Both constructors use the shared window observer, which installs a main-thread
alignment object with a weak WK reference. It measures button-to-WK coordinates,
converts the required center displacement to the titlebar container's parent,
and translates that container without altering button dimensions/horizontal
placement or shared CSS. One pending main-queue correction coalesces events;
already aligned geometry schedules nothing. Resize/backing/update and exit
fullscreen recheck the actual position; fullscreen itself is left to AppKit.
Page zoom/menu and actual terminal rect update the expected46-CSS-pixel chrome
center. Scheduling is not proof of alignment: the new gate checks actual centers.

The 63d confirmation run already observed Cancel zero requests and Confirm one
authenticated inert503 request plus the page error alert. Its remaining failure
was a driver assumption that the server must see a CSRF GET. The existing page
adapter returns that token locally (and the API may cache it), so the corrected
predicate requires only the actual single authenticated POST/omitted inner header
and feedback. No token is logged, production adapter changed or cache cleared.
The missing success confirmation/reload evidence is not backfilled into63d.

The same opt-in run now preserves each earliest metric sample before asserting
create/firstRect/live requested/window/layer scale agreement and engine versus
layer/view physical size within1px. Present nonfullscreen buttons must match a
measurable DOM header center within0.5pt. Normal Settings plus/minus controls
exercise dynamic font change and restoration in owned data, then the existing
inert success confirmation and real WK reload continue. These numerical checks
do not establish visible glyph parity. Non-Retina, real backing transitions,
window resize/fullscreen and zoom GUI paths remain separately pending unless
actually exercised; hidden documents are never forced visible for acceptance.

### Relay reload and service menu follow-up

The20ef direct run passed numerical/confirmation/reload checks; the relay run
passed numerical/confirmation checks but its new page never mounted the terminal.
The Preview provider repeated its boot invitation on every document, and the
authorization Gate handled that prompt before reading existing permissions.
An optional metadata receipt now runs only after actual readDeviceAuthorization
success, with the captured client still current/open and the selected target,
page generation and exact invitation promise unchanged. The bridge rechecks the
same guard after hashing, binds the receipt to its own window origin/target and
SHA256 of that invitation, and stores one bounded session marker without raw
secrets. A later document suppresses only that completed prompt and still performs
normal Noise/permission reads. New invitations/targets/windows, stale responses
and failed permissions do not consume it. Ordinary connect keeps its original
invitation stamp until permission success, as does the password entry. Legacy
browser/Electron without this optional bridge keep their normal confirmation.

Open-service menu rows group only recorded equal peer pins. An unpaired bootstrap
row is omitted from presentation only at an exact address with one recorded pin;
unknown/different peers and different unverified origins remain separate. No
configuration, routes, profiles, open windows or user labels are deleted. Address
labels retain ports. The local shortcut is omitted only when the same exact
connect_local resolver already selects a saved pinned row; otherwise it is
explicitly labeled as a shortcut. That resolver prefers an unambiguous accepted
pin over its bootstrap alias. The opt-in App does not read standalone user daemon
metadata; its owned invitation fixture includes a same-peer alias to exercise
the production grouping. A bounded main-thread C getter reads the actual NSApp
service submenus (at most2x32 items/16KiB), and frees its strdup result once via
the existing string ABI. Epoch-bound private gate evidence compares those real
labels with the production row helper; no normal debugging/IPC permission is
added. The next Mac run covers only the affected relay and menu path, retaining
the20ef direct evidence at its actual tested source.

The1264 Mac run recorded matching actual menus, then stalled before script
submission: its owned main-thread stack showed eval reacquiring the dispatcher
window-id mutex inside WithWebview. Its timeout and135-second owned safety kill
remain failed evidence. Menu inspection now uses an independent AppHandle main
task, without WithWebview, and passes a plain bounded value into the same eval as
the driver. Finished/page-epoch checks run before sampling and submission;
submission errors remain failures. The Linux generated-script regression checks
menu installation before driver execution and the original scalar callback.
Only the next signed Mac relay run can verify actual dispatcher completion,
normal authorization, post-reload component mount and consumption receipts.

The opt-in driver records settings DOM disappearance as its own step, then separately samples remaining global layers and actual native visibility. Layer evidence adds only known startup identity and sidebar side, bounded scalar opacity/pointer-events/hidden/aria-hidden, four animation-state flags and a capped startup-marker count; arbitrary IDs, text, classes and history remain excluded. If the actual lifecycle reports a hidden document, the driver preserves an `ok=false` final with an explicit visible-presentation prerequisite and pending later focus/visibility gates immediately. It does not wait repeatedly for the same hidden document, force a native view visible, remove a startup surface or claim native consumption means painting. Normal App/index/StartupScreen/MultiTerminalView code remains untouched.

The four discovery regressions retain a fixed 5b source counterexample (inactive transparent backdrop counted; 1 failure out of 4 focused cases) separately from the new affected Node results. The new lifecycle 17 plus helper 7 tests describe Linux controlled DOM semantics only. One new signed production direct/entry-only sample must establish actual layer identity and presentation prerequisite. If only unavailable background presentation is established, freeze that evidence and await observable GUI conditions instead of iterating product changes or weakening the gate.

### Native interaction and page feedback follow-up (after e3)

The e3 signed relay/menu result remains the measured baseline:17 steps and3
original consumption ACKs, normal WK reload, numerical scale/title alignment and
page service-update confirmation passed. Its attempted user installation stopped
at the first trusted-target resolver without sending credentials or replacing the
user's7cdf Preview. This follow-up changes source only in the isolated task tree;
no stable service, PTY, user files, OS updater or user Preview is operated here.

Native exact Cmd/Ctrl-K now uses a typed localReset. Cmd-Enter, Cmd-Backspace,
Cmd-forward-delete and Cmd-left/right send the existing page-owned sequence
payload (CR, ^U, ^K, ^A, ^E); other Command combinations do not become PTY input.
AppKit keycodes normalize control/private-use characters, and composition/DOM
editable guards retain their own input path. A fixed32-byte production C bitmap
suppresses releases of intercepted shortcuts, including modifier-first release
and repeats. A fresh nonrepeat press clears an obsolete bit after a key-up lost
during blur; ordinary key-up remains available to the engine. Command modifier
reports do not leak into Kitty release reporting. Physical keys/IME are untested.

The output queue places localReset after all previously accepted batches' actual
consumption and before later batches. It does not discard unsent output, inject
RIS/CAN/ST, create a PTY or acknowledge remote output. A reset still waiting for
consumption cancels before submission after10s; an already submitted operation is
never retried on an unknown outcome. The host confirms the IO barrier, destroys
the old parser/worker before creating one neutral Ghostty receiver, rotates the
capability, and keeps the same backend/owner, effective geometry/font/theme/history
and last actually consumed stream cursor. The page restores tmux policy and normal
layout/focus handling. Old capability events/controls cannot advance the new queue.
The store chunk floor survives so later updates cannot replay cleared chunks.

Before host reset, the page confirms deletion of the old durable entry. Session
capture stamps and the authorization revision reject late old writes without
invalidating unrelated sessions. After reset it captures and commits a neutral
checkpoint at the actual cursor, allowing a supported durable reload to recover
only the clear state and later output. IndexedDB deletion failure prevents reset
and presents an error. A neutral capture/write failure after host reset presents
an explicit unsaved-reload error; it is not a durable success or a fabricated
checkpoint. Recovery without a committed checkpoint retains the existing original
server recovery boundary, not a promise of persisted local-clear state. Baselines
are never inferred from pending bytes, parser-ground guesses or a local reset.

Search close serializes direction2/search_end and layout under the same owner;
late search responses cannot reopen or repopulate it. Paste button/native paste
callbacks use the same newline/Unicode-space/zero-width normalization as the old
terminal, with the existing single bracketed block and submit=false. Renderer
preferences now explain their browser/fallback scope without treating static
native availability as the active engine or changing the saved renderer enum.

The latent copySelectionOrViewport controller contract returns Copied/Empty/
TooLarge/Unreadable. A text allocation is still freed exactly once after a
successful read, including the256KiB rejection; limit/no-text/clipboard denial
shows feedback rather than destroying the receiver or switching renderer. There
is no current desktop toolbar caller of this controller. AppKit copy/Cmd-C/mouse
release limit feedback exists, but those OS clipboard/physical paths remain
unmeasured. A successful return from the C free path is not allocator instrumentation.

FileTree delete and App desktop install confirmation use the explicit page-v1
DOM capability; browser/Electron keep their original confirm/alert behavior.
A synchronous pending lock spans approval and transport. FileTree captures page,
root, target, client/open state and available file metadata; an equivalent cache
refresh remains valid, while a changed file/context or an old response cannot
mutate the new target. The existing encrypted DELETE rechecks its live guard both
before and after CSRF acquisition. Cancel sends no DELETE; failures use bounded
page feedback. Desktop approval captures the exact ready-state object and owner,
so changed readiness invalidates it. Health dismissal/service-update errors are
also visible in page-v1 instead of the unsupported WK JavaScript alert.

The new private modes are opt-in only:

- Owned fixture: `TD_PREVIEW_OLD_SERVER_ROOT=<fixed79> node --import tsx
  desktop-rust/scripts/browser-server-fixture.ts --native-react --interactions`
  (append `--relay` for entry-only). Keep the fixture stdin open, write its returned
  descriptor to a private file, then send its existing `done` control for cleanup.
- Normal product DOM: signed executable `--native-react-workspace-gate
  NEW_ABSOLUTE_GATE_DIR descriptor.url PRIVATE_DESCRIPTOR`. It performs ordinary
  OPAQUE/Noise, mounts real TerminalView/NativeViewport and waits for actual model
  flowSeq/since/epoch ACK, then exercises FileTree Cancel/one inert encrypted503
  DELETE, renderer explanation, desktop Cancel/one inert failure/ready invalidation/
  explicit inert success, and visible health/update failures. It does not run the
  previous numerical/reload or whole host suite. Direct and entry-only each need
  one new actual Mac run for these affected paths.
- Owned host receiver: use a separate `--native-react --interactions --relay`
  descriptor and signed executable `--native-interaction-workspace-gate
  NEW_ABSOLUTE_GATE_DIR descriptor.url PRIVATE_DESCRIPTOR`. This uses normal
  verified origin/context/token checks, without opening a real PTY or bypassing
  authorization. It covers partial OSC/DCS/UTF8 localReset, neutral capture/restore,
  stale tokens, search_end/reopen and real over-limit read/free followed by feed/
  resize. This receiver directly tests the host contract, not physical shortcuts
  or React queue wiring. Its terminal-model fixtureOk can be false because it
  deliberately opens no model terminal; record that boundary and ordinary0.

Controlled desktop readiness/install state is separate from the actual Updater.
Only this owned interactions descriptor/fresh profile enables it, after ordinary
shell caller validation plus current window/target/service/page checks. Controlled
installation only counts and returns an inert503 or explicit success; it cannot
invoke OS download/install. Private bounded nonce/epoch/index stage receipts may
invalidate readiness for this test; they are not business capabilities or feed
ACKs. Default launch has no gate/descriptor/stub. FS receivers likewise return
owned metadata/inert failures and never delete real files. Reports preserve
original ACK values, bounded steps/stages, methods/encrypted-inner-header facts,
no authorization secrets or user file data; stale document callbacks cannot amend a new epoch.

Linux affected checks include queue/cache/viewport34, FileTree19 plus shared
feedback/API/transport7, service confirmation3, production C release-state1,
actual bridge18, owned protocol model5, receiver rejection/late-epoch2 and Rust
native_25. The client build/default Cargo/native API checks passed. Full tsc still
reports only the previously recorded unused React test import and two server-agent
test type/import errors; these are not repaired by this interaction batch.
The current changes still require a new signed Mac C/link/resource package and
these new opt-in runs. No Linux result establishes that actual Mac outcome.

P2 cursor policy remains explicit next-stage work: the stable1.4.298 bundled
frontend selects blink=true for auto/canvas and false for explicit webgl;
native currently fixes blink=false and does not consume cursorVisible. The public
config can set cursor style/blink/opacity, but the pinned renderer maps unfocused
cursors to block_hollow, with no independent old bar/none inactive-style option.
An owned cursorVisible focus/blur hunk and an agreed inactive policy need separate
source/GUI verification; this batch does not blindly remap browser preferences,
change global opacity or patch the library to claim complete cursor parity.
All visible glyph/focus/physical keys/IME/system clipboard/notifications/performance
and real OS update/FS deletion remain independent unmeasured gates. Overall UX is
still working; the passed baseline and this source follow-up are not full parity.

### Normal feedback driver correction after6eba

The signed6eba App C/link, resources and the new owned receiver actually passed
on the build Mac: receiver7 steps/14 original ACKs, natural exit0. Direct and relay
ordinary DOM runs remained failures (8/2 and5/2, natural exit1), so they do not
establish this batch's full DOM gate or authorize installing that candidate.
The source, original runtime/index and independent comparison remain frozen.

Direct's health failure was a text predicate mismatch. The production API throws
`Failed to dismiss server health` on a non-OK response and does not forward the
inert503 body; the driver expected the body's different message. The old report
did not capture feedback DOM existence/text, so it does not prove absent feedback
or allow backfilling a displayed alert. The corrected driver requires the normal
alert role, actual existence and production message, preserving bounded
observations (recognized fixed API message or null, capped length/matched flag).

Service checking calls the unchanged page API's encrypted POST
`/api/terminal/update/check`, not GET update. The owned model now keeps its ordinary
GET status and handles only the exact authorized POST with omitted inner CSRF
header, returning inert503 and recording method/authorization/counts. The driver
requires both the actual encrypted model request and normal API error alert
`Failed to check for updates`. It selects the runtime row under the existing
termdock-update title, never the similarly named desktop updater button.
Production API/authentication/headers and all normal App handlers are unchanged.

Relay's undefined install button establishes only that the driver did not have
that button at its immediate click. Confirmation DOM disappearance does not prove
App pending has settled, and the previous run's cause is not inferred from this
static race. Each new click waits within the original bounded deadline for a
connected enabled button, rechecks actual controlled readiness before clicking,
and records at most8 distinct button/readiness/lifecycle scalar samples. Stale
readiness is rejected without clicking. No fixed sleep, forced button state,
visibility override, extra total deadline or unknown-operation retry is added.

Only the private driver, helper tests, owned model/tests and this documentation
change. Actual helper DOM regressions cover delayed enabled action, bounded wait
failure/no click, old ready rejection, alert-message/role matching, and the
same-label service/desktop distinction; model regressions check exact authorized
POST503 and rejected unauthorized/ambient-header requests. A new fixed signed
App must run only the two affected ordinary DOM paths. The receiver/C/engine/queue/
App/API bytes remain6eba, so its receiver evidence is retained at that source;
there is no new receiver or old numerical/reload suite run. Overall UX, P2 cursor,
physical keys/IME/clipboard/visible presentation/performance remain unverified.

### Real user image/restart feedback: isolated clipboard diagnosis

The installed2b55 user's image paste returned the collector's generic nonzero
child error. It does not establish empty clipboard, permission failure or image
size. Its parent discarded stderr, and directory/limit/read/output failures shared
exit2. The new diagnostic retains exact child exit code/signal and at most32
whitelisted fixed stages, numeric errno/address-space/CPU/alarm values. It drains
stderr continuously with fixed-size buffers, discarding all other native logging,
paths, pasteboard names and data. Metadata/RSS/wall cancellation/reaping bounds
remain unchanged. A failure reports its last fixed phase instead of guessing.

`--preview-clipboard-fixture NEW_ABSOLUTE_DIRECTORY` is an explicit private CLI,
not a bridge capability. It requires a fresh0700 directory and creates only its
own8x8 PNG/TIFF/JPEG images in independent random owned named pasteboards. Each
case invokes the same signed executable's private fixture-helper mode on the main
thread through the real collector, with unchanged CPU8s/alarm10s/AS-current+512MiB/
RSS384MiB/metadata256KiB/input128MiB/RGBA32MiB limits and the shared ImageIO decode/
encode implementation. It verifies a real PNG output's8x8 dimensions/count/size,
cleans only its owned board and temporary directory, and writes a bounded0600
clipboard-fixture-report.json. No general/system pasteboard is read or written,
no GUI/Node/PTY/user config is initialized, and no upload or business HTTP occurs.
The ordinary clipboard helper still exclusively reads generalPasteboard; the page
cannot supply named-board data or access this CLI through normal IPC.

This is a diagnosis candidate, not an image-paste fix or a passed Mac image gate.
The next immutable signed build needs one invocation of this private fixture to
obtain actual limits/read/decode stages and exit/signal. Linux real child tests
cover bounded metadata/time/RSS/context cancellation/reaping, long untrusted stderr
without pipe closure, exact exit/signal and whitelist bounds; they are not AppKit
image/provider evidence. Preserve previous2b55 package/install/controlled results
at their actual source, and do not repeat old native/numerical/reload suites.
User requested no repeated hash/MD5 workflow; use necessary compilation and this
affected diagnosis only, without accessing the running user's system clipboard.


## Installed2b55 feedback follow-up: private directories, retirement, preferences, update target

The immutable4359 owned-image Mac baseline failed all3 formats at the helper's
`arguments,directory` stages, exit2, before any limits or ImageIO evidence. The
locked tempfile3.27 implementation leaves directories at0777&umask by default,
while the original helper correctly requires0700. Both ordinary collection and
the named-board fixture now use the same creation-time0700 builder. The strict
absolute/prefix/no-symlink/mode check and every existing resource limit remain.
Linux actual-directory tests cover owner-only creation and0755/symlink rejection;
only the next same-signed Mac fixture can establish real image decoding success.

RetireView now returns exact view/token/epoch plus `current` or `absent` with a
real detached receipt, or `superseded` with `detached:false` and a replacement
capability. A bounded128-entry pointer-free owner history recognizes only actual
host replacements, under the ordinary current-window/context/epoch check. An
unknown or evicted token remains an error even without a live entry; it never removes the new view.
The page accepts supersession only against an exact currently registered same
bridge/target replacement and retained CSS guard. This ends only the obsolete
binding's cleanup: it does not release the new guard, claim the NSView detached,
or permit browser fallback. Actual fallback still requires `detached`.

Renderer preference buttons retain their stored values. They are absent only for
the selected frontend session's actual native lease after matching layout Ready,
not static bridge availability. Native preparation, reset, fatal failure and
unmount withdraw Ready; current browser/fallback selections expose their normal
three choices. Multi-session/late old token behavior has component regressions.

Service npm updates resolve this running module AND argv entry's real path to
the same supported global Termdock installation, explicitly pass its npm prefix,
and fresh-read that root's package name/version after installation. Wrong-root,
no-op exit0, mismatch, unsupported layouts and accidental downgrades are refused.
Persisted ready/restarting state must validate that installation before becoming
ready; confirmation revalidates and requires the existing supervised IPC entry.
Only explicit check retries failed pending installation; no timer/confirmation
implicitly restarts a service. A synchronous restart-dispatch error becomes a
visible error state. External disk changes after this validation and before the
supervisor spawn remain a TOCTOU boundary; supervisor code is unchanged.
Temp fake-npm argv/disk and update-state tests do NOT update the user's running
1.4.318. Preview contains no server updater distribution; adopting this server
fix requires separately coordinated distribution/restart, not merely this App.

The added `--native-feedback` owned fixture flag emits
`controlledInteractions:true,controlledNativeFeedback:true`. Default startup has
neither diagnostic path. Using that descriptor with the ordinary existing
`--native-interaction-workspace-gate` selects only the retirement receiver's
current/known-absent/unknown-absent/known-superseded/unknown cases (zero writes/ACK claims); it skips
old clear/search/read-free suites. The ordinary existing
`--native-react-workspace-gate` instead follows real OPAQUE/Noise login and the
normal React stream, then checks settings for actual native, actual production
RetireAll→fatal→confirmed-detach→browser fallback, and a second owned session's
normal tab selection. It does not fabricate host events, set renderer readiness,
or introduce an IPC/debug capability. It skips previous11-step FS/update gates.
Only those affected paths and one owned-image CLI invocation are requested on
the build Mac; no user-system pasteboard, real PTY/files/OS update/restart,9834,
keys/IME or production service operations. Visible glyph/focus, notifications,
performance, cursor policy P2 and the previous neutral-IDB-failure boundary remain
unaccepted. New Mac measurements must be reported separately from Linux tests.
