import {
  type AgentRunContext,
  type ContextReferenceRef,
  type HarnessKind,
  assertContextReferencesFit,
  CONTEXT_BUDGET,
  originHeaderLine,
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

/**
 * Materialise the block's linked context (docs + tracker issues) into files the harness
 * writes under CONTEXT_DIR in the checkout, so a container agent reads them on demand.
 * Each file is prefixed with its title and, where the document HAS an origin page, its source URL
 * (the zero-cost slice of Anthropic's contextual-retrieval). An uploaded document has none, and
 * says so by carrying no header line rather than an empty one.
 *
 * Bounded by {@link CONTEXT_BUDGET.maxContextFileBytes} so a large corpus can't bloat the job
 * body — and a corpus that does not fit REFUSES the dispatch
 * ({@link assertContextReferencesFit}) rather than materialising a prefix of it. The overflow
 * items used to be dropped, which kept the prompt index honest about what was on disk but left
 * nobody able to tell that a document the task points at never reached the agent. A `preflight`
 * rejection naming what did not fit is the only disposition that lets the human make the call
 * (~256 KB of attached context is far past where trimming is a judgement someone should make
 * deliberately).
 */
export function buildContextFiles(context: AgentRunContext): {
  files: { path: string; title: string; url: string; content: string }[]
} {
  const { contextDocs, contextTasks } = context.block
  const files: { path: string; title: string; url: string; content: string }[] = []
  if (!contextDocs?.length && !contextTasks?.length) return { files }
  const used = new Set<string>()
  const omitted: ContextReferenceRef[] = []
  let bytes = 0
  let totalBytes = 0
  // Write the file when it fits the byte budget; anything past it is recorded so the refusal
  // below can name it (and size the whole corpus against the budget in the same pass).
  const fit = (title: string, url: string, baseName: string, raw: string): void => {
    const content = `# ${title}\n${originHeaderLine(url)}\n${raw}`
    const size = new TextEncoder().encode(content).length
    totalBytes += size
    if (bytes + size > CONTEXT_BUDGET.maxContextFileBytes) {
      omitted.push({ title, url })
      return
    }
    bytes += size
    files.push({ path: contextFileName(baseName, used), title, url, content })
  }
  for (const doc of contextDocs ?? []) fit(doc.title, doc.url, doc.title, doc.body || doc.excerpt)
  for (const task of contextTasks ?? [])
    fit(`[${task.key}] ${task.title}`, task.url, task.key, renderTaskContext(task))
  assertContextReferencesFit(omitted, {
    totalBytes,
    budgetBytes: CONTEXT_BUDGET.maxContextFileBytes,
  })
  return { files }
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
