import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { updateArchitectureField } from './fieldMutation.js';
import { ARCHITECTURE_FIELDS, ARCHITECTURE_FILE,  analysisFile, architectureSourceDiagram, buildArchitecturePrompt, buildOmmScanPrompt, parseArchitecture, type ArchitectureDocument, type ArchitectureField, type ArchitectureNode } from './document.js';
import { ArchitectureStore } from './store.js';
import { parseFlowchart } from './flowchart.js';
import { diffMermaid } from './mermaidDiff.js';
import { diffArchitecture } from './documentDiff.js';

export const ARCHITECTURE_HELP = `Termdock architecture — recursive code architecture documents
Usage: td architecture <command> [--project <directory>] [--file <map.json>] [--format native|omm]
  prompt [--language en|zh]         Print the recursive analysis instructions
  setup [claude|codex|cursor|openclaw|antigravity] [--teardown]
  init | list | status             Initialize or inspect project maps
  tree [perspective/element]       Browse the recursive document tree
  read <element> <field>           Read a field
  write <element> <field> <text|->  Write a field (stdin with -)
  show <element>                   Read all fields and metadata
  delete <element>                 Delete that element and descendants
  save <json|->                    Validate and atomically save a native map, retaining history
  validate [element]               Check diagrams, documents and references
  refs <element>                   Show incoming/outgoing and cross-perspective references
  diff [element] | history         Show changes and previous versions
  config language [en|zh|...]       Read/write the .omm content language
  export [--format omm]            Export native JSON or a portable .omm file bundle
  import <json|->                  Import a native map or a .omm file bundle
  view                            Print the native Termdock viewer link
Fields: description, diagram, context, constraint, concern, todo, note.
Examples: td architecture prompt --project .
          td architecture write --format omm overall-architecture/auth description -
          td architecture save --file .termdock/architecture.json -`;

export interface ArchitectureCliIo { write: (value: string) => void; stdin: () => Promise<string> }
function target(document: ArchitectureDocument, element: string) {
  const [perspective, ...parts] = element.split('/');
  const view = document.perspectives.find(view => view.id === perspective);
  if (!view) throw new Error(`Perspective not found: ${perspective}`);
  let node: ArchitectureNode | undefined;
  for (const [index, part] of parts.entries()) {
    const id = document.origin === 'omm' ? `e_${createHash('sha256').update([perspective, ...parts.slice(0, index + 1)].join('/')).digest('hex').slice(0, 20)}` : part;
    const next = view.nodes.find(item => item.id === id && item.parentId === node?.id);
    if (!next) throw new Error(`Element not found: ${element}`);
    node = next;
  }
  return { view, node, value: node ?? view };
}
export async function runArchitectureCli(args: string[], io: ArchitectureCliIo = { write: value => process.stdout.write(`${value}\n`), stdin: async () => { let text = ''; for await (const chunk of process.stdin) { text += String(chunk); if (text.length > 5_000_000) throw new Error('Input exceeds the architecture limit'); } return text; } }): Promise<number> {
  try {
    const positional: string[] = [], options: Record<string, string> = {};
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (['--project', '--file', '--format', '--language'].includes(arg)) { if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`); options[arg.slice(2)] = args[++index]; }
      else if (['--teardown', '--list', '--help'].includes(arg)) options[arg.slice(2)] = 'true';
      else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
      else positional.push(arg);
    }
    const [command = 'help', element, field, ...content] = positional;
    if (command === 'help' || options.help) { io.write(ARCHITECTURE_HELP); return 0; }
    const root = await fs.realpath(path.resolve(options.project ?? process.cwd()));
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Project root must be a directory');
    const store = new ArchitectureStore(root);
    const omm = options.format === 'omm' || options.file === '.omm';
    if (options.format && !['native', 'omm'].includes(options.format)) throw new Error('Format must be native or omm');
    const file = options.file ?? (omm ? '.omm' : ARCHITECTURE_FILE);
    const input = async (values: string[]) => values[0] === '-' ? io.stdin() : values.join(' ');
    const json = (value: unknown) => io.write(JSON.stringify(value, null, 2));
    if (command === 'prompt' || command === 'scan') { io.write(omm ? buildOmmScanPrompt(root, options.language === 'zh' ? 'zh' : 'en') : buildArchitecturePrompt(root, options.language === 'zh' ? 'zh' : 'en')); return 0; }
    if (command === 'setup') {
      const platforms: Record<string, string> = { claude: '.claude/skills', codex: '.agents/skills', cursor: '.cursor/skills', openclaw: '.openclaw/skills', antigravity: '.agent/skills' };
      if (options.list) { json(Object.keys(platforms)); return 0; }
      const selected = element ? [element] : Object.keys(platforms);
      if (selected.some(platform => !platforms[platform])) throw new Error('Unknown AI platform');
      const marker = '<!-- Termdock architecture skill -->';
      for (const platform of selected) {
        const relative = `${platforms[platform]}/termdock-architecture/SKILL.md`, destination = await store.bounded(relative, true);
        let existing = ''; try { existing = await fs.readFile(destination, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (existing && !existing.includes(marker)) throw new Error(`Refusing to overwrite an unrelated skill: ${relative}`);
        if (options.teardown) { if (existing.includes(marker)) await fs.unlink(destination); io.write(`Removed ${relative}`); continue; }
        const prompt = omm ? buildOmmScanPrompt(root, options.language === 'zh' ? 'zh' : 'en') : buildArchitecturePrompt(root, options.language === 'zh' ? 'zh' : 'en');
        await fs.writeFile(destination, `---\nname: termdock-architecture\ndescription: Recursively analyze or update this project's Termdock code architecture.\n---\n${marker}\n\n${prompt}\n`, { mode: 0o600 });
        io.write(`Installed ${relative}`);
      }
      return 0;
    }
    if (command === 'config') { if (element !== 'language') throw new Error('Use config language [code]'); json(await store.config(field)); return 0; }
    if (command === 'init') { await store.config(); if (omm) await store.config(options.language ?? 'en'); io.write('Ready. Use td architecture prompt, or Generate in the Architecture panel.'); return 0; }
    if (command === 'list') { json(await store.list()); return 0; }
    if (command === 'save' || command === 'import') {
      const raw = await input(positional.slice(1)); if (!raw) throw new Error('Supply JSON or - for stdin');
      const value = JSON.parse(raw);
      if (value?.format === 'termdock-omm-bundle') { await store.importOmmBundle(value); json(await store.read('.omm')); }
      else { const document = parseArchitecture(raw); json(await store.save(options.file ?? (document.analysis ? analysisFile(document.analysis) : ARCHITECTURE_FILE), document)); }
      return 0;
    }
    if (command === 'export' && omm) { const source = options.file && options.file !== '.omm' ? (await store.read(options.file)).document : undefined; if (source === null) throw new Error('Architecture not found'); json(await store.exportOmmBundle(source)); return 0; }
    if (command === 'delete' && omm) { if (!element) throw new Error('Supply an element path'); await store.deleteOmmElement(element); io.write(`Deleted ${element}`); return 0; }
    if (command === 'write' && omm) { if (!element || !ARCHITECTURE_FIELDS.includes(field as ArchitectureField)) throw new Error('Supply an element and valid field'); await store.writeOmmField(element, field as ArchitectureField, await input(content)); io.write(`Updated ${element}/${field}`); return 0; }
    const loaded = await store.read(file), document = loaded.document;
    if (!document) throw new Error('No saved architecture. Generate one first, or select --format omm.');
    if (command === 'export') { json(document); return 0; }
    if (command === 'status') { json({ file, generatedAt: document.generatedAt, meta: document.meta, perspectives: document.perspectives.map(view => ({ id: view.id, nodes: view.nodes.length, edges: view.edges.length })) }); return 0; }
    if (command === 'history') { json(await store.history(file)); return 0; }
    if (command === 'tree' && document.origin === 'omm') { for (const entry of await store.ommElements()) if (!element || entry === element || entry.startsWith(`${element}/`)) io.write(`${'  '.repeat(entry.split('/').length - 1)}${entry.split('/').pop()}`); return 0; }
    if (command === 'tree') {
      const views = element ? [target(document, element).view] : document.perspectives;
      for (const view of views) {
        io.write(view.id);
        const walk = (parent: string | undefined, prefix: string) => { for (const node of view.nodes.filter(node => node.parentId === parent)) { io.write(`${prefix}${node.id} — ${node.title}`); walk(node.id, `${prefix}  `); } };
        walk(element ? target(document, element).node?.id : undefined, '  ');
      }
      return 0;
    }
    if (command === 'validate') {
      const issues: { element: string; message: string }[] = [];
      for (const view of document.perspectives) {
        for (const item of [view, ...view.nodes]) {
          const key = `${view.id}${item === view ? '' : `/${item.id}`}`;
          if (element && !key.startsWith(element)) continue;
          if (!item.description && !item.summary) issues.push({ element: key, message: 'Missing description' });
          if (item.diagram) {
            const diagram = parseFlowchart(item.diagram);
            for (const issue of diagram.issues) issues.push({ element: key, message: issue });
            for (const node of diagram.nodes) if (node.ref && (!document.perspectives.some(other => other.id === node.ref) || node.ref === view.id)) issues.push({ element: key, message: `Unresolved or self-referencing perspective: ${node.ref}` });
          }
        }
      }
      json({ valid: !issues.length, issues }); return issues.length ? 1 : 0;
    }
    if (command === 'diff' && !element) { json(await store.history(file)); return 0; }
    if (command === 'view') { io.write(`Open Termdock → this project → Architecture, or https://localhost:9834/?architecture=${encodeURIComponent(JSON.stringify({ root, file }))}`); return 0; }
    if (!element) throw new Error('Element path is required');
    const selected = target(document, element);
    if (command === 'delete') {
      const removed = new Set<string>();
      if (!selected.node) document.perspectives = document.perspectives.filter(view => view.id !== selected.view.id);
      else {
        removed.add(selected.node.id);
        for (let index = 0; index < selected.view.nodes.length; index++) for (const node of selected.view.nodes) if (node.parentId && removed.has(node.parentId)) removed.add(node.id);
        selected.view.nodes = selected.view.nodes.filter(node => !removed.has(node.id));
        selected.view.edges = selected.view.edges.filter(edge => !removed.has(edge.from) && !removed.has(edge.to));
      }
      // Validation refuses dangling references and an empty document.
      await store.save(file, document, loaded.revision); io.write(`Deleted ${element}`); return 0;
    }
    if (command === 'show') { json(selected.value); return 0; }
    if (command === 'read') { if (!ARCHITECTURE_FIELDS.includes(field as ArchitectureField)) throw new Error('Invalid field'); io.write(selected.value[field as ArchitectureField] ?? (field === 'description' ? selected.value.summary : field === 'diagram' ? architectureSourceDiagram(selected.view, selected.node?.id) : '')); return 0; }
    if (command === 'write') {
      if (!ARCHITECTURE_FIELDS.includes(field as ArchitectureField)) throw new Error('Invalid field');
      const updated = updateArchitectureField(document, selected.view.id, selected.node?.id, field as ArchitectureField, await input(content));
      await store.save(file, updated, loaded.revision); io.write(`Updated ${element}/${field}`); return 0;
    }
    if (command === 'refs') {
      json({ outgoing: selected.node?.references ?? [], incoming: document.perspectives.flatMap(view => view.nodes.filter(node => node.references?.some(ref => ref.perspective === selected.view.id && (!ref.node || ref.node === selected.node?.id))).map(node => ({ perspective: view.id, node: node.id }))), connections: selected.node ? selected.view.edges.filter(edge => edge.from === selected.node!.id || edge.to === selected.node!.id) : selected.view.edges }); return 0;
    }
    if (command === 'diff') {
      if (selected.value.meta?.previousDiagram && selected.value.diagram) json(diffMermaid(selected.value.meta.previousDiagram, selected.value.diagram));
      else { const versions = await store.history(file); json(versions[0] ? diffArchitecture(await store.historical(file, versions[0].id), document).filter(change => change.perspective === selected.view.id && (!selected.node || change.node === selected.node.id)) : []); }
      return 0;
    }
    throw new Error(`Unknown architecture command: ${command}`);
  } catch (error) { io.write(`Error: ${error instanceof Error ? error.message : String(error)}`); return 1; }
}
