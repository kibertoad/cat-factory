// The ESCAPE HATCH, and the honest accounting of why it exists.
//
// This suite is meant to drive `/api/v1`, and it does: every task, start, decision, run
// projection and piece of evidence goes through the published SDK (`publicApi.ts`). Three things
// it needs are not on that surface, and inventing them would be a product change smuggled in as
// a test:
//
//   1. **Bootstrapping a repository.** `POST /workspaces/:ws/bootstrap/jobs`. `/api/v1` can
//      CREATE a service against a repository that already exists (`POST /api/v1/services`) but
//      has nothing that makes a repository, so the "bootstrap an empty repo" half of this suite
//      has no public counterpart.
//   2. **Connecting the k3s engine.** `POST /workspaces/:ws/environments/handlers`. Infrastructure
//      connections are deployment setup and are deliberately absent from a surface frozen forever;
//      see `backend/docs/public-api.md`.
//   3. **Declaring a service's provisioning.** `PATCH /workspaces/:ws/blocks/:blockId`. `/api/v1`
//      has no `position`, no `provisioning` and no block vocabulary at all, on purpose.
//
// Each is SETUP, which is the pattern to hold onto: the acceptance narrative (file work, watch
// it run, answer what it asks, read what it proved) is entirely public. If a future change
// makes one of these reachable from `/api/v1`, delete it from here.
//
// **These calls are session-authed, so they work only against a deployment running open**
// (`AUTH_DEV_OPEN=true`, which local mode sets by default). That is a deliberate limit: the
// suite targets a developer's own local instance, and a hosted deployment would need a real
// session this has no way to mint.

import type {
  BootstrapJob,
  BootstrapRepoInput,
  InfraHandlerConfig,
  ServiceProvisioning,
} from '@cat-factory/contracts'

export type AppApiOptions = {
  baseUrl: string
  workspaceId: string
}

/** The subset of a board block this suite reads back. The app returns the whole `Block`. */
export type BlockView = {
  id: string
  title: string
  level: string
  provisioning?: ServiceProvisioning
}

export class AppApi {
  readonly #baseUrl: string
  readonly #workspaceId: string

  constructor(options: AppApiOptions) {
    this.#baseUrl = options.baseUrl
    this.#workspaceId = options.workspaceId
  }

  /** Kick off a repo bootstrap. Returns the job, whose `blockId` is the provisional frame. */
  startBootstrap(input: BootstrapRepoInput): Promise<BootstrapJob> {
    return this.#request<BootstrapJob>('POST', '/bootstrap/jobs', input)
  }

  getBootstrapJob(jobId: string): Promise<BootstrapJob> {
    return this.#request<BootstrapJob>('GET', `/bootstrap/jobs/${encodeURIComponent(jobId)}`)
  }

  /**
   * Probe a candidate engine connection WITHOUT persisting it.
   *
   * Worth its own call rather than letting `register` find out: a wrong apiserver URL or an
   * expired ServiceAccount token otherwise surfaces on the `deployer` step of a run that has
   * already paid for a design pass and an implementation. Spec 00 spends one call here so that
   * failure lands in preflight, where the message is about the cluster.
   */
  testEnvironmentHandler(config: InfraHandlerConfig, secrets: Record<string, string>) {
    return this.#request<{ ok: boolean; message?: string | null }>(
      'POST',
      '/environments/handlers/test',
      { config, secrets },
    )
  }

  /** Bind a provision type to an engine + its connection. Idempotent: re-registering replaces. */
  registerEnvironmentHandler(input: {
    provisionType: string
    config: InfraHandlerConfig
    secrets: Record<string, string>
  }): Promise<unknown> {
    return this.#request('POST', '/environments/handlers', input)
  }

  /** Declare where a service's per-PR manifests live. The engine half is the handler above. */
  setServiceProvisioning(blockId: string, provisioning: ServiceProvisioning): Promise<BlockView> {
    return this.#request<BlockView>('PATCH', `/blocks/${encodeURIComponent(blockId)}`, {
      provisioning,
    })
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.#baseUrl}/workspaces/${encodeURIComponent(this.#workspaceId)}${path}`
    const response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(await describeAppFailure(method, url, response))
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
  }
}

/**
 * Render an app-API failure with the platform's own refusal in it.
 *
 * The app answers through the shared `handleError`, so the body carries `error.code` and often
 * an `error.details.reason` that names the cause exactly (an unwired capability, a permission,
 * a validation). Reporting only the status would throw that away and leave an operator diffing
 * a 503 against three plausible causes.
 */
export async function describeAppFailure(
  method: string,
  url: string,
  response: { status: number; text: () => Promise<string> },
): Promise<string> {
  let detail = ''
  try {
    detail = (await response.text()).slice(0, 2000)
  } catch (error) {
    detail = `<body unreadable: ${error instanceof Error ? error.message : String(error)}>`
  }
  const hint =
    response.status === 401 || response.status === 403
      ? '\nThe app API is session-authed. This suite needs a deployment running open ' +
        '(AUTH_DEV_OPEN=true, which local mode sets by default).'
      : ''
  return `${method} ${url} failed with ${response.status}: ${detail}${hint}`
}
