import type { PublicApiKeyAuth } from '@cat-factory/integrations'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import {
  readPersonalPassword,
  type PersonalCredentialOwner,
} from '../providers/personalCredentialGate.js'

// How a KEY-authenticated call reaches an individual-usage (personal) subscription.
//
// The rule the whole surface used to state was "a key is not a person", and the consequence was
// that a task pinned to Claude / Codex could not be started over `/api/v1` at all. That is right
// for an ORDINARY key and wrong for the one case an operator actually has: their own key, minted
// by them in the app with the binding opt-in, driving a run they are present for. The binding
// (`PublicApiKeyRecord.actsAsUserId`) says whose credential may be unlocked; the personal password
// on this request proves the holder consents to unlocking it now. Neither half is sufficient
// alone, and the platform stores only the first.

/** The two inputs the personal-credential gate takes, resolved from a key-authenticated call. */
export interface PublicPersonalUnlock {
  /**
   * The user this key was bound to, or `undefined` for an unbound key (the default). Also the
   * run's INITIATOR: a bound key's runs are that person's runs, whatever model they resolve to.
   *
   * Attributing every run rather than only the ones that need an unlock is deliberate. The
   * alternative makes a key's own runs attributed or unattributed depending on which model a task
   * happened to pin, so the same key would produce runs under two different identities, with two
   * different credential scopes and two different merge-policy roles, and nothing in the request
   * would say which. One binding, one answer.
   */
  user: PersonalCredentialOwner | undefined
  /** The `X-Personal-Password` this call carried, if any. Never stored, never logged. */
  password: string | undefined
}

/**
 * Resolve what this call may unlock. Both halves are absent for an ordinary key, which is exactly
 * the pre-binding behaviour: the gate then refuses an individual-usage run as it always did.
 */
export function personalUnlockFor<E extends AppEnv>(
  c: Context<E>,
  auth: PublicApiKeyAuth,
): PublicPersonalUnlock {
  return {
    user: auth.actsAsUserId ? { id: auth.actsAsUserId } : undefined,
    password: readPersonalPassword(c),
  }
}

/**
 * Whether a `CredentialRequiredError` from the gate should be flattened into the surface's
 * `409 individual_model_unsupported`, or left to propagate as its own `428 credential_required`.
 *
 * The distinction is whether the caller can DO anything about it. An unbound key cannot: no
 * password would help, so a 428 inviting one is a prompt to nowhere and the flat 409 naming the
 * unsupported case is the honest answer. A bound key can, and the 428 carries the two things it
 * needs — which vendor, and whether the password was missing or wrong — so flattening it there
 * would throw away the only actionable part of the refusal.
 */
export function unlockIsUnavailable(unlock: PublicPersonalUnlock): boolean {
  return unlock.user === undefined
}

/**
 * The `409` body every public start/retry surface answers when {@link unlockIsUnavailable} holds.
 *
 * One factory rather than a literal per route, because a caller that hits this on `POST /jobs`,
 * again on `POST /tasks/:id/start` and again on `retry` must not be told three different stories
 * about the same key. The `code` is the machine-readable half and is identical everywhere; only the
 * remedy tail differs, and it differs because it has to be TRUE: a board task can also be started
 * by its owner in the app, while a headless job has no board affordance to fall back on, so
 * offering one there would send an operator looking for a button that does not exist.
 */
export function individualModelUnsupported(subject: 'task' | 'job'): {
  code: string
  message: string
} {
  const remedy =
    subject === 'task'
      ? 'start or retry it from the app, or use a key bound to the subscription owner and send the'
      : 'use a key bound to the subscription owner and send the'
  return {
    code: 'individual_model_unsupported',
    message:
      `This ${subject} runs on an individual-usage model that needs a personal-credential ` +
      `unlock; ${remedy} X-Personal-Password header`,
  }
}
