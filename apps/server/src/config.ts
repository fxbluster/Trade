import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Attempt to load .env from current directory or root workspace
try {
  if (fs.existsSync('.env')) {
    process.loadEnvFile('.env');
  } else if (fs.existsSync(path.resolve(process.cwd(), '../../.env'))) {
    process.loadEnvFile(path.resolve(process.cwd(), '../../.env'));
  }
} catch {
  // Silent fallback if .env does not exist or process.loadEnvFile is unhandled
}

export const PORT: number = Number(process.env.PORT) || 3400;
export const HOST: string = '127.0.0.1';

export const BINANCE_DEMO_API_KEY: string = process.env.BINANCE_DEMO_API_KEY || '';
export const BINANCE_DEMO_API_SECRET: string = process.env.BINANCE_DEMO_API_SECRET || '';
export const GEMINI_API_KEY: string = process.env.GEMINI_API_KEY || '';

// 256-bit cryptographic session token generated on server startup
export const SESSION_TOKEN: string = process.env.TEST_SESSION_TOKEN || crypto.randomBytes(32).toString('hex');

export const ALLOWED_HOSTS = new Set<string>([
  '127.0.0.1:3400',
  'localhost:3400',
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`
]);

export const ALLOWED_ORIGINS = new Set<string>([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  'http://localhost:5173',
  'http://127.0.0.1:5173'
]);

export const DB_PATH: string = process.env.DB_PATH || path.resolve(process.cwd(), 'data/tradeos.db');

/**
 * Sanitizes sensitive credentials and tokens from logging objects.
 */
export function redactSecrets(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => redactSecrets(item));
  }
  const clone: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  for (const key of Object.keys(clone)) {
    if (/key|secret|token|password|auth|authorization/i.test(key) && typeof clone[key] === 'string') {
      clone[key] = '***REDACTED***';
    } else if (typeof clone[key] === 'object' && clone[key] !== null) {
      clone[key] = redactSecrets(clone[key]);
    }
  }
  return clone;
}
