import ts from 'typescript';

function parse(text, name) {
  const tree = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, name.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  if (tree.parseDiagnostics.length) throw new Error(`Invalid ${name}`);
  return tree;
}
function walk(node, visit) { visit(node); ts.forEachChild(node, child => walk(child, visit)); }
function literalArray(tree, key) {
  const matches = [];
  walk(tree, node => {
    if (!ts.isPropertyAssignment(node) || node.name.getText(tree) !== key) return;
    if (!ts.isArrayLiteralExpression(node.initializer) || node.initializer.elements.some(e => !ts.isStringLiteral(e))) throw new Error(`Preview needs a reviewed static ${key} policy`);
    matches.push(node.initializer.elements.map(e => e.text));
  });
  if (matches.length !== 1) throw new Error(`Preview needs exactly one ${key} policy`);
  return matches[0];
}
function matcher(pattern) {
  if (pattern.includes('**') || /[?\[\]{}]/.test(pattern)) throw new Error('Review new worker glob syntax before packaging Preview');
  return new RegExp('^' + pattern.replace(/[.+^$()|\\]/g, '\\$&').replaceAll('*', '[^/]*') + '$');
}
function entries(tree) {
  const calls = [];
  walk(tree, node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'precacheAndRoute') calls.push(node);
  });
  if (calls.length !== 1 || !ts.isArrayLiteralExpression(calls[0].arguments[0])) throw new Error('Unrecognized generated worker precache table');
  const table = calls[0].arguments[0];
  return { table, rows: table.elements.map(node => {
    if (!ts.isObjectLiteralExpression(node)) throw new Error('Invalid worker precache entry');
    const property = node.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(tree) === 'url');
    if (!property || !ts.isStringLiteral(property.initializer)) throw new Error('Invalid worker precache URL');
    return { node, url: property.initializer.text };
  }) };
}
// APFS globbing can match assets/App-* when the source says assets/app-*.
// Enforce the existing source's exact case; keep runtime caching/importScripts.
export function normalizeWorkspaceWorker(script, resourceNames, viteSource) {
  const policy = parse(viteSource, 'vite.config.ts');
  const patterns = [...literalArray(policy, 'globPatterns'), ...literalArray(policy, 'includeAssets'), 'manifest.webmanifest'];
  const strict = patterns.map(matcher), folded = patterns.map(p => matcher(p.toLowerCase()));
  const permitted = url => strict.some(r => r.test(url));
  const files = new Set(resourceNames);
  const tree = parse(script, 'sw.js'), { table, rows } = entries(tree);
  const seen = new Set(), kept = [], removed = [];
  for (const row of rows) {
    if (!files.has(row.url) || seen.has(row.url)) throw new Error('Unlisted or duplicate worker precache resource');
    seen.add(row.url);
    if (permitted(row.url)) kept.push(row);
    else if (folded.some(r => r.test(row.url.toLowerCase()))) removed.push(row.url);
    else throw new Error(`Generated worker differs from source cold-loading policy: ${row.url}`);
  }
  if ([...files].filter(permitted).some(url => !kept.some(row => row.url === url))) throw new Error('Worker omits a required cold-load resource');
  const result = script.slice(0, table.getStart(tree)) + '[' + kept.map(row => row.node.getText(tree)).join(',') + ']' + script.slice(table.end);
  return { script: result, precacheUrls: kept.map(row => row.url), removedCaseVariants: removed };
}
export function workspacePrecacheUrls(script) { return entries(parse(script, 'sw.js')).rows.map(row => row.url); }
