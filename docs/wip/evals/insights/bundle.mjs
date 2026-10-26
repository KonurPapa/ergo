import { build } from '/home/konur/Documents/Ergo/node_modules/esbuild/lib/main.js';
await build({
  entryPoints: ['/home/konur/Documents/Ergo/src/lib/memory/insights.ts'],
  bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'warning',
  outfile: new URL('./insights.bundle.mjs', import.meta.url).pathname,
  plugins: [{ name: 'raw', setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: a.path, namespace: 'raw' }));
    b.onLoad({ filter: /.*/, namespace: 'raw' }, () => ({ contents: 'export default ""', loader: 'js' }));
  } }],
});
