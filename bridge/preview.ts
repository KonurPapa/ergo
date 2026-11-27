/**
 * Live Web Preview: serves a task's web output (HTML + its CSS/JS/assets) to the app's Preview tab, and finds dev
 * servers running on this computer.
 *
 * Files are served under an unguessable per-folder session path, /api/preview/s/<token>/<relPath>, so relative asset
 * URLs just work. These GETs come from an iframe (no Origin, or Origin "null" from the sandboxed page itself), so the
 * bridge guard lets them through on the token alone. Every response carries a CSP `sandbox` (no allow-same-origin):
 * the page always runs in an opaque origin and can never call the bridge's /api/* with the app's origin.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const PREVIEW_FILE_PREFIX = '/api/preview/s/';

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 64;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

interface PreviewSession {
  root: string;
  expiresAt: number;
}

const sessions = new Map<string, PreviewSession>();

function pruneSessions(now = Date.now()) {
  for (const [token, s] of sessions) if (s.expiresAt <= now) sessions.delete(token);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

/** Returns the token for a folder, reusing a live one so reloads keep the same URL. `root` must already be validated. */
export function createPreviewSession(root: string): string {
  pruneSessions();
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.root === root) {
      s.expiresAt = now + SESSION_TTL_MS;
      return token;
    }
  }
  const token = randomBytes(16).toString('base64url');
  sessions.set(token, { root, expiresAt: now + SESSION_TTL_MS });
  return token;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

/** Sent to the parent (LivePreviewPane) so the console drawer shows the page's logs and errors. */
const CONSOLE_BRIDGE_SCRIPT = `<script>(function(){try{if(window.parent===window)return;var P=window.parent;
function s(v){try{if(v instanceof Error)return v.stack||String(v);if(typeof v==='object'&&v!==null)return JSON.stringify(v,null,0).slice(0,2000);return String(v)}catch(e){return String(v)}}
function send(level,args){try{P.postMessage({ergoPreview:'console',level:level,text:Array.prototype.map.call(args,s).join(' ').slice(0,4000),ts:Date.now()},'*')}catch(e){}}
['log','info','warn','error','debug'].forEach(function(l){var o=console[l];console[l]=function(){send(l,arguments);return o&&o.apply(console,arguments)}});
window.addEventListener('error',function(e){send('error',[e.message+(e.filename?' ('+e.filename.split('/').pop()+':'+e.lineno+')':'')])});
window.addEventListener('unhandledrejection',function(e){send('error',['Unhandled promise rejection: '+s(e.reason)])});
}catch(e){}})();</script>`;

function injectConsoleBridge(html: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + CONSOLE_BRIDGE_SCRIPT + html.slice(head.index + head[0].length);
  const htmlTag = /<html\b[^>]*>/i.exec(html);
  if (htmlTag) return html.slice(0, htmlTag.index + htmlTag[0].length) + CONSOLE_BRIDGE_SCRIPT + html.slice(htmlTag.index + htmlTag[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + CONSOLE_BRIDGE_SCRIPT + html.slice(doctype[0].length);
  return CONSOLE_BRIDGE_SCRIPT + html;
}

const isInside = (p: string, root: string) => p === root || p.startsWith(root + path.sep);

function sendText(res: ServerResponse, status: number, text: string) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(text);
}

/** GET /api/preview/s/<token>/<relPath>. Returns false when `url` isn't a preview file URL. */
export async function handlePreviewFile(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
  if (!url.startsWith(PREVIEW_FILE_PREFIX)) return false;
  // Applies to every response, errors included: the page and anything it loads stay in an opaque origin.
  res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // The sandboxed page's own fetch()/module scripts send Origin "null"; the token is the access check.
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed');
    return true;
  }
  const rest = url.slice(PREVIEW_FILE_PREFIX.length);
  const slash = rest.indexOf('/');
  const token = slash === -1 ? rest : rest.slice(0, slash);
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sendText(res, 404, 'This preview has expired. Reopen it from Ergo.');
    return true;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;

  let rel = slash === -1 ? '' : rest.slice(slash + 1);
  try {
    rel = decodeURIComponent(rel);
  } catch {
    sendText(res, 400, 'Bad request');
    return true;
  }
  if (rel.includes('\0') || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    sendText(res, 403, 'Forbidden');
    return true;
  }
  try {
    const realRoot = await fs.realpath(session.root);
    let full = path.resolve(realRoot, rel);
    let st = await fs.stat(full);
    if (st.isDirectory()) {
      full = path.join(full, 'index.html');
      st = await fs.stat(full);
    }
    // Symlinks may not lead out of the folder.
    const real = await fs.realpath(full);
    if (!isInside(real, realRoot)) {
      sendText(res, 403, 'Forbidden');
      return true;
    }
    if (!st.isFile()) {
      sendText(res, 404, 'Not found');
      return true;
    }
    if (st.size > MAX_FILE_BYTES) {
      sendText(res, 413, 'File too large to preview');
      return true;
    }
    const ext = path.extname(real).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    const buf = await fs.readFile(real);
    if (ext === '.html' || ext === '.htm') {
      res.end(injectConsoleBridge(buf.toString('utf-8')));
    } else {
      res.end(buf);
    }
  } catch {
    sendText(res, 404, 'Not found');
  }
  return true;
}

/** Ports dev servers commonly use. */
const DEV_PORTS = [
  3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010,
  4000, 4173, 4174, 4200, 4321, 5000, 5001, 5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180,
  6006, 8000, 8001, 8080, 8081, 8888, 9000,
];

function probePort(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

interface PageProbe {
  ok: boolean;
  title?: string;
  isErgoBridge?: boolean;
}

/** GETs / with a short timeout: is it a web server, what's its <title>, is it another Ergo bridge? */
function probePage(host: string, port: number): Promise<PageProbe> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout: 1200, headers: { Accept: 'text/html' } }, (r) => {
      const isErgoBridge = Boolean(r.headers['x-ergo-bridge']);
      let body = '';
      r.setEncoding('utf-8');
      r.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 64 * 1024) r.destroy();
      });
      const finish = () => {
        const m = /<title[^>]*>([^<]{0,200})<\/title>/i.exec(body);
        const title = m ? m[1].trim() : undefined;
        // Bridges older than the X-Ergo-Bridge header still show their status page.
        resolve({ ok: true, title, isErgoBridge: isErgoBridge || title === 'Ergo Bridge' });
      };
      r.on('end', finish);
      r.on('close', finish);
      r.on('error', finish);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false });
    });
    req.on('error', () => resolve({ ok: false }));
  });
}

export interface DevServer {
  port: number;
  url: string;
  title?: string;
}

/** Web servers listening on common dev ports on this computer, except the bridge itself (`ownPort`). */
export async function listDevServers(ownPort: number | undefined): Promise<DevServer[]> {
  const found = await Promise.all(
    DEV_PORTS.filter((p) => p !== ownPort).map(async (port) => {
      // Vite and Node often listen on ::1 only ("localhost"), others on 127.0.0.1 only.
      const host = (await probePort('127.0.0.1', port)) ? '127.0.0.1' : (await probePort('::1', port)) ? '::1' : null;
      if (!host) return null;
      const page = await probePage(host, port);
      if (!page.ok || page.isErgoBridge) return null;
      return { port, url: `http://localhost:${port}/`, title: page.title } as DevServer;
    }),
  );
  return found.filter((d): d is DevServer => d !== null);
}
