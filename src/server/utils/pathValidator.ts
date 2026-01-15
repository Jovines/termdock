import path from 'path';
import fs from 'fs';

/**
 * 安全路径验证器
 * 防止路径遍历攻击，限制访问范围
 */
export class PathValidator {
  private allowedPaths: Set<string>;
  private defaultAllowedPaths: string[];
  
  constructor() {
    // 默认允许的路径
    this.defaultAllowedPaths = [
      // 用户主目录
      process.env.HOME || process.env.USERPROFILE || '/home',
      // 临时目录
      '/tmp',
      // 当前工作目录
      process.cwd(),
    ].filter(Boolean).map(p => path.resolve(p));
    
    this.allowedPaths = new Set(this.defaultAllowedPaths);
    
    // 从环境变量读取额外的允许路径
    const extraPaths = process.env.ALLOWED_PATHS?.split(':').filter(Boolean) || [];
    extraPaths.forEach(p => {
      try {
        this.allowedPaths.add(path.resolve(p));
      } catch (error) {
        console.warn(`Invalid allowed path: ${p}`, error);
      }
    });
  }
  
  /**
   * 验证和规范化路径
   * @param requestedPath 请求的路径
   * @returns 安全、规范化的路径
   * @throws Error 如果路径不安全
   */
  validate(requestedPath: string): string {
    if (!requestedPath || typeof requestedPath !== 'string') {
      throw new Error('Path must be a non-empty string');
    }
    
    // 解析路径，去除相对路径
    let resolvedPath: string;
    try {
      resolvedPath = path.resolve(requestedPath);
    } catch (error) {
      throw new Error(`Invalid path format: ${requestedPath}`);
    }
    
    // 检查路径是否存在
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Directory does not exist: ${resolvedPath}`);
    }
    
    // 检查是否为目录
    try {
      const stat = fs.statSync(resolvedPath);
      if (!stat.isDirectory()) {
        throw new Error(`Path is not a directory: ${resolvedPath}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('not a directory')) {
        throw error;
      }
      throw new Error(`Cannot access directory: ${resolvedPath}`);
    }
    
    // 检查路径是否在允许的范围内
    let isAllowed = false;
    for (const allowedPath of this.allowedPaths) {
      if (resolvedPath.startsWith(allowedPath)) {
        isAllowed = true;
        break;
      }
    }
    
    if (!isAllowed) {
      console.warn(`Access denied: ${resolvedPath} is not in allowed paths`);
      throw new Error('Access denied: directory not allowed');
    }
    
    // 额外的安全检查：避免系统关键目录
    const dangerousPatterns = [
      '/bin', '/sbin', '/usr/bin', '/usr/sbin',
      '/etc', '/var', '/lib', '/proc', '/sys',
      '/boot', '/root', '/dev'
    ];
    
    for (const pattern of dangerousPatterns) {
      if (resolvedPath.startsWith(pattern)) {
        console.warn(`Access denied: ${resolvedPath} is a system directory`);
        throw new Error('Access denied: system directories are restricted');
      }
    }
    
    return resolvedPath;
  }
  
  /**
   * 添加允许的路径
   */
  addAllowedPath(pathToAdd: string): void {
    const resolved = path.resolve(pathToAdd);
    this.allowedPaths.add(resolved);
  }
  
  /**
   * 获取所有允许的路径
   */
  getAllowedPaths(): string[] {
    return Array.from(this.allowedPaths);
  }
  
  /**
   * 检查路径是否在允许范围内（不抛出异常）
   */
  isPathAllowed(requestedPath: string): boolean {
    try {
      this.validate(requestedPath);
      return true;
    } catch {
      return false;
    }
  }
}

// 单例实例
export const pathValidator = new PathValidator();