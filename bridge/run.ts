/** `npm run bridge`: Ergo's device bridge on its own, without Vite or the web app (what Ergo Bridge runs). */
import { startBridge } from './standalone.ts';

// Vite installs no handler, so one stray rejection in a route would take the whole bridge down.
process.on('unhandledRejection', (err) => console.error('[Ergo Bridge] Unhandled rejection:', err));

const fixedPort = Number(process.env.ERGO_BRIDGE_PORT) || undefined;
const bridge = await startBridge(fixedPort ? [fixedPort] : undefined);
console.log(`[Ergo Bridge] Running at http://localhost:${bridge.port} (Ctrl+C to stop)`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void bridge.close().finally(() => process.exit(0)));
}
