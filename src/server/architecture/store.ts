import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { ARCHITECTURE_FIELDS, ARCHITECTURE_FILE, ARCHITECTURE_DIRECTORY, analysisFile, architectureScope, isArchitectureFile, isArchitectureSourcePath, parseArchitecture, type ArchitectureDocument, type ArchitectureField, type ArchitectureFields, type ArchitectureMeta, type ArchitectureNode, type ArchitecturePerspective } from './document.js';
import { parseFlowchart } from './flowchart.js';
import { diffArchitecture } from './documentDiff.js';

const runFile = promisify(execFile);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const safeName = (name: string) => /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(name);
const names = Object.fromEntries(ARCHITECTURE_FIELDS.map(field => [field, field === 'diagram' ? 'diagram.mmd' : `${field}.md`])) as Record<ArchitectureField, string>;
export class ArchitectureConflict extends Error {}
export interface StoredArchitecture { document: ArchitectureDocument | null; revision: string | null }

/** Bound all document IO to real project directories; refuse symlinks in document trees. */
export class ArchitectureStore {
  constructor(readonly root: string) {}
  async bounded(relative: string, create = false): Promise<string> {
    if (!relative || relative.startsWith('/') || /[\\\x00-\x1f]/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe architecture path');
    const root = await fs.realpath(this.root);
    let current = root;
    const parts = relative.split('/');
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      try { const stat = await fs.lstat(current); if (stat.isSymbolicLink()) throw new Error('Architecture paths cannot contain symlinks'); }
      catch (error) { if (!missing(error)) throw error; if (create && index < parts.length - 1) await fs.mkdir(current).catch(async error => { if (error.code !== 'EEXIST' || !(await fs.lstat(current)).isDirectory()) throw error; }); }
    }
    return current;
  }
  private async text(relative: string): Promise<string | null> {
    const target = await this.bounded(relative);
    try { const stat = await fs.stat(target); if (!stat.isFile() || stat.size > 5_000_000) throw new Error('Architecture file exceeds the read limit'); return await fs.readFile(target, 'utf8'); }
    catch (error) { if (missing(error)) return null; throw error; }
  }
  private async atomic(relative: string, content: string): Promise<void> {
    const target = await this.bounded(relative, true), temp = `${target}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temp, content, { flag: 'wx', mode: 0o600 }); await fs.rename(temp, target); }
    finally { await fs.rm(temp, { force: true }); }
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const lock = await this.bounded('.termdock/architecture.lock', true);
    let handle: fs.FileHandle | undefined;
    const deadline = Date.now() + 10_000;
    while (!handle) {
      try { handle = await fs.open(lock, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid, time: Date.now() })); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new ArchitectureConflict('Another architecture update is in progress');
        try {
          const owner = JSON.parse(await fs.readFile(lock, 'utf8')) as { pid: number };
          try { process.kill(owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { await fs.rm(lock, { force: true }); continue; } }
        } catch { /* A newly created lock may not yet contain its owner. */ }
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    }
    try { return await operation(); } finally { await handle.close(); await fs.rm(lock, { force: true }); }
  }
  async list(): Promise<string[]> {
    const result: string[] = [];
    if (await this.text(ARCHITECTURE_FILE)) result.push(ARCHITECTURE_FILE);
    const folder = await this.bounded(ARCHITECTURE_DIRECTORY);
    try { for (const entry of await fs.readdir(folder, { withFileTypes: true })) if (entry.isFile() && isArchitectureFile(`${ARCHITECTURE_DIRECTORY}/${entry.name}`)) result.push(`${ARCHITECTURE_DIRECTORY}/${entry.name}`); }
    catch (error) { if (!missing(error)) throw error; }
    try { if ((await fs.readdir(await this.bounded('.omm'), { withFileTypes: true })).some(entry => entry.isDirectory() && safeName(entry.name))) result.push('.omm'); }
    catch (error) { if (!missing(error)) throw error; }
    return result.sort();
  }
  async read(file = ARCHITECTURE_FILE): Promise<StoredArchitecture> {
    if (!isArchitectureFile(file)) throw new Error('Invalid architecture document');
    if (file === '.omm') return this.readOmm();
    const content = await this.text(file);
    return { document: content ? parseArchitecture(content) : null, revision: content ? digest(content) : null };
  }
  private async git(): Promise<Partial<ArchitectureMeta>> {
    try {
      const [{ stdout: gitCommit }, { stdout: gitBranch }] = await Promise.all([runFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: this.root, timeout: 2000 }), runFile('git', ['branch', '--show-current'], { cwd: this.root, timeout: 2000 })]);
      return { gitCommit: gitCommit.trim(), gitBranch: gitBranch.trim() };
    } catch { return {}; }
  }
  private historyDirectory(file: string): string { return `.termdock/architecture-history/${digest(file).slice(0, 24)}`; }
  private async archive(file: string, previous: StoredArchitecture): Promise<void> {
    if (!previous.document) return;
    const folder = this.historyDirectory(file);
    const id = `${Date.now()}-${randomUUID()}`;
    await this.atomic(`${folder}/${id}.json`, JSON.stringify(previous.document, null, 2));
    const entries = (await fs.readdir(await this.bounded(folder))).filter(name => /^\d+-[a-f0-9-]+\.json$/.test(name)).sort().reverse();
    for (const old of entries.slice(30)) await fs.unlink(await this.bounded(`${folder}/${old}`));
  }
  async history(file: string): Promise<{ id: string; savedAt: string; changes: ReturnType<typeof diffArchitecture> }[]> {
    if (!isArchitectureFile(file)) throw new Error('Invalid architecture document');
    const current = await this.read(file); if (!current.document) return [];
    const folder = this.historyDirectory(file);
    let entries: string[];
    try { entries = (await fs.readdir(await this.bounded(folder))).filter(name => /^\d+-[a-f0-9-]+\.json$/.test(name)).sort().reverse().slice(0, 30); }
    catch (error) { if (missing(error)) return []; throw error; }
    return Promise.all(entries.map(async name => {
      const previous = parseArchitecture((await this.text(`${folder}/${name}`))!);
      return { id: name.slice(0, -5), savedAt: previous.generatedAt, changes: diffArchitecture(previous, current.document!) };
    }));
  }
  async historical(file: string, id: string): Promise<ArchitectureDocument> {
    if (!isArchitectureFile(file) || !/^\d+-[a-f0-9-]+$/.test(id)) throw new Error('Invalid architecture version');
    const content = await this.text(`${this.historyDirectory(file)}/${id}.json`);
    if (!content) throw new Error('Architecture version not found');
    return parseArchitecture(content);
  }
  async save(file: string, input: unknown, expectedRevision?: string | null): Promise<StoredArchitecture> {
    if (!isArchitectureFile(file) || file === '.omm') throw new Error('Use field writes for .omm documents');
    const document = parseArchitecture(JSON.stringify(input));
    if (document.analysis && analysisFile(document.analysis) !== file) throw new Error('Architecture scope does not match its file');
    return this.locked(async () => {
      const previous = await this.read(file);
      if (expectedRevision !== undefined && previous.revision !== expectedRevision) throw new ArchitectureConflict('Architecture changed; reload before saving');
      const changes = diffArchitecture(previous.document, document);
      if (previous.document && !changes.length && ['summary', 'analysis', 'details', 'origin'].every(key => JSON.stringify(previous.document![key as keyof ArchitectureDocument]) === JSON.stringify(document[key as keyof ArchitectureDocument]))) return previous;
      await this.archive(file, previous);
      const now = new Date().toISOString(), git = await this.git();
      document.generatedAt = now;
      document.meta = { ...previous.document?.meta, created: previous.document?.meta?.created ?? now, updated: now, updateCount: (previous.document?.meta?.updateCount ?? 0) + 1, ...git };
      for (const view of document.perspectives) {
        const oldView = previous.document?.perspectives.find(old => old.id === view.id);
        view.meta = !oldView || changes.some(change => change.perspective === view.id) ? { created: oldView?.meta?.created ?? now, updated: now, updateCount: (oldView?.meta?.updateCount ?? 0) + 1, ...git, ...(oldView?.diagram ? { previousDiagram: oldView.diagram } : {}) } : oldView.meta;
        for (const node of view.nodes) {
          const old = oldView?.nodes.find(old => old.id === node.id);
          if (!old || changes.some(change => change.perspective === view.id && change.node === node.id)) node.meta = { created: old?.meta?.created ?? now, updated: now, updateCount: (old?.meta?.updateCount ?? 0) + 1, ...git, ...(old?.diagram ? { previousDiagram: old.diagram } : {}) };
          else node.meta = old.meta;
        }
      }
      const content = JSON.stringify(document, null, 2);
      await this.atomic(file, content);
      return { document, revision: digest(content) };
    });
  }
  private ommPath(element: string): string {
    if (!element || element.split('/').length > 12 || !element.split('/').every(safeName)) throw new Error('Invalid .omm element path');
    return `.omm/${element}`;
  }
  async ommElements(): Promise<string[]> {
    const result: string[] = [];
    const walk = async (relative: string, depth: number) => {
      if (depth > 12 || result.length > 2400) throw new Error('.omm tree exceeds the architecture limit');
      let entries;
      try { entries = await fs.readdir(await this.bounded(relative), { withFileTypes: true }); } catch (error) { if (missing(error)) return; throw error; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!safeName(entry.name)) continue;
        if (entry.isSymbolicLink()) throw new Error('.omm tree cannot contain symlinks');
        if (entry.isDirectory()) { const next = `${relative}/${entry.name}`; result.push(next.slice(5)); await walk(next, depth + 1); }
      }
    };
    await walk('.omm', 0); return result;
  }
  async readOmmFields(element: string): Promise<ArchitectureFields & { meta?: ArchitectureMeta }> {
    const base = this.ommPath(element), fields: ArchitectureFields = {};
    for (const field of ARCHITECTURE_FIELDS) { const value = await this.text(`${base}/${names[field]}`); if (value !== null) fields[field] = value; }
    const raw = await this.text(`${base}/meta.yaml`);
    if (!raw) return fields;
    const m = YAML.parse(raw, { maxAliasCount: 10 }) as Record<string, unknown> | null;
    const meta: ArchitectureMeta = {};
    for (const [from, to] of [['created', 'created'], ['updated', 'updated'], ['git_commit', 'gitCommit'], ['git_branch', 'gitBranch'], ['prev_diagram', 'previousDiagram']] as const) if (typeof m?.[from] === 'string') meta[to] = m[from] as string;
    if (typeof m?.update_count === 'number' && Number.isSafeInteger(m.update_count) && m.update_count >= 0) meta.updateCount = m.update_count;
    return { ...fields, meta };
  }
  private async validateOmmMerge(files: Record<string, string>): Promise<void> {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'termdock-omm-import-'));
    try {
      const stage = new ArchitectureStore(temporary), merged = { ...(await this.exportOmmBundle()).files, ...files };
      for (const [name, value] of Object.entries(merged)) await stage.atomic(`.omm/${name}`, value);
      const result = await stage.readOmm(); if (!result.document) throw new Error('Bundle contains no architecture perspectives');
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
  async writeOmmField(element: string, field: ArchitectureField, content: string, expectedRevision?: string | null): Promise<StoredArchitecture> {
    if (!ARCHITECTURE_FIELDS.includes(field) || typeof content !== 'string' || content.length > 100_000) throw new Error('Invalid architecture field');
    const base = this.ommPath(element);
    if (field === 'diagram') { const issues = parseFlowchart(content).issues.filter(issue => !issue.startsWith('Connection needs')); if (issues.length) throw new Error(issues.join('\n')); }
    return this.locked(async () => {
      const previous = await this.readOmm();
      if (expectedRevision !== undefined && previous.revision !== expectedRevision) throw new ArchitectureConflict('Architecture changed; reload before saving');
      const old = await this.readOmmFields(element);
      if (old[field] === content) return previous;
      await this.validateOmmMerge({ [`${element}/${names[field]}`]: content });
      await this.archive('.omm', previous);
      const now = new Date().toISOString();
      const git = await this.git();
      // Field writes preserve the upstream file layout and metadata convention.
      await this.atomic(`${base}/${names[field]}`, content);
      const meta = { created: old.meta?.created ?? now, updated: now, update_count: (old.meta?.updateCount ?? 0) + 1,
        last_field: field, git_commit: git.gitCommit, git_branch: git.gitBranch,
        ...(field === 'diagram' && old.diagram ? { prev_diagram: old.diagram } : old.meta?.previousDiagram ? { prev_diagram: old.meta.previousDiagram } : {}) };
      await this.atomic(`${base}/meta.yaml`, YAML.stringify(meta));
      return this.readOmm();
    });
  }
  async deleteOmmElement(element: string): Promise<void> { const target = this.ommPath(element); await this.locked(async () => { await this.archive('.omm', await this.readOmm()); await fs.rm(await this.bounded(target), { recursive: true, force: false }); }); }
  async readOmm(): Promise<StoredArchitecture> {
    const elements = await this.ommElements(); if (!elements.length) return { document: null, revision: null };
    const data = new Map<string, ArchitectureFields & { meta?: ArchitectureMeta }>();
    let total = 0;
    for (let offset = 0; offset < elements.length; offset += 16) {
      for (const [element, fields] of await Promise.all(elements.slice(offset, offset + 16).map(async element => [element, await this.readOmmFields(element)] as const))) {
        total += Buffer.byteLength(JSON.stringify(fields), 'utf8');
        if (total > 5_000_000) throw new Error('.omm documentation exceeds the read limit');
        data.set(element, fields);
      }
    }
    const perspectives: ArchitecturePerspective[] = [];
    const uid = (element: string) => `e_${digest(element).slice(0, 20)}`;
    const label = (value: string) => value.replace(/-/g, ' ').replace(/^\w/, ch => ch.toUpperCase());
    const links: { node: ArchitectureNode; target: string }[] = [];
    for (const perspective of elements.filter(element => !element.includes('/'))) {
      const fields = data.get(perspective)!;
      const nodes = new Map<string, ArchitectureNode>(), edges: ArchitecturePerspective['edges'] = [];
      const add = async (element: string, parentId?: string, diagramLabel?: string): Promise<ArchitectureNode> => {
        const old = nodes.get(element); if (old) return old;
        const entry = data.get(element) ?? {};
        const lines = (diagramLabel ?? '').split('\n');
        const files: ArchitectureNode['files'] = [];
        for (const line of lines.slice(1)) { const relative = line.trim(); if (isArchitectureSourcePath(relative)) { try { if ((await fs.stat(await this.bounded(relative))).isFile()) files.push({ path: relative }); } catch { /* Documentation can reference a directory or a removed file. */ } } }
        const node: ArchitectureNode = { id: uid(element), documentPath: element, title: lines[0]?.replace(/^@/, '') || label(element.split('/').pop()!), summary: (entry.description ?? '').replace(/[#*`]/g, '').split(/\n\s*\n/)[0].slice(0, 600), files, ...entry, ...(parentId ? { parentId } : {}) };
        nodes.set(element, node);
        const graph = parseFlowchart(entry.diagram ?? '');
        for (const child of graph.nodes) {
          const childElement = `${element}/${child.id}`, childNode = await add(childElement, node.id, child.label);
          childNode.role = child.role;
          if (child.ref) links.push({ node: childNode, target: child.ref });
        }
        for (const edge of graph.edges) edges.push({ from: uid(`${element}/${edge.from}`), to: uid(`${element}/${edge.to}`), label: edge.label });
        // Include documented children even if an old diagram has not mentioned them yet.
        for (const child of elements.filter(child => child.startsWith(`${element}/`) && child.slice(element.length + 1).indexOf('/') === -1)) await add(child, node.id);
        return node;
      };
      const graph = parseFlowchart(fields.diagram ?? '');
      for (const child of graph.nodes) { const node = await add(`${perspective}/${child.id}`, undefined, child.label); node.role = child.role; if (child.ref) links.push({ node, target: child.ref }); }
      for (const child of elements.filter(child => child.startsWith(`${perspective}/`) && child.split('/').length === 2)) await add(child);
      for (const edge of graph.edges) edges.push({ from: uid(`${perspective}/${edge.from}`), to: uid(`${perspective}/${edge.to}`), label: edge.label });
      if (!nodes.size) nodes.set(perspective, { id: uid(perspective), title: label(perspective), summary: fields.description ?? '', files: [], ...fields });
      perspectives.push({ id: perspective, title: label(perspective), summary: (fields.description ?? '').split(/\n\s*\n/)[0].slice(0, 600), nodes: [...nodes.values()], edges, ...fields });
    }
    for (const link of links) if (perspectives.some(view => view.id === link.target)) link.node.references = [...(link.node.references ?? []), { perspective: link.target }];
    const generatedAt = [...data.values()].map(value => value.meta?.updated).filter((value): value is string => !!value && Number.isFinite(Date.parse(value))).sort().pop() ?? new Date(0).toISOString();
    const document = parseArchitecture(JSON.stringify({ version: 1, origin: 'omm', generatedAt, summary: `${path.basename(this.root)} architecture`, perspectives }));
    const config = await this.text('.omm/config.yaml');
    return { document, revision: digest(JSON.stringify([...data]) + (config ?? '')) };
  }
  async config(language?: string): Promise<{ language: string }> {
    const raw = await this.text('.omm/config.yaml');
    const config = raw ? YAML.parse(raw, { maxAliasCount: 10 }) : { version: '0.1.0', language: 'en' };
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid .omm configuration');
    if (language !== undefined) { if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language)) throw new Error('Invalid language'); config.language = language; await this.locked(() => this.atomic('.omm/config.yaml', YAML.stringify(config))); }
    return { language: typeof config?.language === 'string' ? config.language : 'en' };
  }
  async exportOmmBundle(document?: ArchitectureDocument): Promise<{ format: 'termdock-omm-bundle'; version: 1; files: Record<string, string> }> {
    const files: Record<string, string> = {};
    if (!document) {
      for (const element of await this.ommElements()) {
        for (const name of [...Object.values(names), 'meta.yaml']) {
          const value = await this.text(`.omm/${element}/${name}`); if (value !== null) files[`${element}/${name}`] = value;
        }
      }
      const config = await this.text('.omm/config.yaml'); if (config) files['config.yaml'] = config;
    } else {
      files['config.yaml'] = YAML.stringify({ version: '0.1.0' });
      for (const view of document.perspectives) {
        const elementPath = (node?: ArchitectureNode): string => {
          const ids: string[] = [], visited = new Set<string>();
          while (node) { if (visited.has(node.id)) throw new Error('Cyclic architecture'); visited.add(node.id); ids.unshift(node.id); node = view.nodes.find(parent => parent.id === node!.parentId); }
          return [view.id, ...ids].join('/');
        };
        for (const item of [view, ...view.nodes]) {
          const node = item === view ? undefined : item as ArchitectureNode, base = elementPath(node), scope = architectureScope(view, node?.id);
          for (const field of ARCHITECTURE_FIELDS) {
            const value = item[field] ?? (field === 'description' ? item.summary : undefined);
            if (value !== undefined && field !== 'diagram') files[`${base}/${names[field]}`] = value;
          }
          if (scope.nodes.length) {
            const label = (value: string) => value.replace(/["<>|`\\\r\n]/g, ' ');
            files[`${base}/diagram.mmd`] = ['graph LR', ...scope.nodes.map(child => `${child.id}["${child.references?.[0]?.perspective ? `@${child.references[0].perspective}` : label(child.title)}${child.files.length ? `\\n${child.files.map(file => file.path).join('\\n')}` : ''}"]`), ...scope.edges.map(edge => `${edge.from} -->|"${label(edge.label)}"| ${edge.to}`), ...scope.nodes.filter(child => child.role).map(child => `class ${child.id} ${child.role}`)].join('\n');
          } else if (item.diagram) files[`${base}/diagram.mmd`] = item.diagram;
          const meta = item.meta ?? { created: document.generatedAt, updated: document.generatedAt, updateCount: 0 };
          files[`${base}/meta.yaml`] = YAML.stringify({ created: meta.created, updated: meta.updated, update_count: meta.updateCount, git_commit: meta.gitCommit, git_branch: meta.gitBranch, prev_diagram: meta.previousDiagram });
        }
      }
    }
    if (Buffer.byteLength(JSON.stringify(files), 'utf8') > 5_000_000) throw new Error('Export exceeds the architecture limit');
    return { format: 'termdock-omm-bundle', version: 1, files };
  }
  async importOmmBundle(input: unknown, expectedRevision?: string | null): Promise<void> {
    const bundle = input as { format?: unknown; version?: unknown; files?: unknown };
    if (bundle?.format !== 'termdock-omm-bundle' || bundle.version !== 1 || !bundle.files || typeof bundle.files !== 'object' || Array.isArray(bundle.files)) throw new Error('Invalid .omm bundle');
    const files = Object.entries(bundle.files);
    if (!files.length || files.length > 16_801 || Buffer.byteLength(JSON.stringify(input), 'utf8') > 5_000_000) throw new Error('Invalid .omm bundle size');
    for (const [name, value] of files) {
      const parts = name.split('/'), filename = parts.pop();
      if (!(name === 'config.yaml' || (parts.length > 0 && parts.length <= 12 && parts.every(safeName) && [...Object.values(names), 'meta.yaml'].includes(filename!))) || typeof value !== 'string' || value.length > 100_000) throw new Error(`Unsafe .omm bundle file: ${name}`);
      await this.bounded(`.omm/${name}`);
      if (filename?.endsWith('.yaml')) YAML.parse(value, { maxAliasCount: 10 });
    }
    await this.locked(async () => {
      const previous = await this.readOmm();
      if (expectedRevision !== undefined && previous.revision !== expectedRevision) throw new ArchitectureConflict('Architecture changed; reload before importing');
      // Validate the merged tree in isolation before touching the project's documents.
      await this.validateOmmMerge(Object.fromEntries(files) as Record<string, string>);
      await this.archive('.omm', previous);
      // A bundle merges explicit files, preserving unrelated existing perspectives.
      // Every destination is checked before the first write; no business files are touched.
      const undo: [string, string | null][] = [];
      try { for (const [name, value] of files) { undo.push([name, await this.text(`.omm/${name}`)]); await this.atomic(`.omm/${name}`, value as string); } }
      catch (error) { for (const [name, value] of undo.reverse()) { if (value === null) await fs.rm(await this.bounded(`.omm/${name}`), { force: true }); else await this.atomic(`.omm/${name}`, value); } throw error; }
    });
  }
}
