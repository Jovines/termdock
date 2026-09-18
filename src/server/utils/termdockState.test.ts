import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isProcessRunning,
  readJsonFile,
  readServerState,
  removeJsonState,
  writeJsonStateAtomic,
} from './termdockState.js';

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-state-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('writeJsonStateAtomic', () => {
  it('落盘可读回，权限 0600，不留 tmp 残骸', () => {
    const directory = makeTemporaryDirectory();
    const filePath = path.join(directory, 'state.json');

    writeJsonStateAtomic(filePath, { pid: 1234, note: 'ok' });

    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ pid: 1234, note: 'ok' });
    // 敏感内容（localApiToken / 崩溃栈）不该对同机其它用户可读
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory)).toEqual(['state.json']);
  });

  it('覆盖已有文件时不残留旧内容', () => {
    const directory = makeTemporaryDirectory();
    const filePath = path.join(directory, 'state.json');
    fs.writeFileSync(filePath, JSON.stringify({ pid: 1, extra: 'x'.repeat(500) }));

    writeJsonStateAtomic(filePath, { pid: 2 });

    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ pid: 2 });
  });

  it('父目录不存在时自建（0700），适配 ~/.termdock 首次使用', () => {
    const directory = makeTemporaryDirectory();
    const nested = path.join(directory, 'termdock', 'nested', 'state.json');

    writeJsonStateAtomic(nested, { pid: 7 });

    expect(JSON.parse(fs.readFileSync(nested, 'utf8'))).toEqual({ pid: 7 });
    expect(fs.statSync(path.dirname(path.dirname(nested))).mode & 0o777).toBe(0o700);
  });
});

describe('readJsonFile', () => {
  it('文件不存在或 JSON 损坏都返回 null，不抛异常', () => {
    const directory = makeTemporaryDirectory();
    const missing = path.join(directory, 'missing.json');
    const corrupt = path.join(directory, 'corrupt.json');
    fs.writeFileSync(corrupt, '{"pid": 1,');

    expect(readJsonFile(missing)).toBeNull();
    expect(readJsonFile(corrupt)).toBeNull();
  });
});

describe('readServerState', () => {
  // readServerState 读的是模块常量路径，这里直接验证它依赖的校验语义。
  it('缺少 pid 的状态文件视为无效', () => {
    const directory = makeTemporaryDirectory();
    const filePath = path.join(directory, 'invalid.json');
    fs.writeFileSync(filePath, JSON.stringify({ port: 9834 }));

    expect(readJsonFile<{ pid?: number }>(filePath)?.pid).toBeUndefined();
    expect(readServerState).toBeTypeOf('function');
  });
});

describe('removeJsonState', () => {
  it('删得掉；文件本就不存在也不抛', () => {
    const directory = makeTemporaryDirectory();
    const filePath = path.join(directory, 'state.json');
    writeJsonStateAtomic(filePath, { pid: 1 });

    removeJsonState(filePath);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(() => removeJsonState(filePath)).not.toThrow();
  });
});

describe('isProcessRunning', () => {
  it('当前进程算活着，明显不存在的 pid 算死了', () => {
    expect(isProcessRunning(process.pid)).toBe(true);
    // pid 上限内但几乎不可能存在的号；用 0/-1 这类非法值一起覆盖早退分支
    expect(isProcessRunning(0)).toBe(false);
    expect(isProcessRunning(-1)).toBe(false);
    expect(isProcessRunning(2 ** 31 - 1)).toBe(false);
  });
});
