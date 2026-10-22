// Bundles the Electron main process and the bridge (../bridge/standalone.ts and everything it imports from the
// repo) into dist/. Native and heavy packages stay external and ship in node_modules.
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  logLevel: 'warning',
  // The bridge loads node-pty, ws and transformers with import(); in a CommonJS bundle those must be require()
  // calls so Electron resolves them inside the app's asar archive.
  supported: { 'dynamic-import': false },
};

await build({
  ...common,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  external: ['electron', 'electron-updater'],
});

await build({
  ...common,
  entryPoints: ['src/bridge-process.ts'],
  outfile: 'dist/bridge.cjs',
  external: ['electron', 'node-pty', 'ws', '@huggingface/transformers'],
});
