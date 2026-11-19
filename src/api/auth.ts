// Server-side authentication (FR-01). A bearer credential maps to a principal on the
// server. Anything the client claims in the body (user_id, "owner approved") is ignored.
import { createHash, timingSafeEqual } from 'node:crypto';

/** template: P0 fixed templates (POST /v1/requests). free_text: P1 voice text (POST /v1/ask).
 *  device: paired G2 app (P1-02) — transcriptions, and /v1/ask with a server transcript only. */
export type Scope = 'template' | 'free_text' | 'device';

/** Paired-device lookup by token hash (hex). Re-read on every call so revocation is immediate. */
export type DeviceLookup = (tokenSha256Hex: string) => { deviceId: string; principalId: string; revoked: boolean } | undefined;

export interface PrincipalEntry {
  principalId: string;
  tokenSha256: Buffer;
  disabled: boolean;
  scopes: Scope[];
}

export type AuthResult = { ok: true; principalId: string; scopes: Scope[]; deviceId?: string } | { ok: false; status: 401 | 403; code: string };

export const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export class Authenticator {
  private entries: PrincipalEntry[];
  private readonly devices: DeviceLookup | undefined;

  constructor(entries: { principalId: string; token: string; disabled?: boolean; scopes?: Scope[] }[], devices?: DeviceLookup) {
    this.entries = entries.map((e) => ({ principalId: e.principalId, tokenSha256: sha(e.token), disabled: !!e.disabled, scopes: e.scopes ?? ['template'] }));
    this.devices = devices;
  }

  authenticate(authorization: string | undefined): AuthResult {
    const m = /^Bearer ([\x21-\x7e]{1,512})$/.exec(authorization ?? '');
    if (!m) return { ok: false, status: 401, code: 'unauthenticated' };
    const presented = sha(m[1]!);
    let found: PrincipalEntry | undefined;
    for (const e of this.entries) if (timingSafeEqual(presented, e.tokenSha256)) found = e;
    if (!found) {
      // Device tokens: looked up by hash (an index lookup on a 256-bit random secret's hash).
      const dev = this.devices?.(presented.toString('hex'));
      if (!dev) return { ok: false, status: 401, code: 'unauthenticated' };
      if (dev.revoked) return { ok: false, status: 403, code: 'device_revoked' };
      return { ok: true, principalId: dev.principalId, scopes: ['device'], deviceId: dev.deviceId };
    }
    // Re-checked on every call, including GET: revocation takes effect immediately (AT-14).
    if (found.disabled) return { ok: false, status: 403, code: 'principal_disabled' };
    return { ok: true, principalId: found.principalId, scopes: [...found.scopes] };
  }

  setDisabled(principalId: string, disabled: boolean): void {
    for (const e of this.entries) if (e.principalId === principalId) e.disabled = disabled;
  }
}

/** Per-principal sliding window limit (429). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs = 60_000, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  allow(key: string): boolean {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(t);
    this.hits.set(key, list);
    return true;
  }
}
