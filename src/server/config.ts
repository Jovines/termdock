/**
 * 共享端口配置
 * - 前端开发服务器 (Vite): 9833
 * - 正式/安装后服务: 9834
 * - 后端开发 API 服务器: 9835
 *
 * 开发时访问 9833（Vite 会代理 API 到 devBackend）
 * 生产环境访问 9834（后端直接 serve 前端静态文件）
 */

export const PORT = {
  /** 前端开发服务器 (Vite dev server) */
  frontend: 9833,
  /** 正式/安装后服务 */
  backend: 9834,
  /** 后端开发 API 服务器 */
  devBackend: 9835,
} as const;

/** 默认主机 */
export const DEFAULT_HOST = '0.0.0.0';

/** Local Access 域名配置 */
export const LOCAL_ACCESS = {
  domainSuffix: 'termdock.local',
  generatedNameLength: 4,
  generatedNameAlphabet: 'abcdefghijklmnopqrstuvwxyz0123456789',
  mdnsTtlSeconds: 120,
} as const;
