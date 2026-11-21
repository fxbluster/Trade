import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const logFile = path.resolve('server-daemon.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(msg);
  try {
    fs.appendFileSync(logFile, line);
  } catch {}
}

log('[TradeOS Supervisor] Starting continuous daemon supervisor...');

let isShuttingDown = false;

function startServer() {
  if (isShuttingDown) return;

  log('[TradeOS Supervisor] Launching TradeOS server process...');
  const proc = spawn('npx', ['tsx', 'apps/server/src/index.ts'], {
    shell: true,
    stdio: 'inherit',
    env: process.env,
  });

  proc.on('exit', (code, signal) => {
    log(`[TradeOS Supervisor] Server exited with code: ${code}, signal: ${signal}`);
    if (!isShuttingDown) {
      log('[TradeOS Supervisor] Auto-restarting TradeOS server in 2 seconds...');
      setTimeout(startServer, 2000);
    }
  });

  proc.on('error', (err) => {
    log(`[TradeOS Supervisor] Server spawn error: ${err.message}`);
    if (!isShuttingDown) {
      setTimeout(startServer, 3000);
    }
  });
}

process.on('SIGINT', () => {
  isShuttingDown = true;
  log('[TradeOS Supervisor] Received SIGINT, shutting down gracefully.');
  process.exit(0);
});

process.on('SIGTERM', () => {
  isShuttingDown = true;
  log('[TradeOS Supervisor] Received SIGTERM, shutting down gracefully.');
  process.exit(0);
});

startServer();
