/**
 * Entry point of the Electron utility process that runs Ergo's device bridge (bridge/standalone.ts), kept apart from
 * the tray app so a crash here only restarts the bridge. Reports to the main process over process.parentPort.
 */
import fs from 'node:fs';
import path from 'node:path';
import { withUserToolPaths } from './tool-paths.ts';
import { activeSessionCount, setBridgeHost } from '../../bridge/selfUpdate.ts';
import type { BridgeUpdateState } from '../../src/lib/bridgeProtocol.ts';

// The updater runs in the main process (main.ts); it sends its state here so the bridge can report it to the web app,
// and asks how many agent sessions are running before it installs.
let update: BridgeUpdateState = { status: 'idle' };
// The file dialog belongs to the main process too: each request waits for its answer by id.
let pickSeq = 0;
const pendingPicks = new Map<number, { resolve: (paths: string[]) => void; reject: (err: Error) => void }>();
setBridgeHost({
  version: process.env.ERGO_BRIDGE_VERSION || 'unknown',
  getUpdate: () => update,
  requestUpdate: () => process.parentPort.postMessage({ type: 'check-update' }),
  pickFiles: ({ defaultPath }) =>
    new Promise((resolve, reject) => {
      const id = ++pickSeq;
      pendingPicks.set(id, { resolve, reject });
      process.parentPort.postMessage({ type: 'pick-files', id, defaultPath });
    }),
});
process.parentPort.on('message', (event) => {
  const message = event.data as { type?: string; state?: BridgeUpdateState; id?: number; paths?: string[]; error?: string };
  if (message.type === 'update-state' && message.state) update = message.state;
  if (message.type === 'pick-files-result' && typeof message.id === 'number') {
    const pending = pendingPicks.get(message.id);
    pendingPicks.delete(message.id);
    if (message.error) pending?.reject(new Error(message.error));
    else pending?.resolve(Array.isArray(message.paths) ? message.paths : []);
  }
  if (message.type === 'busy-query') process.parentPort.postMessage({ type: 'busy', sessions: activeSessionCount() });
});

async function main() {
  const home = process.env.ERGO_BRIDGE_HOME;
  const resources = process.env.ERGO_BRIDGE_RESOURCES;
  if (!home || !resources) throw new Error('ERGO_BRIDGE_HOME and ERGO_BRIDGE_RESOURCES must be set.');

  // The bridge reads its built-in skill guides from <cwd>/docs/skills and keeps checkout-local state in <cwd>/.ergo,
  // so it runs from a writable folder of its own instead of from the read-only app bundle.
  fs.mkdirSync(home, { recursive: true });
  fs.cpSync(path.join(resources, 'docs', 'skills'), path.join(home, 'docs', 'skills'), { recursive: true, force: true });
  process.chdir(home);
  process.env.PATH = withUserToolPaths(process.env.PATH ?? '');
  process.on('unhandledRejection', (err) => console.error('[Ergo Bridge] Unhandled rejection:', err));

  // Loaded only now: the bridge reads .env files and docs relative to the working directory as it loads.
  const { startBridge } = await import('../../bridge/standalone.ts');
  const bridge = await startBridge();
  console.log(`[Ergo Bridge] Running at http://localhost:${bridge.port}`);
  process.parentPort.postMessage({ type: 'listening', port: bridge.port });
}

main().catch((err) => {
  console.error('[Ergo Bridge] Could not start:', err);
  process.parentPort.postMessage({ type: 'fatal', message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
