// Structured JSON-lines logger with secret redaction (FR-12, AT-14).
// Message bodies are never logged; callers pass IDs and states only.

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const DISCORD_TOKEN = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g;
const BEARER = /(Bearer\s+)\S+/gi;

export function createRedactor(secrets: string[]): (s: string) => string {
  const list = secrets.filter((s) => s.length >= 8);
  return (s: string) => {
    let out = s;
    for (const secret of list) out = out.split(secret).join('[REDACTED]');
    return out.replace(BEARER, '$1[REDACTED]').replace(DISCORD_TOKEN, '[REDACTED]');
  };
}

export function createLogger(secrets: string[], sink: (line: string) => void = (l) => process.stderr.write(l + '\n')): Logger {
  const redact = createRedactor(secrets);
  const emit = (level: string, event: string, fields?: Record<string, unknown>) => {
    let body: string;
    try {
      body = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
    } catch {
      body = JSON.stringify({ ts: new Date().toISOString(), level, event, note: 'unserializable fields' });
    }
    sink(redact(body));
  };
  return {
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
