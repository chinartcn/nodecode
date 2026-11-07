/**
 * Codeck Mobile 服务端
 * - 提供静态页面（public / shared）
 * - 蓝图编译与沙箱运行 API
 * - 工作区持久化
 * 零第三方依赖，直接 node server/index.js 启动。
 */

import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileGraph } from './compiler.js';
import { runInSandbox } from './sandbox.js';
import { loadState, saveState } from './storage.js';
import { examples } from './examples.js';
import { normalizeGraph } from '../shared/graph-utils.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJSON(res, 200, { ok: true, name: 'codeck-mobile' });
    return true;
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    sendJSON(res, 200, await loadState());
    return true;
  }

  if (pathname === '/api/state' && req.method === 'POST') {
    const body = await readBody(req);
    const saved = await saveState({ name: body.name, graph: body.graph });
    sendJSON(res, 200, { ok: true, name: saved.name, updatedAt: saved.updatedAt });
    return true;
  }

  if (pathname === '/api/examples' && req.method === 'GET') {
    sendJSON(
      res,
      200,
      examples.map(({ id, name, description, graph }) => ({ id, name, description, graph }))
    );
    return true;
  }

  if (pathname === '/api/compile' && req.method === 'POST') {
    const body = await readBody(req);
    const graph = normalizeGraph(body.graph);
    try {
      const code = compileGraph(graph);
      sendJSON(res, 200, { code });
    } catch (error) {
      sendJSON(res, 400, { error: error.message || '编译失败' });
    }
    return true;
  }

  if (pathname === '/api/run' && req.method === 'POST') {
    const body = await readBody(req);
    const graph = normalizeGraph(body.graph);
    let code = '';
    try {
      code = compileGraph(graph);
    } catch (error) {
      sendJSON(res, 400, { error: error.message || '编译失败' });
      return true;
    }
    const result = await runInSandbox(code, { timeoutMs: body.timeoutMs });
    sendJSON(res, 200, { code, ...result });
    return true;
  }

  return false;
}

async function serveStatic(res, pathname) {
  const isShared = pathname.startsWith('/shared/');
  const baseDir = isShared ? SHARED_DIR : PUBLIC_DIR;
  const relativePath = isShared
    ? pathname.slice('/shared/'.length)
    : pathname === '/'
      ? 'index.html'
      : pathname.slice(1);

  const resolved = path.resolve(baseDir, decodeURIComponent(relativePath));
  const relative = path.relative(baseDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = await readFile(resolved);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, pathname);
      if (!handled) sendJSON(res, 404, { error: 'Not Found' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }
    await serveStatic(res, pathname);
  } catch (error) {
    console.error('[server]', error);
    if (!res.headersSent) sendJSON(res, 500, { error: error.message || '服务器内部错误' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Codeck Mobile 已启动: http://localhost:${PORT}`);
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  手机访问（同一局域网）: http://${net.address}:${PORT}`);
      }
    }
  }
});
