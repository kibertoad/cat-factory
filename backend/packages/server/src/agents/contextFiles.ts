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

/** One entry of the top-level `skills` job-body field the harness materialises (harness-aware). */
export interface SkillJobBody {
  name: string
  description: string
  instructions: string
  /** Sibling resource files, keyed by their path within the skill dir (only those with a body). */
  resources: { relPath: string; content: string }[]
}

/**
 * Render the dispatch's resolved skills for the running harness — a step's picked skill and/or
 * the skills the running agent KIND declared. The payload always travels as the dedicated
 * top-level `skills` job-body field (NEVER a context file — the agent-context snapshot copies
 * context files verbatim, whereas an unknown top-level field is omitted by its allow-list). The
 * harness materialises them HARNESS-AWARE from that field: `CLAUDE_CONFIG_DIR/skills/<name>/`
 * natively for claude-code (the CLI loads and INVOKES them on its own judgement), or
 * `.cat-context/skill/<name>/<relPath>` for Pi/codex (which read the checkout).
 *
 * Only the PROMPT differs: a NATIVE install gets a short pointer (the instructions live in the
 * installed SKILL.md, so they are not duplicated into the prompt), while every checkout-reading
 * case gets the full instructions folded in plus a pointer to the materialised resources. A
 * resource whose body couldn't be fetched (oversized / binary / unreadable) is referenced by its
 * repo path in the prompt rather than materialised. No skills ⇒ everything empty.
 *
 * `ambientAuth` decides this as much as the harness does. An ambient claude-code run has no
 * isolated `CLAUDE_CONFIG_DIR` to install into, and the harness REFUSES to write a skill into the
 * developer's own `~/.claude` (it would outlive the run, and two concurrent native jobs carrying
 * same-named skills would clobber each other), so it reads the checkout exactly like codex.
 * Rendering such a run the native way would point the agent at a skill that was never installed,
 * with its instructions nowhere in the prompt.
 */
export function renderSkillsForHarness(
  skills: AgentRunContext['skills'],
  harness: HarnessKind,
  ambientAuth = false,
): { body?: SkillJobBody[]; section?: string } {
  if (!skills?.length) return {}
  const native = harness === 'claude-code' && !ambientAuth
  const body = skills.map(toSkillJobBody)
  const sections = skills.map((skill) => renderSkillSection(skill, native))
  return {
    body,
    section:
      skills.length === 1
        ? sections[0]!
        : // Numbered when several apply, so the agent reads them as a set of playbooks to
          // combine rather than as one run-on instruction block whose parts blur together.
          [
            'Apply these skills to this task, all of them:',
            ...sections.map((s, i) => `${i + 1}. ${s}`),
          ].join('\n\n'),
  }
}

function toSkillJobBody(skill: NonNullable<AgentRunContext['skills']>[number]): SkillJobBody {
  return {
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    resources: skill.resources
      .filter(
        (r): r is { path: string; relPath: string; body: string } => typeof r.body === 'string',
      )
      .map((r) => ({ relPath: r.relPath, content: r.body })),
  }
}

/** The prompt directive for ONE skill — a pointer when natively installed, the full text otherwise. */
function renderSkillSection(
  skill: NonNullable<AgentRunContext['skills']>[number],
  native: boolean,
): string {
  const withBody = skill.resources.filter((r) => typeof r.body === 'string')
  const withoutBody = skill.resources.filter((r) => typeof r.body !== 'string')
  const missingNote = withoutBody.length
    ? ` Some resources were too large or binary to include — read them from the repo if you need them: ${withoutBody
        .map((r) => r.path)
        .join(', ')}.`
    : ''
  if (native) {
    return (
      `Apply the "${skill.name}" skill, installed for this step as a Claude skill (its SKILL.md ` +
      `and resource files are available to you). Follow it precisely.${missingNote}`
    )
  }
  // Pi / codex / AMBIENT claude-code: fold the instructions into the prompt; the harness
  // materialises the resources under `.cat-context/skill/<name>/` (see the harness `skills`
  // handling), which the prompt points at.
  const resourceNote = withBody.length
    ? ` The skill's resource files are available under \`.cat-context/skill/${skill.name}/\`: ${withBody
        .map((r) => r.relPath)
        .join(', ')}.`
    : ''
  return (
    `Apply the following skill "${skill.name}" to this task — follow its steps and honour its ` +
    `constraints:\n\n${skill.instructions}\n${resourceNote}${missingNote}`
  )
}
