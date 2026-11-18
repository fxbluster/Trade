import crypto from 'node:crypto';
import type { Middleware, NextHandler, Request, Response } from 'polka';
import {
  SESSION_TOKEN,
  ALLOWED_HOSTS,
  ALLOWED_ORIGINS
} from '../config.js';

export const MAX_BODY_BYTES = 256 * 1024; // 256 KB limit

/**
 * Validates Host header against DNS rebinding attacks.
 * Strictly permits only 127.0.0.1 and localhost on the configured port.
 */
export const validateHost: Middleware = (req: Request, res: Response, next: NextHandler) => {
  const rawHost = req.headers['host'];
  if (!rawHost) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Forbidden: Missing Host header' }));
    return;
  }

  // Normalize host (strip trailing dot if present)
  const host = rawHost.replace(/\.$/, '');
  if (!ALLOWED_HOSTS.has(host)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `Forbidden: Host '${host}' rejected by DNS rebinding guard` }));
    return;
  }

  next();
};

/**
 * Validates Origin header against strict allowlist.
 * Allows requests with no Origin (direct server-side / same-origin without header).
 */
export const validateOrigin: Middleware = (req: Request, res: Response, next: NextHandler) => {
  const origin = req.headers['origin'];

  if (origin) {
    if (!ALLOWED_ORIGINS.has(origin)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `Forbidden: Origin '${origin}' is not allowed` }));
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  next();
};

/**
 * Enforces cryptographic Bearer session token authentication.
 * Exempts non-API routes (static SPA assets), OPTIONS, GET /api/health, and GET /api/auth/session.
 */
export const requireSessionToken: Middleware = (req: Request, res: Response, next: NextHandler) => {
  const pathname = req.url ? req.url.split('?')[0] : '';

  // Public exemptions: static web assets, OPTIONS, and public API endpoints
  if (
    req.method === 'OPTIONS' ||
    !pathname.startsWith('/api/') ||
    (req.method === 'GET' && (pathname === '/api/health' || pathname === '/api/auth/session'))
  ) {
    return next();
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Unauthorized: Missing or malformed Bearer session token' }));
    return;
  }

  const token = authHeader.slice(7).trim();
  const tokenBuf = Buffer.from(token);
  const sessionBuf = Buffer.from(SESSION_TOKEN);

  const isValid =
    tokenBuf.length === sessionBuf.length &&
    crypto.timingSafeEqual(tokenBuf, sessionBuf);

  if (!isValid) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Unauthorized: Invalid session token' }));
    return;
  }

  req.token = token;
  next();
};

/**
 * Streaming JSON body parser capped strictly at 256KB to guard against memory exhaustion.
 */
export const jsonBodyParser: Middleware = (req: Request, res: Response, next: NextHandler) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    req.body = {};
    return next();
  }

  const contentLength = Number(req.headers['content-length']);
  if (!Number.isNaN(contentLength) && contentLength > MAX_BODY_BYTES) {
    res.statusCode = 413;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Payload Too Large: Body exceeds 256KB limit' }));
    return;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  const onData = (chunk: Buffer) => {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      res.statusCode = 413;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Payload Too Large: Body exceeds 256KB limit' }));
      return;
    }
    chunks.push(chunk);
  };

  const onEnd = () => {
    if (chunks.length === 0) {
      req.body = {};
      return next();
    }

    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) {
      req.body = {};
      return next();
    }

    try {
      req.body = JSON.parse(raw);
      next();
    } catch {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Bad Request: Malformed JSON payload' }));
    }
  };

  req.on('data', onData);
  req.on('end', onEnd);
};
