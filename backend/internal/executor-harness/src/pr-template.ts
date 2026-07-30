import { readdir, readFile, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { fencedOutput } from './captured-command.js'
import type { RepoSpec } from './job.js'
import type { Logger } from './logger.js'
import { MAX_PR_BODY_CHARS, PR_DESCRIPTION_FILE } from './pr-description.js'

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
// writes is model-authored text on the way OUT either way. What it DOES change on the way out is
// the title heuristic: the headings are now the repo's, so the caller reads the sentinel with
// `titleFromHeading: false` (see `ReadPrDescriptionOptions`).
// ---------------------------------------------------------------------------

/** The VCS providers a repo can live on. Bound to `RepoSpec` so the two cannot drift. */
type ProviderName = NonNullable<RepoSpec['provider']>

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
  /**
   * The template's size. ALWAYS the real one, including when {@link text} is absent: an over-budget
   * template reporting `chars: 0` would read in the log exactly like an empty file, which is the
   * one thing discovery treats as "no template at all".
   */
  chars: number
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

/** What {@link resolvePrTemplateNote} tells the run about the templates it found. */
export interface PrTemplateResolution {
  /** The prompt note, or absent when no target ships a template (which is most repos). */
  note?: string
  /**
   * The `repoDir`s whose briefing is a FILLED TEMPLATE. The push phase reads those sentinels with
   * `titleFromHeading: false`, because the headings in them are the repo's — see
   * `ReadPrDescriptionOptions.titleFromHeading`. A SET keyed by directory rather than a boolean
   * because a multi-repo run's legs need not all ship a template.
   */
  templated: ReadonlySet<string>
}

/** Why a discovered template was named rather than inlined — the two are not the same fix. */
type NotInlinedReason = 'over-file-budget' | 'over-shared-budget'

/**
 * THE entry point: find each target's pull-request template and build the prompt note that asks
 * the agent to fill it, plus the set of checkouts whose sentinel will therefore hold a filled
 * template rather than a free-form briefing (see {@link PrTemplateResolution}).
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
}): Promise<PrTemplateResolution> {
  const { targets, logger } = args
  const notes: string[] = []
  const templated = new Set<string>()
  let inlineBudget = MAX_TOTAL_INLINE_PR_TEMPLATE_CHARS
  for (const target of targets) {
    const found = await discoverPrTemplate(target.repoDir, target.provider)
    if (!found) continue
    // Spend the shared budget in leg order; a template that no longer fits is named, not cut. The
    // per-file budget was already spent inside discovery, so an absent `text` means THAT ceiling —
    // distinguished in the log because the two want different fixes (a smaller template vs a
    // workspace carrying more template text than one prompt should hold).
    const text = found.text
    const inline = text !== undefined && text.length <= inlineBudget
    if (inline) inlineBudget -= text.length
    const reason: NotInlinedReason | undefined = inline
      ? undefined
      : text === undefined
        ? 'over-file-budget'
        : 'over-shared-budget'
    logger.info('pr template: found', {
      path: found.path,
      chars: found.chars,
      inlined: inline,
      ...(reason ? { reason } : {}),
      ...(target.repoLabel ? { repo: target.repoLabel } : {}),
    })
    templated.add(target.repoDir)
    notes.push(
      buildPrTemplateNote(
        inline ? found : { path: found.path, chars: found.chars },
        target.repoLabel,
      ),
    )
  }
  return { ...(notes.length > 0 ? { note: notes.join('\n\n') } : {}), templated }
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
    const text = await readTemplate(join(repoDir, location.dir, name), repoDir)
    // An empty (or unreadable) file imposes no structure, so keep probing: a repo can carry a
    // placeholder at one location and its real template at another.
    if (!text) continue
    const chars = text.length
    return chars <= MAX_INLINE_PR_TEMPLATE_CHARS ? { path, chars, text } : { path, chars }
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

/**
 * The template's text, or undefined when it is unreadable or carries nothing.
 *
 * A checkout is REPO-AUTHORED, symlinks included, and this is the one read the harness performs on
 * a repo-chosen path without the agent asking for it — so the resolved target must stay inside
 * `repoDir`. A link out of the tree would inline an arbitrary container file (the run's own env,
 * a sibling checkout) into the prompt, and from there into a body only `redactSecrets` stands in
 * front of. Containment rather than a blanket symlink refusal, because a monorepo pointing
 * `.github/PULL_REQUEST_TEMPLATE.md` at a doc it keeps elsewhere in the repo is a real and
 * legitimate layout.
 */
async function readTemplate(path: string, repoDir: string): Promise<string | undefined> {
  try {
    // Both sides resolved, so the comparison is between two canonical paths — `repoDir` itself is
    // routinely reached through a symlinked temp dir (macOS `/tmp`), which a raw prefix test on the
    // unresolved root would read as an escape.
    const [target, root] = await Promise.all([realpath(path), realpath(repoDir)])
    if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) {
      return undefined
    }
    return (await readFile(target, 'utf8')).trim() || undefined
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
 * The template is delimited with `fencedOutput`, the same helper every other captured-text-into-a-
 * prompt path uses. Templates routinely carry fenced blocks of their own, and a fixed three-tick
 * wrapper closes on the first of them — spilling the rest of the template, and the instructions
 * after it, into the prompt as prose. `fencedOutput` sizes the fence one tick longer than the
 * longest run in the body, which is what CommonMark specifies for exactly this, so no template can
 * break out of its own block. A plain `--- BEGIN/END ---` rule would read more nicely and is
 * trivially forgeable by the template's own content, which is the whole thing being defended.
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
    'secrets, and no issue/PR numbers, @-mentions, or issue-closing wording. Do NOT put a title ' +
    "line above the template — the platform titles this pull request itself, so the template's " +
    'own first heading stays the first line of the file. Keep the finished file under ' +
    `${MAX_PR_BODY_CHARS.toLocaleString('en-US')} characters: the platform truncates a longer ` +
    "body, which would cut the template's last sections."
  if (template.text === undefined) {
    // Reached both when the file alone exceeds the inline budget and when a multi-repo run's
    // earlier legs spent the shared one, so the wording states the size and stays true of both.
    return (
      `${lead} ${instructions} The template (${template.chars} characters) is not reproduced ` +
      'here — read it from the checkout.'
    )
  }
  return `${lead} ${instructions}\n\nThe template follows, in a fenced block that is NOT part of it:\n${fencedOutput(template.text)}`
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
