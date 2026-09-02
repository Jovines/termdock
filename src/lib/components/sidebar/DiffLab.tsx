import { useEffect, useMemo, useState } from 'react';
import { canUseSplitDiffView, DiffViewer, SPLIT_DIFF_MEDIA_QUERY, type DiffInlineMode, type DiffViewType } from './DiffViewer';

export const DIFF_FIXTURES: Record<string, { label: string; path: string; diff: string; oldSource?: string }> = {
  kotlin: {
    label: 'Kotlin function signature + callback',
    path: 'SearchHintIconHelper.kt',
    diff: `diff --git a/SearchHintIconHelper.kt b/SearchHintIconHelper.kt
--- a/SearchHintIconHelper.kt
+++ b/SearchHintIconHelper.kt
@@ -43,15 +43,20 @@ object SearchHintIconHelper {
 
 /** _________________________ Hybrid 标 _________________________ **/
 
- fun buildNinePatchHybridIcon(alpha: Int, searchHintBeen: SearchHintBeen?, url: String, appendString: String?, tv: EditText, iconLeftMargin: Int, rootView: ViewGroup?, isSaaS: Boolean? = false) {
+ fun buildNinePatchHybridIcon(alpha: Int, searchHintBeen: SearchHintBeen?, url: String, appendString: String?, tv: EditText, iconLeftMargin: Int, rootView: ViewGroup?, isSaaS: Boolean? = false, shouldAttach: () -> Boolean = { true }) {
      val ninePatchTV = buildNinePatchTextView(
          text = SearchHintIconStrategy.getHintIconText(searchHintBeen),
          color = SearchHintIconStrategy.getHintIconTextColor(searchHintBeen),
      )
      ResizableImageLoader.loadResizableImage(ninePatchTV, url, object :
          ResizableImageLoader.LoadResizableImageCallback {
          override fun onSuccess(ninePatchDrawable: NinePatchDrawable) {
+             if (!shouldAttach()) {
+                 return
+             }
              createTagView(alpha, appendString, tv, iconLeftMargin, rootView, isSaaS, ninePatchTV, null)
          }
      })
@@ -79,7 +84,7 @@ object SearchHintIconHelper {
      rootView?.addView(ninePatchTV)
      ninePatchTV.setOnClickListener {
-         tracker.reportClick(searchHintBeen, url)
+         tracker.reportClick(searchHintBeen, url, source = "hint_icon")
      }
 }`,
  },
  formatting: {
    label: 'Formatting and whitespace noise',
    path: 'settings.ts',
    diff: `diff --git a/settings.ts b/settings.ts
--- a/settings.ts
+++ b/settings.ts
@@ -10,14 +10,16 @@ export function normalizeSettings(input: Partial<Settings>): Settings {
-  return { theme: input.theme ?? 'dark', fontSize: input.fontSize ?? 13, wrap: input.wrap ?? true };
+  return {
+    theme: input.theme ?? 'dark',
+    fontSize: input.fontSize ?? 13,
+    wrap: input.wrap ?? true,
+  };
 }
 
 export function isEnabled(value: string | null): boolean {
-  return value === '1' || value === 'true' || value === 'yes'
+  return value === '1' || value === 'true' || value === 'yes';
 }
 
 export const DEFAULT_FILTERS = [
-  'node_modules', 'dist', 'coverage',
+  'node_modules',
+  'dist',
+  'coverage',
 ];`,
  },
  json: {
    label: 'JSON long-line mutation',
    path: 'payload.json',
    diff: `diff --git a/payload.json b/payload.json
--- a/payload.json
+++ b/payload.json
@@ -1,9 +1,11 @@
 {
   "workspaceRoot": "/Users/bytedance/vscode/termdock",
-  "mode": "basic",
+  "mode": "advanced",
   "features": {
     "diff": true,
-    "inline": "chars"
+    "inline": "words",
+    "split": true,
+    "ignoreWhitespace": "trim"
   },
-  "updatedAt": 1783660000
+  "updatedAt": 1783661200
 }`,
  },
  moved: {
    label: 'Moved block + small edits',
    path: 'DiffToolbar.tsx',
    diff: `diff --git a/DiffToolbar.tsx b/DiffToolbar.tsx
--- a/DiffToolbar.tsx
+++ b/DiffToolbar.tsx
@@ -1,28 +1,32 @@
 export function DiffToolbar({ settings, onChange }: Props) {
-  const inlineOptions = [
-    { value: 'words', label: 'Words' },
-    { value: 'chars', label: 'Characters' },
-    { value: 'none', label: 'Off' },
-  ];
-
   const algorithmOptions = [
     { value: 'default', label: 'Default' },
+    { value: 'histogram', label: 'Histogram' },
     { value: 'patience', label: 'Patience' },
-    { value: 'histogram', label: 'Histogram' },
   ];
 
   const whitespaceOptions = [
     { value: 'default', label: 'All' },
     { value: 'trim', label: 'Trim' },
     { value: 'ignore', label: 'Ignore' },
+    { value: 'ignore-blank-lines', label: 'No blank lines' },
   ];
 
+  const inlineOptions = [
+    { value: 'words', label: 'Words' },
+    { value: 'chars', label: 'Characters' },
+    { value: 'none', label: 'Off' },
+  ];
+
   return (
     <div className="toolbar">
-      <Select label="Inline" value={settings.inline} options={inlineOptions} onChange={onChange.inline} />
       <Select label="Algorithm" value={settings.algorithm} options={algorithmOptions} onChange={onChange.algorithm} />
       <Select label="Whitespace" value={settings.whitespace} options={whitespaceOptions} onChange={onChange.whitespace} />
+      <Select label="Inline" value={settings.inline} options={inlineOptions} onChange={onChange.inline} />
     </div>
   );
 }`,
  },
  imports: {
    label: 'Import-only noise',
    path: 'SearchPresenter.kt',
    diff: `diff --git a/SearchPresenter.kt b/SearchPresenter.kt
--- a/SearchPresenter.kt
+++ b/SearchPresenter.kt
@@ -1,10 +1,11 @@
 package com.example.search
 
-import com.example.search.model.OldWord
 import com.example.search.model.SuggestWord
+import com.example.search.model.SearchHint
 import com.example.search.tracker.SearchTracker
+import com.example.search.util.SearchSession
 import kotlinx.coroutines.CoroutineScope
-import kotlinx.coroutines.Job
+import kotlinx.coroutines.SupervisorJob
 
 class SearchPresenter(
   private val tracker: SearchTracker,
 )`,
  },
  importTypeExpansion: {
    label: 'Same-line import type expansion',
    path: 'DiffStreamItem.tsx',
    diff: `diff --git a/src/lib/components/sidebar/DiffStreamItem.tsx b/src/lib/components/sidebar/DiffStreamItem.tsx
--- a/src/lib/components/sidebar/DiffStreamItem.tsx
+++ b/src/lib/components/sidebar/DiffStreamItem.tsx
@@ -1,6 +1,6 @@
 import { useEffect, useState, useRef } from 'react';
-import type { ChangeAuditRecord, GitChangedFile } from '../../terminal/api';
-import { DiffViewer, type DiffViewType } from './DiffViewer';
+import type { ChangeAuditRecord, GitChangedFile, GitDiffOptions } from '../../terminal/api';
+import { DiffViewer, type DiffInlineMode, type DiffViewType } from './DiffViewer';
 
 export interface DiffStreamFile {
   path: string;`,
  },
  commentContext: {
    label: 'Kotlin block comment across hunks',
    path: 'CommentContext.kt',
    oldSource: `class CommentContext {
    /**
     * Explains old behavior.
     */
    fun activeValue(): String {
        return "old"
    }

    /**
     * A second comment that ends before the next function.
     */
    fun nextValue(): String {
        return "next"
    }
}`,
    diff: `diff --git a/CommentContext.kt b/CommentContext.kt
--- a/CommentContext.kt
+++ b/CommentContext.kt
@@ -1,8 +1,8 @@
 class CommentContext {
     /**
-     * Explains old behavior.
+     * Explains new behavior.
      */
     fun activeValue(): String {
-        return "old"
+        return "new"
     }
 
@@ -10,6 +10,9 @@ class CommentContext {
      * A second comment that ends before the next function.
      */
     fun nextValue(): String {
-        return "next"
+        val value = "next"
+        println(value)
+        return value
     }
 }`,
  },
  insertThenModify: {
    label: 'Insert block then modify next line',
    path: 'InsertThenModify.ts',
    diff: `diff --git a/InsertThenModify.ts b/InsertThenModify.ts
--- a/InsertThenModify.ts
+++ b/InsertThenModify.ts
@@ -1,7 +1,10 @@
 export function buildConfig(input: Input): Config {
   const config = createBaseConfig(input);
+  config.enableDiffLab = true;
+  config.inlineMode = 'words';
+  config.algorithm = 'histogram';
-  config.timeoutMs = 1000;
+  config.timeoutMs = 1500;
   config.retry = 2;
   return config;
 }`,
  },
  unrelatedReplacement: {
    label: 'Unrelated replacement lines',
    path: 'UnrelatedReplacement.ts',
    diff: `diff --git a/UnrelatedReplacement.ts b/UnrelatedReplacement.ts
--- a/UnrelatedReplacement.ts
+++ b/UnrelatedReplacement.ts
@@ -1,5 +1,5 @@
 export function updateSession(request: Request) {
-  const retries = calculateRetryBudget(request);
+  notifyObservers(session.status);
   return session;
 }`,
  },
  repeatedScaffolding: {
    label: 'Repeated code with one real replacement',
    path: 'RepeatedScaffolding.ts',
    diff: `diff --git a/RepeatedScaffolding.ts b/RepeatedScaffolding.ts
--- a/RepeatedScaffolding.ts
+++ b/RepeatedScaffolding.ts
@@ -1,6 +1,7 @@
 export function renderItems(items: Item[]) {
-  items.map((item) => renderLegacy(item));
-  items.map((item) => renderLegacy(item));
+  logger.debug('rendering modern items');
+  items.map((item) => renderModern(item));
+  items.map((item) => renderLegacy(item));
   flushRenderQueue();
 }`,
  },
  movedAndEdited: {
    label: 'Moved block across hunks with an edit',
    path: 'MovedAndEdited.ts',
    diff: `diff --git a/MovedAndEdited.ts b/MovedAndEdited.ts
--- a/MovedAndEdited.ts
+++ b/MovedAndEdited.ts
@@ -1,8 +1,5 @@
 export function run(input: Input) {
-  const timeoutMs = config.timeoutMs;
-  return runTask(timeoutMs);
-
   prepare(input);
   return execute(input);
 }
@@ -20,4 +17,7 @@ export function configure(config: Config) {
   validate(config);
+  const timeoutMs = config.timeoutMs;
+  return runTask(timeoutMs, signal);
+
   persist(config);
 }`,
  },
  ifWrapper: {
    label: 'Wrap an unchanged block in an if',
    path: 'TaskRunner.ts',
    diff: `diff --git a/TaskRunner.ts b/TaskRunner.ts
--- a/TaskRunner.ts
+++ b/TaskRunner.ts
@@ -8,7 +8,9 @@ export function runTask(input: Input) {
   const context = createContext(input);
-  prepare(context);
-  executeTask(context);
-  finish(context);
+  if (shouldRun(context)) {
+    prepare(context);
+    executeTask(context);
+    finish(context);
+  }
   return context;
 }`,
  },
  loopNesting: {
    label: 'Reorder nested loops while preserving the inner block',
    path: 'BlockRanges.ts',
    diff: `diff --git a/BlockRanges.ts b/BlockRanges.ts
--- a/BlockRanges.ts
+++ b/BlockRanges.ts
@@ -1,8 +1,9 @@
 function projectBlockRanges(ranges: InlineDiffRange[], block: BlockText) {
-  for (const range of ranges) {
-    const rangeEnd = range.start + range.length;
-    for (const line of block.lines) {
+  for (const line of block.lines) {
+    const lineRanges: InlineDiffRange[] = [];
+    for (const range of ranges) {
+      const rangeEnd = range.start + range.length;
       const start = Math.max(range.start, line.start);
       const end = Math.min(rangeEnd, line.end);
       if (end <= start) continue;
 }`,
  },
  addedFile: {
    label: 'Entirely added file',
    path: 'NewFeature.ts',
    diff: `diff --git a/NewFeature.ts b/NewFeature.ts
new file mode 100644
--- /dev/null
+++ b/NewFeature.ts
@@ -0,0 +1,5 @@
+export function newFeature(): string {
+  const status = 'ready';
+  announce(status);
+  return status;
+}`,
  },
  deletedFile: {
    label: 'Entirely deleted file',
    path: 'LegacyFeature.ts',
    diff: `diff --git a/LegacyFeature.ts b/LegacyFeature.ts
deleted file mode 100644
--- a/LegacyFeature.ts
+++ /dev/null
@@ -1,5 +0,0 @@
-export function legacyFeature(): string {
-  const status = 'deprecated';
-  warn(status);
-  return status;
-}`,
  },
  renameOnly: {
    label: 'Rename without content changes',
    path: 'NewName.ts',
    diff: `diff --git a/OldName.ts b/NewName.ts
similarity index 100%
rename from OldName.ts
rename to NewName.ts`,
  },
  renamedWithEdit: {
    label: 'Rename with a content edit',
    path: 'NewConfig.ts',
    diff: `diff --git a/OldConfig.ts b/NewConfig.ts
similarity index 88%
rename from OldConfig.ts
rename to NewConfig.ts
--- a/OldConfig.ts
+++ b/NewConfig.ts
@@ -1,3 +1,3 @@
 export const config = {
-  timeoutMs: 1000,
+  timeoutMs: 1500,
 };`,
  },
  binaryFile: {
    label: 'Binary file changed',
    path: 'preview.png',
    diff: `diff --git a/preview.png b/preview.png
index 1111111..2222222 100644
Binary files a/preview.png and b/preview.png differ`,
  },
  blankAndTabs: {
    label: 'Blank lines + tabs/spaces only',
    path: 'Whitespace.ts',
    diff: `diff --git a/Whitespace.ts b/Whitespace.ts
--- a/Whitespace.ts
+++ b/Whitespace.ts
@@ -1,6 +1,6 @@
 export function whitespace() {
-\tconst value = readValue();
-
+  const value = readValue();
+${'  '}
   return value;
 }`.replace(/\n/gu, '\r\n'),
  },
  noFinalNewline: {
    label: 'No final newline marker',
    path: 'NoFinalNewline.txt',
    diff: `diff --git a/NoFinalNewline.txt b/NoFinalNewline.txt
--- a/NoFinalNewline.txt
+++ b/NoFinalNewline.txt
@@ -1 +1 @@
-status=old
\\ No newline at end of file
+status=new
\\ No newline at end of file`,
  },
  unicodeGraphemes: {
    label: 'CJK + emoji + combining marks',
    path: 'messages.ts',
    diff: `diff --git a/messages.ts b/messages.ts
--- a/messages.ts
+++ b/messages.ts
@@ -1,5 +1,5 @@
 export const messages = {
-  status: '正在连接 👩‍💻 cafe\u0301',
+  status: '连接成功 👩🏽‍💻 café',
   action: '继续',
 };`,
  },
  longLine: {
    label: 'Very long line with one mutation',
    path: 'generated.ts',
    diff: `diff --git a/generated.ts b/generated.ts
--- a/generated.ts
+++ b/generated.ts
@@ -1,3 +1,3 @@
 export const generated = {
-  payload: "${'stable-segment-'.repeat(90)}OLD_VALUE${'-stable-tail'.repeat(35)}",
+  payload: "${'stable-segment-'.repeat(90)}NEW_VALUE${'-stable-tail'.repeat(35)}",
 };`,
  },
  ambiguousDuplicates: {
    label: 'Ambiguous duplicate lines',
    path: 'DuplicatePipeline.ts',
    diff: `diff --git a/DuplicatePipeline.ts b/DuplicatePipeline.ts
--- a/DuplicatePipeline.ts
+++ b/DuplicatePipeline.ts
@@ -1,8 +1,9 @@
 export function pipeline(item: Item) {
-  process(item);
-  process(item);
-  saveLegacy(item);
-  process(item);
+  process(item);
+  audit(item);
+  process(item);
+  saveModern(item);
+  process(item);
   finish(item);
 }`,
  },
  commentStringCollision: {
    label: 'Comment/string similarity collision',
    path: 'RetryLogger.ts',
    diff: `diff --git a/RetryLogger.ts b/RetryLogger.ts
--- a/RetryLogger.ts
+++ b/RetryLogger.ts
@@ -1,6 +1,6 @@
 export function reportRetry(error: Error) {
-  // retry request after backoff
-  logger.info('request failed');
+  logger.info('retry request after backoff');
+  // request failed permanently
   capture(error);
 }`,
  },
  multiHunkMixed: {
    label: 'Multiple hunks with mixed change types',
    path: 'MixedChanges.ts',
    diff: `diff --git a/MixedChanges.ts b/MixedChanges.ts
--- a/MixedChanges.ts
+++ b/MixedChanges.ts
@@ -1,5 +1,6 @@
 export function start(config: Config) {
-  connect(config, 1000);
+  connect(config, 1500);
+  logConnection(config);
   return config;
 }
@@ -20,6 +21,5 @@ export function stop(session: Session) {
   flush(session);
-  reportLegacyMetrics(session);
   disconnect(session);
   return session;
 }`,
  },
  multiFilePatch: {
    label: 'Multiple files in one patch',
    path: 'First.ts',
    diff: `diff --git a/First.ts b/First.ts
--- a/First.ts
+++ b/First.ts
@@ -1 +1 @@
-export const first = 'old';
\\ No newline at end of file
+export const first = 'new';
\\ No newline at end of file
diff --git a/Second.ts b/Second.ts
new file mode 100644
--- /dev/null
+++ b/Second.ts
@@ -0,0 +1,2 @@
+export const second = true;
+announce(second);`,
  },
};

function readInitialFixture(): keyof typeof DIFF_FIXTURES {
  if (typeof window === 'undefined') return 'kotlin';
  const params = new URLSearchParams(window.location.search);
  const value = params.get('fixture');
  return value && value in DIFF_FIXTURES ? value as keyof typeof DIFF_FIXTURES : 'kotlin';
}

function readInitialViewType(): DiffViewType {
  if (typeof window === 'undefined') return 'unified';
  return new URLSearchParams(window.location.search).get('view') === 'split' ? 'split' : 'unified';
}

function readInitialInlineMode(): DiffInlineMode {
  if (typeof window === 'undefined') return 'words';
  const value = new URLSearchParams(window.location.search).get('inline');
  return value === 'none' || value === 'chars' || value === 'words' ? value : 'words';
}

function readInitialWrap(): boolean {
  if (typeof window === 'undefined') return true;
  return new URLSearchParams(window.location.search).get('wrap') !== 'off';
}

export function DiffLab() {
  const [fixtureKey, setFixtureKey] = useState<keyof typeof DIFF_FIXTURES>(() => readInitialFixture());
  const [viewType, setViewType] = useState<DiffViewType>(() => readInitialViewType());
  const [splitViewAvailable, setSplitViewAvailable] = useState(() => canUseSplitDiffView());
  const [inlineMode, setInlineMode] = useState<DiffInlineMode>(() => readInitialInlineMode());
  const [wrap, setWrap] = useState(() => readInitialWrap());
  const fixture = DIFF_FIXTURES[fixtureKey];
  const fixtureOptions = useMemo(() => Object.entries(DIFF_FIXTURES), []);
  const effectiveViewType: DiffViewType = viewType === 'split' && !splitViewAvailable ? 'unified' : viewType;

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(SPLIT_DIFF_MEDIA_QUERY);
    const update = () => setSplitViewAvailable(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let lastSearch = window.location.search;
    const syncFromLocation = () => {
      if (window.location.search === lastSearch) return;
      lastSearch = window.location.search;
      setFixtureKey(readInitialFixture());
      setViewType(readInitialViewType());
      setInlineMode(readInitialInlineMode());
      setWrap(readInitialWrap());
    };
    window.addEventListener('popstate', syncFromLocation);
    window.addEventListener('pageshow', syncFromLocation);
    window.addEventListener('focus', syncFromLocation);
    const timer = window.setInterval(syncFromLocation, 250);
    return () => {
      window.removeEventListener('popstate', syncFromLocation);
      window.removeEventListener('pageshow', syncFromLocation);
      window.removeEventListener('focus', syncFromLocation);
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div
      className="min-h-screen bg-background-subtle text-foreground"
      data-diff-lab
      data-diff-lab-fixture={fixtureKey}
      data-diff-lab-view={effectiveViewType}
      data-diff-lab-requested-view={viewType}
      data-diff-lab-inline={inlineMode}
      data-diff-lab-wrap={wrap ? 'on' : 'off'}
    >
      <div className="mx-auto flex min-h-screen max-w-[1180px] flex-col px-4 py-4">
        <header className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-border/20 pb-3">
          <div>
            <div className="text-sm font-semibold">Diff Lab</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              Fixed fixtures for iterating diff rendering without app auth, PWA state, or live Git data.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={fixtureKey}
              onChange={(event) => setFixtureKey(event.target.value as keyof typeof DIFF_FIXTURES)}
              aria-label="Fixture"
              className="h-8 rounded-md border border-border/30 bg-surface px-2 text-xs text-foreground outline-none"
            >
              {fixtureOptions.map(([key, item]) => (
                <option key={key} value={key}>{item.label}</option>
              ))}
            </select>
            <div className="inline-flex h-8 overflow-hidden rounded-full bg-surface-2 p-0.5">
              <button
                type="button"
                onClick={() => setViewType('unified')}
                aria-pressed={effectiveViewType === 'unified'}
                className={`rounded-full px-3 text-xs font-semibold ${effectiveViewType === 'unified' ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground'}`}
              >
                Unified
              </button>
              <button
                type="button"
                onClick={() => setViewType('split')}
                disabled={!splitViewAvailable}
                aria-pressed={effectiveViewType === 'split'}
                className={`rounded-full px-3 text-xs font-semibold ${effectiveViewType === 'split' ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground'} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                Split
              </button>
            </div>
            <div className="inline-flex h-8 overflow-hidden rounded-full bg-surface-2 p-0.5">
              {(['none', 'words', 'chars'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setInlineMode(mode)}
                  className={`rounded-full px-3 text-xs font-semibold ${inlineMode === mode ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground'}`}
                >
                  {mode}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setWrap((value) => !value)}
              className={`h-8 rounded-full px-3 text-xs font-semibold ${wrap ? 'bg-primary/15 text-primary' : 'bg-surface-2 text-muted-foreground'}`}
            >
              Wrap {wrap ? 'on' : 'off'}
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/20 bg-surface">
          <DiffViewer
            filePath={fixture.path}
            repoRoot="/tmp/termdock-diff-lab"
            changedFile={{
              path: fixture.path,
              absolutePath: `/tmp/termdock-diff-lab/${fixture.path}`,
              repoRoot: '/tmp/termdock-diff-lab',
              status: 'modified',
              staged: false,
              unstaged: true,
              untracked: false,
              tracked: true,
              canStage: false,
              canUnstage: false,
              canStash: false,
              canRestoreWorktree: false,
            }}
            diffOverride={fixture.diff}
            oldSourceOverride={fixture.oldSource}
            active
            wrap={wrap}
            showScrollHint={!wrap}
            viewType={effectiveViewType}
            inlineMode={inlineMode}
          />
        </main>
      </div>
    </div>
  );
}
