import express from 'express';
import { createServer } from 'http';

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(express.json());

// Import the terminal routes
import terminalRoutes from './routes/terminal.js';

app.use('/api/terminal', terminalRoutes);

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const server = createServer(app);

server.listen(Number(PORT), HOST, () => {
  console.log(`Web Terminal Server running at http://${HOST}:${PORT}`);
  console.log(`Health check: http://${HOST}:${PORT}/health`);
});

server.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});
