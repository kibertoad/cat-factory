import { RateLimitedError, describeError } from '@cat-factory/kernel'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { logger } from '../../observability/logger.js'

// The password-endpoint throttle (signup / login / forgot / reset), SEC-4. Two layers:
//
//  - The DURABLE ledger (`container.authAttemptRepository`, D1/Postgres) is the
//    authoritative window: cross-replica, deploy-surviving, and carrying the per-IP
//    aggregate that stops one-password-many-emails credential stuffing (each email gets
//    a fresh per-key bucket, so only an aggregate can see the pattern).
//  - The in-process Map is the BACKSTOP: per isolate and reset by a deploy, but always
//    ticked, so a facade with no store wired — or a store outage mid-attack — degrades
//    to the old speed bump instead of failing open.
//
// The client IP is the socket peer unless `auth.trustProxyHeaders` says a trusted proxy
// overwrites the forwarded headers: `x-forwarded-for` (and, off Cloudflare,
// `cf-connecting-ip`) is attacker-supplied on a bare deployment, and a spoofable IP is
// unlimited fresh buckets. PBKDF2's per-attempt cost remains the base defence.

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000
/** Attempts per `<ip>:<email>` bucket per window (the 11th in a window trips). */
const MAX_ATTEMPTS = 10
/**
 * Attempts per client IP per window across EVERY bucket. Sized well above the per-key
 * cap times a plausible number of legitimate users behind one NAT/proxy egress, so a
 * shared-office IP does not trip it in normal use, while a one-password-sweep across
 * hundreds of emails does.
 */
const MAX_ATTEMPTS_PER_IP = 50

/** Resolve the throttle's client IP under the deployment's proxy-trust policy. */
function clientIp<E extends AppEnv>(c: Context<E>): string {
  const container = c.get('container')
  if (container.config.auth.trustProxyHeaders) {
    const forwarded =
      c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    if (forwarded) return forwarded
  }
  return container.resolveClientAddress?.(c as unknown as Context<AppEnv>) ?? 'unknown'
}

/** The per-isolate backstop window: bucket key → recent attempt timestamps. */
const attempts = new Map<string, number[]>()

/** Tick one in-memory bucket and report whether it is over `max`. */
function memoryBucketLimited(key: string, now: number, max: number): boolean {
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < ATTEMPT_WINDOW_MS)
  recent.push(now)
  attempts.set(key, recent)
  // Opportunistically evict fully-stale keys so the map can't grow unbounded.
  if (attempts.size > 10_000) {
    for (const [k, ts] of attempts) {
      if (ts.every((t) => now - t >= ATTEMPT_WINDOW_MS)) attempts.delete(k)
    }
  }
  return recent.length > max
}

/**
 * Record a password attempt for `c`+`bucket` and report whether it is over a limit —
 * the per-key burst cap or the per-IP aggregate. Counted BEFORE any credential work, and
 * never refunded on success (the window is short; a refund is a write for no security
 * value). `bucket` is the email for the email-addressed endpoints and a fixed literal
 * for token redeem: keying redeem by token value would hand every guess its own bucket.
 */
export async function passwordAttemptLimited<E extends AppEnv>(
  c: Context<E>,
  bucket: string,
): Promise<boolean> {
  const now = Date.now()
  const ip = clientIp(c)
  const key = `${ip}:${bucket.toLowerCase().trim()}`
  // Always tick the backstop, even with a healthy store: it costs a Map touch and is
  // what still binds while the store is erroring below.
  const memoryLimited =
    memoryBucketLimited(key, now, MAX_ATTEMPTS) ||
    memoryBucketLimited(`ip:${ip}`, now, MAX_ATTEMPTS_PER_IP)
  const store = c.get('container').authAttemptRepository
  if (!store) return memoryLimited
  try {
    // Record first, then count (the recorded attempt counts itself): an attempt that
    // fails the password check later must still have been counted.
    await store.record({ key, ip, at: now })
    const since = now - ATTEMPT_WINDOW_MS
    const [byKey, byIp] = await Promise.all([
      store.countByKeySince(key, since),
      store.countByIpSince(ip, since),
    ])
    return byKey > MAX_ATTEMPTS || byIp > MAX_ATTEMPTS_PER_IP || memoryLimited
  } catch (error) {
    // A store outage must not fail OPEN (unlimited guessing) — the in-process window
    // still binds — and must not fail the login path outright either: the throttle is a
    // guard, not the feature.
    logger.warn('auth throttle: durable attempt store unavailable; in-process backstop only', {
      err: describeError(error),
    })
    return memoryLimited
  }
}

/**
 * The one refusal for every limited attempt, identical across endpoints and causes so
 * the response never becomes an oracle for WHICH arm limited (or which email is under
 * attack). `retryAfterSeconds` is the full window: an upper bound, honest enough for a
 * client backoff without leaking the bucket's exact state.
 */
export const tooManyAttempts = (): never => {
  throw new RateLimitedError(
    'Too many attempts. Please try again later.',
    'auth_attempts',
    Math.ceil(ATTEMPT_WINDOW_MS / 1000),
  )
}
