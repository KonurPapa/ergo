// Bundles the Electron main process and the bridge (../bridge/standalone.ts and everything it imports from the
// repo) into dist/. Native and heavy packages stay external and ship in node_modules.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Keep desktop/package.json version in parity with BRIDGE_PROTOCOL in src/lib/bridgeProtocol.ts
try {
  const protocolFile = path.resolve(__dirname, '../../src/lib/bridgeProtocol.ts');
  const pkgFile = path.resolve(__dirname, '../package.json');
  const protocolSource = fs.readFileSync(protocolFile, 'utf8');
  const match = protocolSource.match(/export\s+const\s+BRIDGE_PROTOCOL\s*=\s*(\d+);/);
  if (match) {
    const protocolNum = match[1];
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    const expectedMajorMinor = `0.${protocolNum}`;
    if (!pkg.version.startsWith(`${expectedMajorMinor}.`)) {
      pkg.version = `${expectedMajorMinor}.0`;
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
      console.log(`[build] Synced desktop/package.json version to ${pkg.version} (BRIDGE_PROTOCOL = ${protocolNum})`);
    }
  }
} catch (e) {
  console.warn('[build] Could not sync version with BRIDGE_PROTOCOL:', e);
}

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
