// The closing comment delimiter is in omitted context between the two hunks.
export const kotlinCommentGapDiff = `diff --git a/CommentGap.kt b/CommentGap.kt
--- a/CommentGap.kt
+++ b/CommentGap.kt
@@ -1,4 +1,4 @@
 fun before(): Boolean {
-    return false
+    return true
 }
 /**
@@ -10,3 +10,4 @@
 fun after(): Boolean {
-    return false
+    val hasMultiSticky = true
+    return hasMultiSticky
 }
`;
export const kotlinCommentGapSource = [
  'fun before(): Boolean {', '    return false', '}', '/**',
  ' * Layout helper documentation', ' * More documentation', ' */', '', '',
  'fun after(): Boolean {', '    return false', '}', '',
].join('\n');
