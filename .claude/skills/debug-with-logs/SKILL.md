---
name: debug-with-logs
description: |
  Investigate frontend bugs in this web-terminal project by instrumenting the
  code with diagnostic logs, reproducing the bug, and analyzing the log stream
  to find the actual runtime cause. MUST USE whenever the user reports a bug
  that involves runtime state, timing, lifecycle, or any "it sometimes does X"
  behavior that can't be answered by pure code inspection — e.g. "the tab name
  is wrong after reload", "scroll position resets", "session doesn't reconnect",
  "first render shows stale value", "value gets overwritten". Prefer this over
  guessing what the code might do, because the bug usually lives in the gap
  between what the code says and what actually executes.
---

# debug-with-logs

Find the actual cause of a runtime bug by **watching the values flow** rather
than guessing from code. The goal is to make the invisible visible: timing,
state transitions, async ordering, race conditions.

## When to reach for this

Reach for this when the bug answer requires knowing **what values were where, in
what order, at runtime**. Common shapes:

- "Tab/UI shows wrong value on first render, fixes itself a few seconds later"
- "Value gets overwritten / reset unexpectedly"
- "Works on second reload but not the first"
- "Race condition between A and B"
- "Hook/effect fires more than expected, or in unexpected order"
- "Server returns X but UI shows Y"
- "Sometimes / occasionally / depends on timing"

Skip this for purely static bugs (typos, type errors, missing imports). Those
get solved faster by reading the code.

## The three log channels

This project has three log channels — pick the one that matches **how you'll
reproduce the bug**, not by default habit.

### 1. Server stdout → `.dev-server.log`

For backend logic (Express routes, WS handlers, PTY plumbing, tmux interaction).
Plain `console.log(...)` from any file under `src/server/`.

```ts
console.log('[ws:connected]', { sessionId, sinceSeq, replayCount: chunks.length });
```

Goes straight to `.dev-server.log`. No code wiring needed.

### 2. Browser console + agent-browser (preferred for automated repro)

When you can drive the reproduction yourself with [agent-browser], browser
`console.log()` plus `agent-browser console` is the **fastest, lowest-overhead**
channel. No HTTP roundtrip, no setup, you can inspect store state on demand via
`agent-browser eval` instead of pre-instrumenting reads.

```ts
console.log('[hydrate]', { frontendId, cachedMeta });
```

Then:
```bash
agent-browser open http://localhost:9833
agent-browser reload && sleep 0.3 && agent-browser console
agent-browser eval "JSON.stringify(useTerminalStore.getState().sessions, null, 2)"
```

### 3. `clientLog` → server log (for real-device / user-operated repro)

When repro must happen on a real mobile PWA, or the user is operating the page
themselves and you can't drive the browser, route browser logs to server via
`src/lib/utils/clientLog.ts`:

```ts
import { clientLog } from '../utils/clientLog';

clientLog('debug', '[area:event]', { keyData, moreContext });
```

Auto-batched, posted to `/api/client-log`, appears in `.dev-server.log` as
`[client-log <iso-ts>] [debug] [area:event] {...}`.

Use this when:
- Repro requires touch / soft keyboard / mobile-specific viewport
- Repro requires authenticated mobile account / external login
- User is already in front of the page and faster than wiring up agent-browser
- Need to compare across devices

## The loop

```
1. Pick the log channel based on repro strategy
2. Add diagnostic logs at suspected branch points
3. Reproduce (auto via agent-browser OR ask user)
4. Read the log stream
5. Identify the actual sequence
6. Form/test a hypothesis; loop back to 2 if wrong
7. Apply the fix
8. Verify with the same repro
9. Clean up diagnostic logs (or leave a couple of high-signal ones)
```

### Step 1 — Pick channel: auto vs manual

Default to **agent-browser auto-repro**. Switch to manual only when:

- Bug needs touch / pinch / native soft keyboard
- Bug needs authenticated mobile account (Wechat, biometrics, etc.)
- User says "let me do it, it's faster"
- Bug is on-device and dev machine can't reach the device

For auto:
```bash
# Make sure dev is running
./restart-dev.sh restart  # only if needed; check first with curl localhost:9834/health
agent-browser open http://localhost:9833
```

For manual: tell user concretely what to click + that you'll watch
`.dev-server.log` for `[area:event]` tags. Truncate the log first so signal isn't
buried:
```bash
: > .dev-server.log
```

### Step 2 — Where to anchor logs

Anchor at points where **values cross a boundary or a decision branches**. Some
recurring patterns in this codebase:

| Symptom | Where to anchor |
|---|---|
| Cached value not showing on first render | Cache read site + the store mutator that consumes it + the render site that reads from store |
| Value overwritten by null/default | Store subscription writer + every setter call site, with `prev` and `next` |
| Effect runs wrong number of times / wrong order | Top of every related useEffect with deps logged |
| WS event handler doing wrong thing | Inside each `case` of the message switch, log msg + relevant local state |
| Race between two async paths | Both async entry points + both completion sites, with timestamps |

Naming convention: `[area:event]` so you can grep one tag and see the whole
trace. Examples: `[meta-cache:hydrate-read]`, `[ws:connected]`, `[restore:loop]`.
For decision points include enough context to distinguish branches:

```ts
clientLog('debug', '[meta-cache:write]', {
  frontendId: sessionId,
  prevActiveProgram: prev?.activeProgram,
  nextActiveProgram: sessionState.activeProgram,
  skipped: allNull,  // ← include the decision flag itself
});
```

Logging the input AND the decision flag is what turns logs into a debugger: you
can see "we reached the branch, decided X, because input was Y".

### Step 3 — Reproduce

Auto-repro template:
```bash
agent-browser open http://localhost:9833
agent-browser reload && sleep 0.3 && agent-browser screenshot /tmp/dbg-t300.png
sleep 0.7 && agent-browser screenshot /tmp/dbg-t1000.png
# If user has localStorage, query it
agent-browser eval "Object.keys(localStorage).filter(k => k.startsWith('termdock-'))"
# Read the in-memory store
agent-browser eval "JSON.stringify(Array.from(useTerminalStore.getState().sessions.entries()), null, 2)"
```

Manual-repro template — tell user something like:
> 1. 强制刷新一次 PWA 让新代码进去
> 2. 把页面调到 X 状态
> 3. 做 Y 操作
> 4. **不要操作其它**，告诉我"好了"
>
> 我会从 server log 里 grep `[area:event]` 看实际发生了什么。

### Step 4 — Read the log stream

```bash
# Just the diagnostic tags you added (filter out noise)
grep -E "\[meta-cache:|\[hydrate:|\[ws:" .dev-server.log | tail -50

# Or by session id for cross-component tracing
grep "<some-uuid>" .dev-server.log
```

For agent-browser:
```bash
agent-browser console 2>&1 | tail -40
```

### Step 5 — Identify the actual sequence

This is the analysis step. Look for:

- **Order mismatches**: log A claimed to happen before log B but order shows the opposite → race
- **Unexpected nulls**: a value was `null` where you expected real data → who wrote null, or who failed to write real
- **Repeated calls**: same effect logged 4× when it should log 1× → dependency loop
- **Missing logs**: branch you instrumented didn't fire → control flow doesn't reach it; instrument the parent

The mental move is: trace **what wrote the bad value**, not **what read it**.
The reader is usually fine; the writer is usually the bug.

### Step 6 — Form and test a hypothesis

State the hypothesis in one sentence ("X overwrites Y because Z fires after W").
Then add a log that would prove or disprove it cheaply, and re-run. Don't fix
until the hypothesis is confirmed by a log — guessing wastes more time than one
more measurement.

### Step 7 — Apply the fix

Now you know the cause. Make the smallest change that addresses it. Leave the
diagnostic logs in place for verification.

### Step 8 — Verify

Re-run the same repro. The bad log should be gone (or replaced by the correct
sequence). Take a screenshot or capture a final agent-browser snapshot.

### Step 9 — Clean up

Two valid choices:
- **Remove** the diagnostic logs (PR is clean, nothing changed except the fix)
- **Keep 1–3** as observability anchors (`[ws:connected]` style entries that
  stay useful for future debugging)

Don't leave a wall of `[meta-cache:hydrate-read]` style traces. They were
debug tools, not production logs.

## Real example from this codebase (for pattern matching)

Bug: "Tab name shows `tmux:wt-...` for ~1s on cold reload before switching to
`claude web-terminal`".

Instrumentation added:
```ts
// MultiTerminalView restore loop — verify cache read result
clientLog('debug', '[meta-cache:hydrate-read]', { frontendId, hit, meta });
clientLog('debug', '[meta-cache:hydrate-applied]', { frontendId, storeActiveProgram, storeCwd });

// App.tsx store subscription — every cache write
clientLog('debug', '[meta-cache:write]', { frontendId, activeProgram, cwd });

// App.tsx tab render — first sample per session
clientLog('debug', '[tab-render:first-sample]', { renderedPrimary, activeProgram, cwd });
```

Log showed:
```
[meta-cache:write]          activeProgram: null, cwd: null    ← write fires first with null
[meta-cache:hydrate-read]   hit: true, meta: all null         ← we just overwrote our own cache
[tab-render:first-sample]   renderedPrimary: "tmux:wt-..."   ← fall through to tmux name
[meta-cache:write]          activeProgram: "claude"           ← real value, too late
```

Root cause: `setTerminalSession` creates the empty initial entry, which
triggers the store subscription to write `null` to cache, clobbering the
previous-session real values. Hydrate read got the nulls we just wrote.

Fix: in the subscription, skip writing when all metadata fields are null
(transient state with no useful info to persist).

Verification: same instrumentation re-ran, sequence now showed
`[meta-cache:write-skip-allnull]` and `hydrate-read` returned real values.
Tab showed `claude web-terminal` on first render.

## Anti-patterns

- **Logging without a hypothesis**: dumping `console.log('here')` randomly. Each
  log should answer a specific question.
- **Logging only one side**: only logging reads but not writes (or vice versa)
  means you can't tell which side is wrong.
- **Skipping repro**: trying to fix without seeing the bug ourselves. The user's
  description is always incomplete; one round of seeing it yourself saves three
  rounds of guessing.
- **Not cleaning up**: leaving every diagnostic log in place. Some are worth
  keeping; most aren't.
- **`clientLog` overuse**: routing browser logs through HTTP when agent-browser
  could just read `console.log` directly. Use `clientLog` when the repro is on
  a device you can't drive, not by default.

## Quick reference: ops cheatsheet

```bash
# Restart dev cleanly (kills stale processes, frees ports)
./restart-dev.sh restart

# Tail the log (server stdout + client-log relay)
tail -f .dev-server.log

# Truncate before a repro so signal is on top
: > .dev-server.log

# Grep your tag
grep -E "\[meta-cache:|\[hydrate:" .dev-server.log | tail -50

# Auto repro skeleton
agent-browser open http://localhost:9833
agent-browser reload && sleep 0.5
agent-browser screenshot /tmp/dbg.png
agent-browser console 2>&1 | tail -40
agent-browser eval "JSON.stringify(useTerminalStore.getState(), null, 2)"
agent-browser close
```
