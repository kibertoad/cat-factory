import { type CoreRepositories, type DriveConfig, driveExecution } from '@cat-factory/node-server'
import {
  DelegatedAppTokenSource,
  HttpMachineEventClient,
  HttpMachineNotificationClient,
  HttpMachineTelemetryClient,
  HttpMachineTelemetryReadClient,
  HttpBinaryGeneratorSource,
  HttpFoundationalBuiltinSource,
  HttpDeploymentDocumentResolver,
  HttpPromptFragmentSource,
  HttpPersistenceRpcClient,
  HttpSecretDelegate,
  type LocalFirstPersistenceRepository,
  type Logger,
  type MothershipConnector,
  RemoteNotificationChannel,
  createRemoteRepositoryRegistry,
  logger,
} from '@cat-factory/server'
import type { AgentRunRepository, WorkRunner } from '@cat-factory/kernel'
import { MothershipWebSocketPropagator } from './mothershipPropagator.js'
import { withTelemetryReadThrough } from './telemetryReadThrough.js'
import { MothershipEventSubscriber } from './mothershipSubscriber.js'
import { type LocalCredentialStore, createLocalCredentialStore } from './sqlite/credentialStore.js'
import { localDbPath } from './sqlite/db.js'
import { type LocalSettingsStore, createLocalSettingsStore } from './sqlite/localSettingsStore.js'
import { type LocalTelemetryStore, createLocalTelemetryStore } from './sqlite/telemetryStore.js'
import {
  type LocalMachineTokenStore,
  createLocalMachineTokenStore,
} from './sqlite/machineTokenStore.js'
import { SqliteWorkQueue, createWorkQueue } from './sqlite/workQueue.js'

// Mothership mode (docs/initiatives/mothership-mode.md): the local node keeps NO main
// database. Org/durable state lives on a hosted "mothership" cat-factory (Node or Cloudflare)
// and is reached over the authenticated `/internal/persistence` machine API; agent/model
// CREDENTIALS stay on the laptop in a file-based `node:sqlite` store, sealed with the LOCAL
// key (the mothership's ENCRYPTION_KEY never reaches the machine); and run TELEMETRY is
// local-first in a second `node:sqlite` store (append-heavy and hot-path, so it must never
// ride the per-call RPC). This module composes those halves into the seams
// `buildLocalContainer` threads into `buildNodeContainer`, and supplies the in-process work
// runner that replaces pg-boss when there is no Postgres.

/** True when this local node should boot in mothership mode (a mothership URL is configured). */
export function isMothershipMode(env: NodeJS.ProcessEnv): boolean {
  return !!env.LOCAL_MOTHERSHIP_URL?.trim()
}

/** The cached machine token if present AND unexpired, else null (an expired token is "no token"). */
function validCachedToken(store: LocalMachineTokenStore): string | null {
  const cached = store.read()
  return cached && cached.exp > Date.now() ? cached.token : null
}

/** The composed mothership persistence: remote org repos + the local credential store. */
export interface MothershipComposition {
  /**
   * The full {@link CoreRepositories} surface, remote (RPC-backed) except the local-first
   * TELEMETRY bucket layered over it from {@link telemetryStore}. The server-side
   * allow-list (`REMOTE_PERSISTENCE_METHODS`) gates which repo+method actually executes on the
   * mothership; an un-allow-listed call returns `unknown_method`. The allow-list covers the
   * board-load + run paths (resolved by the Phase-3 merge gate — see
   * docs/initiatives/mothership-mode.md), so a board loads and a run drives to a persisted
   * terminal state over this registry; the remaining `pending` org methods (the live per-repo
   * checklist in the tracker) are widened slice by slice. Credentials are NOT here — they stay
   * local (the `node:sqlite` store), composed over the top of this registry by the facade.
   */
  repos: CoreRepositories
  /**
   * The local-sqlite credential store (kept on the laptop, sealed with the local key). Beyond the
   * direct-vendor API-key pool + local-model endpoints, it now also backs the subscription
   * credentials the local container executor leases — `providerSubscriptionTokenRepository`,
   * `personalSubscriptionRepository`, `subscriptionActivationRepository` — for the same reason
   * (they never traverse the machine API to the mothership).
   */
  credentialStore: LocalCredentialStore
  /**
   * The local-sqlite store for the local-mode operational settings singleton (warm-pool +
   * checkout config for the local Docker runner). NOT org state — it configures the local
   * facade's own differentiator — so it lives on the laptop, not the mothership.
   */
  localSettingsStore: LocalSettingsStore
  /**
   * The local-sqlite TELEMETRY store (product decision 5: telemetry/logs are local-first). Holds
   * the per-call LLM metrics, agent-context snapshots, performed web searches, provisioning log
   * and modeled subscription quota cycles a run produces on this machine — append-heavy,
   * high-volume, short-retention state that must never ride the per-call persistence RPC. Layered
   * over the remote registry in {@link repos}, so every consumer (recorders, the observability
   * endpoints, the board's per-step rollups) resolves it with no per-consumer wiring; the local
   * retention sweep prunes it to the deployment's configured window.
   */
  telemetryStore: LocalTelemetryStore
  /**
   * Delegated GitHub token source: installation tokens minted BY THE MOTHERSHIP over
   * `POST /internal/github/installation-token` (the mothership owns the GitHub App; its
   * private key never reaches this machine). The facade wires it as the push-token mint +
   * the `FetchGitHubClient` token source when no local `GITHUB_PAT` is configured, so
   * agent containers, gates/merge, RepoFiles ops — and the environment self-test's branch
   * create/delete — reach GitHub through the org's App installation. Reads the SAME
   * machine token as the persistence RPC (per request, so a post-boot login is picked up).
   */
  githubTokenSource: DelegatedAppTokenSource
  /**
   * The catalog's `builtin` tier, read from the MOTHERSHIP over
   * `GET /internal/foundational-services` (+ the batched `POST .../contracts`) rather than from this node's own
   * `FoundationalServiceRegistry`. A deployment's estate is org state: with only the registry as
   * a route it had to be registered on both entry points, and a node one build behind — the
   * normal state of a local node — silently resolved a catalog missing whatever the mothership
   * had since added, which reads exactly like an Architect judging a service irrelevant. Reads
   * the SAME per-request machine token as the persistence RPC. See
   * backend/docs/adr/0031-foundational-services.md.
   */
  foundationalBuiltins: HttpFoundationalBuiltinSource
  /**
   * The deployment's GENERATIVE BINARY INTEGRATIONS, read from the MOTHERSHIP over
   * `GET /internal/binary-generators` (+ the batched `POST .../contracts`) rather than from this
   * node's own `BinaryGeneratorRegistry`. Same story as the estate above with a louder symptom:
   * the pipeline builder's picker is fed by the MOTHERSHIP's registry, so a node resolving its
   * own copy refuses a step somebody configured through the product itself — reporting
   * `unknown_generator` against a configuration that is correct, with the half-wired deployment
   * invisible in the message. Reads the SAME per-request machine token as the persistence RPC.
   */
  binaryGenerators: HttpBinaryGeneratorSource
  /**
   * The deployment's best-practice PROMPT-FRAGMENT pool (and the per-task-type default sets that
   * select them), read from the MOTHERSHIP over `GET /internal/prompt-fragments` rather than from
   * this node's own `PromptFragmentRegistry`. The same story as its two siblings above: what a run
   * folds as its standards has to be what the deployment actually registered, and this node's build
   * can only hold a second copy. The symptom here is the quietest of the three, which is why it
   * matters: a run judged against a standard the org never wrote, or against nothing at all, and
   * the reviewer's adherence report reads perfectly well either way. Reads the SAME per-request
   * machine token as the persistence RPC.
   */
  promptFragments: HttpPromptFragmentSource
  /**
   * How a code-registered fragment's `documentRef` resolves on a node: over
   * `POST /internal/prompt-fragments/document-bodies`, because the credentials that authenticate
   * the fetch live in the MOTHERSHIP's environment and never reach a laptop. So the credential
   * stays put and the resolved BODY crosses, which is the same shape the sealed-secret rule forces
   * on a decrypting repository.
   */
  deploymentDocuments: HttpDeploymentDocumentResolver
  /**
   * The real-time UPSTREAM propagation adapter: forwards this local node's engine events to the
   * mothership over `POST /internal/events/publish`, so a hosted teammate on the same shared board
   * sees the local node's activity live. `buildLocalContainer` wraps the local hub in a
   * {@link LayeredEventPropagator} with this adapter, so every event fans to the laptop's own SPA AND
   * the mothership with no engine change. Reads the SAME per-request machine token as the persistence
   * RPC (a post-boot login is picked up without a restart). This is the OUTBOUND half of "real-time
   * both directions"; the inbound subscribe leg is a later slice (see the tracker).
   */
  realtimeAdapter: MothershipWebSocketPropagator
  /**
   * The real-time INBOUND subscriber: holds one machine-authed WebSocket to the mothership's
   * `GET /internal/events/subscribe/:ws` per workspace someone is watching locally, and
   * re-broadcasts what arrives into the laptop's own hub. Without it a mothership-mode board is
   * write-only in real time — it animates for work this laptop drove and stays frozen for a hosted
   * teammate's. `buildLocalContainer` binds it to the injected hub; a token-less node just doesn't
   * connect until the login completes.
   */
  realtimeSubscriber: MothershipEventSubscriber
  /**
   * The mothership-delegated notification channel: asks the mothership to deliver a notification
   * this node raised (by id) through the ORG's external transports — Slack today. The bot token is
   * sealed with the mothership's key, which never reaches this machine (product decision 3), so
   * external delivery cannot happen locally; `buildLocalContainer` composes this channel alongside
   * the local in-app push, whose frame already reaches the mothership over the real-time upstream
   * relay. Reads the SAME per-request machine token as the persistence RPC.
   */
  notificationChannel: RemoteNotificationChannel
  /**
   * The SECRET DELEGATION client: opens (and seals) the ORG-owned credentials this laptop holds no
   * key for (a provisioned environment's access handle, an infra handler's secret bundle, a
   * release-health connection) over `POST /internal/secrets/{unseal,seal}`. It is the mirror
   * image of the local credential store beside it: that keeps the laptop's OWN secrets off the
   * mothership; this makes the ORG's secrets usable here without the mothership's key ever
   * moving. `buildLocalContainer` threads it into `buildNodeContainer`'s `secretDelegate` seam, so
   * every service holding one of those rows composes it with its own cipher. Reads the SAME
   * per-request machine token as the persistence RPC.
   */
  secretDelegate: HttpSecretDelegate
  /**
   * The telemetry INGEST client: uploads a quiesced run's locally captured rows to the mothership
   * over `POST /internal/telemetry/ingest` (product decision 5's sync UP). Without it a run this
   * laptop drove is observable ONLY on this laptop, and only until the local retention window
   * passes. `buildLocalContainer` drives it from the background ingest sweep; a token-less node
   * simply keeps the rows local until the login completes. Reads the SAME per-request machine
   * token as the persistence RPC.
   */
  telemetryClient: HttpMachineTelemetryClient
  /** The durable local-sqlite execution work queue (the no-pg-boss durability substrate). */
  workQueue: SqliteWorkQueue
  /**
   * The local-sqlite cache of the mothership-minted machine token. The `/local/mothership/connect`
   * login flow writes it; the RPC client's token provider reads it per request (below). Kept
   * separate from the RPC client so the connect controller can update it live (no restart).
   */
  machineTokenStore: LocalMachineTokenStore
  /** Close the underlying SQLite databases (call on shutdown). */
  close(): void
}

/**
 * Compose the mothership persistence from env. Builds the machine-authed RPC client +
 * the full remote repository registry, and opens the local credential store. The caller
 * (`buildLocalContainer`) passes `repos` as `options.repos` and the credential store's two
 * repositories as `options.providerApiKeyRepository` / `options.localModelEndpointRepository`,
 * with `options.db` left undefined.
 *
 * The machine token is resolved PER RPC via a token provider, precedence:
 *   1. `LOCAL_MOTHERSHIP_TOKEN` env (a headless/CI override — no login flow), else
 *   2. the local-sqlite cache written by the `/local/mothership/connect` login flow (if unexpired),
 *      else
 *   3. `null` — every call comes back 403 and the node boots "not connected", so the SPA can drive
 *      the login. Booting inert (rather than throwing on a missing token) is what makes the
 *      SPA-driven login possible: the node must be up to serve the SPA that mints the token.
 */
export function composeMothership(env: NodeJS.ProcessEnv): MothershipComposition {
  const baseUrl = env.LOCAL_MOTHERSHIP_URL?.trim()
  if (!baseUrl) {
    throw new Error('composeMothership called without LOCAL_MOTHERSHIP_URL set')
  }
  const machineTokenStore = createLocalMachineTokenStore(
    localDbPath(env.LOCAL_MOTHERSHIP_TOKEN_DB, 'machine-token.sqlite'),
  )
  const envToken = env.LOCAL_MOTHERSHIP_TOKEN?.trim()
  const machineToken = () => envToken || validCachedToken(machineTokenStore)
  const client = new HttpPersistenceRpcClient({ baseUrl, token: machineToken })
  // Telemetry is LOCAL-FIRST (product decision 5), so its repositories are layered over the
  // remote registry rather than proxied: they are written on the hot path of every LLM call,
  // dispatch and provisioning attempt, and none of their methods is (or should be) allow-listed
  // on the machine API. Opened before the registry so the composition is a single expression.
  const telemetryStore = createLocalTelemetryStore(
    localDbPath(env.LOCAL_MOTHERSHIP_TELEMETRY_DB, 'telemetry.sqlite'),
  )
  // READ-THROUGH: the three RUN-SCOPED sinks answer a read the local store has no rows for from
  // the mothership's copy (`POST /internal/telemetry/read`), so a run whose local rows were
  // pruned — or that another node drove entirely — renders instead of reading as a run that
  // spent nothing. Wrapped HERE rather than at each consumer for the same reason the bucket is
  // declared once: the registry is the composition seam, so the recorders, the observability
  // endpoints, the board rollups and the debug surface all get it with no per-consumer wiring.
  // The other two sinks are deliberately NOT wrapped — a provisioning log and a quota cycle are
  // never ingested, so there is nothing on the mothership to read through to.
  const readThrough = withTelemetryReadThrough(telemetryStore, {
    client: new HttpMachineTelemetryReadClient({ baseUrl, token: machineToken }),
    // What lets it tell a WHOLE local answer from the suffix the prune left behind. Threaded from
    // the store rather than defaulted, so a facade cannot compose a read-through that silently
    // reports a partially pruned run's token total as the run's.
    coverage: telemetryStore.coverage,
    logger,
  })
  // Typed by `LocalFirstPersistenceRepository` (the server-side declaration of the bucket), so
  // the map can never be HALF-wired: omitting an entry fails to typecheck rather than silently
  // leaving that repository on a remote proxy the allow-list only ever answers `unknown_method`.
  const localFirst: Record<LocalFirstPersistenceRepository, unknown> = {
    llmCallMetricRepository: readThrough.llmCallMetricRepository,
    agentContextSnapshotRepository: readThrough.agentContextSnapshotRepository,
    agentSearchQueryRepository: readThrough.agentSearchQueryRepository,
    agentToolCallRepository: readThrough.agentToolCallRepository,
    provisioningLogRepository: telemetryStore.provisioningLogRepository,
    subscriptionQuotaCycleRepository: telemetryStore.subscriptionQuotaCycleRepository,
  }
  const repos = createRemoteRepositoryRegistry(client, localFirst) as unknown as CoreRepositories
  // Same base URL + per-request token as the persistence RPC, so GitHub delegation follows
  // the exact connect/expiry lifecycle of the rest of the machine API.
  const githubTokenSource = new DelegatedAppTokenSource({ baseUrl, token: machineToken })
  // The foundational-service catalog's `builtin` tier, read from the mothership on the same base
  // URL + per-request token. It is the deployment's ESTATE — org state — and this node's own
  // build can only hold a second copy of it, so the node does not consult its own registry at all
  // (see the boot warning in `server.ts` when one is nonetheless registered).
  const foundationalBuiltins = new HttpFoundationalBuiltinSource({ baseUrl, token: machineToken })
  // The deployment's generative integrations, on the same base URL + per-request token and for
  // the same reason: what a run resolves a step's `generatorIds` against has to be the set the
  // builder offered them from, and this node's own build can only hold a second copy of it (see
  // the boot warning in `server.ts` when one is nonetheless registered).
  const binaryGenerators = new HttpBinaryGeneratorSource({ baseUrl, token: machineToken })
  // …and the standards pool, on the same base URL + per-request token, for the same reason once
  // more (see the boot warning in `server.ts` when a registry is nonetheless registered here).
  const promptFragments = new HttpPromptFragmentSource({ baseUrl, token: machineToken })
  // …and the living documents those standards may name. No `configuredSources` here: a node cannot
  // see the mothership's environment, so it assumes every deployment-scopable source may be served
  // and lets the read decide. That direction costs one round trip that resolves nothing; the
  // opposite would silently skip a document the mothership could have served.
  const deploymentDocuments = new HttpDeploymentDocumentResolver({ baseUrl, token: machineToken })
  // Real-time, BOTH directions, on the SAME base URL + per-request token, so the stream follows the
  // same connect/expiry lifecycle as the rest of the machine API. A token-less node neither
  // publishes nor subscribes (its own SPA still gets every locally produced event).
  //
  // The two legs share ONE stable per-process connection id: the subscriber connects with it as
  // `?cid=`, the publisher stamps it as `originConnectionId`, and the mothership's fan-out skips
  // that socket — so this node's own events never come back down and reach its browsers twice.
  const nodeConnectionId = `mothership-node-${crypto.randomUUID()}`
  const realtimeAdapter = new MothershipWebSocketPropagator(
    new HttpMachineEventClient({ baseUrl, token: machineToken }),
    nodeConnectionId,
  )
  const realtimeSubscriber = new MothershipEventSubscriber({
    baseUrl,
    token: machineToken,
    connectionId: nodeConnectionId,
    log: logger,
  })
  // Notification delivery delegation: same base URL + per-request token again, so the org's Slack
  // reaches the team for a run this laptop drove. A token-less node simply doesn't delegate (the
  // row is still persisted and the in-app card still renders).
  const notificationChannel = new RemoteNotificationChannel({
    client: new HttpMachineNotificationClient({ baseUrl, token: machineToken }),
    onError: (error, ctx) =>
      logger.warn('mothership notification delivery failed', {
        err: error instanceof Error ? error.message : String(error),
        ...ctx,
      }),
  })
  // Secret delegation: the org's sealed rows are opened (and this node's writes sealed) by the
  // mothership, on the SAME base URL + per-request token. A token-less node simply cannot open
  // them: the client REJECTS rather than answering an empty credential, because provisioning
  // against an empty bundle would fail somewhere far less legible.
  const secretDelegate = new HttpSecretDelegate({ baseUrl, token: machineToken })
  // Telemetry sync UP: the local-first capture above stays on the laptop until this carries a
  // quiesced run's rows to the mothership. Same base URL + per-request token again, so it follows
  // the same connect/expiry lifecycle as the rest of the machine API.
  const telemetryClient = new HttpMachineTelemetryClient({ baseUrl, token: machineToken })
  const credentialStore = createLocalCredentialStore(
    localDbPath(env.LOCAL_MOTHERSHIP_CREDENTIAL_DB, 'credentials.sqlite'),
  )
  const localSettingsStore = createLocalSettingsStore(
    localDbPath(env.LOCAL_MOTHERSHIP_SETTINGS_DB, 'local-settings.sqlite'),
  )
  const workQueue = createWorkQueue(localDbPath(env.LOCAL_MOTHERSHIP_WORK_DB, 'work-queue.sqlite'))
  return {
    repos,
    githubTokenSource,
    foundationalBuiltins,
    binaryGenerators,
    promptFragments,
    deploymentDocuments,
    realtimeAdapter,
    realtimeSubscriber,
    notificationChannel,
    secretDelegate,
    telemetryClient,
    credentialStore,
    localSettingsStore,
    telemetryStore,
    workQueue,
    machineTokenStore,
    close: () => {
      realtimeSubscriber.stop()
      credentialStore.close()
      localSettingsStore.close()
      telemetryStore.close()
      workQueue.close()
      machineTokenStore.close()
    },
  }
}

/**
 * Build the local-mode mothership login connector: exchange a mothership SESSION token (captured
 * by the SPA from the OAuth redirect fragment) for a machine token via `POST /auth/machine-token`,
 * cache the OPAQUE result in the local store, and report the resulting scope. The mothership
 * assigns the node id on each connect: the forwarded session is opaque here, so the node can't
 * tell WHICH user is connecting, and reusing the previously-cached id would mint a different
 * user's token under the last user's node id (conflating identity for future revocation). The
 * mothership verifies the session (its own secret) — the node never verifies the returned token,
 * it only presents it — so a session the mothership won't mint for yields a clean failure.
 */
export function createMothershipConnector(opts: {
  baseUrl: string
  store: LocalMachineTokenStore
  fetchImpl?: typeof fetch
}): MothershipConnector {
  const fetchImpl = opts.fetchImpl ?? fetch
  const baseUrl = opts.baseUrl.replace(/\/$/, '')
  return {
    async connect(session) {
      let res: Response
      try {
        res = await fetchImpl(`${baseUrl}/auth/machine-token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` },
          // No client-supplied node id: the mothership assigns one bound to the verified user,
          // so a reconnect as a different user never inherits the previous user's node id.
          body: '{}',
        })
      } catch (err) {
        return {
          ok: false,
          status: 502,
          message: `Could not reach the mothership: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      const body = (await res.json().catch(() => null)) as {
        token?: string
        nodeId?: string
        userId?: string
        accountIds?: string[]
        exp?: number
        user?: {
          id: string
          login: string
          name: string | null
          avatarUrl: string | null
          email?: string | null
        }
        error?: { message?: string }
      } | null
      if (
        !res.ok ||
        !body?.token ||
        !body.nodeId ||
        !body.userId ||
        !Array.isArray(body.accountIds) ||
        typeof body.exp !== 'number' ||
        !body.user
      ) {
        return {
          ok: false,
          status: res.status || 502,
          message: body?.error?.message ?? 'The mothership rejected the sign-in',
        }
      }
      opts.store.write({
        token: body.token,
        nodeId: body.nodeId,
        userId: body.userId,
        accountIds: body.accountIds,
        exp: body.exp,
        createdAt: Date.now(),
      })
      return { ok: true, accountIds: body.accountIds, exp: body.exp, user: body.user }
    },
  }
}

type ExecutionService = Parameters<typeof driveExecution>[0]

/** Timing + sizing knobs for the durable work runner, derived from the execution runtime config. */
export interface SqliteWorkRunnerOptions {
  /** The advance/poll drive config (poll intervals + budgets). */
  drive: DriveConfig
  /** Lease for an in-flight drive; an `active` row past it is treated as crash-orphaned. */
  leaseMs: number
  /** Delay before re-polling a re-armed unbounded gate (≈ the gate poll interval). */
  reArmDelayMs: number
  /** Backoff before retrying a drive that threw. */
  errorBackoffMs: number
  /** Periodic recovery poll: reclaim queued + lease-expired rows (the crash-recovery backstop). */
  sweepIntervalMs: number
  /** Max drive attempts before a poison run is evicted (parity with pg-boss `retryLimit`). */
  maxAttempts: number
  /** How many runs to drive in parallel on this node (parity with pg-boss worker concurrency). */
  concurrency: number
}

/**
 * The durable SQLite-backed work runner: the no-Postgres analogue of {@link PgBossWorkRunner}. A
 * mothership-mode node has no pg-boss, so it drives runs in this process — but unlike PR 1's
 * best-effort in-memory runner, the intent "this run needs driving" is persisted in a local
 * `node:sqlite` {@link SqliteWorkQueue}, so a crash or restart re-drives what was in flight. It
 * mirrors pg-boss's `exclusive` advance queue:
 *
 *   - one row per run (the queue's PRIMARY KEY) = pg-boss's `singletonKey` dedup;
 *   - a `startRun` / `signalDecision` (re)queues the run and kicks the drain loop;
 *   - the drain loop claims drivable runs up to `concurrency` and drives each via the SAME
 *     `driveExecution` advance/poll loop the Node facade uses (real timer-backed sleeps);
 *   - a signal arriving mid-drive coalesces into exactly one follow-up via the row's `rerun` flag;
 *   - a re-armed unbounded gate (human review) is deferred for `reArmDelayMs` then re-polled — the
 *     in-process analogue of the stale-run sweeper re-enqueuing it. A re-arm is a SUCCESSFUL drive,
 *     so it resets the retry budget: an unbounded gate re-arms forever without ever being mistaken
 *     for a poison pill;
 *   - `maxAttempts` bounds CONSECUTIVE drive FAILURES (not total claims): a poison run is evicted
 *     AND failed loudly, while a healthy run that re-arms / coalesces keeps its budget;
 *   - a periodic recovery poll + a boot-time orphan reset reclaim runs left `active` by a dead
 *     process, and a storage-reconciliation pass re-enqueues any run still `running` in storage that
 *     lost its queue row (the two legs of the durability pg-boss gets from Postgres, here from the
 *     SQLite file + the `agent_runs` source of truth).
 *
 * The execution service is bound after the container is built (it does not exist when the runner is
 * constructed). The `running` set tracks which runs THIS process is driving, so the claim loop and
 * the recovery poll never double-drive an in-flight run.
 */
export class SqliteWorkRunner implements WorkRunner {
  private exec?: ExecutionService
  private staleRuns?: AgentRunRepository
  private readonly running = new Set<string>()
  private sweepTimer?: ReturnType<typeof setInterval>
  private stopped = false

  constructor(
    private readonly queue: SqliteWorkQueue,
    private readonly opts: SqliteWorkRunnerOptions,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Bind the execution service once the container is built, recover any runs orphaned by a previous
   * process, drive what's queued, and start the periodic recovery poll. `staleRuns` (the
   * kind-spanning `agent_runs` reader) enables the storage-reconciliation backstop — re-driving a
   * run that storage reports `running` but that has no queue row at all (its row was lost, or never
   * enqueued because a prior process died). Idempotent: a second call clears the previous sweep
   * timer before re-arming, so it never leaks an interval.
   */
  bind(exec: ExecutionService, staleRuns?: AgentRunRepository): void {
    this.exec = exec
    this.staleRuns = staleRuns
    // Boot recovery: any row left `active` was orphaned when a previous process died (this process
    // drives nothing yet), so reclaim it for an immediate re-drive.
    const orphans = this.queue.resetOrphans()
    if (orphans > 0) {
      this.log.warn('mothership work queue: re-driving runs orphaned by a prior process', {
        orphans,
      })
    }
    this.drain()
    // Boot-time storage reconciliation: re-enqueue any run `running` in storage with no queue row
    // (the second leg of pg-boss-style durability — the stale-run sweeper). Best-effort.
    void this.reconcileStorage()
    // Backstop for runs whose deferred re-arm / error-backoff kick was lost, or whose lease lapsed:
    // a periodic drain reclaims every queued + lease-expired row, evicts exhausted runs, and
    // reconciles storage orphans. Unref'd so it never holds the process open on its own.
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = setInterval(() => {
      this.drain()
      void this.reconcileStorage()
    }, this.opts.sweepIntervalMs)
    this.sweepTimer.unref?.()
  }

  /** Stop the recovery poll (shutdown). In-flight drives are left to finish or die with the process. */
  stop(): void {
    this.stopped = true
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
  }

  async startRun(workspaceId: string, executionId: string): Promise<void> {
    this.wake(workspaceId, executionId)
  }

  async signalDecision(workspaceId: string, executionId: string): Promise<void> {
    // The decision is already persisted (to the mothership); (re)queue so the parked run resumes.
    this.wake(workspaceId, executionId)
  }

  async cancelRun(): Promise<void> {
    // Best-effort: the run is finalized via ExecutionService.stopRun; an in-flight drive is a
    // no-op once the run is terminal (advanceInstance returns noop), and its row is settled away.
  }

  /**
   * (Re)queue a run and kick the drain loop. If a drive is already in flight for it, flag the row
   * for a coalesced re-drive (the finishing driver re-queues it); otherwise force it claimable now
   * (covers a fresh run, an idle run, and waking a deferred gate re-poll early). The `running` set
   * read is race-free: a drive only reaches `settle` synchronously between awaits, with the run
   * still in `running`, so an in-flight run is never misclassified as idle.
   */
  private wake(workspaceId: string, executionId: string): void {
    if (this.running.has(executionId)) {
      this.queue.markRerun(executionId)
    } else {
      this.queue.enqueue(workspaceId, executionId, this.now())
    }
    this.drain()
  }

  /** Claim and launch drives up to the concurrency cap. Synchronous; each drive re-drains on finish. */
  private drain(): void {
    if (!this.exec || this.stopped) return
    // First reap poison runs (consecutive-failure budget exhausted): delete the row AND fail the
    // run loudly, so it surfaces as a terminal failure instead of silently vanishing from the queue
    // while storage still reports it `running`.
    for (const evicted of this.queue.evictExhausted(
      this.now(),
      this.opts.maxAttempts,
      this.running,
    )) {
      void this.failEvicted(evicted.workspaceId, evicted.executionId, evicted.attempts)
    }
    while (this.running.size < this.opts.concurrency) {
      const job = this.queue.claim(this.now(), this.opts.leaseMs, this.running)
      if (!job) break
      void this.driveClaimed(job.workspaceId, job.executionId)
    }
  }

  private async driveClaimed(workspaceId: string, executionId: string): Promise<void> {
    const exec = this.exec
    if (!exec) return
    this.running.add(executionId)
    try {
      const outcome = await driveExecution(exec, workspaceId, executionId, this.opts.drive, {
        log: this.log,
      })
      // Shutting down: don't touch the (closing) queue; the in-memory cleanup below still runs.
      if (this.stopped) return
      if (outcome.rearmedGate) {
        // A re-armed unbounded-wait gate (human review) released without finishing — a SUCCESSFUL
        // drive, so it resets the retry budget and is never evicted as poison no matter how long
        // the human takes. If a signal coalesced mid-drive, deferRearm re-queues it NOW (the
        // trailing drain() picks it up); otherwise it holds the run off the queue until the gate's
        // poll interval, then re-polls — the in-process analogue of the sweeper re-enqueuing it.
        // The future lease doubles as crash recovery.
        const { requeued } = this.queue.deferRearm(executionId, this.now() + this.opts.reArmDelayMs)
        if (!requeued) this.scheduleKick(this.opts.reArmDelayMs)
      } else {
        // Standstill (or a coalesced signal): settle deletes the row, or re-queues it for one more
        // drive — the trailing drain() below picks the re-queued run straight back up.
        this.queue.settle(executionId)
      }
    } catch (err) {
      if (this.stopped) return
      this.log.error('mothership in-process execution driver failed', {
        workspaceId,
        executionId,
        err: err instanceof Error ? err.message : String(err),
      })
      // Hold the run for a backoff'd retry, bumping the consecutive-failure count; once it reaches
      // the cap the next drain evicts it (and fails it loudly) rather than re-driving forever.
      this.queue.deferFailure(executionId, this.now() + this.opts.errorBackoffMs)
      this.scheduleKick(this.opts.errorBackoffMs)
    } finally {
      this.running.delete(executionId)
    }
    // Pick up a coalesced re-drive of this run plus any other queued run a freed slot now allows.
    this.drain()
  }

  /** Re-run the drain loop after `delayMs` (a deferred gate re-poll / error backoff). Unref'd. */
  private scheduleKick(delayMs: number): void {
    const timer = setTimeout(() => this.drain(), Math.max(1, delayMs))
    timer.unref?.()
  }

  /**
   * Fail an evicted run loudly. A run is evicted only after `maxAttempts` CONSECUTIVE drive errors —
   * which (because `driveExecution` funnels every recoverable error into `failRun` itself) means
   * the persistence path kept throwing, e.g. the mothership was unreachable. Mark it `evicted` so
   * it leaves the `running` limbo it would otherwise sit in forever; best-effort, since the same
   * broken persistence may make this `failRun` throw too (logged, not rethrown).
   */
  private async failEvicted(
    workspaceId: string,
    executionId: string,
    attempts: number,
  ): Promise<void> {
    this.log.error('mothership work queue: evicting run after repeated drive failures', {
      workspaceId,
      executionId,
      attempts,
    })
    try {
      await this.exec?.failRun(
        workspaceId,
        executionId,
        `Execution driver failed ${attempts} times in a row; giving up.`,
        'evicted',
        null,
      )
    } catch (err) {
      this.log.error('mothership work queue: failed to mark an evicted run failed', {
        workspaceId,
        executionId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * The second leg of pg-boss-style durability (the stale-run sweeper): re-enqueue any run that
   * storage still reports `running` but that has NO queue row — its row was lost, or the enqueue
   * never happened because a prior process died between the storage write and the enqueue. The
   * queue-local recovery (orphan reset + lease reclaim) only covers rows that EXIST; this reconciles
   * the queue against the source of truth. `enqueueIfAbsent` makes it safe: a run already deferred /
   * driving keeps its row untouched. Best-effort — the remote `agentRunRepository` may not yet
   * allow-list `listStale` (mothership gating phase), so a throw is swallowed.
   */
  private async reconcileStorage(): Promise<void> {
    if (!this.staleRuns || this.stopped) return
    let recovered = 0
    try {
      const stale = await this.staleRuns.listStale(this.now() - this.opts.leaseMs)
      if (this.stopped) return
      for (const ref of stale) {
        if (ref.kind !== 'execution') continue
        if (this.running.has(ref.id)) continue
        if (this.queue.enqueueIfAbsent(ref.workspaceId, ref.id, this.now())) recovered++
      }
    } catch {
      // listStale not reachable / not allow-listed yet — the backstop is best-effort.
      return
    }
    if (recovered > 0) {
      this.log.warn(
        'mothership work queue: re-enqueued runs still running in storage with no queue row',
        { recovered },
      )
      this.drain()
    }
  }
}
