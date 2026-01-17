import express from 'express';
import { createServer } from 'http';
import cookieParser from 'cookie-parser';
import { csrfProtection } from './utils/csrfProtection.js';
import { pathValidator } from './utils/pathValidator.js';

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();

// 基础中间件
app.use(express.json());
app.use(cookieParser());

// 安全中间件：CSRF令牌生成（在所有路由之前）
app.use(csrfProtection.tokenMiddleware());

// 健康检查端点（不需要CSRF保护）
app.get('/health', (_req, res) => {
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      security: {
        csrfEnabled: true,
        pathValidationEnabled: true
      }
    });
});

// CSRF令牌获取端点
app.get('/api/csrf-token', csrfProtection.getTokenHandler());

// 安全中间件：将路径验证器注入到请求对象中
app.use((req, _res, next) => {
  req.pathValidator = pathValidator;
  next();
});

// Import the terminal routes
import terminalRoutes from './routes/terminal.js';

// Home directory endpoint
import { homedir } from 'os';

app.get('/api/home', (_req, res) => {
  res.json({ home: homedir() });
});

// 应用CSRF保护（在终端路由之前）
app.use('/api/terminal', csrfProtection.verifyMiddleware());

// 终端路由
app.use('/api/terminal', terminalRoutes);

const server = createServer(app);

server.listen(Number(PORT), HOST, () => {
  console.log(`Web Terminal Server running at http://${HOST}:${PORT}`);
  console.log(`Health check: http://${HOST}:${PORT}/health`);
});

server.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});
