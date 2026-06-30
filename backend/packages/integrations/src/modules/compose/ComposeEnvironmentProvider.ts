import type {
  ConnectionTestResult,
  EnvironmentConnectionTestRequest,
  EnvironmentProvider,
  EnvironmentStatus,
  EnvironmentStatusRequest,
  EnvironmentTeardownRequest,
  ProviderConfigField,
  ProvisionEnvironmentRequest,
  ProvisionedEnvironment,
  RunRepoContext,
} from '@cat-factory/kernel'
import {
  type ComposeEnvironmentConfig,
  type ComposeRuntime,
  classifyComposePs,
  parseComposeEnvConfig,
  parseHostPort,
  prepareComposeProject,
  renderEnvMap,
  renderTemplate,
  resolveProjectName,
  tailOutput,
  templateVars,
} from './compose-environment.logic.js'

// Native Docker Compose ephemeral-environment provider. It brings the PR repo's OWN
// `docker-compose.yml` up on a local Docker daemon under a per-PR project name, publishes the
// configured web service's port to an ephemeral host port, and returns `http://localhost:<port>`
// for the Tester to run against — the Checkbox compose-stack mechanic. Teardown is a single
// project `down -v`. Daemon access is the injected `ComposeRuntime` (the local facade wires the
// docker CLI), so this stays runtime-neutral; it is registered only where a daemon exists
// (local/Node), never the Cloudflare Worker.
//
// The repo compose file is read checkout-free (no working tree) and rewritten into ONE
// isolation-safe project file before `up` (`prepareComposeProject`): host ports forced ephemeral
// so concurrent per-PR stacks never collide, the probed service guaranteed to publish its port,
// and references that can't be honored (build contexts / host bind mounts / relative env_files /
// privileged) refused up front instead of silently mis-mounting.
//
// Per-workspace config rides the stored manifest's `providerConfig` (parsed here); there are no
// secrets. The provider is a stateless singleton — every call re-reads the config + project from
// the request, so one instance serves every workspace.

const WAIT_TIMEOUT_S = 300
// Bound for the plain compose calls (port / ps / down / version-probe) so a wedged daemon can't
// hang a provision/status/teardown forever; `up` gets a longer bound that clears its own --wait.
const SHORT_TIMEOUT_MS = 60_000
const UP_TIMEOUT_MS = (WAIT_TIMEOUT_S + 30) * 1000

export interface ComposeEnvironmentProviderOptions {
  /** Reserved for future URL-policy-aware behaviour; unused today (the URL is always localhost). */
  urlPolicy?: unknown
}

export class ComposeEnvironmentProvider implements EnvironmentProvider {
  constructor(
    private readonly runtime: ComposeRuntime,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private readonly options: ComposeEnvironmentProviderOptions = {},
  ) {}

  async provision(req: ProvisionEnvironmentRequest): Promise<ProvisionedEnvironment> {
    const config = parseComposeEnvConfig(req.manifest)
    const inputs = req.inputs
    const project = resolveProjectName(config, inputs)
    const image = config.imageTemplate ? renderTemplate(config.imageTemplate, inputs) : undefined
    const vars = templateVars(inputs, project, image)

    const composeText = renderTemplate(await this.readComposeFile(req, config), vars)
    // Rewrite the repo compose into one isolation-safe project file (ephemeral host ports, the
    // probed service guaranteed to publish, unsupported references rejected). A blocking issue
    // surfaces as a deterministic failure BEFORE we touch the daemon.
    const prepared = prepareComposeProject(composeText, config.service, config.port)
    if (prepared.issues.length > 0) {
      return this.failed(
        project,
        `This Docker Compose stack can't be provisioned as a preview env:\n- ${prepared.issues.join('\n- ')}`,
      )
    }
    const basePath = await this.runtime.writeProjectFile(project, 'compose.yaml', prepared.content)
    const files = ['-f', basePath]
    const env = config.envTemplate ? renderEnvMap(config.envTemplate, vars) : undefined

    const up = await this.runtime.compose(
      ['-p', project, ...files, 'up', '-d', '--wait', '--wait-timeout', String(WAIT_TIMEOUT_S)],
      { env, timeoutMs: UP_TIMEOUT_MS },
    )
    if (up.code !== 0) {
      // Best-effort cleanup so a retry starts from a clean slate, then surface the verbatim
      // compose error as a deterministic (non-throwing) failure → `step.environment.lastError`.
      await this.safeDown(project)
      return this.failed(project, tailOutput(up.stderr || up.stdout) || 'docker compose up failed')
    }

    const portRes = await this.runtime.compose(
      ['-p', project, ...files, 'port', config.service, String(config.port)],
      { env, timeoutMs: SHORT_TIMEOUT_MS },
    )
    const hostPort = parseHostPort(portRes.stdout)
    if (hostPort === null) {
      await this.safeDown(project)
      return this.failed(
        project,
        `Service '${config.service}' does not publish container port ${config.port}; cannot resolve a preview URL`,
      )
    }
    const scheme = config.scheme ?? 'http'
    const url = `${scheme}://localhost:${hostPort}`
    return {
      externalId: project,
      url,
      status: 'ready',
      // Auto-teardown TTL (the connect form's `ttlMinutes`, default 2h) so a forgotten preview
      // env is swept off the host instead of leaking containers + volumes forever. Null ⇒ the
      // operator chose "never expire" (teardown still runs on demand / at run end).
      expiresAt: config.defaultTtlMs ? Date.now() + config.defaultTtlMs : null,
      access: null,
      // `status()`/`teardown()` re-derive everything from `project`; the URL is captured here so
      // a later status poll returns it without re-running `compose port` (which needs the files).
      fields: { project, url, hostPort: String(hostPort), scheme },
    }
  }

  async status(req: EnvironmentStatusRequest): Promise<ProvisionedEnvironment> {
    const project = req.provisionFields.project ?? req.externalId
    if (!project) {
      return {
        externalId: null,
        url: null,
        status: 'failed',
        expiresAt: null,
        access: null,
        fields: {},
      }
    }
    // `-a` so a container that's briefly recreating (or a completed one-shot) is still visible —
    // an empty default `ps` would otherwise flip a healthy env to `failed` mid-recreate.
    const ps = await this.runtime.compose(['-p', project, 'ps', '-a', '--format', 'json'], {
      timeoutMs: SHORT_TIMEOUT_MS,
    })
    const status = ps.code === 0 ? classifyComposePs(ps.stdout) : 'provisioning'
    return {
      externalId: project,
      url: req.provisionFields.url ?? null,
      status,
      expiresAt: null,
      access: null,
      fields: req.provisionFields,
    }
  }

  async teardown(req: EnvironmentTeardownRequest): Promise<{ status: EnvironmentStatus }> {
    const project = req.provisionFields.project ?? req.externalId
    if (!project) return { status: 'torn_down' }
    await this.safeDown(project)
    await this.runtime.cleanupProject?.(project)
    return { status: 'torn_down' }
  }

  async testConnection(_req: EnvironmentConnectionTestRequest): Promise<ConnectionTestResult> {
    try {
      const version = await this.runtime.compose(['version', '--short'], {
        timeoutMs: SHORT_TIMEOUT_MS,
      })
      if (version.code !== 0) {
        return {
          ok: false,
          message: tailOutput(version.stderr || version.stdout) || 'docker compose unavailable',
        }
      }
      // `version --short` is a client-only call and succeeds even with the daemon stopped, so it
      // can't confirm reachability on its own. `compose ls` actually contacts the daemon — only a
      // success there means a real provision could run.
      const ls = await this.runtime.compose(['ls', '--format', 'json'], {
        timeoutMs: SHORT_TIMEOUT_MS,
      })
      if (ls.code !== 0) {
        return {
          ok: false,
          message: tailOutput(ls.stderr || ls.stdout) || 'Docker daemon is not reachable',
        }
      }
      const v = version.stdout.trim()
      return {
        ok: true,
        message: v ? `Docker Compose ${v} reachable.` : 'Docker Compose reachable.',
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  describeConfig(): ProviderConfigField[] {
    // Flat, descriptor-driven connect form (the SPA overlays these onto the manifest's
    // providerConfig). `service` + `port` are required, so the unconfigured banner stays lit
    // until they're set (the local preset prefills them). No secret — Compose stacks need none.
    return [
      {
        key: 'composePath',
        label: 'Compose file path',
        default: 'docker-compose.yml',
        help: 'Path to the compose file in the PR repo (read at the PR head branch).',
      },
      {
        key: 'composeRepo',
        label: 'Separate repo (optional)',
        placeholder: 'owner/repo',
        help: 'Read the compose file from a different repo instead of the PR repo.',
      },
      { key: 'composeRef', label: 'Separate repo ref (optional)', placeholder: 'main' },
      {
        key: 'service',
        label: 'Web service name',
        required: true,
        placeholder: 'web',
        help: 'The compose service whose port becomes the preview URL.',
      },
      {
        key: 'port',
        label: 'Container port',
        required: true,
        placeholder: '8080',
        help: 'The in-container port to publish to an ephemeral host port + probe. Image-based stacks only (v1) — a service that builds from source is not yet supported.',
      },
      { key: 'scheme', label: 'URL scheme', default: 'http' },
      {
        key: 'projectTemplate',
        label: 'Project name template (optional)',
        placeholder: 'cf-env-{{pullNumber}}',
        help: 'Defaults to cf-env-<repo>-<pullNumber>. Drives COMPOSE_PROJECT_NAME (per-PR isolation).',
      },
      {
        key: 'imageTemplate',
        label: 'Image override (optional)',
        help: 'Made available to the compose file as {{image}} (e.g. a CI-built tag).',
      },
      {
        key: 'ttlMinutes',
        label: 'Auto-teardown after (minutes)',
        default: '120',
        help: 'The stack is swept + torn down this many minutes after it comes up, so a forgotten preview env does not leak containers + volumes on the host. 0 = never expire (teardown still runs on demand / at run end).',
      },
    ]
  }

  describeManifestTemplate() {
    return {
      providerId: 'compose',
      label: 'Docker Compose',
      baseUrl: 'http://localhost',
      auth: { type: 'none' as const },
      provision: { method: 'POST' as const, pathTemplate: '' },
      response: {},
      providerConfig: {},
    }
  }

  // --- internals ----------------------------------------------------------

  private failed(project: string, error: string): ProvisionedEnvironment {
    return {
      externalId: project,
      url: null,
      status: 'failed',
      expiresAt: null,
      access: null,
      fields: { project },
      error,
    }
  }

  /** `down -v` is idempotent (a missing project is a no-op); swallow its result. */
  private async safeDown(project: string): Promise<void> {
    try {
      await this.runtime.compose(['-p', project, 'down', '-v', '--remove-orphans'], {
        timeoutMs: SHORT_TIMEOUT_MS,
      })
    } catch {
      // teardown is best-effort; the registry tombstones the record regardless.
    }
  }

  /** Read the compose file from the configured source (co-located PR repo or a separate repo). */
  private async readComposeFile(
    req: ProvisionEnvironmentRequest,
    config: ComposeEnvironmentConfig,
  ): Promise<string> {
    let ctx: RunRepoContext | null
    let ref: string
    if (!config.composeRepo) {
      ctx = req.runRepo ?? null
      if (!ctx) {
        throw new Error(
          'A co-located docker-compose file requires the run repo (is the VCS connected?)',
        )
      }
      ref = req.inputs.branch || ctx.baseBranch
    } else {
      const [owner, repo] = config.composeRepo.split('/')
      ctx =
        (await req.resolveRepoFiles?.({ owner: owner!, repo: repo!, ref: config.composeRef })) ??
        null
      if (!ctx) {
        throw new Error(`Could not resolve the compose repo '${config.composeRepo}'`)
      }
      ref = config.composeRef || ctx.baseBranch
    }
    const file = await ctx.repo.getFile(config.composePath, ref)
    if (!file) throw new Error(`No docker-compose file found at '${config.composePath}'`)
    return file.content
  }
}
