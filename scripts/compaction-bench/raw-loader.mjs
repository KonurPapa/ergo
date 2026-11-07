/** Node loader for the benchmark: `import x from './file.md?raw'` gives the file's text, as Vite does; plus the browser globals app modules expect. */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('?raw')) {
    const r = await next(specifier.slice(0, -4), context);
    return { url: `${r.url}?raw`, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith('?raw')) {
    const text = readFileSync(fileURLToPath(url.slice(0, -4)), 'utf-8');
    return { format: 'module', source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  }
  return next(url, context);
}

// Browser globals some imported app modules read at load time (in memory only: the benchmark keeps no app state).
if (typeof globalThis.localStorage?.getItem !== 'function') {
  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => void store.set(k, String(v)), removeItem: (k) => void store.delete(k), clear: () => store.clear(), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; } },
  });
}

if (!globalThis.__ergoRawLoader) {
  globalThis.__ergoRawLoader = true;
  register(import.meta.url);
}
