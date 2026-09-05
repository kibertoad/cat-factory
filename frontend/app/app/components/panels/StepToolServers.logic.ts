import {
  toolServerObservedStatusSchema,
  toolServerUnavailableReasonSchema,
} from '@cat-factory/contracts'
import type {
  ObservedToolServer,
  StepToolServers,
  ToolServerObservedStatus,
  ToolServerUnavailableReason,
} from '~/types/toolServers'

// The step surface's tool-server (MCP) reason mapping. Kept out of the SFC on the same seam as
// `StepTestReport.logic.ts`, so the vocabulary rule can be asserted without mounting a component.
//
// The rule: a dropped tool server is reported with the reason it was dropped for, and a reason
// this build does not recognise is rendered as unknown rather than dropped or folded onto a
// neighbour. The vocabulary is CLOSED and PERSISTED on a run, so a step recorded before a member
// was retired still carries that member, and a chip that silently vanished would report a
// withheld capability as one that was never declared, which is the confusion this surface exists
// to end.

/**
 * The i18n key per reason. An exhaustive `Record` rather than a lookup with a default, so a member
 * added to the wire vocabulary fails to compile here instead of rendering as a blank chip.
 */
export const REASON_KEY: Record<ToolServerUnavailableReason, string> = {
  harness_unsupported: 'panels.stepDetail.toolServers.reason.harnessUnsupported',
  transport_unsupported: 'panels.stepDetail.toolServers.reason.transportUnsupported',
  missing_secret: 'panels.stepDetail.toolServers.reason.missingSecret',
  reserved_secret: 'panels.stepDetail.toolServers.reason.reservedSecret',
  unusable_secret: 'panels.stepDetail.toolServers.reason.unusableSecret',
  oauth_not_connected: 'panels.stepDetail.toolServers.reason.oauthNotConnected',
  oauth_token_failed: 'panels.stepDetail.toolServers.reason.oauthTokenFailed',
  over_budget: 'panels.stepDetail.toolServers.reason.overBudget',
  consensus_panel: 'panels.stepDetail.toolServers.reason.consensusPanel',
}

/**
 * The i18n key per reason for the REMEDY line: what an operator has to change to get the server
 * wired next run. Exhaustive on the same vocabulary and for the same reason as {@link REASON_KEY}.
 *
 * Split from the reason rather than folded into one sentence because the two answer different
 * questions and only one of them is stable: the reason states what the dispatch decided and is a
 * fact about that run forever, while the remedy names a surface this deployment happens to offer
 * (the Infrastructure window, a declaration in deployment code). The split is also the vocabulary's
 * own justification, since every member exists precisely because it needs a DIFFERENT fix
 * (`docs`' table in `backend/docs/mcp-tool-servers.md` is the same mapping for a reader who never
 * opens the SPA); a reason with no remedy leaves the operator holding an accurate diagnosis and no
 * next step, which is the state this surface was built to end.
 *
 * EDITING ONE OF THESE MEANS READING EVERY CAUSE IT COVERS FIRST. A member is not a cause:
 * `harness_unsupported`, `missing_secret` and `oauth_not_connected` are each reached from more
 * than one place, and a line addressing only the obvious one is a dead end for whoever hit the
 * other, which is worse than the bare diagnosis this replaced because it also costs them the
 * attempt. The causes per member are enumerated on kernel's `UnavailableToolServer` (which the SPA
 * cannot import) and restated in that doc's table, whose "What happened" column is the list to
 * check a remedy against.
 */
export const REMEDY_KEY: Record<ToolServerUnavailableReason, string> = {
  harness_unsupported: 'panels.stepDetail.toolServers.remedy.harnessUnsupported',
  transport_unsupported: 'panels.stepDetail.toolServers.remedy.transportUnsupported',
  missing_secret: 'panels.stepDetail.toolServers.remedy.missingSecret',
  reserved_secret: 'panels.stepDetail.toolServers.remedy.reservedSecret',
  unusable_secret: 'panels.stepDetail.toolServers.remedy.unusableSecret',
  oauth_not_connected: 'panels.stepDetail.toolServers.remedy.oauthNotConnected',
  oauth_token_failed: 'panels.stepDetail.toolServers.remedy.oauthTokenFailed',
  over_budget: 'panels.stepDetail.toolServers.remedy.overBudget',
  consensus_panel: 'panels.stepDetail.toolServers.remedy.consensusPanel',
}

/** The reason vocabulary as the SCHEMA states it: what a parity assertion grades {@link REASON_KEY} against. */
export const KNOWN_REASONS = toolServerUnavailableReasonSchema.options

/**
 * Whether a persisted reason is a member THIS build knows, derived from the picklist's own options
 * rather than from a list retyped here.
 *
 * A predicate rather than a truthiness check on the lookup, because `REASON_KEY` is an ordinary
 * object literal: a persisted value that happens to name an inherited `Object.prototype` member
 * (`constructor`, `toString`) reads back as a truthy non-key and would be handed to `t` as though
 * it were a translation key, taking the retired-member path away from exactly the case it exists
 * for. Narrowing at the boundary keeps the exhaustive `Record` compile-time guard intact.
 */
function isKnownReason(reason: string): reason is ToolServerUnavailableReason {
  return (KNOWN_REASONS as readonly string[]).includes(reason)
}

/**
 * Render one reason, falling back to the retired-member line that names the raw code.
 *
 * `t` is passed in rather than composed here so this stays a pure function: the component owns the
 * i18n instance, and the fallback branch is the one worth testing without one.
 */
export function reasonText(
  reason: ToolServerUnavailableReason,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  return isKnownReason(reason)
    ? t(REASON_KEY[reason])
    : t('panels.stepDetail.toolServers.reason.unknown', { reason })
}

/**
 * Render the remedy for one reason, or `null` when there is none to give.
 *
 * `null` is the honest answer for a RETIRED member and the reason it is not folded into
 * {@link reasonText}: this build knows the code was recorded and does not know what it meant, so it
 * cannot name a surface to change without guessing which current member the operator should act
 * on. The reason line already names the raw code, which is the whole of what is known.
 */
export function remedyText(
  reason: ToolServerUnavailableReason,
  t: (key: string, params?: Record<string, unknown>) => string,
): string | null {
  return isKnownReason(reason) ? t(REMEDY_KEY[reason]) : null
}

// ---------------------------------------------------------------------------
// The OBSERVED half: what the agent's CLI reported about the servers it loaded.
//
// The mapping above answers "why did the platform withhold this tool". This one answers the
// question that mapping structurally cannot: a server that passed every check, was promised to the
// agent in its prompt, and then did not come up. The two are rendered together on one chip because
// they are two halves of one answer about one server — but they are never merged into one status,
// because a withheld server and a failed one need different people to fix different things.
// ---------------------------------------------------------------------------

/**
 * What this build knows about one WIRED server after joining the CLI's report onto it.
 *
 * `null` and `not_loaded` are the pair this whole type exists to keep apart, and conflating them is
 * the mistake that would make the surface lie. `null` means NO OBSERVATION WAS MADE — the run's
 * harness publishes no report (codex's CLI does not, nor does any image older than the one that
 * introduced this, nor an unmapped runner pool) — so nothing at all is known about whether the
 * server started. `not_loaded` means an observation WAS made and this server was not in it, which
 * is positive evidence that the CLI never loaded it. Rendering the first as the second would
 * accuse every wired server on every deployment one image behind.
 */
export type ToolServerObservation =
  | null
  | { kind: 'loaded'; status: ToolServerObservedStatus; toolCount?: number }
  | { kind: 'not_loaded' }

/**
 * Join the CLI's report onto one wired server id.
 *
 * Takes the whole `observed` field rather than a prepared map so the absent-vs-empty decision is
 * made HERE, in the one place that owns the distinction, instead of by each caller building the
 * map. An absent field yields `null` for every server; a present one yields either the CLI's line
 * or `not_loaded`.
 */
export function observationFor(
  observed: readonly ObservedToolServer[] | undefined,
  id: string,
): ToolServerObservation {
  if (!observed) return null
  const found = observed.find((server) => server.id === id)
  if (!found) return { kind: 'not_loaded' }
  return {
    kind: 'loaded',
    status: isKnownObservedStatus(found.status) ? found.status : 'unknown',
    // Carried only when the CLI counted, and `0` is carried: a server that connected and exposed
    // nothing reaches the agent exactly like one that was never wired, so it is the most
    // diagnostic count on the field and the one a truthiness guard would erase.
    ...(typeof found.toolCount === 'number' ? { toolCount: found.toolCount } : {}),
  }
}

/**
 * The servers the CLI named that this step's record does not list as wired.
 *
 * Empty by construction on every ordinary run: the harness starts the CLI under
 * `--strict-mcp-config`, so the only servers it can load are the ones this dispatch wrote for it.
 * Surfaced anyway rather than filtered out, because the one way to reach it is a producer whose
 * report does not describe this job — a runner-pool manifest pointing `toolServersPath` at the
 * wrong field, say — and a surface that silently dropped those rows would present a report about
 * some other job as a clean bill of health for this one.
 */
export function unattributedObservations(record: StepToolServers): ObservedToolServer[] {
  if (!record.observed) return []
  const wired = new Set(record.wired.map((server) => server.id))
  return record.observed.filter((server) => !wired.has(server.id))
}

/**
 * The i18n key per observed status, for a server the CLI DID name. An exhaustive `Record` for the
 * same reason {@link REASON_KEY} is one: a member added to the wire vocabulary must fail to
 * compile here rather than render as a blank line.
 *
 * `ready` is deliberately absent — a started server's line depends on its tool COUNT, which is
 * three separate sentences (counted some, counted none, did not count), so it is resolved by
 * {@link observationText} rather than by a single key.
 */
export const OBSERVED_STATUS_KEY: Record<Exclude<ToolServerObservedStatus, 'ready'>, string> = {
  failed: 'panels.stepDetail.toolServers.observed.failed',
  needs_auth: 'panels.stepDetail.toolServers.observed.needsAuth',
  unknown: 'panels.stepDetail.toolServers.observed.unknown',
}

/** The observed-status vocabulary as the SCHEMA states it: what a parity assertion grades against. */
export const KNOWN_OBSERVED_STATUSES = toolServerObservedStatusSchema.options

/**
 * Whether a persisted status is a member THIS build knows, derived from the picklist's own options.
 * A predicate rather than a truthiness check on the lookup, for the reason {@link isKnownReason}
 * gives: an `Object.prototype` member name reads back as a truthy non-key.
 */
function isKnownObservedStatus(status: string): status is ToolServerObservedStatus {
  return (KNOWN_OBSERVED_STATUSES as readonly string[]).includes(status)
}

/**
 * Render one observation, or `null` when there is nothing to say.
 *
 * `null` is returned for `null` — no observation was made — and it is the whole reason this
 * function exists rather than a template expression: the surface must be BYTE-FOR-BYTE what it was
 * before this field existed on every run that carries no report, which is every codex run, every
 * run on an image one version behind, and every run on an unmapped runner pool. Silence is the
 * only honest rendering of "nobody looked".
 */
export function observationText(
  observation: ToolServerObservation,
  t: (key: string, params?: Record<string, unknown>) => string,
): string | null {
  if (observation === null) return null
  if (observation.kind === 'not_loaded') {
    return t('panels.stepDetail.toolServers.observed.notLoaded')
  }
  if (observation.status !== 'ready') return t(OBSERVED_STATUS_KEY[observation.status])
  if (observation.toolCount === undefined) {
    return t('panels.stepDetail.toolServers.observed.ready')
  }
  // Zero gets its own sentence rather than "0 tools": a server that started and offers nothing is
  // a distinct fault (a narrowed `allowedTools` matching nothing, a vendor that authenticated and
  // served an empty catalog), and it is the one an operator would otherwise never suspect,
  // because every other signal about it says healthy.
  return observation.toolCount === 0
    ? t('panels.stepDetail.toolServers.observed.readyNoTools')
    : t('panels.stepDetail.toolServers.observed.readyTools', { count: observation.toolCount })
}

/**
 * Whether an observation should DRAW ATTENTION on the chip: the server was promised to the agent
 * and the CLI could not deliver it.
 *
 * `unknown` is deliberately NOT alarming. It covers a word this build could not map (a fact about
 * this build rather than about the server) and a server the CLI reported as still handshaking when
 * it announced the session (a fact about the moment the report was taken). Neither says anything
 * happened to the server, and painting either as a fault would send an operator to debug a working
 * integration every time a CLI adds a status or starts a server a moment slower.
 */
export function observationIsFault(observation: ToolServerObservation): boolean {
  if (observation === null) return false
  if (observation.kind === 'not_loaded') return true
  return observation.status === 'failed' || observation.status === 'needs_auth'
}
