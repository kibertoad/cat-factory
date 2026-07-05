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
import type { RecipeStepRecorder, StackRecipe } from '@cat-factory/kernel'
import {
  type ComposeEnvironmentConfig,
  type ComposeRuntime,
  DEFAULT_RECIPE_HEALTH_GATE,
  checkoutDepthFor,
  classifyComposePs,
  composeFileDir,
  healthGateIntervalMs,
  healthGateTimeoutMs,
  parseComposeEnvConfig,
  parseHostPort,
  prepareComposeProject,
  prepareRecipeComposeFiles,
  recipeCheckoutPathIssues,
  recipeProfilesEnv,
  renderEnvMap,
  renderTemplate,
  resolveProjectName,
  resolveRecipeComposeFiles,
  tailOutput,
  templateVars,
} from './compose-environment.logic.js'
import { runHealthGate, runRecipeStep } from './recipe-runner.js'

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
// Build mode default bound for `docker compose build` — separate from UP_TIMEOUT_MS so a slow
// image build (a .NET/Angular multi-stage Dockerfile) doesn't consume the health-wait budget.
// Overridable per-workspace via the connect form's `buildTimeoutMinutes`.
const DEFAULT_BUILD_TIMEOUT_MS = 900_000
// The rewritten (isolation-safe) compose file, written beside the original inside the checkout.
const REWRITTEN_COMPOSE_NAME = 'cat-factory.compose.yaml'

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
    // A declarative STACK RECIPE (multi-`-f` layering, profiles, env-file materialization, ordered
    // setup steps + a terminal health gate) takes a dedicated path — it always materializes a
    // checkout and drives the imperative bring-up. Absent ⇒ the simple single-file flow below.
    if (config.recipe) return this.provisionRecipe(req, config, config.recipe)
    const inputs = req.inputs
    const project = resolveProjectName(config, inputs)
    const image = config.imageTemplate ? renderTemplate(config.imageTemplate, inputs) : undefined
    const vars = templateVars(inputs, project, image)

    const composeText = renderTemplate(await this.readComposeFile(req, config), vars)
    // Rewrite the repo compose into one isolation-safe project file (ephemeral host ports, the
    // probed service guaranteed to publish, unsupported references rejected — mode-aware: build
    // mode allows build:/in-checkout binds/relative env_files). A blocking issue surfaces as a
    // deterministic failure BEFORE we touch the daemon or clone anything.
    const prepared = prepareComposeProject(composeText, config.service, config.port, {
      build: config.build,
      // In build mode, relatives resolve against the compose file's own dir inside the checkout, so
      // a ref may climb this many `../`s and still be in-checkout (the escape line is the root).
      baseDepth: config.build ? checkoutDepthFor(config.composePath) : 0,
    })
    if (prepared.issues.length > 0) {
      return this.failed(
        project,
        `This Docker Compose stack can't be provisioned as a preview env:\n- ${prepared.issues.join('\n- ')}`,
      )
    }
    const env = config.envTemplate ? renderEnvMap(config.envTemplate, vars) : undefined

    // Materialize the project: build mode clones the PR head into a working tree (so build:/binds/
    // env_files resolve) and `docker compose build`s; image mode writes the rewritten file to a
    // scratch dir and relies on pre-built images. Either yields the `-f` file(s) + project dir.
    const setup = config.build
      ? await this.setupBuildProject(req, config, project, prepared.content, env)
      : await this.setupImageProject(project, prepared.content)
    if ('error' in setup) return this.failed(project, setup.error)
    const scope = setup.projectDir
      ? ['-p', project, '--project-directory', setup.projectDir, ...setup.files]
      : ['-p', project, ...setup.files]

    const up = await this.runtime.compose(
      [...scope, 'up', '-d', '--wait', '--wait-timeout', String(WAIT_TIMEOUT_S)],
      { env, timeoutMs: UP_TIMEOUT_MS },
    )
    if (up.code !== 0) {
      // Best-effort cleanup so a retry starts from a clean slate, then surface the verbatim
      // compose error as a deterministic (non-throwing) failure → `step.environment.lastError`.
      await this.safeDown(project)
      return this.failed(project, tailOutput(up.stderr || up.stdout) || 'docker compose up failed')
    }

    const portRes = await this.runtime.compose(
      [...scope, 'port', config.service, String(config.port)],
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
        help: 'The in-container port to publish to an ephemeral host port + probe.',
      },
      {
        key: 'build',
        label: 'Image source',
        type: 'select',
        default: 'false',
        options: [
          { value: 'false', label: 'Pull pre-built images' },
          { value: 'true', label: 'Build from source (clone the PR head)' },
        ],
        help: 'Build from source clones the PR head into a working tree and runs `docker compose build`, so `build:` contexts, in-checkout bind mounts, and relative env_files resolve. Requires a Docker-capable (local) deployment.',
      },
      {
        key: 'buildTimeoutMinutes',
        label: 'Build timeout (minutes)',
        default: '15',
        help: 'Build-from-source only: how long `docker compose build` may run before it is aborted (separate from the startup health-wait).',
      },
      {
        key: 'allowHostCommands',
        label: 'Allow host commands',
        type: 'select',
        default: 'false',
        options: [
          { value: 'false', label: 'No (containers only)' },
          { value: 'true', label: 'Yes (allow recipe host-command steps)' },
        ],
        help: 'Stack recipes only: permit a recipe’s `host-command` steps to run an arbitrary command on this host (not in a container). Off by default; enable only for a trusted local deployment.',
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

  /** Image mode: write the rewritten compose to a scratch dir; images are pulled, not built. */
  private async setupImageProject(
    project: string,
    content: string,
  ): Promise<{ files: string[]; projectDir?: string }> {
    const basePath = await this.runtime.writeProjectFile(project, 'compose.yaml', content)
    return { files: ['-f', basePath] }
  }

  /**
   * Build mode: clone the PR head into a per-project working tree, write the rewritten compose
   * BESIDE the original inside the checkout (so relative build contexts / bind mounts / env_files
   * resolve against the compose file's own directory), then `docker compose build`. Returns the
   * `-f` file + the `--project-directory` to reuse for `up`/`port`, or a deterministic `error`.
   */
  private async setupBuildProject(
    req: ProvisionEnvironmentRequest,
    config: ComposeEnvironmentConfig,
    project: string,
    content: string,
    env: Record<string, string> | undefined,
  ): Promise<{ files: string[]; projectDir: string } | { error: string }> {
    if (!this.runtime.checkout || !this.runtime.writeCheckoutFile) {
      return {
        error:
          'Build-from-source compose mode needs a Docker-capable runtime that can clone + build (unavailable on this deployment).',
      }
    }
    const clone = await req.clone?.()
    if (!clone) {
      return {
        error:
          'Build-from-source compose mode needs a repo clone target — is the VCS connected and the service linked to a repo?',
      }
    }
    const ref = req.inputs.branch || clone.ref
    let dir: string
    try {
      ;({ dir } = await this.runtime.checkout(project, {
        cloneUrl: clone.cloneUrl,
        ref,
        token: clone.token,
      }))
    } catch (err) {
      return {
        error: `Could not clone the repo for build: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    const composeDir = composeFileDir(config.composePath)
    const relPath = composeDir ? `${composeDir}/${REWRITTEN_COMPOSE_NAME}` : REWRITTEN_COMPOSE_NAME
    const filePath = await this.runtime.writeCheckoutFile(project, relPath, content)
    const projectDir = composeDir ? `${dir}/${composeDir}` : dir
    const files = ['-f', filePath]

    const build = await this.runtime.compose(
      ['-p', project, '--project-directory', projectDir, ...files, 'build'],
      { env, timeoutMs: config.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS },
    )
    if (build.code !== 0) {
      await this.safeDown(project)
      return { error: tailOutput(build.stderr || build.stdout) || 'docker compose build failed' }
    }
    return { files, projectDir }
  }

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
    const { ctx, ref } = await this.resolveComposeSource(req, config)
    const file = await ctx.repo.getFile(config.composePath, ref)
    if (!file) throw new Error(`No docker-compose file found at '${config.composePath}'`)
    return file.content
  }

  /** Resolve the checkout-free repo + ref the compose file(s) are read at (co-located or separate). */
  private async resolveComposeSource(
    req: ProvisionEnvironmentRequest,
    config: ComposeEnvironmentConfig,
  ): Promise<{ ctx: RunRepoContext; ref: string }> {
    if (!config.composeRepo) {
      const ctx = req.runRepo ?? null
      if (!ctx) {
        throw new Error(
          'A co-located docker-compose file requires the run repo (is the VCS connected?)',
        )
      }
      return { ctx, ref: req.inputs.branch || ctx.baseBranch }
    }
    const [owner, repo] = config.composeRepo.split('/')
    const ctx =
      (await req.resolveRepoFiles?.({ owner: owner!, repo: repo!, ref: config.composeRef })) ?? null
    if (!ctx) throw new Error(`Could not resolve the compose repo '${config.composeRepo}'`)
    return { ctx, ref: config.composeRef || ctx.baseBranch }
  }

  // --- stack-recipe execution ---------------------------------------------

  /**
   * Provision a complex compose stack from a declarative STACK RECIPE: clone the repo into a
   * working tree, materialize env-file templates, rewrite the layered `-f` files into isolation-
   * safe project files, `up -d` under `COMPOSE_PROFILES` (no `--wait` — readiness is the recipe's
   * own gate, since these stacks rarely declare healthchecks), run the ordered setup steps, then
   * poll the terminal health gate — streaming a per-step provisioning-log entry the whole way. Any
   * step's failure tears the half-up stack down for a clean retry and surfaces the step's error.
   */
  private async provisionRecipe(
    req: ProvisionEnvironmentRequest,
    config: ComposeEnvironmentConfig,
    recipe: StackRecipe,
  ): Promise<ProvisionedEnvironment> {
    const inputs = req.inputs
    const project = resolveProjectName(config, inputs)
    const record = req.recordStep

    // A recipe always needs a working tree (its steps + env files operate on the checkout).
    if (
      !this.runtime.checkout ||
      !this.runtime.writeCheckoutFile ||
      !this.runtime.copyCheckoutFile
    ) {
      return this.failed(
        project,
        'A stack recipe needs a Docker-capable runtime that can clone + write into a checkout (unavailable on this deployment).',
      )
    }

    // Fail fast (before the daemon / clone) on any checkout-escaping recipe path, and on a
    // `host-command` step that isn't opted into — the `prepareComposeProject` deterministic posture.
    const pathIssues = recipeCheckoutPathIssues(recipe)
    if (pathIssues.length > 0) {
      return this.failed(
        project,
        `This stack recipe can't be provisioned:\n- ${pathIssues.join('\n- ')}`,
      )
    }
    const hostCmdIssue = this.checkHostCommandsAllowed(recipe, config)
    if (hostCmdIssue) return this.failed(project, hostCmdIssue)

    const image = config.imageTemplate ? renderTemplate(config.imageTemplate, inputs) : undefined
    const vars = templateVars(inputs, project, image)
    // The compose invocation env: the templated `envTemplate` plus `COMPOSE_PROFILES`.
    const env = {
      ...(config.envTemplate ? renderEnvMap(config.envTemplate, vars) : {}),
      ...recipeProfilesEnv(recipe),
    }

    // Read + rewrite the layered compose files. `-f` order is preserved; the first file's dir is the
    // shared `--project-directory`, so every layer's relatives resolve against it (its checkout depth
    // bounds the host-escape guard). A blocking issue fails BEFORE the daemon is touched.
    const composeFiles = resolveRecipeComposeFiles(recipe, config.composePath)
    const baseDepth = checkoutDepthFor(composeFiles[0]!)
    let source: { ctx: RunRepoContext; ref: string }
    try {
      source = await this.resolveComposeSource(req, config)
    } catch (err) {
      return this.failed(project, err instanceof Error ? err.message : String(err))
    }
    const inputsFiles: { path: string; text: string }[] = []
    for (const path of composeFiles) {
      const file = await source.ctx.repo.getFile(path, source.ref)
      if (!file) return this.failed(project, `No docker-compose file found at '${path}'`)
      inputsFiles.push({ path, text: renderTemplate(file.content, vars) })
    }
    const prepared = prepareRecipeComposeFiles(inputsFiles, config.service, config.port, {
      baseDepth,
    })
    if (prepared.issues.length > 0) {
      return this.failed(
        project,
        `This stack recipe can't be provisioned as a preview env:\n- ${prepared.issues.join('\n- ')}`,
      )
    }

    // Clone the PR head into a working tree so `build:` contexts / binds / env_files resolve.
    const clone = await req.clone?.()
    if (!clone) {
      return this.failed(
        project,
        'A stack recipe needs a repo clone target — is the VCS connected and the service linked to a repo?',
      )
    }
    const ref = req.inputs.branch || clone.ref
    let checkoutDir: string
    try {
      ;({ dir: checkoutDir } = await this.runtime.checkout(project, {
        cloneUrl: clone.cloneUrl,
        ref,
        token: clone.token,
      }))
    } catch (err) {
      return this.failed(
        project,
        `Could not clone the repo for the recipe: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const composeDir = composeFileDir(composeFiles[0]!)
    const projectDir = composeDir ? `${checkoutDir}/${composeDir}` : checkoutDir

    // Materialize env-file templates (`.env.dev.local-dist` → `.env.dev.local`) BEFORE `up`, each a
    // logged step so a materialization failure is visible.
    for (const envFile of recipe.envFiles ?? []) {
      const started = Date.now()
      try {
        await this.runtime.copyCheckoutFile(project, envFile.template, envFile.target)
        await this.logStep(record, `env-file: ${envFile.target}`, started, { ok: true })
      } catch (err) {
        const message = `Could not materialize env file '${envFile.target}': ${
          err instanceof Error ? err.message : String(err)
        }`
        await this.logStep(record, `env-file: ${envFile.target}`, started, {
          ok: false,
          error: message,
        })
        await this.safeDown(project)
        return this.failed(project, message)
      }
    }

    // Write the rewritten compose files into the checkout (beside their originals) + build the `-f`s.
    const files: string[] = []
    for (const file of prepared.files) {
      const abs = await this.runtime.writeCheckoutFile(project, file.path, file.content)
      files.push('-f', abs)
    }
    const scope = ['-p', project, '--project-directory', projectDir, ...files]

    // Optional build (pull mode skips it); then `up -d` (no `--wait`).
    if (config.build) {
      const buildStarted = Date.now()
      const build = await this.runtime.compose([...scope, 'build'], {
        env,
        timeoutMs: config.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
      })
      const buildOk = build.code === 0
      await this.logStep(record, 'compose build', buildStarted, {
        ok: buildOk,
        ...(buildOk ? {} : { error: tailOutput(build.stderr || build.stdout) }),
      })
      if (!buildOk) {
        await this.safeDown(project)
        return this.failed(
          project,
          tailOutput(build.stderr || build.stdout) || 'docker compose build failed',
        )
      }
    }
    const upStarted = Date.now()
    const up = await this.runtime.compose([...scope, 'up', '-d'], { env, timeoutMs: UP_TIMEOUT_MS })
    const upOk = up.code === 0
    await this.logStep(record, 'compose up', upStarted, {
      ok: upOk,
      ...(upOk ? {} : { error: tailOutput(up.stderr || up.stdout) }),
    })
    if (!upOk) {
      await this.safeDown(project)
      return this.failed(project, tailOutput(up.stderr || up.stdout) || 'docker compose up failed')
    }

    // Ordered setup steps, then the terminal health gate. The first failure tears down + surfaces.
    for (const step of recipe.setupSteps ?? []) {
      const started = Date.now()
      const result = await runRecipeStep(step, { runtime: this.runtime, scope, env, project })
      await this.logStep(record, step.name, started, result)
      if (!result.ok) {
        await this.safeDown(project)
        return this.failed(project, `Recipe step '${step.name}' failed: ${result.error}`)
      }
    }
    const gate = recipe.healthGate ?? DEFAULT_RECIPE_HEALTH_GATE
    const gateStarted = Date.now()
    const gateResult = await runHealthGate(
      gate,
      { runtime: this.runtime, scope, env },
      {
        timeoutMs: healthGateTimeoutMs(gate),
        intervalMs: healthGateIntervalMs(gate),
        shortTimeoutMs: SHORT_TIMEOUT_MS,
      },
    )
    await this.logStep(record, `health gate (${gate.kind})`, gateStarted, gateResult)
    if (!gateResult.ok) {
      await this.safeDown(project)
      return this.failed(project, `Health gate did not pass: ${gateResult.error}`)
    }

    // Resolve the preview URL from the probed service's ephemeral host port.
    const portRes = await this.runtime.compose(
      [...scope, 'port', config.service, String(config.port)],
      {
        env,
        timeoutMs: SHORT_TIMEOUT_MS,
      },
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
      expiresAt: config.defaultTtlMs ? Date.now() + config.defaultTtlMs : null,
      access: null,
      fields: { project, url, hostPort: String(hostPort), scheme },
    }
  }

  /**
   * Refuse a recipe's `host-command` steps unless the workspace handler opted in
   * (`allowHostCommands`) AND the runtime can run host commands — the ONE trust-boundary-widening
   * step kind. Returns a blocking message, or null when there are no host-command steps / they are
   * allowed.
   */
  private checkHostCommandsAllowed(
    recipe: StackRecipe,
    config: ComposeEnvironmentConfig,
  ): string | null {
    // Only `setupSteps` execute in this slice (`teardownSteps` are deferred — `down -v` is the
    // teardown), so gating on a teardown-only host-command would demand the opt-in for a step that
    // never runs. Add `teardownSteps` back here when their execution lands.
    if (!(recipe.setupSteps ?? []).some((s) => s.kind === 'host-command')) return null
    if (!config.allowHostCommands) {
      return "This recipe declares host-command step(s), but this workspace's compose handler has not enabled them (set 'Allow host commands')."
    }
    if (!this.runtime.hostCommand) {
      return 'This recipe declares host-command step(s), but the runtime cannot run host commands.'
    }
    return null
  }

  /** Best-effort per-step provisioning-log entry (never throws; no-op when no recorder is wired). */
  private async logStep(
    record: RecipeStepRecorder | undefined,
    name: string,
    startedAt: number,
    result: { ok: boolean; detail?: string; error?: string },
  ): Promise<void> {
    if (!record) return
    try {
      await record({
        name,
        outcome: result.ok ? 'success' : 'failure',
        durationMs: Date.now() - startedAt,
        ...(result.detail ? { detail: result.detail } : {}),
        ...(result.error ? { error: result.error } : {}),
      })
    } catch {
      // best-effort: a log-write failure must never break the provision.
    }
  }
}
