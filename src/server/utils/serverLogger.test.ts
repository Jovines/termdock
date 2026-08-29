import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { enforceTermdockLogBudget } from './serverLogger.js';

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-log-budget-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('enforceTermdockLogBudget', () => {
  it('retains only the recent tail of oversized active logs', () => {
    const directory = makeTemporaryDirectory();
    const logPath = path.join(directory, 'access.log');
    fs.writeFileSync(logPath, 'old-entry\nnew-entry\n');

    enforceTermdockLogBudget({
      directory,
      structuredLogMaxBytes: 11,
      serverLogMaxBytes: 11,
      totalLogMaxBytes: 100,
    });

    expect(fs.readFileSync(logPath, 'utf8')).toBe('new-entry\n');
    expect(fs.statSync(logPath).size).toBeLessThanOrEqual(11);
  });

  it('removes the oldest rotations until the total budget is met', () => {
    const directory = makeTemporaryDirectory();
    const oldRotation = path.join(directory, 'access.log.1');
    const newRotation = path.join(directory, 'errors.log.1');
    fs.writeFileSync(path.join(directory, 'access.log'), 'active-a');
    fs.writeFileSync(path.join(directory, 'errors.log'), 'active-b');
    fs.writeFileSync(oldRotation, 'old-rotation');
    fs.writeFileSync(newRotation, 'new-rotation');
    fs.utimesSync(oldRotation, new Date(1_000), new Date(1_000));
    fs.utimesSync(newRotation, new Date(2_000), new Date(2_000));

    enforceTermdockLogBudget({
      directory,
      structuredLogMaxBytes: 100,
      serverLogMaxBytes: 100,
      totalLogMaxBytes: 28,
    });

    expect(fs.existsSync(oldRotation)).toBe(false);
    expect(fs.existsSync(newRotation)).toBe(true);
  });

  it('caps server.log separately without replacing its inode', () => {
    const directory = makeTemporaryDirectory();
    const logPath = path.join(directory, 'server.log');
    fs.writeFileSync(logPath, 'first-line\nsecond-line\n');
    const inodeBefore = fs.statSync(logPath).ino;

    enforceTermdockLogBudget({
      directory,
      structuredLogMaxBytes: 100,
      serverLogMaxBytes: 12,
      totalLogMaxBytes: 100,
    });

    expect(fs.readFileSync(logPath, 'utf8')).toBe('second-line\n');
    expect(fs.statSync(logPath).ino).toBe(inodeBefore);
  });
});
