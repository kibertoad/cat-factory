import type {
  ConnectionTestResult,
  EnvironmentAccessHandle,
  EnvironmentHandle,
  EnvironmentManifest,
  EnvironmentStatus,
  ProviderConfigField,
  TeardownConfirmation,
  TeardownProbe,
} from '@cat-factory/kernel'
import type { EnvironmentRecord, UrlSafetyPolicy } from '@cat-factory/kernel'
import { connectionFailureResult, STRICT_URL_SAFETY_POLICY } from '@cat-factory/kernel'
import type { EnvironmentRouteCandidate, EnvironmentReachability } from '@cat-factory/contracts'
import { environmentReachabilitySchema } from '@cat-factory/contracts'
import * as v from 'valibot'
import { safeFetch } from '../shared/safe-fetch.js'
import { assertSafePublicUrl, publicUrlHost } from '../shared/url-guard.js'

// Pure helpers for the ephemeral-environment integration: SSRF validation of the
// URLs we fetch/expose, `{{var}}` interpolation over a bounded scope, dot-path
// extraction from an arbitrary self-rolled response, status mapping and expiry
// coercion. Keeping these pure makes the generic provider deterministic and
// testable without a live management API.

/**
 * The agent kind that triggers deterministic provisioning, and its counterpart that triggers the
 * deterministic RECLAIM. Re-exported from `@cat-factory/contracts` rather than restated: the
 * pipeline builder and the save boundary both reason about the pair (a Deployer without a
 * Disposer leaves the environment to the TTL sweep), and the SPA has to name the same two kinds.
 */
export { DEPLOYER_AGENT_KIND, DISPOSER_AGENT_KIND } from '@cat-factory/contracts'
import {
  DEPLOYER_AGENT_KIND,
  describeWildcardDnsShift,
  describeWildcardDnsShiftProblem,
  DISPOSER_AGENT_KIND,
  wildcardDnsShiftRemedies,
} from '@cat-factory/contracts'
import type { WildcardDnsShift } from '@cat-factory/contracts'
/** Board category for environment blocks (a deployer pipeline typically runs here). */
export const ENVIRONMENT_BLOCK_TYPE = 'environment'

/**
 * Whether a pipeline step should provision an environment deterministically.
 * Keyed strictly on the `deployer` agent kind so that other steps in a pipeline
 * on an `environment` block (e.g. a following `tester`) still run normally.
 */
export function isDeployStep(agentKind: string): boolean {
  return agentKind === DEPLOYER_AGENT_KIND
}

/**
 * Whether a pipeline step should RECLAIM the run's environments deterministically. The mirror of
 * {@link isDeployStep}: it lets an author decide WHEN the environment goes away (after the
 * automated tester, or after a human has finished poking at it) instead of leaving that to the
 * TTL sweep, which fires long after the run settled and therefore cannot close the run's own
 * up → evidence → down proof.
 */
export function isDisposeStep(agentKind: string): boolean {
  return agentKind === DISPOSER_AGENT_KIND
}

/**
 * Turn a provider's post-teardown {@link TeardownProbe} into the recorded verdict, plus the
 * verbatim reason a human needs when it is anything but `confirmed`.
 *
 * The mapping is the whole point of the split: `gone` is the only probe that proves a reclaim,
 * and each of the other answers becomes a DIFFERENT verdict rather than being flattened into one
 * "not confirmed" bucket, because each is a different person's next action (see
 * {@link TeardownConfirmation}). A `present` probe is split by `terminating` for the same
 * reason — a namespace draining its finalizers is on its way out and will confirm on a later
 * pass, where an `Active` one means the teardown did nothing and will never confirm on its own.
 */
export function classifyTeardownProbe(probe: TeardownProbe): {
  confirmation: TeardownConfirmation
  reason: string | null
} {
  switch (probe.state) {
    case 'gone':
      return { confirmation: 'confirmed', reason: null }
    case 'present':
      return probe.terminating
        ? {
            confirmation: 'unconfirmed',
            reason:
              probe.detail ??
              'The environment is still shutting down; it was not gone when checked.',
          }
        : {
            confirmation: 'still_standing',
            reason:
              probe.detail ??
              'The environment was still running after the teardown, so nothing was reclaimed.',
          }
    case 'unknown':
      // A permanent inability to verify is a CONFIGURATION fact and a transient one is an
      // outage; only the second is worth waiting on, so they must not share a verdict.
      return {
        confirmation: probe.retryable ? 'unconfirmed' : 'unverifiable',
        reason: probe.reason,
      }
    default:
      return describeUnrecognisedProbe(probe)
  }
}

/**
 * A probe state this build does not define, reported as the unusable answer it is.
 *
 * {@link TeardownProbe} crosses a PUBLIC port, so the value is not the platform's to trust: a
 * deployment's own provider can return anything, and adding a state to the union without a case
 * here must fail the build (the argument stops being `never`). What it must NOT do is fall off
 * the end of the switch — that returns `undefined`, which then rides into the confirmation row as
 * a missing verdict and, being neither `confirmed` nor anything else a reader recognises, is the
 * one outcome worse than an honest refusal to say.
 *
 * Never guessed onto `gone`: an answer nobody can interpret is the opposite of proof.
 */
function describeUnrecognisedProbe(probe: never): {
  confirmation: TeardownConfirmation
  reason: string
} {
  return {
    confirmation: 'unconfirmed',
    reason: `The provider reported a teardown probe state this deployment does not recognise (${JSON.stringify(probe)}), so the teardown could not be verified.`,
  }
}

/** The provider-identity fields that decide whether a superseded env's real infra is reclaimed. */
export interface EnvironmentIdentity {
  provisionType: string | null
  engine: string | null
  /** The provider's external resource id (a k8s namespace, …); null when not yet known/provisioned. */
  externalId: string | null
}

/**
 * Whether a superseded environment's REAL infrastructure should be torn down when a new provision
 * takes its place. `next` is the incoming env's identity, or `null` when NOTHING replaces it (an
 * `infraless` flip / removed provisioning). Teardown fires only when the prior actually provisioned
 * real infra (`externalId` set) AND the new target is a DIFFERENT provider resource — a different
 * type/engine, or (when the new external id is known) a different external id. When the new external
 * id is not yet known (the async `provisioning` placeholder insert), a matching type/engine is
 * treated as the same deterministic resource (overwrite-in-place), so nothing is torn down and the
 * TTL reaper stays the backstop. Same identity ⇒ keep the tombstone-only supersede (tearing a
 * namespace down then re-applying it would churn/race).
 */
export function shouldTeardownSuperseded(
  prior: EnvironmentIdentity,
  next: EnvironmentIdentity | null,
): boolean {
  if (!prior.externalId) return false
  if (next === null) return true
  if (prior.provisionType !== next.provisionType) return true
  if (prior.engine !== next.engine) return true
  if (next.externalId != null && next.externalId !== prior.externalId) return true
  return false
}

/**
 * Validate a URL before it is stored, fetched, or exposed. The default policy
 * (STRICT_URL_SAFETY_POLICY) requires `https` and rejects internal/private hosts; a
 * trusted operator-installed adapter can pass a widened policy to permit specific
 * schemes/hosts (e.g. an internal env platform on a private/VPN host). Embedded
 * credentials are forbidden regardless of policy.
 *
 * The environment-labelled face of the SHARED {@link assertSafePublicUrl} guard, which the
 * runner-pool and notification-webhook integrations also front with their own wording. Only the
 * message differs — the host/scheme rules are one implementation, so an SSRF bypass is fixed once
 * rather than per integration.
 */
export function assertSafeEnvironmentUrl(
  url: string,
  label = 'URL',
  policy: UrlSafetyPolicy = STRICT_URL_SAFETY_POLICY,
): void {
  assertSafePublicUrl(url, { subject: 'Environment', label, policy })
}

/**
 * Refuse an environment URL whose wildcard-DNS host answers a DIFFERENT address than the one the
 * operator wrote into it. `null` when there is nothing wrong, which is every ordinary host and
 * every correctly-composed wildcard one.
 *
 * This is the one environment failure the platform can see coming and previously did not. An
 * environment URL is a CLAIM: it is derived from config (or read back off a rendered Ingress),
 * published as the environment's address, and nothing between here and the tester ever asks
 * whether it points at this deployment. Readiness cannot catch it either, because readiness is
 * workload readiness (the pods are fine; they are just unreachable through that name). So a run
 * rolled out, reported `ready`, and spent a tester agent for eight minutes on an address
 * belonging to someone else before failing with a connection error that named the cluster rather
 * than the config.
 *
 * **Refusing is the honest disposition rather than a warning**, and it costs nothing that was
 * working: a mis-resolving host makes the environment unreachable to every consumer, so there is
 * no deployment this turns from green to red.
 *
 * It sits BESIDE {@link assertSafeEnvironmentUrl} because it answers the same kind of question
 * about the same value, and because that pairing is what makes it provider-agnostic: the three
 * places an environment URL is published (`EnvironmentProvisioningService`'s sync
 * provision, its async finalize, and its status reconcile) all run the pair, so a URL rendered
 * inside a deploy container or read off a live Ingress is graded exactly as one derived in
 * process is. A check bolted to one provider's synchronous path would have covered a third of
 * the ways this URL reaches a user.
 */
export function describeMisresolvingEnvironmentUrl(url: string): string | null {
  const host = publicUrlHost(url)
  // Not this rule's failure to report. A URL the platform cannot parse is already refused by the
  // environment URL-safety policy, which says so far better than a DNS note would.
  if (host === null) return null
  const shift = describeWildcardDnsShift(host)
  return shift ? describeMisresolvingHostProblem(shift) : null
}

/**
 * The refusal wording, shared by this seam and by the Kubernetes provider's earlier one so the
 * two do not become two accounts of the same fault.
 *
 * It names the manifests as CORRECT on purpose: the automated instinct on an environment failure
 * is to send a fixer at the checkout, and the one thing that cannot help here is editing the
 * files. The fix is a person editing the connection.
 */
export function describeMisresolvingHostProblem(shift: WildcardDnsShift): string {
  return (
    `The environment URL cannot reach this deployment: ${describeWildcardDnsShiftProblem(shift)}. ` +
    `Fix the environment connection, not the manifests, which are correct. ` +
    wildcardDnsShiftRemedies(shift)
      .map((remedy, index) => `(${index + 1}) ${remedy}`)
      .join(' ')
  )
}

/** Validate every URL a manifest will fetch (defence against SSRF). */
export function assertManifestUrlsSafe(
  manifest: EnvironmentManifest,
  policy: UrlSafetyPolicy,
): void {
  assertSafeEnvironmentUrl(manifest.baseUrl, 'base URL', policy)
  if (manifest.auth.type === 'oauth2_client_credentials') {
    assertSafeEnvironmentUrl(manifest.auth.tokenUrl, 'OAuth token URL', policy)
  }
}

/** Collect every secret key a manifest's auth scheme references. */
export function referencedSecretKeys(manifest: EnvironmentManifest): string[] {
  const auth = manifest.auth
  switch (auth.type) {
    case 'none':
      return []
    case 'api_key':
    case 'bearer':
      return [auth.secretRef.key]
    case 'basic':
      return [auth.usernameSecretRef.key, auth.passwordSecretRef.key]
    case 'oauth2_client_credentials':
      return [auth.clientIdSecretRef.key, auth.clientSecretSecretRef.key]
    case 'custom_headers':
      return auth.headers.map((h) => h.secretRef.key)
  }
}

/**
 * Stringify a manifest's opaque `providerConfig` bag (`Record<string, unknown>`) into
 * the `Record<string, string>` a native adapter receives. The bag can carry nested
 * values (objects/arrays — see `providerDescriptorSchema.manifestTemplate`), so a plain
 * `String(v)` would mangle them into `[object Object]` / comma-joined garbage; serialize
 * non-primitive values as JSON instead so the provider sees a faithful representation.
 */
export function stringifyProviderConfig(
  config: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!config) return undefined
  return Object.fromEntries(
    Object.entries(config).map(([k, v]) => [
      k,
      v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v),
    ]),
  )
}

/**
 * Render a manifest's referenced secret keys as password config fields, so the
 * manifest editor can show which secrets a connection still needs. Shared by the
 * generic environment + runner-pool providers' `describeConfig`.
 */
export function configFieldsFromSecretKeys(keys: string[]): ProviderConfigField[] {
  return keys.map((key) => ({ key, label: key, secret: true, required: true }))
}

/**
 * The config-field keys a provider still needs the org to supply: fields that are
 * `required`, carry no `default` (so there's no fallback), and have no value stored
 * yet. `storedKeys` is every key already persisted for the workspace — the secret
 * bundle keys plus, for a native adapter, its manifest `providerConfig` keys. Empty
 * ⇒ fully configured. This is the single source of truth behind
 * `ProviderDescriptor.missingRequired` (the unconfigured-provider banner) and the
 * shared `describeProvider` of both connection services.
 */
export function missingRequiredConfigKeys(
  fields: ProviderConfigField[],
  storedKeys: Iterable<string>,
): string[] {
  const present = new Set(storedKeys)
  return fields
    .filter((f) => f.required === true && f.default === undefined && !present.has(f.key))
    .map((f) => f.key)
}

/**
 * A minimal, side-effect-free connection probe: an authed GET against the pool/env
 * management `baseUrl`. Any HTTP response means the host is reachable; a 401/403
 * means the credentials were rejected. Never throws: a network failure is reported
 * as `{ ok:false }`. Shared by the generic providers' `testConnection`.
 *
 * `options.subject` names what is being reached, purely so the failure hint can say "the runner
 * pool API is most likely not running" instead of "the server". The URL-policy refusals thrown by
 * `assertSafeEnvironmentUrl` pass through {@link connectionFailureResult} unchanged: they carry
 * no error `code`, so they classify as `unknown` and are reported verbatim with no hint, which is
 * right, since a refused host is a config decision and not a reachability problem.
 */
export async function probeConnection(
  baseUrl: string,
  headers: Record<string, string>,
  policy: UrlSafetyPolicy = STRICT_URL_SAFETY_POLICY,
  options: { timeoutMs?: number; subject?: string } = {},
): Promise<ConnectionTestResult> {
  const { timeoutMs = 10_000, subject } = options
  try {
    // Re-validate every redirect hop (not just the initial URL), so a permitted base
    // URL can't 302 the probe to an internal/metadata host with the creds attached.
    const res = await safeFetch(
      baseUrl,
      {
        method: 'GET',
        headers: { accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (u) => assertSafeEnvironmentUrl(u, 'base URL', policy),
      (status, message) => new Error(`${message} (HTTP ${status})`),
    )
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `Credentials rejected (HTTP ${res.status})` }
    }
    return { ok: true, message: `Reachable (HTTP ${res.status})` }
  } catch (err) {
    return connectionFailureResult(err, {
      ...(subject ? { subject } : {}),
      target: baseUrl,
    })
  }
}

/** Variables available to manifest templates, in a bounded namespace. */
export interface InterpolationScope {
  input: Record<string, string>
  provision: Record<string, string>
}

/**
 * Replace `{{ namespace.key }}` placeholders from the given scope. Unknown
 * namespaces and missing keys resolve to an empty string, so a template can
 * never reference arbitrary host state.
 */
export function interpolateTemplate(template: string, scope: InterpolationScope): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, expr: string) => {
    const dot = expr.indexOf('.')
    if (dot === -1) return ''
    const ns = expr.slice(0, dot)
    const key = expr.slice(dot + 1)
    const bag = ns === 'input' ? scope.input : ns === 'provision' ? scope.provision : undefined
    if (!bag) return ''
    const value = bag[key]
    return value === undefined ? '' : value
  })
}

/** Read a value from parsed JSON by a dot-path (e.g. `data.url`, `items.0.id`). */
export function extractByPath(json: unknown, path: string): unknown {
  if (!path) return undefined
  let current: unknown = json
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Extract a scalar as a string, or undefined if absent/non-scalar. */
export function extractString(json: unknown, path: string | undefined): string | undefined {
  if (!path) return undefined
  const value = extractByPath(json, path)
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/**
 * Map a provider status string onto our lifecycle states using the manifest's
 * `statusMap`. Falls back to `fallback` (caller decides, e.g. 'ready' for a
 * synchronous provisioner with no status polling).
 */
export function mapStatus(
  raw: string | undefined,
  statusMap: { from: string; to: EnvironmentStatus }[] | undefined,
  fallback: EnvironmentStatus,
): EnvironmentStatus {
  if (raw !== undefined && statusMap) {
    const hit = statusMap.find((m) => m.from.toLowerCase() === raw.toLowerCase())
    if (hit) return hit.to
  }
  return fallback
}

/**
 * Read a manifest's `addressesPath` (or `hostsPath`) off an arbitrary provider response.
 *
 * Three shapes are accepted because a self-rolled management API can reasonably return any of
 * them, and refusing two would push an org into reshaping its API for us: a single string, an array
 * of strings, or an array of objects. Anything else in the array is SKIPPED rather than coerced, so
 * an unexpected element cannot become the literal `[object Object]` in an `--add-host` argument.
 *
 * `bare` is what a plain string in that path MEANS, and it comes from which manifest key was
 * declared rather than from reading the value: a bare string is unlabelled, so nothing about it
 * says whether `10.4.19.22` is an address or a name someone is about to resolve. An object entry
 * states its own kind and is read as it is written, which is what lets ONE path interleave the two
 * in a provider's preference order.
 *
 * Nothing here validates the values. Which addresses a bridge may name is kernel's rule
 * (`isBridgeableAddress`), applied at plan time and again where the bridge is built, and what
 * actually carries is the proof's answer; a provider stating a useless candidate gets a recorded
 * failed attempt, which is the honest outcome.
 */
export function extractAddresses(
  json: unknown,
  path: string | undefined,
  bare: 'address' | 'host' = 'address',
): EnvironmentRouteCandidate[] {
  if (!path) return []
  const raw = extractByPath(json, path)
  if (typeof raw === 'string') return raw.trim() ? [{ [bare]: raw.trim() }] : []
  if (!Array.isArray(raw)) return []
  const out: EnvironmentRouteCandidate[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      if (entry.trim()) out.push({ [bare]: entry.trim() })
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const address = typeof record.address === 'string' ? record.address.trim() : ''
    const host = typeof record.host === 'string' ? record.host.trim() : ''
    // Exactly one, on the schema's own rule: an entry stating both names two things with no way to
    // tell which was meant, and is dropped here rather than carried to the plan as a candidate that
    // could only ever be refused.
    if ((address && host) || (!address && !host)) continue
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    const target = address ? { address } : { host }
    out.push(label ? { ...target, label } : target)
  }
  return out
}

/**
 * Parse the stored reachability blob, or null when there is none and when what is there does not
 * validate.
 *
 * The ONE parse of that column, which is why it is here rather than in each facade's repository:
 * two implementations of one validator is how a D1 row and a Postgres row come to disagree about
 * what they hold. A blob that fails validation reads as ABSENT rather than throwing, because the
 * caller is a projection every environment read goes through and a stale shape written by an older
 * build must not take the whole handle down with it: an unreadable proof and no proof are the same
 * fact to every reader (nothing has been shown to carry).
 */
export function parseReachability(raw: string | null): EnvironmentReachability | null {
  if (!raw) return null
  try {
    const parsed = v.safeParse(environmentReachabilitySchema, JSON.parse(raw))
    return parsed.success ? parsed.output : null
  } catch {
    return null
  }
}

/**
 * Serialize reachability for the row, or null when there is nothing worth a column.
 *
 * `probedAt` alone is worth one. It is the record that the platform has LOOKED at reaching this
 * environment, which outlives both halves it sits beside (a proof about an address the provider
 * has stopped stating is dropped, and the candidate list with it), and it is what the status
 * poll's re-prove paces itself against. Dropping the value for want of the other two would make
 * the first held re-prove permanent.
 */
export function serializeReachability(value: EnvironmentReachability | null): string | null {
  if (!value) return null
  if (value.candidates.length === 0 && !value.proof && value.probedAt === undefined) return null
  return JSON.stringify(value)
}

/** Project a stored record onto the wire handle, optionally with decrypted access. */
export function recordToHandle(
  record: EnvironmentRecord,
  access?: EnvironmentAccessHandle | null,
): EnvironmentHandle {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    blockId: record.blockId,
    frameId: record.frameId,
    executionId: record.executionId,
    providerId: record.providerId,
    externalId: record.externalId,
    url: record.url,
    reachability: parseReachability(record.reachability),
    status: record.status,
    ...(access ? { access } : {}),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastError: record.lastError,
    statusNote: record.statusNote,
    lastPolledAt: record.lastPolledAt,
    pollCount: record.pollCount,
    provisionType: record.provisionType as EnvironmentHandle['provisionType'],
    engine: record.engine as EnvironmentHandle['engine'],
  }
}

/**
 * How much of a provider's status note is persisted. The note is provider-authored prose that
 * lands in three places a sentence has to stay readable in: the step's Environment panel, the
 * readiness ceiling's run-failure message, and the outcome card's environment row.
 *
 * `lastError` is deliberately uncapped beside it, and the asymmetry is the point: a fault is
 * something a person opens and scrolls (the panel gives it its own scrollable block), while the
 * note is one muted line beside an environment that is doing fine. A code adapter answering with
 * a controller dump or an event list would otherwise push everything under it off the surface.
 */
const STATUS_NOTE_CAP = 400

/**
 * A provider's status note as it is stored: trimmed, blank-as-null, and bounded.
 *
 * A capped note SAYS it was capped rather than trailing off, so a reader never takes the prefix
 * for the whole account (the same rule every other cap in the environment path follows).
 */
export function boundStatusNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim()
  if (!trimmed) return null
  if (trimmed.length <= STATUS_NOTE_CAP) return trimmed
  const dropped = trimmed.length - STATUS_NOTE_CAP
  return (
    `${trimmed.slice(0, STATUS_NOTE_CAP)} ` +
    `[note truncated: ${dropped} of ${trimmed.length} characters dropped]`
  )
}

/** Coerce an extracted expiry (epoch-ms number, numeric string, or ISO) to ms. */
export function coerceExpiresAt(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^\d+$/.test(trimmed)) return Number(trimmed)
    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}
