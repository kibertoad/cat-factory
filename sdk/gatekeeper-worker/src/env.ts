// The deployment's configuration, and the one rule about reading it: a missing value is a
// REFUSAL that names the binding, never a default.
//
// Every field below is either a credential or the identity of the thing it talks to, and there is
// no safe stand-in for either. A Gatekeeper that booted with an empty webhook secret would accept
// unsigned deliveries; one that booted with an empty shared token would serve capabilities to
// anybody who found the route. So configuration is validated at the edge of each request and
// answered as a 503 naming the binding an operator has to set, which is the same shape the
// platform's own unwired-capability refusals take.
//
// A request reads the bindings its own path needs, so it can only name the first one it trips on.
// `/health` is the other question ("could this deployment serve at all"), and it takes the other
// route through this file: `missingBindings` over the whole table in one pass.

import type { GatekeeperState } from './state.js'

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

/** How an operator supplies one binding. */
export type BindingKind = 'var' | 'secret' | 'durable-object'

/**
 * Which mechanism each binding arrives through, and the one place that fact is stated.
 *
 * A var and a Durable Object namespace are written in `wrangler.toml`; a secret is put with
 * `wrangler secret put` and belongs in no file the repository carries. That distinction is the one
 * an operator gets wrong, and "set it in wrangler.toml OR with `wrangler secret put`" invites the
 * wrong half, so every refusal names the mechanism that binding actually takes. It is a
 * `Record` over `GatekeeperEnv`'s own keys, so a binding added above fails to compile until it
 * says how it is supplied.
 */
const BINDING_KINDS = {
  CAT_FACTORY_BASE_URL: 'var',
  WEBHOOK_ID: 'var',
  PUBLIC_URL: 'var',
  PROVISIONING_KEY: 'secret',
  WEBHOOK_SECRET: 'secret',
  OS_SHARED_TOKEN: 'secret',
  STATE: 'durable-object',
} as const satisfies Record<keyof GatekeeperEnv, BindingKind>

type Binding = keyof GatekeeperEnv

/** Where an operator sets one binding, phrased as the remedy a refusal ends on. */
function howToSet(binding: Binding): string {
  // The declared return type is the exhaustiveness guard: a `BindingKind` added with no case here
  // widens this to `string | undefined` and fails the build.
  switch (BINDING_KINDS[binding]) {
    case 'var':
      return 'set it as a var in wrangler.toml'
    case 'secret':
      return `put it with \`wrangler secret put ${binding}\`, never in wrangler.toml`
    case 'durable-object':
      return 'bind it in wrangler.toml as a durable_objects binding to the GatekeeperState class'
  }
}

/** A configuration binding this deployment has not set. */
export class ConfigError extends Error {
  readonly binding: Binding

  constructor(binding: Binding) {
    super(`${binding} is not configured on this Gatekeeper: ${howToSet(binding)}.`)
    this.name = 'ConfigError'
    this.binding = binding
  }
}

type StringBinding = Exclude<Binding, 'STATE'>

/** Read a required string binding, or refuse naming it. */
export function requireVar(env: GatekeeperEnv, binding: StringBinding): string {
  const value = env[binding]
  if (typeof value !== 'string' || value.length === 0) throw new ConfigError(binding)
  return value
}

/**
 * Every binding this deployment has not set, in ONE pass.
 *
 * `requireVar` answers the first binding the path a request happened to take reads, which is the
 * right answer for that request and the wrong one for a health check: an operator wiring a
 * deployment learns the next unset name only after fixing this one and redeploying. So the health
 * check asks the whole table at once, and derives it from `GatekeeperEnv` rather than a
 * transcribed list, because a binding this check silently passed over is a binding whose absence
 * reads as a healthy Gatekeeper.
 */
export function missingBindings(env: GatekeeperEnv): Binding[] {
  const bindings = Object.keys(BINDING_KINDS) as Binding[]
  return bindings.filter((binding) => !isSet(env, binding))
}

function isSet(env: GatekeeperEnv, binding: Binding): boolean {
  if (BINDING_KINDS[binding] === 'durable-object') {
    // A namespace this Worker can reach, rather than merely a truthy property: an unbound
    // `durable_objects` entry is a plain `undefined`, and a bound one always answers `idFromName`.
    return typeof env.STATE?.idFromName === 'function'
  }
  const value = env[binding]
  return typeof value === 'string' && value.length > 0
}

/**
 * The durable object holding everything this pairing knows, addressed the ONE way.
 *
 * Named for the deployment it is paired with, so pointing this Worker at a different cat-factory
 * gets a different object rather than inheriting the previous one's cards, hooks and minted keys.
 * It is a function rather than a line inside `Gatekeeper` because the hook controller reaches the
 * same object without assembling a Gatekeeper at all, and a second spelling of the name would be
 * a second object holding half the state.
 */
export function stateFor(env: GatekeeperEnv): DurableObjectStub<GatekeeperState> {
  return env.STATE.get(env.STATE.idFromName(requireVar(env, 'CAT_FACTORY_BASE_URL')))
}

/** The refusal an operator can act on: every unset binding, each with how to set it. */
export function describeMissingBindings(missing: readonly Binding[]): string {
  const remedies = missing.map((binding) => `${binding} (${howToSet(binding)})`).join('; ')
  return `This Gatekeeper is not fully configured, so it can accept no traffic. Unset: ${remedies}.`
}
