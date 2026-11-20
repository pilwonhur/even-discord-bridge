import { defineConfig, loadEnv } from 'vite';

// index.html = the Chris voice app (P1-05). spike.html = P1-01 device spike, tts-spike.html = read-aloud
// spike (docs/p1/tts-design.md T0): the dev server still serves them, but they are left out of the build
// so the packaged .ehpk carries only the Chris app.
// base './' = relative asset URLs, since the packaged app is not served from a web root.
// VITE_RELAY_ORIGIN (app/.env.local, untracked) = the relay's Tailscale Serve origin; it must also be the
// network whitelist entry in app.json (untracked; copy app.json.example).
export default defineConfig(({ mode }) => {
  const origin = loadEnv(mode, process.cwd(), 'VITE_').VITE_RELAY_ORIGIN;
  if (!origin || !/^https:\/\/[^/\s]+$/.test(origin)) throw new Error('Set VITE_RELAY_ORIGIN=https://<mac>.<tailnet>.ts.net:8443 in app/.env.local');
  return {
    base: './',
    build: { rollupOptions: { input: { main: 'index.html' } } },
  };
});
