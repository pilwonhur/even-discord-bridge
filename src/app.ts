// Wires config → store → adapter → service → HTTP server. Used by main.ts and tests.
import type { Server } from 'node:http';
import { Authenticator, RateLimiter } from './api/auth.ts';
import { createApiServer } from './api/server.ts';
import type { RelayConfig } from './config.ts';
import { secretsOf } from './config.ts';
import { Pairing } from './devices.ts';
import { FakeDiscord } from './discord/fake.ts';
import { RealDiscord } from './discord/real.ts';
import type { DiscordAdapter } from './discord/types.ts';
import { createLogger } from './log.ts';
import type { Logger } from './log.ts';
import { RelayService } from './service.ts';
import type { ServiceDeps } from './service.ts';
import { Store } from './store/store.ts';
import { WhisperCli } from './stt.ts';
import type { Transcriber } from './stt.ts';

export interface App {
  config: RelayConfig;
  store: Store;
  adapter: DiscordAdapter;
  service: RelayService;
  auth: Authenticator;
  server: Server;
  logger: Logger;
  listen(): Promise<number>;
  close(): Promise<void>;
}

export interface AppOverrides extends Partial<Pick<ServiceDeps, 'now' | 'sleep' | 'newId' | 'sweepIntervalMs'>> {
  adapter?: DiscordAdapter;
  logger?: Logger;
  /** Extra principals (tests: multi-principal isolation). */
  extraPrincipals?: { principalId: string; token: string; scopes?: ('template' | 'free_text')[] }[];
  transcriber?: Transcriber;
}

export function createApp(config: RelayConfig, o: AppOverrides = {}): App {
  const logger = o.logger ?? createLogger(secretsOf(config));
  const store = new Store(config.dbPath);
  const adapter =
    o.adapter ??
    (config.mode === 'live'
      ? new RealDiscord({ token: config.discordBotToken, guildId: config.guildId, channelId: config.channelId, relayBotId: config.relayBotId, chrisBotId: config.chrisBotId, logger })
      : new FakeDiscord({ guildId: config.guildId, channelId: config.channelId, relayBotId: config.relayBotId, chrisBotId: config.chrisBotId, chris: { mode: config.mockChrisMode, delayMs: 1500 } }));
  const service = new RelayService({ config, store, adapter, logger, now: o.now, sleep: o.sleep, newId: o.newId, sweepIntervalMs: o.sweepIntervalMs });
  const principals: ConstructorParameters<typeof Authenticator>[0] = [{ principalId: config.principalId, token: config.clientToken, disabled: config.principalDisabled, scopes: ['template'] }];
  if (config.voiceToken) principals.push({ principalId: config.voicePrincipalId, token: config.voiceToken, disabled: config.voiceDisabled, scopes: ['free_text'] });
  const pairing = new Pairing({ store, basePrincipal: config.principalId, now: o.now });
  const auth = new Authenticator([...principals, ...(o.extraPrincipals ?? [])], pairing.lookup);
  const limiter = new RateLimiter(config.rateLimitPerMinute);
  const transcriber = o.transcriber ?? new WhisperCli({ bin: config.whisperBin, modelPath: config.whisperModel });
  const server = createApiServer({
    service,
    auth,
    limiter,
    logger,
    targetAlias: config.targetAlias,
    allowedOrigins: config.allowedOrigins,
    tailscaleLogins: config.tailscaleLogins,
    pairing,
    // Pairing polls (claim every ~2 s) share one bucket; no principal exists yet.
    pairingLimiter: new RateLimiter(60),
    transcriber,
    store,
    sttMinRms: config.sttMinRms,
    now: o.now,
  });

  return {
    config,
    store,
    adapter,
    service,
    auth,
    server,
    logger,
    async listen() {
      await service.start();
      await new Promise<void>((resolve) => server.listen(config.port, config.bindHost, resolve));
      const addr = server.address();
      return typeof addr === 'object' && addr ? addr.port : config.port;
    },
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      service.abortWaits(); // release long-poll /v1/ask responses so close() does not hang
      // Connections that finish a long-poll after close() began stay keep-alive; drop them as they go idle.
      const reaper = setInterval(() => server.closeIdleConnections(), 50);
      await closed;
      clearInterval(reaper);
      server.closeAllConnections();
      await service.stop();
      store.close();
    },
  };
}
