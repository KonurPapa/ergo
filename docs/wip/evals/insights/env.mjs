// Browser globals some Ergo modules touch at import time.
const mem = new Map();
const ls = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), clear: () => mem.clear(), key: () => null, length: 0 };
Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: ls, configurable: true });
globalThis.window ??= globalThis;
globalThis.window.location ??= { origin: 'http://localhost:5173', href: 'http://localhost:5173/', hostname: 'localhost', protocol: 'http:', search: '' };
globalThis.window.addEventListener ??= () => {};
globalThis.document ??= { addEventListener() {}, visibilityState: 'visible' };
