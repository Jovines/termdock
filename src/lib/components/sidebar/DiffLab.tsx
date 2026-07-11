import { useEffect, useMemo, useState } from 'react';
import { DiffViewer, type DiffInlineMode, type DiffViewType } from './DiffViewer';

const DIFF_FIXTURES: Record<string, { label: string; path: string; diff: string; oldSource?: string }> = {
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
  const [inlineMode, setInlineMode] = useState<DiffInlineMode>(() => readInitialInlineMode());
  const [wrap, setWrap] = useState(() => readInitialWrap());
  const fixture = DIFF_FIXTURES[fixtureKey];
  const fixtureOptions = useMemo(() => Object.entries(DIFF_FIXTURES), []);

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
      data-diff-lab-view={viewType}
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
                className={`rounded-full px-3 text-xs font-semibold ${viewType === 'unified' ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground'}`}
              >
                Unified
              </button>
              <button
                type="button"
                onClick={() => setViewType('split')}
                className={`rounded-full px-3 text-xs font-semibold ${viewType === 'split' ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground'}`}
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
            viewType={viewType}
            inlineMode={inlineMode}
          />
        </main>
      </div>
    </div>
  );
}
