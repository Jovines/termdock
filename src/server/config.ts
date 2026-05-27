/**
 * 共享端口配置
 * - 前端开发服务器 (Vite): 9833
 * - 后端 API 服务器: 9834
 *
 * 开发时访问 9833（Vite 会代理 API 到后端）
 * 生产环境访问 9834（后端直接 serve 前端静态文件）
 */

export const PORT = {
  /** 前端开发服务器 (Vite dev server) */
  frontend: 9833,
  /** 后端 API 服务器 */
  backend: 9834,
} as const;

/** 默认主机 */
export const DEFAULT_HOST = '0.0.0.0';