import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import { PathValidator } from './pathValidator.js';

// 家目录的父目录（如 C:\Users / /home）：真实存在、但不在默认白名单内
const outsideDir = path.dirname(os.homedir());

describe('PathValidator', () => {
  let savedAllowedPaths: string | undefined;

  beforeEach(() => {
    savedAllowedPaths = process.env.ALLOWED_PATHS;
    delete process.env.ALLOWED_PATHS;
  });

  afterEach(() => {
    if (savedAllowedPaths === undefined) {
      delete process.env.ALLOWED_PATHS;
    } else {
      process.env.ALLOWED_PATHS = savedAllowedPaths;
    }
  });

  it('默认拒绝白名单之外的目录', () => {
    const validator = new PathValidator();
    expect(() => validator.validate(outsideDir)).toThrow(/Access denied/);
  });

  it('addAllowedPath 之后允许该目录及其子路径（会话 cwd 动态放行）', async () => {
    const validator = new PathValidator();
    validator.addAllowedPath(outsideDir);
    expect(validator.validate(outsideDir)).toBeTruthy();
    // 子路径（家目录本身是 outsideDir 的子目录）
    expect(validator.validate(os.homedir())).toBeTruthy();
    await expect(validator.validatePathAsync(os.homedir())).resolves.toBeTruthy();
  });

  it('ALLOWED_PATHS 使用平台分隔符解析（Windows 盘符路径不能被冒号拆碎）', () => {
    process.env.ALLOWED_PATHS = [outsideDir, os.homedir()].join(path.delimiter);
    const validator = new PathValidator();
    expect(validator.validate(outsideDir)).toBeTruthy();
  });
});
