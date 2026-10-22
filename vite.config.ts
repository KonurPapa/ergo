import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {
  ergoFileSystemPlugin,
  ergoLocalModelPlugin,
  ergoMemoryPlugin,
  ergoModelCatalogPlugin,
  ergoPtyPlugin,
} from './bridge/plugins.ts';

// https://vite.dev/config/
// The device bridge lives in bridge/plugins.ts; bridge/standalone.ts runs it without Vite for the desktop app.
export default defineConfig({
  plugins: [react(), ergoFileSystemPlugin(), ergoPtyPlugin(), ergoMemoryPlugin(), ergoLocalModelPlugin(), ergoModelCatalogPlugin()],
  server: {
    // Agent run files (.ergo/runs/…) change constantly during a task run; never reload the app for them.
    watch: { ignored: ['**/.ergo/**'] },
  },
});
