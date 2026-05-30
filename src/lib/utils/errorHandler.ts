/**
 * 错误类型定义
 */
export enum ErrorType {
  NETWORK = 'NETWORK',
  SESSION = 'SESSION',
  TERMINAL = 'TERMINAL',
  AUTH = 'AUTH',
  VALIDATION = 'VALIDATION',
  UNKNOWN = 'UNKNOWN',
}

/**
 * 错误严重程度
 */
export enum ErrorSeverity {
  LOW = 'LOW',      // 不影响核心功能
  MEDIUM = 'MEDIUM', // 部分功能受影响
  HIGH = 'HIGH',    // 核心功能受影响
  CRITICAL = 'CRITICAL', // 应用无法使用
}

/**
 * 应用错误类
 */
export class AppError extends Error {
  constructor(
    message: string,
    public type: ErrorType,
    public severity: ErrorSeverity,
    public code?: string,
    public details?: Record<string, any>,
    public recoverable: boolean = true
  ) {
    super(message);
    this.name = 'AppError';
  }

  /**
   * 转换为用户友好的消息
   */
  toUserMessage(locale: string = 'zh-CN'): string {
    const messages: Record<string, Record<ErrorType, string>> = {
      'zh-CN': {
        [ErrorType.NETWORK]: '网络连接错误',
        [ErrorType.SESSION]: '会话错误',
        [ErrorType.TERMINAL]: '终端错误',
        [ErrorType.AUTH]: '认证错误',
        [ErrorType.VALIDATION]: '验证错误',
        [ErrorType.UNKNOWN]: '未知错误',
      },
      'en-US': {
        [ErrorType.NETWORK]: 'Network connection error',
        [ErrorType.SESSION]: 'Session error',
        [ErrorType.TERMINAL]: 'Terminal error',
        [ErrorType.AUTH]: 'Authentication error',
        [ErrorType.VALIDATION]: 'Validation error',
        [ErrorType.UNKNOWN]: 'Unknown error',
      },
    };

    const baseMessage = messages[locale]?.[this.type] || this.message;
    
    // 根据严重程度添加前缀
    const severityPrefix: Record<string, Record<ErrorSeverity, string>> = {
      'zh-CN': {
        [ErrorSeverity.LOW]: '提示：',
        [ErrorSeverity.MEDIUM]: '警告：',
        [ErrorSeverity.HIGH]: '错误：',
        [ErrorSeverity.CRITICAL]: '严重错误：',
      },
      'en-US': {
        [ErrorSeverity.LOW]: 'Note: ',
        [ErrorSeverity.MEDIUM]: 'Warning: ',
        [ErrorSeverity.HIGH]: 'Error: ',
        [ErrorSeverity.CRITICAL]: 'Critical: ',
      },
    };

    return (severityPrefix[locale]?.[this.severity] || '') + baseMessage;
  }

  /**
   * 获取恢复建议
   */
  getRecoverySuggestions(locale: string = 'zh-CN'): string[] {
    const suggestions: Record<string, Record<ErrorType, string[]>> = {
      'zh-CN': {
        [ErrorType.NETWORK]: [
          '检查网络连接',
          '尝试重新连接',
          '检查代理设置',
          '等待网络恢复',
        ],
        [ErrorType.SESSION]: [
          '重新创建会话',
          '检查服务器状态',
          '清理浏览器缓存',
        ],
        [ErrorType.TERMINAL]: [
          '重启终端',
          '检查终端配置',
          '清除终端输出',
        ],
        [ErrorType.AUTH]: [
          '重新登录',
          '检查凭证',
          '联系管理员',
        ],
        [ErrorType.VALIDATION]: [
          '检查输入格式',
          '验证参数',
          '参考文档',
        ],
        [ErrorType.UNKNOWN]: [
          '刷新页面',
          '重启应用',
          '联系技术支持',
        ],
      },
      'en-US': {
        [ErrorType.NETWORK]: [
          'Check network connection',
          'Try reconnecting',
          'Check proxy settings',
          'Wait for network recovery',
        ],
        [ErrorType.SESSION]: [
          'Recreate session',
          'Check server status',
          'Clear browser cache',
        ],
        [ErrorType.TERMINAL]: [
          'Restart terminal',
          'Check terminal configuration',
          'Clear terminal output',
        ],
        [ErrorType.AUTH]: [
          'Re-login',
          'Check credentials',
          'Contact administrator',
        ],
        [ErrorType.VALIDATION]: [
          'Check input format',
          'Validate parameters',
          'Refer to documentation',
        ],
        [ErrorType.UNKNOWN]: [
          'Refresh page',
          'Restart application',
          'Contact support',
        ],
      },
    };

    return suggestions[locale]?.[this.type] || [];
  }

  /**
   * 转换为JSON格式
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      type: this.type,
      severity: this.severity,
      code: this.code,
      details: this.details,
      recoverable: this.recoverable,
      stack: process.env.NODE_ENV === 'development' ? this.stack : undefined,
    };
  }
}

/**
 * 错误工厂函数
 */
export const errorFactory = {
  network: (message: string, details?: Record<string, any>) => 
    new AppError(message, ErrorType.NETWORK, ErrorSeverity.HIGH, 'NETWORK_ERROR', details),
  
  session: (message: string, details?: Record<string, any>) =>
    new AppError(message, ErrorType.SESSION, ErrorSeverity.MEDIUM, 'SESSION_ERROR', details),
  
  terminal: (message: string, details?: Record<string, any>) =>
    new AppError(message, ErrorType.TERMINAL, ErrorSeverity.HIGH, 'TERMINAL_ERROR', details),
  
  auth: (message: string, details?: Record<string, any>) =>
    new AppError(message, ErrorType.AUTH, ErrorSeverity.HIGH, 'AUTH_ERROR', details, false),
  
  validation: (message: string, details?: Record<string, any>) =>
    new AppError(message, ErrorType.VALIDATION, ErrorSeverity.LOW, 'VALIDATION_ERROR', details),
  
  unknown: (message: string, details?: Record<string, any>) =>
    new AppError(message, ErrorType.UNKNOWN, ErrorSeverity.CRITICAL, 'UNKNOWN_ERROR', details),
};

/**
 * 错误报告器
 */
export class ErrorReporter {
  private static instance: ErrorReporter;
  private reports: Array<{ error: AppError; timestamp: number; context?: any }> = [];
  private maxReports = 100;

  private constructor() {}

  static getInstance(): ErrorReporter {
    if (!ErrorReporter.instance) {
      ErrorReporter.instance = new ErrorReporter();
    }
    return ErrorReporter.instance;
  }

  /**
   * 报告错误
   */
  report(error: Error | AppError, context?: any): void {
    const appError = error instanceof AppError ? error : errorFactory.unknown(error.message, { originalError: error });
    
    this.reports.push({
      error: appError,
      timestamp: Date.now(),
      context,
    });

    // 限制报告数量
    if (this.reports.length > this.maxReports) {
      this.reports = this.reports.slice(-this.maxReports);
    }

    // 在开发环境中打印错误
    if (process.env.NODE_ENV === 'development') {
      console.error('Error reported:', {
        error: appError.toJSON(),
        context,
      });
    }

  }

  /**
   * 获取最近的错误报告
   */
  getRecentReports(limit: number = 10) {
    return this.reports.slice(-limit);
  }

  /**
   * 清除错误报告
   */
  clearReports() {
    this.reports = [];
  }

  /**
   * 获取错误统计
   */
  getStats() {
    const stats: Record<ErrorType, number> = {
      [ErrorType.NETWORK]: 0,
      [ErrorType.SESSION]: 0,
      [ErrorType.TERMINAL]: 0,
      [ErrorType.AUTH]: 0,
      [ErrorType.VALIDATION]: 0,
      [ErrorType.UNKNOWN]: 0,
    };

    for (const report of this.reports) {
      stats[report.error.type]++;
    }

    return {
      total: this.reports.length,
      byType: stats,
      recentCount: Math.min(10, this.reports.length),
    };
  }
}

/**
 * 全局错误处理器
 */
export const globalErrorHandler = {
  /**
   * 初始化全局错误处理
   */
  initialize() {
    // 捕获未处理的Promise拒绝
    window.addEventListener('unhandledrejection', (event) => {
      const error = errorFactory.unknown('Unhandled promise rejection', {
        reason: event.reason,
      });
      ErrorReporter.getInstance().report(error);
    });

    // 捕获全局错误
    window.addEventListener('error', (event) => {
      const error = errorFactory.unknown('Global error', {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      });
      ErrorReporter.getInstance().report(error);
    });

    // 捕获控制台错误（备用）
    const originalConsoleError = console.error;
    console.error = (...args) => {
      originalConsoleError.apply(console, args);
      
      // 尝试从参数中提取错误
      for (const arg of args) {
        if (arg instanceof Error) {
          ErrorReporter.getInstance().report(arg, { source: 'console.error' });
        }
      }
    };
  },

  /**
   * 处理API错误响应
   */
  handleApiError(response: Response, data?: any): AppError {
    let error: AppError;
    
    switch (response.status) {
      case 400:
        error = errorFactory.validation(data?.error || 'Bad request', data);
        break;
      case 401:
      case 403:
        error = errorFactory.auth(data?.error || 'Authentication failed', data);
        break;
      case 404:
        error = errorFactory.session('Resource not found', data);
        break;
      case 429:
        error = errorFactory.network('Rate limit exceeded', {
          ...data,
          retryAfter: data?.retryAfter,
        });
        break;
      case 500:
      case 502:
      case 503:
      case 504:
        error = errorFactory.network('Server error', data);
        break;
      default:
        error = errorFactory.unknown(`HTTP ${response.status}: ${response.statusText}`, data);
    }

    ErrorReporter.getInstance().report(error, { response });
    return error;
  },

  /**
   * 处理网络错误
   */
  handleNetworkError(error: any): AppError {
    let appError: AppError;
    
    if (error.name === 'AbortError') {
      appError = errorFactory.network('Request aborted', { originalError: error });
    } else if (error.name === 'TimeoutError') {
      appError = errorFactory.network('Request timeout', { originalError: error });
    } else if (!navigator.onLine) {
      appError = errorFactory.network('No internet connection', { originalError: error });
    } else {
      appError = errorFactory.network('Network request failed', { originalError: error });
    }

    ErrorReporter.getInstance().report(appError);
    return appError;
  },
};

/**
 * 错误恢复工具
 */
export const errorRecovery = {
  /**
   * 指数退避重试
   */
  async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        
        // 如果不是最后一次尝试，等待后重试
        if (attempt < maxRetries - 1) {
          const delay = baseDelay * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError!;
  },

  /**
   * 检查是否可恢复的错误
   */
  isRecoverable(error: Error | AppError): boolean {
    if (error instanceof AppError) {
      return error.recoverable;
    }
    
    // 某些原生错误可能是可恢复的
    const recoverableErrors = [
      'NetworkError',
      'TimeoutError',
      'AbortError',
    ];
    
    return recoverableErrors.includes(error.name);
  },

  /**
   * 获取重试建议
   */
  getRetrySuggestion(error: Error | AppError): string | null {
    if (!this.isRecoverable(error)) {
      return null;
    }
    
    if (error instanceof AppError) {
      switch (error.type) {
        case ErrorType.NETWORK:
          return 'network_retry';
        case ErrorType.SESSION:
          return 'session_restart';
        default:
          return 'generic_retry';
      }
    }
    
    return 'generic_retry';
  },
};