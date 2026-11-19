// Configuration loading with fail-fast validation (02_TECHNICAL_DESIGN §6).
// Secrets are only read from the environment; they are never logged.

export type RelayMode = 'mock' | 'live';

export interface RelayConfig {
  mode: RelayMode;
  bindHost: string;
  port: number;
  dbPath: string;
  discordBotToken: string; // empty in mock mode
  clientToken: string;
  principalId: string;
  principalDisabled: boolean;
  guildId: string;
  channelId: string;
  relayBotId: string;
  chrisBotId: string;
  targetAlias: string;
  /** How relayed posts refer to the owner, e.g. "Discord에서 <title> 확인" (RELAY_OWNER_TITLE, default 사용자). */
  ownerTitle: string;
  replyTimeoutMs: number;
  /** CORS origins for browser clients (Even Hub WebView). Comma-separated RELAY_ALLOWED_ORIGIN. */
  allowedOrigins: string[];
  textRetentionDays: number;
  metadataRetentionDays: number;
  rateLimitPerMinute: number;
  mockChrisMode: 'request_id' | 'reference' | 'none' | 'silent';
  /** If non-empty, /v1 requests must carry a Tailscale-User-Login (set by Tailscale Serve) in this list. */
  tailscaleLogins: string[];
  /** P1 voice client (Siri Shortcut / Even AI). Separate credential, free-text scope only. Empty = disabled. */
  voiceToken: string;
  voicePrincipalId: string;
  voiceDisabled: boolean;
  /** P1-03 whisper.cpp. Missing binary/model → /v1/transcriptions answers 503 stt_unavailable. */
  whisperBin: string;
  whisperModel: string;
  /** Loudest-50ms-frame RMS below this is treated as no speech (whisper invents text on silence). */
  sttMinRms: number;
}

export class ConfigError extends Error {}

const SNOWFLAKE = /^\d{17,20}$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

// Fixed, obviously-fake IDs for mock mode only. Never used in live mode.
const MOCK_IDS = {
  guildId: '900000000000000001',
  channelId: '900000000000000002',
  relayBotId: '900000000000000003',
  chrisBotId: '900000000000000004',
};

function int(env: NodeJS.ProcessEnv, key: string, def: number, problems: string[]): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    problems.push(`${key} must be a positive integer`);
    return def;
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const problems: string[] = [];
  const mode = (env.RELAY_MODE || 'mock') as RelayMode;
  if (mode !== 'mock' && mode !== 'live') problems.push('RELAY_MODE must be "mock" or "live"');

  const bindHost = env.RELAY_BIND_HOST || '127.0.0.1';
  // P0: HTTPS termination is not implemented here. Refuse non-loopback binds so the
  // bearer token is never sent over plain HTTP on a network.
  if (!LOOPBACK.has(bindHost)) problems.push('RELAY_BIND_HOST must be loopback in P0 (put an HTTPS proxy in front for device access)');

  const clientToken = env.RELAY_CLIENT_TOKEN || '';
  if (clientToken.length < 32) problems.push('RELAY_CLIENT_TOKEN is required (>= 32 chars, from secret storage)');
  const principalId = env.RELAY_PRINCIPAL_ID || '';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(principalId)) problems.push('RELAY_PRINCIPAL_ID is required ([A-Za-z0-9._-], <= 64 chars)');

  const voiceToken = env.RELAY_VOICE_TOKEN || '';
  if (voiceToken && voiceToken.length < 32) problems.push('RELAY_VOICE_TOKEN must be >= 32 chars');
  if (voiceToken && voiceToken === clientToken) problems.push('RELAY_VOICE_TOKEN must differ from RELAY_CLIENT_TOKEN');
  const voicePrincipalId = env.RELAY_VOICE_PRINCIPAL_ID || `${principalId}.voice`;
  if (voiceToken && !/^[A-Za-z0-9._-]{1,64}$/.test(voicePrincipalId)) problems.push('RELAY_VOICE_PRINCIPAL_ID invalid ([A-Za-z0-9._-], <= 64 chars)');
  if (voiceToken && voicePrincipalId === principalId) problems.push('RELAY_VOICE_PRINCIPAL_ID must differ from RELAY_PRINCIPAL_ID');

  const ids = {
    guildId: env.DISCORD_GUILD_ID || '',
    channelId: env.DISCORD_CHANNEL_ID || '',
    relayBotId: env.DISCORD_RELAY_BOT_ID || '',
    chrisBotId: env.DISCORD_CHRIS_BOT_ID || '',
  };
  const discordBotToken = env.DISCORD_BOT_TOKEN || '';
  if (mode === 'live') {
    if (!discordBotToken) problems.push('DISCORD_BOT_TOKEN is required in live mode');
    for (const [k, v] of Object.entries(ids)) {
      if (!SNOWFLAKE.test(v)) problems.push(`${envName(k)} must be a Discord snowflake in live mode`);
    }
    if (ids.relayBotId && ids.relayBotId === ids.chrisBotId) problems.push('relay bot and Chris bot must differ');
  } else {
    for (const k of Object.keys(ids) as (keyof typeof ids)[]) {
      if (!ids[k]) ids[k] = MOCK_IDS[k];
    }
  }

  const mockChrisMode = (env.RELAY_MOCK_CHRIS || 'request_id') as RelayConfig['mockChrisMode'];
  if (!['request_id', 'reference', 'none', 'silent'].includes(mockChrisMode)) problems.push('RELAY_MOCK_CHRIS invalid');

  const cfg: RelayConfig = {
    mode,
    bindHost,
    port: int(env, 'RELAY_PORT', 8787, problems),
    dbPath: env.RELAY_DB_PATH || './data/relay.sqlite',
    discordBotToken,
    clientToken,
    principalId,
    principalDisabled: env.RELAY_PRINCIPAL_DISABLED === '1',
    ...ids,
    targetAlias: env.RELAY_TARGET_ALIAS || 'chris-primary',
    ownerTitle: env.RELAY_OWNER_TITLE || '사용자',
    replyTimeoutMs: int(env, 'RELAY_REPLY_TIMEOUT_SECONDS', 120, problems) * 1000,
    allowedOrigins: (env.RELAY_ALLOWED_ORIGIN || '').split(',').map((x) => x.trim()).filter(Boolean),
    textRetentionDays: int(env, 'RELAY_TEXT_RETENTION_DAYS', 7, problems),
    metadataRetentionDays: int(env, 'RELAY_METADATA_RETENTION_DAYS', 30, problems),
    rateLimitPerMinute: int(env, 'RELAY_RATE_LIMIT_PER_MINUTE', 10, problems),
    mockChrisMode,
    tailscaleLogins: (env.RELAY_TAILSCALE_LOGINS || '').split(',').map((x) => x.trim()).filter(Boolean),
    voiceToken,
    voicePrincipalId,
    voiceDisabled: env.RELAY_VOICE_DISABLED === '1',
    whisperBin: env.RELAY_WHISPER_BIN || '/opt/homebrew/bin/whisper-cli',
    whisperModel: env.RELAY_WHISPER_MODEL || `${env.HOME ?? ''}/.cache/whisper/ggml-small.bin`,
    sttMinRms: int(env, 'RELAY_STT_MIN_RMS', 500, problems),
  };
  // Only wildcard: 'http://127.0.0.1:*' (installed Even app, port changes per launch).
  if (!/^[^\n<>@`*_~|]{1,20}$/.test(cfg.ownerTitle)) problems.push('RELAY_OWNER_TITLE must be 1..20 characters without newlines or Discord markup');
  for (const o of cfg.allowedOrigins) if (o !== 'http://127.0.0.1:*' && (o.includes('*') || !/^https?:\/\/[^/\s]+$/.test(o))) problems.push(`RELAY_ALLOWED_ORIGIN entry invalid: ${o}`);
  if (problems.length) throw new ConfigError('Invalid configuration:\n - ' + problems.join('\n - '));
  return cfg;
}

function envName(k: string): string {
  return { guildId: 'DISCORD_GUILD_ID', channelId: 'DISCORD_CHANNEL_ID', relayBotId: 'DISCORD_RELAY_BOT_ID', chrisBotId: 'DISCORD_CHRIS_BOT_ID' }[k] ?? k;
}

/** Values that must never appear in logs. */
export function secretsOf(cfg: RelayConfig): string[] {
  return [cfg.discordBotToken, cfg.clientToken, cfg.voiceToken].filter((s) => s.length > 0);
}
