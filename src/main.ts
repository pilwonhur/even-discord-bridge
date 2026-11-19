// Entry point: manual start only. No daemon/service registration (P0 non-scope).
import { createApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';

let config;
try {
  config = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(e.message + '\n');
    process.exit(2);
  }
  throw e;
}

const app = createApp(config);
const port = await app.listen();
app.logger.info('listening', { host: config.bindHost, port, mode: config.mode, stt_min_rms: config.sttMinRms, ready: app.service.isReady(), problems: app.service.readiness().problems });
if (config.mode === 'mock') app.logger.warn('mock_mode', { note: 'Discord is simulated; replies are [MOCK Chris] and are not evidence of the real Chris.' });

const purgeTimer = setInterval(() => {
  const r = app.service.purge();
  if (r.textsCleared || r.requestsDeleted) app.logger.info('retention_purge', r);
}, 3_600_000);
purgeTimer.unref();

let stopping = false;
const shutdown = async (sig: string) => {
  if (stopping) return;
  stopping = true;
  app.logger.info('shutdown', { signal: sig });
  clearInterval(purgeTimer);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
