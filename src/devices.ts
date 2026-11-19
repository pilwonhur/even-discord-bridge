// P1-02 device pairing (docs/p1/P1-design.md §4.1). No secret is ever bundled into the Even app:
//   1. app  POST /v1/pairing/start            → {pairing_id, code, claim_secret}; the code is shown on the glasses
//   2. owner on this Mac: npm run admin -- pair <code>   (5 minutes, single use)
//   3. app  POST /v1/pairing/claim {pairing_id, claim_secret} → device token, once; app keeps it in bridge storage
// The server stores only SHA-256 hashes (claim secret, device token). `admin revoke-device <id>` cuts a device
// off immediately without touching the P0 CLI token or the Siri voice token.
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { sha } from './api/auth.ts';
import type { Store } from './store/store.ts';

export const PAIRING_TTL_MS = 5 * 60_000;
export const MAX_ACTIVE_PAIRINGS = 3;

const hex = (s: string) => sha(s).toString('hex');

export type StartResult = { ok: true; pairingId: string; code: string; claimSecret: string; expiresAt: number } | { ok: false; code: 'too_many_pairings' };
export type ClaimResult =
  | { ok: true; status: 'pending'; expiresAt: number }
  | { ok: true; status: 'approved'; deviceId: string; deviceToken: string }
  | { ok: false; code: 'not_found' | 'pairing_expired' | 'already_claimed' };

export class Pairing {
  private readonly store: Store;
  private readonly basePrincipal: string;
  private readonly now: () => number;

  constructor(o: { store: Store; basePrincipal: string; now?: () => number }) {
    this.store = o.store;
    this.basePrincipal = o.basePrincipal;
    this.now = o.now ?? Date.now;
  }

  start(): StartResult {
    const now = this.now();
    if (this.store.countActivePairings(now) >= MAX_ACTIVE_PAIRINGS) return { ok: false, code: 'too_many_pairings' };
    const claimSecret = randomBytes(32).toString('base64url');
    const p = this.store.createPairing({
      id: randomBytes(16).toString('hex'),
      claimSha256: hex(claimSecret),
      now,
      ttlMs: PAIRING_TTL_MS,
      code: () => String(randomInt(0, 1_000_000)).padStart(6, '0'),
    });
    return { ok: true, pairingId: p.id, code: p.code, claimSecret, expiresAt: p.expires_at };
  }

  claim(pairingId: unknown, claimSecret: unknown): ClaimResult {
    if (typeof pairingId !== 'string' || typeof claimSecret !== 'string' || !/^[0-9a-f]{32}$/.test(pairingId) || claimSecret.length > 128) return { ok: false, code: 'not_found' };
    const p = this.store.pairing(pairingId);
    // A wrong secret looks exactly like an unknown pairing.
    if (!p || !timingSafeEqual(Buffer.from(p.claim_sha256, 'hex'), sha(claimSecret))) return { ok: false, code: 'not_found' };
    const now = this.now();
    if (p.status === 'claimed') return { ok: false, code: 'already_claimed' };
    if (p.expires_at <= now) return { ok: false, code: 'pairing_expired' };
    if (p.status === 'pending') return { ok: true, status: 'pending', expiresAt: p.expires_at };
    const deviceId = randomBytes(4).toString('hex');
    const deviceToken = `g2d_${randomBytes(32).toString('base64url')}`;
    const ok = this.store.claimPairing(p.id, { id: deviceId, principalId: `${this.basePrincipal}.g2.${deviceId}`, tokenSha256: hex(deviceToken) }, now);
    if (!ok) return { ok: false, code: 'already_claimed' };
    return { ok: true, status: 'approved', deviceId, deviceToken };
  }

  /** Authenticator hook. */
  lookup = (tokenSha256Hex: string) => {
    const d = this.store.deviceByTokenHash(tokenSha256Hex);
    if (!d) return undefined;
    if (!d.revoked_at) this.store.touchDevice(d.id, this.now());
    return { deviceId: d.id, principalId: d.principal_id, revoked: d.revoked_at !== null };
  };
}
