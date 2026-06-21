import {
  type AgentJobHandle,
  type AgentJobUpdate,
  type AgentRunContext,
  type AgentRunResult,
  type AsyncAgentExecutor,
  type ModelRef,
  type RunnerDispatchKind,
  type RunnerJobResult,
} from '@cat-factory/kernel'
import {
  type AgentRouting,
  composeBlockSystemPrompt,
  resolveStepModelRef,
  systemPromptFor,
  userPromptFor,
  webResearchGuidanceFor,
} from '@cat-factory/agents'
import {
  CI_FIXER_AGENT_KIND,
  CONFLICT_RESOLVER_AGENT_KIND,
  MERGER_AGENT_KIND,
  SPEC_WRITER_AGENT_KIND,
} from '@cat-factory/orchestration'
import type { ContainerSessionService } from '../containers/ContainerSessionService.js'
import { RunnerJobClient, type ResolveRunnerTransport } from './RunnerJobClient.js'

// Re-exported for the composition root + tests that wire this executor by name.
export type { ResolveRunnerTransport }

// The GitHub repo a run should be implemented against, resolved from the
// workspace's installation + connected repos (see each facade's container.ts).
export interface RepoTarget {
  installationId: number
  owner: string
  name: string
  baseBranch: string
  /**
   * For a service in a monorepo, the subdirectory (relative to the repo root) the
   * service lives in, e.g. `packages/api`. Present only when the resolved repo is
   * flagged a monorepo AND the service pins a directory; the harness then runs the
   * agent within that subtree and tells it so. Absent ⇒ whole-repo behaviour.
   */
  serviceDirectory?: string
}

export type ResolveRepoTarget = (workspaceId: string, blockId: string) => Promise<RepoTarget | null>

export type MintInstallationToken = (installationId: number) => Promise<string>

/**
 * The repo spec every container job body carries: clone coordinates plus, for a
 * monorepo service, the subdirectory the harness should run the agent within. Built
 * here once so the (six) agent-kind job bodies can't drift on which repo fields they
 * forward.
 */
function buildRepoSpec(repo: RepoTarget) {
  return {
    owner: repo.owner,
    name: repo.name,
    baseBranch: repo.baseBranch,
    cloneUrl: `https://github.com/${repo.owner}/${repo.name}.git`,
    ...(repo.serviceDirectory ? { serviceDirectory: repo.serviceDirectory } : {}),
  }
}

export interface ContainerAgentExecutorDependencies {
  /** Resolve which runner backend (Cloudflare container or self-hosted pool) a job runs on. */
  resolveTransport: ResolveRunnerTransport
  /** Default model routing; used when the block pins no (usable) model. */
  agentRouting: AgentRouting
  /** Resolve a block's selected model id to a concrete ref (direct flavour). */
  resolveBlockModel: (modelId: string | undefined) => ModelRef | undefined
  /**
   * Resolve the workspace's per-agent-kind default model id, consulted when the
   * block pins no model. Optional: absent → the env routing for the kind is used.
   */
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
  ) => Promise<string | undefined>
  /** Resolve which repo (and installation) a run targets. */
  resolveRepoTarget: ResolveRepoTarget
  /** Mint a short-lived GitHub installation token for cloning + opening the PR. */
  mintInstallationToken: MintInstallationToken
  /** Mints the signed LLM-proxy session token the container uses. */
  sessionService: ContainerSessionService
  /**
   * Public base URL of the facade's OpenAI-compatible LLM proxy, including the
   * `/v1` suffix — Pi posts to `${proxyBaseUrl}/chat/completions`.
   */
  proxyBaseUrl: string
  /** GitHub REST base for opening the PR (GitHub Enterprise / api.github.com). */
  githubApiBase?: string
  /**
   * Whether the facade wired a container web-search upstream (the `/v1/web-search`
   * proxy). When true, coding/ci-fixer jobs are told to point Pi's `web_search` tool
   * at `${proxyBaseUrl}/web-search` with their session token — so no provider key
   * reaches the sandbox. Off ⇒ container web search stays disabled.
   */
  webSearchProxyEnabled?: boolean
}

/** Poll cadence for the non-durable `run()` fallback (the durable driver sleeps between polls itself). */
const RUN_POLL_INTERVAL_MS = 5_000

/** Role prompt the Blueprinter step's agent runs under (returns the tree as JSON). */
const BLUEPRINT_SYSTEM_PROMPT =
  'You are a software architect mapping this repository. Decompose it into ONE ' +
  'top-level service and the modules inside it. ' +
  'Anchor every node to the codebase with explicit repo-relative file/directory ' +
  'references. Keep names short and descriptive; group by domain, not by file type. ' +
  'Respond with ONLY a JSON object of shape {"type","name","summary","references":[],' +
  '"modules":[{"name","summary","references":[]}]} — no prose, no code fences.'

/** Role prompt the spec-writer step runs under (returns the spec doc as JSON). */
const SPEC_WRITER_SYSTEM_PROMPT =
  'You are a requirements analyst producing the unified, PRESCRIPTIVE specification ' +
  'for a service. You are given the collected requirements of every task on the ' +
  'service plus any existing specification. Fold them into ONE de-duplicated spec: ' +
  'functional/nonfunctional/constraint requirements grouped by capability, each ' +
  'phrased as "The system SHALL …" with a MoSCoW priority (must/should/could) and ' +
  'structured Given/When/Then acceptance criteria, plus cross-cutting domain rules / ' +
  'invariants. Acceptance-scenario coverage is a FIRST-CLASS deliverable, not an ' +
  'afterthought: every requirement MUST carry complete acceptance criteria — the ' +
  'happy path AND the invalid-input / error / edge / boundary cases — since the ' +
  'Gherkin `.feature` files and the runnable tests are derived mechanically from ' +
  'them. Preserve provenance in `sourceBlockIds`. Respond with ONLY a JSON object of ' +
  'shape {"service","summary","groups":[{"name","summary","requirements":[{"id",' +
  '"title","statement","kind","priority","sourceBlockIds":[],"acceptance":[{"id",' +
  '"given","when","outcome"}]}]}],"rules":[{"id","rule","rationale","sourceBlockIds":[]}]} ' +
  '(each acceptance criterion is a Given/When/Then, with the Then clause in `outcome`) — ' +
  'no prose, no code fences.'

/** Role prompt the `merger` step runs under (scores the PR; returns JSON only). */
const MERGER_SYSTEM_PROMPT =
  'You are a release manager assessing a pull request before merge. Inspect the ' +
  'diff between the PR head branch and the base branch and judge three axes, each ' +
  'as a number from 0 (trivial/safe) to 1 (severe): complexity (how intricate the ' +
  'change is), risk (how likely it is to break something), and impact (blast radius ' +
  'if it does). Be conservative. Respond with ONLY a JSON object of shape ' +
  '{"complexity":0.0,"risk":0.0,"impact":0.0,"rationale":"…"} — no prose, no code fences.'

/**
 * An {@link AgentExecutor} that performs implementation work in a real sandbox:
 * it dispatches a per-run container running the Pi coding agent (a per-run
 * Cloudflare Container, or an org's self-hosted runner pool), feeds it the block's
 * composed prompt fragments as context, and has it clone the repo, implement the
 * block, push a branch and open a PR.
 *
 * Secrets never reach the container image. Provider keys stay in the backend; the
 * container reaches models only through the facade's LLM proxy using a
 * short-lived, model-locked session token, and clones/pushes with a short-lived
 * GitHub installation token — both handed over per job. Token usage is metered
 * by the proxy (the single metering point), so this executor reports no `usage`
 * to avoid double-counting in the execution engine.
 */
export class ContainerAgentExecutor implements AsyncAgentExecutor {
  /** Shared backend-polymorphic dispatch/poll/release plumbing (see RunnerJobClient). */
  private readonly jobs: RunnerJobClient

  constructor(private readonly deps: ContainerAgentExecutorDependencies) {
    this.jobs = new RunnerJobClient(deps.resolveTransport)
  }

  /** Repo-operating steps always run as polled async jobs (the coding can be long). */
  runsAsync(_context: AgentRunContext): boolean {
    return true
  }

  /**
   * Dispatch the implementation job to this run's container and return a handle.
   * Returns as soon as the job is accepted — the work continues in the container,
   * polled via {@link pollJob}. Idempotent: the harness re-attaches to a job
   * already running for `executionId`, so a replayed dispatch never duplicates work.
   */
  async startJob(context: AgentRunContext): Promise<AgentJobHandle> {
    const { workspaceId, executionId } = this.requireIds(context)
    const { body, model, kind } = await this.buildJobBody(context)
    await this.jobs.dispatch(workspaceId, executionId, body, kind)
    // Carry the workspace on the handle so the poll site can resolve the same
    // backend (Cloudflare container vs. self-hosted pool) given only the job id.
    return { jobId: executionId, model, workspaceId }
  }

  /** Poll a dispatched job for its state, mapping the runner view into an update. */
  async pollJob(handle: AgentJobHandle): Promise<AgentJobUpdate> {
    const view = await this.jobs.poll(handle.workspaceId, handle.jobId)
    if (view.state === 'running') {
      // Forward the latest subtask counts (if any) so the engine can surface
      // live "N/M done" progress on the step; the shapes match field-for-field.
      return view.progress ? { state: 'running', subtasks: view.progress } : { state: 'running' }
    }
    if (view.state === 'failed') {
      return { state: 'failed', error: view.error ?? 'Implementation job failed' }
    }
    // Completed: a structured `error` (e.g. "no file changes") is still a failure.
    const result = view.result ?? {}
    if (result.error) return { state: 'failed', error: `Implementation failed: ${result.error}` }
    return { state: 'done', result: toRunResult(result) }
  }

  /**
   * Stop a running job and reclaim its backing runner: resolve the same transport
   * the job dispatched to (by workspace) and `release` it — for the Cloudflare
   * backend this SIGKILLs the per-run container instead of letting it idle out.
   * Best-effort/idempotent: a transport without `release`, or an already-gone job,
   * is a no-op.
   */
  async stopJob(handle: AgentJobHandle): Promise<void> {
    await this.jobs.release(handle.workspaceId, handle.jobId)
  }

  /**
   * Synchronous convenience for non-durable callers (and tests): dispatch then
   * poll inline until the job finishes. The durable driver does not use this — it
   * calls {@link startJob}/{@link pollJob} so it can sleep durably between polls.
   */
  async run(context: AgentRunContext): Promise<AgentRunResult> {
    const handle = await this.startJob(context)
    for (;;) {
      const update = await this.pollJob(handle)
      if (update.state === 'done') {
        // The poll site can't resolve the model ref, so fold in the label the
        // dispatch captured (matches what the durable path records on the step).
        return { ...update.result, ...(handle.model ? { model: handle.model } : {}) }
      }
      if (update.state === 'failed') throw new Error(update.error)
      await new Promise((resolve) => setTimeout(resolve, RUN_POLL_INTERVAL_MS))
    }
  }

  /**
   * Resolve the step's model ref with the shared step precedence (block pin >
   * workspace per-kind default > env routing). Side-effect-free and dispatch-free,
   * so it backs both the up-front `resolveModel` preview and `buildJobBody`.
   */
  private resolveRef(context: AgentRunContext): Promise<ModelRef> {
    return resolveStepModelRef(
      {
        agentRouting: this.deps.agentRouting,
        resolveBlockModel: this.deps.resolveBlockModel,
        resolveWorkspaceModelDefault: this.deps.resolveWorkspaceModelDefault,
      },
      {
        agentKind: context.agentKind,
        blockModelId: context.block.modelId,
        workspaceId: context.workspaceId,
      },
    )
  }

  /**
   * Preview the model this job will run, without dispatching the container. The
   * proxyable-provider guard is deliberately left to `buildJobBody` (the dispatch
   * path) so an unservable model still fails loudly there; this only names it.
   */
  async resolveModel(context: AgentRunContext): Promise<string> {
    const ref = await this.resolveRef(context)
    return `${ref.provider}:${ref.model}`
  }

  /** Validate the ids every container job needs, narrowing them to non-empty strings. */
  private requireIds(context: AgentRunContext): {
    workspaceId: string
    executionId: string
    blockId: string
  } {
    const { workspaceId, executionId } = context
    const blockId = context.block.id
    if (!workspaceId || !executionId || !blockId) {
      throw new Error('ContainerAgentExecutor requires workspaceId, executionId and block.id')
    }
    return { workspaceId, executionId, blockId }
  }

  /** Resolve tokens/prompts/target and assemble the harness job body for `context`. */
  private async buildJobBody(
    context: AgentRunContext,
  ): Promise<{ body: Record<string, unknown>; model: string; kind: RunnerDispatchKind }> {
    const { workspaceId, executionId, blockId } = this.requireIds(context)

    // Lock the model to a provider the proxy can serve — either a direct
    // OpenAI-compatible provider or Cloudflare Workers AI (served in-Worker via
    // the AI binding) — and locking it here stops the container choosing another.
    const ref = await this.resolveRef(context)
    if (!isProxyableProvider(ref.provider)) {
      throw new Error(
        `Container implementation needs a model the LLM proxy can serve ` +
          `(Workers AI, or a direct OpenAI-compatible provider); ` +
          `'${ref.provider}' is not supported. Pick a Workers AI model, or configure a ` +
          `provider key (QWEN_API_KEY / DEEPSEEK_API_KEY / MOONSHOT_API_KEY) and pick that model.`,
      )
    }

    const repo = await this.deps.resolveRepoTarget(workspaceId, blockId)
    if (!repo) {
      throw new Error(`No connected GitHub repository found for workspace '${workspaceId}'`)
    }

    const ghToken = await this.deps.mintInstallationToken(repo.installationId)
    const sessionToken = await this.deps.sessionService.mint({
      workspaceId,
      executionId,
      agentKind: context.agentKind,
      provider: ref.provider,
      model: ref.model,
    })

    // The Blueprinter step commits the regenerated `blueprints/` folder onto an
    // existing branch (the earlier `coder` step's PR branch when present, else the
    // repo's default branch) — never a fresh branch / new PR. Its body targets the
    // harness `/blueprint` endpoint and returns the decomposition tree.
    if (context.agentKind === 'blueprints') {
      const branch = context.block.pullRequest?.branch ?? repo.baseBranch
      const body = {
        jobId: executionId,
        systemPrompt: BLUEPRINT_SYSTEM_PROMPT,
        instructions:
          'Map (or update) this repository into the canonical service → modules ' +
          'blueprint, anchored to real file/directory references.',
        model: ref.model,
        proxyBaseUrl: this.deps.proxyBaseUrl,
        sessionToken,
        ghToken,
        repo: buildRepoSpec(repo),
        branch,
        mode: context.block.pullRequest?.branch ? 'update' : 'create',
        ...(this.deps.githubApiBase ? { githubApiBase: this.deps.githubApiBase } : {}),
      }
      return { body, model: `${ref.provider}:${ref.model}`, kind: 'blueprint' }
    }

    // The spec-writer commits the regenerated `spec/` folder onto the implementation
    // branch — the earlier `coder` step's PR branch when present, else the
    // deterministic `cat-factory/<blockId>` the coder WILL resume (created from base if
    // absent). It NEVER targets the base branch: the spec is a prescriptive document
    // for not-yet-landed work, so — like the feature-time blueprint — it must merge
    // together WITH the feature, never reach `main` ahead of it. Its body carries the
    // combined requirements of every task under the service frame (the engine resolves
    // them) so the doc is an aggregate, not per-task. Targets the harness `/spec`
    // endpoint.
    if (context.agentKind === SPEC_WRITER_AGENT_KIND) {
      const branch = context.block.pullRequest?.branch ?? `cat-factory/${blockId}`
      const body = {
        jobId: executionId,
        systemPrompt: SPEC_WRITER_SYSTEM_PROMPT,
        instructions:
          'Produce (or update) the unified, prescriptive specification for this ' +
          'service from the combined task requirements below, with COMPLETE ' +
          'acceptance-scenario coverage per requirement.',
        model: ref.model,
        proxyBaseUrl: this.deps.proxyBaseUrl,
        sessionToken,
        ghToken,
        repo: buildRepoSpec(repo),
        branch,
        tasks: (context.serviceTasks ?? []).map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
        })),
        ...(this.deps.githubApiBase ? { githubApiBase: this.deps.githubApiBase } : {}),
      }
      return { body, model: `${ref.provider}:${ref.model}`, kind: 'spec' }
    }

    // The CI-fixer clones the PR head branch, runs the failing build/tests, fixes
    // them and pushes back to the SAME branch (no new branch / PR) so CI re-runs.
    if (context.agentKind === CI_FIXER_AGENT_KIND) {
      const branch = context.block.pullRequest?.branch
      if (!branch) {
        throw new Error('CI-fixer needs the implementation PR branch to push fixes to')
      }
      const body = {
        jobId: executionId,
        systemPrompt: composeBlockSystemPrompt(systemPromptFor(context.agentKind), context.block),
        userPrompt: userPromptFor(context),
        model: ref.model,
        proxyBaseUrl: this.deps.proxyBaseUrl,
        sessionToken,
        ghToken,
        repo: buildRepoSpec(repo),
        branch,
        webToolsGuidance: webResearchGuidanceFor(context.agentKind, { fetch: true }),
        ...(this.deps.webSearchProxyEnabled ? { webSearch: true } : {}),
        ...(this.deps.githubApiBase ? { githubApiBase: this.deps.githubApiBase } : {}),
      }
      return { body, model: `${ref.provider}:${ref.model}`, kind: 'ci-fix' }
    }

    // The conflict-resolver clones the PR head branch, merges the base in, resolves
    // the conflicts and pushes back to the SAME branch (no new branch / PR) so the
    // PR becomes mergeable and CI re-runs. Mirrors the CI-fixer's body.
    if (context.agentKind === CONFLICT_RESOLVER_AGENT_KIND) {
      const branch = context.block.pullRequest?.branch
      if (!branch) {
        throw new Error(
          'Conflict-resolver needs the implementation PR branch to resolve conflicts on',
        )
      }
      const body = {
        jobId: executionId,
        systemPrompt: composeBlockSystemPrompt(systemPromptFor(context.agentKind), context.block),
        userPrompt: userPromptFor(context),
        model: ref.model,
        proxyBaseUrl: this.deps.proxyBaseUrl,
        sessionToken,
        ghToken,
        repo: buildRepoSpec(repo),
        branch,
        ...(this.deps.githubApiBase ? { githubApiBase: this.deps.githubApiBase } : {}),
      }
      return { body, model: `${ref.provider}:${ref.model}`, kind: 'resolve-conflicts' }
    }

    // The merger clones the PR head branch to assess the diff vs base; it makes no
    // commits (the engine performs the real merge through the GitHub API on its
    // verdict). Returns ONLY a JSON assessment, mapped to `mergeAssessment`.
    if (context.agentKind === MERGER_AGENT_KIND) {
      const branch = context.block.pullRequest?.branch ?? repo.baseBranch
      const body = {
        jobId: executionId,
        systemPrompt: MERGER_SYSTEM_PROMPT,
        instructions:
          'Assess the pull request on the head branch against the base branch and ' +
          'return the complexity / risk / impact scores + rationale as JSON.',
        model: ref.model,
        proxyBaseUrl: this.deps.proxyBaseUrl,
        sessionToken,
        ghToken,
        repo: buildRepoSpec(repo),
        branch,
        ...(context.block.pullRequest?.number !== undefined
          ? { prNumber: context.block.pullRequest.number }
          : {}),
        ...(this.deps.githubApiBase ? { githubApiBase: this.deps.githubApiBase } : {}),
      }
      return { body, model: `${ref.provider}:${ref.model}`, kind: 'merge' }
    }

    // The "extra context" Pi runs with: the build-phase role plus the block's
    // selected best-practice fragments, exactly as the inline executor composes
    // (engine-resolved tenant catalog when present, else the manual ids).
    const systemPrompt = composeBlockSystemPrompt(systemPromptFor(context.agentKind), context.block)
    const userPrompt = userPromptFor(context)
    // Deterministic per task (block), NOT per dispatch: a retry mints a fresh
    // executionId but keeps the blockId, and a sweeper re-drive keeps both — so a
    // stable name means every re-dispatch of this task targets the SAME branch. The
    // harness checkpoints commits to it during the run and RESUMES on it if it
    // already exists, so an evicted/failed run's work survives and a retry continues
    // on top of it rather than starting over. (The branch is thus "preserved on the
    // task" by construction, with no extra persistence to fall out of sync.)
    const headBranch = `cat-factory/${blockId}`

    // The harness keys the background job (and the poll endpoint) on `jobId`; the
    // execution id gives an idempotent re-attach across durable-driver replays.
    const body = {
      jobId: executionId,
      systemPrompt,
      userPrompt,
      model: ref.model,
      proxyBaseUrl: this.deps.proxyBaseUrl,
      sessionToken,
      ghToken,
      repo: buildRepoSpec(repo),
      headBranch,
      pr: {
        title: `${context.block.title} (${context.pipelineName})`,
        body: prBody(context),
      },
      // Per-kind web-search nudge (coder/mocker/analysis/… and any custom container
      // kind, which resolves its own hint from the registry). The harness surfaces it
      // only when web search is configured in the container env.
      webToolsGuidance: webResearchGuidanceFor(context.agentKind, { fetch: true }),
      // Turn on the proxy-backed web tools for this run: the harness points Pi's
      // SearXNG client at `${proxyBaseUrl}/web-search` with the session token, so the
      // search runs server-side and no provider key ever reaches the sandbox.
      ...(this.deps.webSearchProxyEnabled ? { webSearch: true } : {}),
      ...(this.deps.githubApiBase ? { githubApiBase: this.deps.githubApiBase } : {}),
    }
    return { body, model: `${ref.provider}:${ref.model}`, kind: 'run' }
  }
}

/** Map a finished runner {@link RunnerJobResult} into the engine's {@link AgentRunResult}. */
function toRunResult(result: RunnerJobResult): AgentRunResult {
  // A Blueprinter job carries a decomposition tree instead of a PR; surface it so
  // the engine can strictly validate + reconcile it onto the board.
  if (result.service !== undefined) {
    return {
      output: result.summary?.trim() || 'Service blueprint updated.',
      blueprintService: result.service,
    }
  }
  // A spec-writer job carries a prescriptive specification doc instead of a PR;
  // surface it so the engine can strictly validate + persist/surface it.
  if (result.spec !== undefined) {
    return {
      output: result.summary?.trim() || 'Service specification updated.',
      spec: result.spec,
    }
  }
  // A `merger` job carries a PR assessment instead of a PR; surface it so the
  // engine can compare it to the task's thresholds and merge-or-notify.
  if (result.assessment !== undefined) {
    return {
      output: result.summary?.trim() || 'Pull request assessed.',
      mergeAssessment: result.assessment,
    }
  }
  // A `ci-fixer` job reports whether it pushed a fix. The engine's CI gate ignores
  // this result (it just re-polls CI), but map it to a sensible output regardless.
  if (result.pushed !== undefined) {
    return {
      output:
        result.summary?.trim() ||
        (result.pushed ? 'Pushed a CI fix to the PR branch.' : 'No CI fix was produced.'),
    }
  }
  // A `conflict-resolver` job reports whether the branch is now mergeable. The
  // engine's conflicts gate re-checks mergeability regardless; map to an output.
  if (result.resolved !== undefined) {
    return {
      output:
        result.summary?.trim() ||
        (result.resolved
          ? 'Resolved merge conflicts and pushed to the PR branch.'
          : 'Could not fully resolve the merge conflicts.'),
    }
  }
  const summary = result.summary?.trim() || 'Implementation complete.'
  const output = result.prUrl ? `${summary}\n\nPR: ${result.prUrl}` : summary
  // Surface the opened PR structurally (not just in the output text) so the
  // engine can record it on the block and the board can link straight to it.
  const pullRequest = result.prUrl
    ? {
        url: result.prUrl,
        ...(prNumberFromUrl(result.prUrl) !== undefined
          ? { number: prNumberFromUrl(result.prUrl) }
          : {}),
        ...(result.branch ? { branch: result.branch } : {}),
      }
    : undefined
  // No `model` here: the proxy meters tokens and the async path doesn't carry the
  // provider ref to the poll site. `usage` is likewise omitted (metered by the proxy).
  return {
    output,
    ...(pullRequest ? { pullRequest } : {}),
  }
}

/** Extract the PR number from a GitHub pull-request URL (`.../pull/42`). */
function prNumberFromUrl(url: string): number | undefined {
  const match = /\/pull\/(\d+)/.exec(url)
  if (!match) return undefined
  const n = Number(match[1])
  return Number.isFinite(n) ? n : undefined
}

/**
 * Providers the LLM proxy can serve: the direct OpenAI Chat Completions-compatible
 * upstreams it forwards to, plus `workers-ai`, which it runs in-Worker through the
 * AI binding (no provider key required).
 */
function isProxyableProvider(provider: string): boolean {
  return (
    provider === 'workers-ai' ||
    provider === 'qwen' ||
    provider === 'deepseek' ||
    provider === 'moonshot' ||
    provider === 'openai'
  )
}

function prBody(context: AgentRunContext): string {
  const lines = [
    `Automated implementation for block **${context.block.title}** (${context.block.type}).`,
    '',
    context.block.description || '(no description)',
    '',
    `Pipeline: ${context.pipelineName}`,
  ]
  return lines.join('\n')
}
