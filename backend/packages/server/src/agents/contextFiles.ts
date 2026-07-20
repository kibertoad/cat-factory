import {
  type AgentRunContext,
  type HarnessKind,
  CONTEXT_BUDGET,
  renderTaskContext,
} from '@cat-factory/kernel'

// Assemble the container agent's context payload from the run's linked inputs: the block's
// linked docs + tracker issues materialised as `.cat-context/` files (`buildContextFiles`), and
// a resolved repo-skill rendered harness-aware (`renderSkillForHarness`). Extracted from
// `ContainerAgentExecutor` as a cohesive, `this`-free seam (mirrors the sibling `jobBody.ts`
// section renderers) so the executor stays focused on dispatch/poll orchestration.

/** A safe, collision-free `<base>.md` filename for a materialised context file. */
function contextFileName(base: string, used: Set<string>): string {
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'context'
  let name = `${slug}.md`
  for (let i = 2; used.has(name); i++) name = `${slug}-${i}.md`
  used.add(name)
  return name
}

type ContextDoc = NonNullable<AgentRunContext['block']['contextDocs']>[number]
type ContextTask = NonNullable<AgentRunContext['block']['contextTasks']>[number]

/**
 * Materialise the block's linked context (docs + tracker issues) into files the harness
 * writes under CONTEXT_DIR in the checkout, so a container agent reads them on demand.
 * Each file is prefixed with its title + source URL (the zero-cost slice of Anthropic's
 * contextual-retrieval). Bounded by {@link CONTEXT_BUDGET.maxContextFileBytes} so a large
 * corpus can't bloat the job body; items past the cap are dropped.
 *
 * Returns both the files AND the docs/tasks that actually fit (`contextDocs`/`contextTasks`),
 * so the caller can render the prompt's summary index from exactly the materialised set —
 * the prompt never names a file the agent won't find on disk.
 */
export function buildContextFiles(context: AgentRunContext): {
  files: { path: string; title: string; url: string; content: string }[]
  contextDocs: ContextDoc[]
  contextTasks: ContextTask[]
} {
  const { contextDocs, contextTasks } = context.block
  const files: { path: string; title: string; url: string; content: string }[] = []
  const keptDocs: ContextDoc[] = []
  const keptTasks: ContextTask[] = []
  if (!contextDocs?.length && !contextTasks?.length)
    return { files, contextDocs: keptDocs, contextTasks: keptTasks }
  const used = new Set<string>()
  let bytes = 0
  // Write the file when it fits the byte budget; report back whether it was kept so the
  // caller can keep the prompt index in lock-step with what's on disk.
  const fit = (title: string, url: string, baseName: string, raw: string): boolean => {
    const content = `# ${title}\nSource: ${url}\n\n${raw}`
    const size = new TextEncoder().encode(content).length
    if (bytes + size > CONTEXT_BUDGET.maxContextFileBytes) return false
    bytes += size
    files.push({ path: contextFileName(baseName, used), title, url, content })
    return true
  }
  for (const doc of contextDocs ?? [])
    if (fit(doc.title, doc.url, doc.title, doc.body || doc.excerpt)) keptDocs.push(doc)
  for (const task of contextTasks ?? [])
    if (fit(`[${task.key}] ${task.title}`, task.url, task.key, renderTaskContext(task)))
      keptTasks.push(task)
  return { files, contextDocs: keptDocs, contextTasks: keptTasks }
}

/** The top-level `skill` job-body field the harness materialises (harness-aware). */
export interface SkillJobBody {
  name: string
  description: string
  instructions: string
  /** Sibling resource files, keyed by their path within the skill dir (only those with a body). */
  resources: { relPath: string; content: string }[]
}

/**
 * Render a resolved `skill` for the running harness (repo-sourced Claude Skills, slice 2). The
 * skill payload always travels as the dedicated top-level `skill` job-body field (NEVER a context
 * file — the agent-context snapshot copies context files verbatim, whereas an unknown top-level
 * field is omitted by its allow-list). The harness materialises it HARNESS-AWARE from that field:
 * `CLAUDE_CONFIG_DIR/skills/<name>/` natively for claude-code (the CLI loads it), or
 * `.cat-context/skill/<relPath>` for Pi/codex (which read the checkout).
 *
 * Only the PROMPT differs by harness: claude-code gets a short pointer (its instructions live in
 * the installed SKILL.md, so they are not duplicated into the prompt), while Pi/codex get the full
 * instructions folded in (their agents don't natively load a skill) plus a pointer to the
 * materialised resources. A resource whose body couldn't be fetched (oversized / binary /
 * unreadable) is referenced by its repo path in the prompt rather than materialised. No skill ⇒
 * everything empty.
 */
export function renderSkillForHarness(
  skill: AgentRunContext['skill'],
  harness: HarnessKind,
): { body?: SkillJobBody; section?: string } {
  if (!skill) return {}
  const withBody = skill.resources.filter(
    (r): r is { path: string; relPath: string; body: string } => typeof r.body === 'string',
  )
  const withoutBody = skill.resources.filter((r) => typeof r.body !== 'string')
  const missingNote = withoutBody.length
    ? ` Some resources were too large or binary to include — read them from the repo if you need them: ${withoutBody
        .map((r) => r.path)
        .join(', ')}.`
    : ''
  const body: SkillJobBody = {
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    resources: withBody.map((r) => ({ relPath: r.relPath, content: r.body })),
  }

  if (harness === 'claude-code') {
    return {
      body,
      section:
        `Apply the "${skill.name}" skill, installed for this step as a Claude skill (its SKILL.md ` +
        `and resource files are available to you). Follow it precisely.${missingNote}`,
    }
  }

  // Pi / codex: fold the instructions into the prompt; the harness materialises the resources
  // under `.cat-context/skill/` (see the harness `skill` handling), which the prompt points at.
  const resourceNote = withBody.length
    ? ` The skill's resource files are available under \`.cat-context/skill/\`: ${withBody
        .map((r) => r.relPath)
        .join(', ')}.`
    : ''
  return {
    body,
    section:
      `Apply the following skill "${skill.name}" to this task — follow its steps and honour its ` +
      `constraints:\n\n${skill.instructions}\n${resourceNote}${missingNote}`,
  }
}
