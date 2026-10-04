/**
 * Local entry point: `npm run dev`.
 * Reads .env (if present), builds the app and listens on PORT (default 3000).
 */
import { existsSync } from 'node:fs';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { startNodeServer } from './nodeServer.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig(process.env);
const app = createApp(config);
const port = Number(process.env['PORT'] ?? 3000);

startNodeServer({ handler: app.handler, port })
  .then((running) => {
    console.error(`MCP endpoint listening on ${running.url}`);
  })
  .catch((err: unknown) => {
    console.error('Failed to start:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
