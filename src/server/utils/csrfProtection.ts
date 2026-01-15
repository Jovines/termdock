import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

/**
 * CSRF保护配置
 */
interface CsrfConfig {
  cookieName?: string;
  headerName?: string;
  tokenLength?: number;
  cookieOptions?: {
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'strict' | 'lax' | 'none';
    maxAge?: number;
  };
}

/**
 * CSRF令牌管理器
 */
export class CsrfProtection {
  private config: Required<CsrfConfig>;
  
  constructor(config: CsrfConfig = {}) {
    this.config = {
      cookieName: config.cookieName || 'XSRF-TOKEN',
      headerName: config.headerName || 'X-XSRF-TOKEN',
      tokenLength: config.tokenLength || 32,
      cookieOptions: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000, // 24小时
        ...config.cookieOptions,
      },
    };
  }
  
  /**
   * 生成CSRF令牌
   */
  generateToken(): string {
    return crypto.randomBytes(this.config.tokenLength).toString('hex');
  }
  
  /**
   * 验证CSRF令牌
   */
  verifyToken(cookieToken: string | undefined, headerToken: string | undefined): boolean {
    if (!cookieToken || !headerToken) {
      return false;
    }
    
    // 使用定时安全比较防止时序攻击
    return crypto.timingSafeEqual(
      Buffer.from(cookieToken),
      Buffer.from(headerToken)
    );
  }
  
  /**
    * Express中间件：生成并设置CSRF令牌
    */
   tokenMiddleware() {
     return (req: Request, res: Response, next: NextFunction) => {
       // 如果是GET请求，生成并设置令牌
       if (req.method === 'GET') {
         const token = this.generateToken();
         
         res.cookie(this.config.cookieName, token, this.config.cookieOptions);
         
         // 对于API端点，也返回令牌在响应头中
         if (req.path.startsWith('/api/')) {
           res.setHeader(this.config.headerName, token);
         }
       }
       
       next();
     };
   }
  
  /**
    * Express中间件：验证CSRF令牌
    */
   verifyMiddleware() {
     return (req: Request, res: Response, next: NextFunction) => {
       // 跳过安全检查和GET/HEAD/OPTIONS请求
       const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
       if (safeMethods.includes(req.method)) {
         return next();
       }
       
       // 开发模式下跳过 CSRF 验证
       if (process.env.NODE_ENV !== 'production') {
         return next();
       }
       
       // 跳过某些端点（如果需要）
       const skipPaths = ['/api/csrf-token'];
       if (skipPaths.some(path => req.path.startsWith(path))) {
         return next();
       }
       
       // 获取令牌
       const cookieToken = req.cookies?.[this.config.cookieName];
       const headerToken = req.headers[this.config.headerName.toLowerCase()] as string;
       
       // 验证令牌
       if (!this.verifyToken(cookieToken, headerToken)) {
         console.warn(`CSRF token validation failed for ${req.method} ${req.path}`);
         return res.status(403).json({
           error: 'CSRF token validation failed',
           code: 'CSRF_ERROR',
         });
       }
       
       next();
     };
   }
  
  /**
   * 获取CSRF令牌端点处理器
   */
  getTokenHandler() {
    return (_req: Request, res: Response) => {
      const token = this.generateToken();
      
      res.cookie(this.config.cookieName, token, this.config.cookieOptions);
      
      res.json({
        csrfToken: token,
        headerName: this.config.headerName,
      });
    };
  }
}

// 默认实例
export const csrfProtection = new CsrfProtection();