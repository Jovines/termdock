import { Request, Response, NextFunction } from 'express';

/**
 * 速率限制配置
 */
interface RateLimitConfig {
  windowMs: number; // 时间窗口（毫秒）
  maxRequests: number; // 最大请求数
  message?: string; // 限制时的错误消息
  statusCode?: number; // 限制时的状态码
  skipFailedRequests?: boolean; // 是否跳过失败请求
  skipSuccessfulRequests?: boolean; // 是否跳过成功请求
  keyGenerator?: (req: Request) => string; // 键生成器
  skip?: (req: Request) => boolean; // 跳过条件
}

/**
 * 请求记录
 */
interface RequestRecord {
  count: number;
  firstRequestTime: number;
  resetTime: number;
}

/**
 * 内存存储的速率限制器
 */
export class RateLimiter {
  private config: Required<RateLimitConfig>;
  private store: Map<string, RequestRecord>;
  private cleanupInterval: NodeJS.Timeout;
  
  constructor(config: RateLimitConfig) {
    this.config = {
      windowMs: config.windowMs,
      maxRequests: config.maxRequests,
      message: config.message || 'Too many requests, please try again later.',
      statusCode: config.statusCode || 429,
      skipFailedRequests: config.skipFailedRequests || false,
      skipSuccessfulRequests: config.skipSuccessfulRequests || false,
      keyGenerator: config.keyGenerator || ((req) => req.ip || 'unknown'),
      skip: config.skip || (() => false),
    };
    
    this.store = new Map();
    
    // 定期清理过期的记录
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredRecords();
    }, this.config.windowMs * 2);
  }
  
  /**
   * 清理过期的记录
   */
  private cleanupExpiredRecords(): void {
    const now = Date.now();
    for (const [key, record] of this.store.entries()) {
      if (now > record.resetTime) {
        this.store.delete(key);
      }
    }
  }
  
  /**
   * 检查请求是否应该被限制
   */
  private shouldSkipRequest(req: Request, _res: Response): boolean {
    // 用户定义的跳过条件
    if (this.config.skip(req)) {
      return true;
    }
    
    // 跳过某些路径
    const skipPaths = ['/health', '/favicon.ico', '/robots.txt'];
    if (skipPaths.some(path => req.path.startsWith(path))) {
      return true;
    }
    
    return false;
  }
  
  /**
   * 获取当前请求的键
   */
  private getKey(req: Request): string {
    const baseKey = this.config.keyGenerator(req);
    
    // 根据路径添加不同的键，实现不同端点的独立限制
    const path = req.path;
    const method = req.method;
    
    return `${baseKey}:${method}:${path}`;
  }
  
  /**
   * 获取请求记录
   */
  private getRecord(key: string): RequestRecord {
    const now = Date.now();
    let record = this.store.get(key);
    
    if (!record || now > record.resetTime) {
      record = {
        count: 0,
        firstRequestTime: now,
        resetTime: now + this.config.windowMs,
      };
      this.store.set(key, record);
    }
    
    return record;
  }
  
  /**
   * 检查是否超过限制
   */
  private isOverLimit(record: RequestRecord): boolean {
    return record.count >= this.config.maxRequests;
  }
  
  /**
   * 增加请求计数
   */
  private incrementRecord(record: RequestRecord): void {
    record.count += 1;
  }
  
  /**
   * 设置速率限制头部
   */
  private setRateLimitHeaders(res: Response, record: RequestRecord): void {
    const remaining = Math.max(0, this.config.maxRequests - record.count);
    const resetTime = Math.ceil(record.resetTime / 1000); // 转换为Unix时间戳
    
    res.setHeader('X-RateLimit-Limit', this.config.maxRequests.toString());
    res.setHeader('X-RateLimit-Remaining', remaining.toString());
    res.setHeader('X-RateLimit-Reset', resetTime.toString());
  }
  
  /**
   * Express中间件
   */
  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      // 检查是否应该跳过
      if (this.shouldSkipRequest(req, res)) {
        return next();
      }
      
      const key = this.getKey(req);
      const record = this.getRecord(key);
      
      // 检查是否超过限制
      if (this.isOverLimit(record)) {
        this.setRateLimitHeaders(res, record);
        
        return res.status(this.config.statusCode).json({
          error: this.config.message,
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: Math.ceil((record.resetTime - Date.now()) / 1000),
        });
      }
      
      // 增加计数
      this.incrementRecord(record);
      
      // 设置响应头
      this.setRateLimitHeaders(res, record);
      
      // 响应完成后再决定是否记录（基于skip配置）
      const originalSend = res.send;
      res.send = ((body: any) => {
        const statusCode = res.statusCode;
        const isSuccess = statusCode >= 200 && statusCode < 300;
        
        // 如果配置了跳过成功或失败的请求，回滚计数
        if ((this.config.skipSuccessfulRequests && isSuccess) ||
            (this.config.skipFailedRequests && !isSuccess)) {
          record.count = Math.max(0, record.count - 1);
        }
        
        return originalSend.call(res, body);
      }) as any;
      
      next();
    };
  }
  
  /**
   * 清理资源
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.store.clear();
  }
  
  /**
   * 获取存储统计信息
   */
  getStats(): {
    totalKeys: number;
    activeRecords: number;
  } {
    const now = Date.now();
    let activeRecords = 0;
    
    for (const record of this.store.values()) {
      if (now <= record.resetTime) {
        activeRecords++;
      }
    }
    
    return {
      totalKeys: this.store.size,
      activeRecords,
    };
  }
}

/**
 * 为不同端点创建特定的速率限制器
 */
export const rateLimiters = {
  // 终端创建：限制为每分钟5次
  terminalCreate: new RateLimiter({
    windowMs: 60 * 1000, // 1分钟
    maxRequests: 5,
    message: 'Too many terminal sessions created, please try again later.',
  }),
  
  // 终端输入：限制为每秒50次
  terminalInput: new RateLimiter({
    windowMs: 1000, // 1秒
    maxRequests: 50,
    message: 'Too many inputs, please slow down.',
  }),
  
  // 通用API：限制为每分钟5000次
  apiGeneral: new RateLimiter({
    windowMs: 60 * 1000, // 1分钟
    maxRequests: 5000,
    message: 'Too many API requests, please try again later.',
  }),
  
  // 身份验证端点：限制为每分钟10次
  auth: new RateLimiter({
    windowMs: 60 * 1000, // 1分钟
    maxRequests: 10,
    message: 'Too many authentication attempts, please try again later.',
  }),
};