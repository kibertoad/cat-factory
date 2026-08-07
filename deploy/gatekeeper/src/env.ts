// The deployment's configuration, and the one rule about reading it: a missing value is a
// REFUSAL that names the binding, never a default.
//
// Every field below is either a credential or the identity of the thing it talks to, and there is
// no safe stand-in for either. A Gatekeeper that booted with an empty webhook secret would accept
// unsigned deliveries; one that booted with an empty shared token would serve capabilities to
// anybody who found the route. So configuration is validated at the edge of each request and
// answered as a 503 naming the binding an operator has to set, which is the same shape the
// platform's own unwired-capability refusals take.

import type { GatekeeperState } from './state'

export interface GatekeeperEnv {
  /** The cat-factory deployment's origin, e.g. `https://cat-factory.example.com`. */
  CAT_FACTORY_BASE_URL: string
  /**
   * The webhook id this Gatekeeper enrols under. Caller-chosen and idempotent by design, so a
   * cold-booting Worker writes its own well-known id with no create-or-discover round trip.
   */
  WEBHOOK_ID: string
  /** This Worker's own public origin, the URL the platform delivers to. */
  PUBLIC_URL: string
  /** An `admin` cat-factory key. Mints per-actor keys and nothing else; never leaves the Worker. */
  PROVISIONING_KEY: string
  /** The signing secret this Gatekeeper registers, and verifies every delivery against. */
  WEBHOOK_SECRET: string
  /** The bearer token the paired Cloudflare OS deployment presents on every RPC call. */
  OS_SHARED_TOKEN: string
  STATE: DurableObjectNamespace<GatekeeperState>
}

/** A configuration binding this deployment has not set. */
export class ConfigError extends Error {
  readonly binding: string

  constructor(binding: string) {
    super(
      `${binding} is not configured on this Gatekeeper. Set it in wrangler.toml (a var) or with ` +
        '`wrangler secret put` (a credential) before serving traffic.',
    )
    this.name = 'ConfigError'
    this.binding = binding
  }
}

type StringBinding = Exclude<keyof GatekeeperEnv, 'STATE'>

/** Read a required string binding, or refuse naming it. */
export function requireVar(env: GatekeeperEnv, binding: StringBinding): string {
  const value = env[binding]
  if (typeof value !== 'string' || value.length === 0) throw new ConfigError(binding)
  return value
}
