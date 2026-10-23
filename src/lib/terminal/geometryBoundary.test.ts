// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const files = (root: string) => fs.readdirSync(root, { recursive: true }).map(String)
  .filter(file => /\.tsx?$/.test(file) && !/\.(test|browser)\./.test(file))
  .map(file => path.join(root, file));

function constructions(source: ts.SourceFile, names: Set<string>) {
  const instances = new Set<string>();
  const visit = (node: ts.Node) => {
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && names.has(node.expression.getText(source))) {
      let owner: ts.Node | undefined = node.parent;
      while (owner && !ts.isVariableDeclaration(owner)) owner = owner.parent;
      if (owner && ts.isVariableDeclaration(owner)) instances.add(owner.name.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return instances;
}

it('keeps browser geometry in the shared lifecycle rather than independent viewport implementations', () => {
  const entries = new Set(['src/lib/components/terminal/TerminalViewport.tsx', 'src/lib/federation/SessionAccessView.tsx']);
  const violations: string[] = [];
  for (const file of files('src/lib')) {
    if (file === 'src/lib/terminal/geometry.ts') continue;
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const names = new Set<string>(['createBrowserTerminal']);
    const terminalConstructors = new Set<string>();
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || !/^['"]@xterm\/(?:xterm|addon-fit)['"]$/.test(node.moduleSpecifier.getText(source))) continue;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
        names.add(item.name.text);
        if ((item.propertyName?.text ?? item.name.text) === 'Terminal') terminalConstructors.add(item.name.text);
      }
    }
    const instances = constructions(source, names);
    if (instances.size && !entries.has(file)) violations.push(`${file}: new browser terminal must reuse TerminalViewport or its geometry lifecycle`);
    if (instances.size && !source.text.includes('new TerminalGeometry(')) violations.push(`${file}: missing shared geometry`);
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && terminalConstructors.has(node.expression.getText(source))) {
        violations.push(`${file}: use createBrowserTerminal so font readiness cannot be skipped`);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && instances.has(node.expression.expression.getText(source))
        && ['resize', 'fit', 'proposeDimensions'].includes(node.expression.name.text)) {
        violations.push(`${file}: raw ${node.expression.getText(source)} bypasses geometry`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});

it('prevents a new display entry from resizing its PTY without retaining the observer size', () => {
  const violations: string[] = [];
  for (const file of files('src/server')) {
    if (file === 'src/server/utils/tmuxDisplayGeometry.ts') continue;
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const instances = constructions(source, new Set(['TerminalClientAttachment']));
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && instances.has(node.expression.expression.getText(source)) && node.expression.name.text === 'resize') {
        violations.push(`${file}: use TmuxDisplayGeometry.resize for display + observer consistency`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
