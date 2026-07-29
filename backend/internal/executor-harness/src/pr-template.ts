import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from './logger.js'
import { PR_DESCRIPTION_FILE } from './pr-description.js'

// ---------------------------------------------------------------------------
// THE REPOSITORY'S OWN PULL-REQUEST TEMPLATE.
//
// A repo that ships `.github/PULL_REQUEST_TEMPLATE.md` (or GitLab's
// `.gitlab/merge_request_templates/Default.md`) is stating the shape every pull request against
// it must take — the sections its reviewers read, the checklist its process requires. A platform
// that opens PRs there and ignores that is a bad citizen: its pull requests are the only ones on
// the repo missing the structure everyone else follows.
//
// The trap this module exists for is that the template is NOT applied for us. Both hosts
// interpolate the template only into the WEB form a human opens; a PR created through the REST
// API gets exactly the body the caller sends. So nothing anywhere fails or warns — the platform's
// pull requests simply, quietly, don't follow the repo's own convention.
//
// The template is FILLED IN BY THE AGENT, not by the platform. Mechanically stuffing the
// briefing under the first heading would produce a document with the template's shape and none
// of its meaning: the sections are questions ("what is the risk?", "how was this tested?") that
// only whoever did the work can answer. So the harness discovers the template and hands it to the
// agent that just did the work, in the same prompt that already asks it for a briefing — and the
// agent answers the template's questions instead of writing a free-form one. Zero extra model
// calls, and the answers come from the run's full context rather than a summary of it.
//
// Discovery is HARNESS-side, deliberately, and reads from the checkout on disk. The backend could
// instead resolve the template through the `RepoFiles` port at dispatch, but that is an HTTP round
// trip per dispatch to answer a question the container can answer for free — and every dispatch
// that opens a pull request has a checkout by definition.
//
// The filled text goes back out through `readPrDescription`, so it crosses `redactSecrets` and
// `host-markdown.ts` on the way to the PR exactly as a free-form briefing does. Nothing here
// widens that boundary: a template is repo-committed text on the way IN, and what the agent
// writes is model-authored text on the way OUT either way.
// ---------------------------------------------------------------------------

/** The VCS providers a repo can live on (mirrors `RepoSpec.provider`). */
type ProviderName = 'github' | 'gitlab'

/**
 * How much template text is inlined into the agent's prompt.
 *
 * Over this, the template is NAMED rather than inlined and the agent is told to read it from the
 * checkout — which it can, because the file is on disk. That is strictly better than the
 * alternatives: truncating a template would have the agent fill a structure whose tail it never
 * saw (silently dropping the repo's last sections), and skipping it entirely would abandon the
 * feature on exactly the repos with the most demanding process.
 */
export const MAX_INLINE_PR_TEMPLATE_CHARS = 8_000

/**
 * The shared inline budget across a multi-repo run's legs. Each repo's template competes for it in
 * leg order, and a leg that does not fit is NAMED rather than inlined (as above) — so a workspace
 * of four template-carrying repos cannot quietly consume 32k of the agent's prompt.
 */
export const MAX_TOTAL_INLINE_PR_TEMPLATE_CHARS = 12_000

/** Extensions a template file may carry. Both hosts also accept an extensionless file. */
const TEMPLATE_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])

/** GitHub's single-file template basename, matched case-insensitively as GitHub itself does. */
const GITHUB_TEMPLATE_STEM = 'pull_request_template'

/**
 * Where a template can live, in each host's OWN precedence order. A `stem` entry is a single file
 * in that directory; a `pick` entry is a directory of templates (see {@link chooseFromDirectory}).
 */
const GITHUB_LOCATIONS: TemplateLocation[] = [
  { dir: '.github', stem: GITHUB_TEMPLATE_STEM },
  { dir: '', stem: GITHUB_TEMPLATE_STEM },
  { dir: 'docs', stem: GITHUB_TEMPLATE_STEM },
  { dir: '.github/PULL_REQUEST_TEMPLATE', pick: true },
]

/**
 * GitLab keeps merge-request templates only in a directory — there is no root single-file
 * convention to probe, so none is invented here.
 */
const GITLAB_LOCATIONS: TemplateLocation[] = [
  { dir: '.gitlab/merge_request_templates', pick: true },
]

interface TemplateLocation {
  /** Repo-root-relative directory ('' = the root). */
  dir: string
  /** Match a single file with this basename (case-insensitive). */
  stem?: string
  /** Treat the directory as a set of templates and pick one. */
  pick?: boolean
}

/** A discovered pull-request template. */
export interface PrTemplate {
  /** Repo-root-relative path, forward-slashed (it is prose an agent reads). */
  path: string
  /** The template text. Absent ⇒ over budget, so the agent is told to read {@link path} itself. */
  text?: string
}

/** One checkout to look for a template in. */
export interface PrTemplateTarget {
  /** The repository checkout root (NOT a monorepo service subtree — a template is a repo fact). */
  repoDir: string
  provider?: ProviderName
  /** Names this repo in the note. Omit when the run has a single checkout ("this repository"). */
  repoLabel?: string
}

/**
 * THE entry point: find each target's pull-request template and build the prompt note that asks
 * the agent to fill it, or `undefined` when no target ships one (which is most repos).
 *
 * Pass NO targets for a dispatch that opens no pull request — an in-place fixer amending someone
 * else's PR, a read-only explore run. Asking such a run to fill a template would be asking for a
 * document nothing publishes.
 *
 * Never rejects: a template is an improvement to a PR body, so no failure reading one may cost a
 * run that otherwise succeeded. An unreadable or empty template is simply no template.
 */
export async function resolvePrTemplateNote(args: {
  targets: PrTemplateTarget[]
  logger: Logger
}): Promise<string | undefined> {
  const { targets, logger } = args
  const notes: string[] = []
  let inlineBudget = MAX_TOTAL_INLINE_PR_TEMPLATE_CHARS
  for (const target of targets) {
    const found = await discoverPrTemplate(target.repoDir, target.provider)
    if (!found) continue
    // Spend the shared budget in leg order; a template that no longer fits is named, not cut.
    const inline = found.text !== undefined && found.text.length <= inlineBudget
    if (inline) inlineBudget -= found.text!.length
    logger.info('pr template: found', {
      path: found.path,
      chars: found.text?.length ?? 0,
      inlined: inline,
      ...(target.repoLabel ? { repo: target.repoLabel } : {}),
    })
    notes.push(buildPrTemplateNote(inline ? found : { path: found.path }, target.repoLabel))
  }
  return notes.length > 0 ? notes.join('\n\n') : undefined
}

/**
 * Locate the template in `repoDir`, probing the repo's OWN host convention first and the other
 * host's second — a repo mirrored across both, or one whose provider the dispatcher did not set,
 * still gets its template respected rather than falling to whichever list happened to be first.
 */
export async function discoverPrTemplate(
  repoDir: string,
  provider?: ProviderName,
): Promise<PrTemplate | undefined> {
  const locations =
    provider === 'gitlab'
      ? [...GITLAB_LOCATIONS, ...GITHUB_LOCATIONS]
      : [...GITHUB_LOCATIONS, ...GITLAB_LOCATIONS]
  for (const location of locations) {
    const entries = await listDirectory(join(repoDir, location.dir))
    if (entries.length === 0) continue
    const name = location.pick ? chooseFromDirectory(entries) : chooseSingleFile(entries, location)
    if (!name) continue
    const path = location.dir ? `${location.dir}/${name}` : name
    const text = await readTemplate(join(repoDir, location.dir, name))
    // An empty (or unreadable) file imposes no structure, so keep probing: a repo can carry a
    // placeholder at one location and its real template at another.
    if (text) return text.length <= MAX_INLINE_PR_TEMPLATE_CHARS ? { path, text } : { path }
  }
  return undefined
}

/** Directory entries with their kind, or `[]` for a directory that is absent or unreadable. */
async function listDirectory(path: string): Promise<{ name: string; directory: boolean }[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    // Sorted so a repo carrying several matches always yields the SAME one: readdir order is
    // filesystem-defined, and a PR body that changed shape between two runs of the same repo
    // would be a genuinely baffling thing to debug.
    return entries
      .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/**
 * The single-file match. Case-insensitive on both the stem and the extension, and extensionless
 * is allowed because both hosts accept it — which is why the DIRECTORY check matters here:
 * `.github/PULL_REQUEST_TEMPLATE/` is itself an extensionless match for the stem, and reading a
 * directory as a template would produce nothing but a swallowed EISDIR.
 */
function chooseSingleFile(
  entries: { name: string; directory: boolean }[],
  location: TemplateLocation,
): string | undefined {
  return entries.find((entry) => {
    if (entry.directory) return false
    const { stem, extension } = splitName(entry.name)
    return stem === location.stem && (extension === '' || TEMPLATE_EXTENSIONS.has(extension))
  })?.name
}

/**
 * Pick from a directory of templates — GitHub's `.github/PULL_REQUEST_TEMPLATE/`, GitLab's
 * `.gitlab/merge_request_templates/`.
 *
 * A `default` template wins (GitLab applies `Default.md` by itself, so it is unambiguously the
 * one meant for a PR that names none). Failing that, a lone template is taken: a repo with
 * exactly one has expressed exactly one convention.
 *
 * SEVERAL templates with no default yields NOTHING, deliberately. That directory exists so a
 * HUMAN can choose per pull request — "bug report" vs "release" vs "RFC" — and the choice is
 * usually not inferable from a diff. Picking one arbitrarily would file every run's work under
 * whichever name sorts first, which is worse than the free-form briefing: it looks like a
 * deliberate categorisation and is not.
 */
function chooseFromDirectory(entries: { name: string; directory: boolean }[]): string | undefined {
  const usable = entries.filter(
    (entry) => !entry.directory && TEMPLATE_EXTENSIONS.has(splitName(entry.name).extension),
  )
  const fallback = usable.find((entry) => splitName(entry.name).stem === 'default')
  if (fallback) return fallback.name
  return usable.length === 1 ? usable[0]!.name : undefined
}

/** Lower-cased stem + extension ('' when the name carries none). */
function splitName(name: string): { stem: string; extension: string } {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return { stem: lower, extension: '' }
  return { stem: lower.slice(0, dot), extension: lower.slice(dot) }
}

/** The template's text, or undefined when it is unreadable or carries nothing. */
async function readTemplate(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, 'utf8')).trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * The prompt note. It has to do more than show the template, because the agent has already been
 * told (by the backend-composed `PR_DESCRIPTION_GUIDANCE`) to write a free-form briefing, and the
 * two genuinely conflict: a template that asks for a test plan or a checklist is asking for
 * exactly the "restated diff" that guidance rules out. So the note states which wins, and states
 * why the template is not already applied — an agent that believes the host will merge the
 * template with its text has no reason to reproduce the structure itself.
 *
 * The template is delimited with plain text rules rather than a code fence: templates routinely
 * contain fenced blocks of their own, which would close the wrapper early and spill the rest of
 * the template — and the instructions after it — into the prompt as prose.
 */
export function buildPrTemplateNote(template: PrTemplate, repoLabel?: string): string {
  const subject = repoLabel ? `The \`${repoLabel}\` repository` : 'This repository'
  const lead =
    `PULL REQUEST TEMPLATE — ${subject} ships a pull request template at \`${template.path}\` ` +
    '(relative to the repository root). The platform opens the pull request through the host API, ' +
    'and neither GitHub nor GitLab applies a template to an API-created pull request — that only ' +
    'happens for a human opening one in the web form. So following it is on you.'
  const instructions =
    `Write \`${PR_DESCRIPTION_FILE}\` as that template, FILLED IN${
      repoLabel ? ` (in the \`${repoLabel}\` checkout)` : ''
    }: keep its headings, their order, and any structure it defines; answer every section from ` +
    'the work you actually did; delete its instructional HTML comments and any placeholder text; ' +
    'and complete checklists honestly, ticking only what is true. Leave a section that genuinely ' +
    'does not apply in place with a brief "n/a" and why, rather than deleting the heading — a ' +
    'reviewer looking for it needs to see it was considered. Where the template asks for ' +
    'something the general description guidance does not, the TEMPLATE wins; where it leaves room ' +
    'for prose, brief it as that guidance describes. The platform rules still hold either way: no ' +
    'secrets, and no issue/PR numbers, @-mentions, or issue-closing wording.'
  if (template.text === undefined) {
    return `${lead} ${instructions} The template is too large to reproduce here — read it from the checkout.`
  }
  return `${lead} ${instructions}\n\nThe template follows, between markers that are NOT part of it:\n--- BEGIN PULL REQUEST TEMPLATE ---\n${template.text}\n--- END PULL REQUEST TEMPLATE ---`
}

/**
 * Fold the note into a prompt. The sibling of `withDependencyNote`, and deliberately not inlined
 * for the same reason: it rides EVERY agent pass, including the validation and reproduction
 * REPAIR passes. Those start a fresh agent that still carries the description guidance in its
 * system prompt, so one that is not also told about the template would rewrite the briefing
 * free-form and undo the filled template the first pass produced.
 */
export function withPrTemplateNote(userPrompt: string, note: string | undefined): string {
  return note ? `${userPrompt}\n\n${note}` : userPrompt
}
