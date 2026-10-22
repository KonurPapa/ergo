/**
 * Runs Ergo's device bridge without Vite: the plugins `npm run dev` loads (bridge/plugins.ts) on a plain Node HTTP
 * server. The Ergo Bridge desktop app (desktop/) runs this; so does `npm run bridge` from a checkout.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import {
  HOSTED_APP_ORIGINS,
  ergoFileSystemPlugin,
  ergoLocalModelPlugin,
  ergoMemoryPlugin,
  ergoModelCatalogPlugin,
  ergoPtyPlugin,
} from './plugins.ts';

/** The ports the hosted app probes, in its order (FALLBACK_BRIDGE_PORTS in src/lib/bridgeClient.ts). */
export const BRIDGE_PORTS = [5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180, 3000];

export interface RunningBridge {
  port: number;
  close(): Promise<void>;
}

type Middleware = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => unknown;

/** All the bridge plugins use of Vite's dev server: a connect-style middleware stack and the HTTP server. */
function createServerShim() {
  const stack: Middleware[] = [];
  const httpServer = http.createServer((req, res) => {
    let index = 0;
    const next = (err?: unknown) => {
      if (err) return sendError(res, err);
      const middleware = stack[index++] ?? statusPage;
      try {
        const result = middleware(req, res, next);
        if (result instanceof Promise) result.catch(next);
      } catch (error) {
        next(error);
      }
    };
    next();
  });
  return { middlewares: { use: (fn: Middleware) => void stack.push(fn) }, httpServer };
}

function sendError(res: ServerResponse, err: unknown) {
  console.error('[Ergo Bridge] Request failed:', err);
  if (res.headersSent) return void res.end();
  res.statusCode = 500;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
}

/** Anyone who opens the bridge's address in a browser lands here instead of on a bare 404. */
function statusPage(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'GET' || (req.url !== '/' && req.url !== '/index.html')) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    return void res.end(JSON.stringify({ error: 'Not found' }));
  }
  const ergoUrl = HOSTED_APP_ORIGINS[0];
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset="utf-8"><title>Ergo Bridge</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.3rem">Ergo Bridge is running</h1>
<p>This computer is ready for Ergo. Go back to <a href="${ergoUrl}">${ergoUrl}</a>; it connects automatically.</p>
</body>`);
}

/**
 * `true` if `port` is free on `host`, `false` if taken (or reserved: Windows blocks Hyper-V's port ranges with
 * EACCES), `null` if this machine has no such address (no IPv6 loopback).
 */
function portState(port: number, host: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT' ? null : false);
    });
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** Starts the bridge on the first port in `ports` that is free on both loopback addresses. */
export async function startBridge(ports: number[] = BRIDGE_PORTS): Promise<RunningBridge> {
  const shim = createServerShim();
  for (const plugin of [ergoFileSystemPlugin(), ergoPtyPlugin(), ergoMemoryPlugin(), ergoLocalModelPlugin(), ergoModelCatalogPlugin()]) {
    const hook = plugin.configureServer;
    const handler = typeof hook === 'function' ? hook : hook?.handler;
    // The plugins only touch `middlewares` and `httpServer`, which the shim provides.
    await handler?.call(undefined as never, shim as never);
  }

  let port: number | undefined;
  for (const candidate of ports) {
    // Browsers try ::1 before 127.0.0.1 for "localhost", so a different server on ::1 would answer instead of us.
    if ((await portState(candidate, '127.0.0.1')) && (await portState(candidate, '::1')) !== false) {
      port = candidate;
      break;
    }
  }
  if (port === undefined) {
    throw new Error(`Every port Ergo looks for its bridge on is taken: ${ports.join(', ')}. Close whatever uses them and restart.`);
  }

  // The plugins hook 'listening', 'upgrade' and 'close' on the primary server; the IPv6 one just forwards to it.
  await listen(shim.httpServer, port, '127.0.0.1');
  const ipv6 = http.createServer();
  ipv6.on('request', (req, res) => shim.httpServer.emit('request', req, res));
  ipv6.on('upgrade', (req, socket, head) => shim.httpServer.emit('upgrade', req, socket, head));
  // Answering on ::1 spares Windows its seconds-long refusal before browsers fall back to 127.0.0.1.
  await listen(ipv6, port, '::1').catch(() => {});

  return {
    port,
    close: async () => {
      await Promise.all([closeServer(ipv6), closeServer(shim.httpServer)]);
    },
  };
}
