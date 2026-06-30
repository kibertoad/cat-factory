import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { type CoreRepositories, type DriveConfig, driveExecution } from '@cat-factory/node-server'
import {
  HttpPersistenceRpcClient,
  type Logger,
  createRemoteRepositoryRegistry,
} from '@cat-factory/server'
import type { WorkRunner } from '@cat-factory/kernel'
import { type LocalCredentialStore, createLocalCredentialStore } from './sqlite/credentialStore.js'

// Mothership mode (docs/initiatives/mothership-mode.md): the local node keeps NO main
// database. Org/durable state lives on a hosted "mothership" cat-factory (Node or Cloudflare)
// and is reached over the authenticated `/internal/persistence` machine API; agent/model
// CREDENTIALS stay on the laptop in a file-based `node:sqlite` store, sealed with the LOCAL
// key (the mothership's ENCRYPTION_KEY never reaches the machine). This module composes those
// two halves into the seams `buildLocalContainer` threads into `buildNodeContainer`, and
// supplies the in-process work runner that replaces pg-boss when there is no Postgres.

/** True when this local node should boot in mothership mode (a mothership URL is configured). */
export function isMothershipMode(env: NodeJS.ProcessEnv): boolean {
  return !!env.LOCAL_MOTHERSHIP_URL?.trim()
}

/** Resolve the on-disk path for the local credential SQLite store (`:memory:` honoured for tests). */
function credentialDbPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.LOCAL_MOTHERSHIP_CREDENTIAL_DB?.trim()
  if (explicit) return explicit
  // Default to a stable per-user file so credentials survive restarts (the whole point of a
  // local store). Created under the developer's home dir; ensure the directory exists.
  const dir = join(homedir(), '.cat-factory')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'credentials.sqlite')
}

/** The composed mothership persistence: remote org repos + the local credential store. */
export interface MothershipComposition {
  /**
   * The full {@link CoreRepositories} surface, every entry remote (RPC-backed). The pilot
   * allow-list gates which repo+method actually executes on the mothership; an
   * un-allow-listed call returns `unknown_method` until a later slice widens the table.
   */
  repos: CoreRepositories
  /** The local-sqlite credential store (kept on the laptop, sealed with the local key). */
  credentialStore: LocalCredentialStore
  /** Close the underlying SQLite db (call on shutdown). */
  close(): void
}

/**
 * Compose the mothership persistence from env. Builds the machine-authed RPC client +
 * the full remote repository registry, and opens the local credential store. The caller
 * (`buildLocalContainer`) passes `repos` as `options.repos` and the credential store's two
 * repositories as `options.providerApiKeyRepository` / `options.localModelEndpointRepository`,
 * with `options.db` left undefined.
 *
 * Throws when `LOCAL_MOTHERSHIP_TOKEN` is missing — a mothership URL with no machine token
 * cannot authenticate a single call, so fail fast at boot rather than 403 on first read.
 */
export function composeMothership(env: NodeJS.ProcessEnv): MothershipComposition {
  const baseUrl = env.LOCAL_MOTHERSHIP_URL?.trim()
  if (!baseUrl) {
    throw new Error('composeMothership called without LOCAL_MOTHERSHIP_URL set')
  }
  const token = env.LOCAL_MOTHERSHIP_TOKEN?.trim()
  if (!token) {
    throw new Error(
      'LOCAL_MOTHERSHIP_URL is set but LOCAL_MOTHERSHIP_TOKEN is not. A mothership-mode node ' +
        'authenticates every persistence call with a machine token minted by the mothership; ' +
        'set LOCAL_MOTHERSHIP_TOKEN and restart. (Login-based minting lands in a later slice.)',
    )
  }
  const client = new HttpPersistenceRpcClient({ baseUrl, token })
  const repos = createRemoteRepositoryRegistry(client) as unknown as CoreRepositories
  const credentialStore = createLocalCredentialStore(credentialDbPath(env))
  return { repos, credentialStore, close: () => credentialStore.close() }
}

/**
 * The in-process work runner: the no-Postgres analogue of {@link PgBossWorkRunner}. A
 * mothership-mode node has no pg-boss, so it drives runs in this process by calling the SAME
 * `driveExecution` advance/poll loop (with real timer-backed sleeps) in the background.
 *
 * It serialises per execution — at most one drive per run at a time — so a `signalDecision`
 * (or a re-armed human-review gate) that arrives mid-drive coalesces into exactly one
 * follow-up drive once the current one returns, mirroring pg-boss's `exclusive` queue
 * semantics (one live advance per run, duplicate sends suppressed). The execution service is
 * bound after the container is built (it does not exist when the runner is constructed).
 *
 * NOTE (single process, best effort): unlike pg-boss there is no durable queue or stale-run
 * sweeper, so a crash loses in-flight drives — acceptable for a single-developer local node,
 * and the durable SQLite work queue is PR 2 in the initiative.
 */
export class InProcessWorkRunner implements WorkRunner {
  private exec?: Parameters<typeof driveExecution>[0]
  /** Per-execution state: `running` = a drive is active, `rerun` = another was requested mid-drive. */
  private readonly inflight = new Map<string, 'running' | 'rerun'>()

  constructor(
    private readonly cfg: DriveConfig,
    private readonly log: Logger,
  ) {}

  /** Bind the execution service once the container is built (chicken-and-egg with `createCore`). */
  bind(exec: Parameters<typeof driveExecution>[0]): void {
    this.exec = exec
  }

  async startRun(workspaceId: string, executionId: string): Promise<void> {
    this.schedule(workspaceId, executionId)
  }

  async signalDecision(workspaceId: string, executionId: string): Promise<void> {
    // The decision is already persisted (to the mothership); re-drive so the parked run resumes.
    this.schedule(workspaceId, executionId)
  }

  async cancelRun(): Promise<void> {
    // Best-effort: the run is finalized via ExecutionService.stopRun; an in-flight drive is a
    // no-op once the run is terminal (advanceInstance returns noop).
  }

  private schedule(workspaceId: string, executionId: string): void {
    if (this.inflight.has(executionId)) {
      // A drive is already running for this run — coalesce into one follow-up.
      this.inflight.set(executionId, 'rerun')
      return
    }
    this.inflight.set(executionId, 'running')
    void this.drive(workspaceId, executionId)
  }

  private async drive(workspaceId: string, executionId: string): Promise<void> {
    if (!this.exec) {
      this.inflight.delete(executionId)
      this.log.error({ executionId }, 'in-process work runner driven before bind()')
      return
    }
    try {
      // Loop while a re-run was requested mid-drive (a coalesced signal); single-threaded JS
      // makes the read-then-act on `inflight` race-free between awaits.
      for (;;) {
        this.inflight.set(executionId, 'running')
        const outcome = await driveExecution(this.exec, workspaceId, executionId, this.cfg, {
          log: this.log,
        })
        // A re-armed unbounded-wait gate (human review) released the drive without finishing;
        // with no stale-run sweeper here, re-arm it ourselves after the gate's poll interval so
        // it polls again rather than stalling.
        if (outcome.rearmedGate) {
          this.rearmAfterDelay(workspaceId, executionId)
        }
        if (this.inflight.get(executionId) !== 'rerun') break
      }
    } catch (err) {
      this.log.error(
        { workspaceId, executionId, err: err instanceof Error ? err.message : String(err) },
        'in-process execution driver failed',
      )
    } finally {
      this.inflight.delete(executionId)
    }
  }

  /** Re-arm a polling gate after its poll interval (the in-process analogue of the sweeper). */
  private rearmAfterDelay(workspaceId: string, executionId: string): void {
    const delay = Math.max(1000, this.cfg.ciPollIntervalMs)
    const timer = setTimeout(() => this.schedule(workspaceId, executionId), delay)
    timer.unref?.() // never keep the process alive on a re-arm timer alone
  }
}
