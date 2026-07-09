import { defineConfig } from 'vite';

// PORT is set by tooling (e.g. preview launchers); default stays 5173
export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5173,
  },
});
