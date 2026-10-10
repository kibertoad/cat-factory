import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildPrTemplateNote,
  discoverPrTemplate,
  MAX_INLINE_PR_TEMPLATE_CHARS,
  MAX_TOTAL_INLINE_PR_TEMPLATE_CHARS,
  resolvePrTemplateNote,
  withPrTemplateNote,
  type PrTemplate,
} from '../src/pr-template.js'
import { PR_DESCRIPTION_FILE, readPrDescription } from '../src/pr-description.js'
import { buildSingleRepoCodingSpec } from '../src/agent.js'
import { parseAgentJob } from '../src/job.js'
import type { Logger } from '../src/logger.js'
import { silentLogger } from './helpers.js'

// The repo's own pull-request template. Neither host applies a template to an API-created pull
// request, so the harness finds it and the agent fills it. Discovery must cover both hosts'
// conventions, be case-insensitive, refuse to GUESS between several templates, and never throw —
// a template is an improvement to a PR body and may not cost a run that otherwise succeeded.

/**
 * Create a symlink, or report that this machine cannot. An unprivileged Windows account cannot,
 * and skipping beats either failing everywhere or dropping the assertion for everyone.
 */
function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path)
    return true
  } catch {
    return false
  }
}

describe('discoverPrTemplate', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pr-tmpl-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (relative: string, content = '## Why\n\n<!-- explain -->') => {
    const path = join(dir, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }

  it('returns undefined for a repo with no template', async () => {
    write('README.md', '# hi')
    expect(await discoverPrTemplate(dir)).toBeUndefined()
  })

  it('finds the canonical GitHub template', async () => {
    write('.github/PULL_REQUEST_TEMPLATE.md', '## Summary')
    expect(await discoverPrTemplate(dir, 'github')).toEqual({
      path: '.github/PULL_REQUEST_TEMPLATE.md',
      chars: '## Summary'.length,
      text: '## Summary',
    })
  })

  it.each([
    'pull_request_template.md',
    'Pull_Request_Template.MD',
    'PULL_REQUEST_TEMPLATE.markdown',
    'PULL_REQUEST_TEMPLATE.txt',
    'PULL_REQUEST_TEMPLATE',
  ])('matches %s case-insensitively at the repo root', async (name) => {
    write(name, '## Summary')
    expect((await discoverPrTemplate(dir))?.path).toBe(name)
  })

  it('finds a template under docs/', async () => {
    write('docs/PULL_REQUEST_TEMPLATE.md', '## Summary')
    expect((await discoverPrTemplate(dir))?.path).toBe('docs/PULL_REQUEST_TEMPLATE.md')
  })

  it("prefers .github over the repo root, matching the host's own precedence", async () => {
    write('PULL_REQUEST_TEMPLATE.md', 'root')
    write('.github/PULL_REQUEST_TEMPLATE.md', 'dotgithub')
    write('docs/PULL_REQUEST_TEMPLATE.md', 'docs')
    expect((await discoverPrTemplate(dir))?.text).toBe('dotgithub')
  })

  it('finds a GitLab merge-request template', async () => {
    write('.gitlab/merge_request_templates/Default.md', '## Change')
    expect(await discoverPrTemplate(dir, 'gitlab')).toEqual({
      path: '.gitlab/merge_request_templates/Default.md',
      chars: '## Change'.length,
      text: '## Change',
    })
  })

  it('probes the repo host convention first when both are present', async () => {
    write('.github/PULL_REQUEST_TEMPLATE.md', 'github one')
    write('.gitlab/merge_request_templates/Default.md', 'gitlab one')
    expect((await discoverPrTemplate(dir, 'gitlab'))?.text).toBe('gitlab one')
    expect((await discoverPrTemplate(dir, 'github'))?.text).toBe('github one')
    // No provider set by the dispatcher: still found, rather than skipped.
    expect((await discoverPrTemplate(dir))?.text).toBe('github one')
  })

  it('finds a GitLab template even for a repo whose provider says github', async () => {
    // A GitLab-hosted repo whose dispatch never set the discriminator would otherwise lose its
    // template entirely; probing both lists costs one absent-directory listing.
    write('.gitlab/merge_request_templates/Default.md', 'gitlab only')
    expect((await discoverPrTemplate(dir, 'github'))?.text).toBe('gitlab only')
  })

  describe('a directory of templates', () => {
    it('takes default.md when present, case-insensitively', async () => {
      write('.github/PULL_REQUEST_TEMPLATE/bug.md', 'bug')
      write('.github/PULL_REQUEST_TEMPLATE/DEFAULT.md', 'the default')
      write('.github/PULL_REQUEST_TEMPLATE/release.md', 'release')
      expect((await discoverPrTemplate(dir))?.text).toBe('the default')
    })

    it('takes a lone template', async () => {
      write('.github/PULL_REQUEST_TEMPLATE/only.md', 'the only one')
      expect((await discoverPrTemplate(dir))?.text).toBe('the only one')
    })

    it('refuses to guess between several templates with no default', async () => {
      // That directory exists so a HUMAN can pick per pull request; picking one arbitrarily would
      // file every run under whichever name sorts first and look deliberate.
      write('.github/PULL_REQUEST_TEMPLATE/bug.md', 'bug')
      write('.github/PULL_REQUEST_TEMPLATE/release.md', 'release')
      expect(await discoverPrTemplate(dir)).toBeUndefined()
    })

    it('is not mistaken for an extensionless single-file template', async () => {
      // `.github/PULL_REQUEST_TEMPLATE` (a directory) matches the extensionless file rule too;
      // reading it as a file would yield nothing but a swallowed EISDIR.
      write('.github/PULL_REQUEST_TEMPLATE/bug.md', 'bug')
      write('.github/PULL_REQUEST_TEMPLATE/release.md', 'release')
      write('docs/PULL_REQUEST_TEMPLATE.md', 'the docs one')
      expect((await discoverPrTemplate(dir))?.text).toBe('the docs one')
    })
  })

  it('skips an empty template and keeps probing', async () => {
    write('.github/PULL_REQUEST_TEMPLATE.md', '   \n\n  ')
    write('docs/PULL_REQUEST_TEMPLATE.md', 'the real one')
    expect((await discoverPrTemplate(dir))?.text).toBe('the real one')
  })

  it('names but does not inline an over-budget template, reporting its real size', async () => {
    // Truncating would have the agent fill a structure whose tail it never saw; the file is on
    // disk, so pointing at it keeps the feature working at any size. `chars` still carries the
    // real length — reporting 0 for the LARGEST templates would read exactly like an empty file,
    // which is the one case discovery treats as no template at all.
    write('.github/PULL_REQUEST_TEMPLATE.md', 'x'.repeat(MAX_INLINE_PR_TEMPLATE_CHARS + 1))
    expect(await discoverPrTemplate(dir)).toEqual({
      path: '.github/PULL_REQUEST_TEMPLATE.md',
      chars: MAX_INLINE_PR_TEMPLATE_CHARS + 1,
    })
  })

  it('trims but keeps a template exactly at the budget', async () => {
    write('.github/PULL_REQUEST_TEMPLATE.md', 'y'.repeat(MAX_INLINE_PR_TEMPLATE_CHARS))
    expect((await discoverPrTemplate(dir))?.text).toHaveLength(MAX_INLINE_PR_TEMPLATE_CHARS)
  })

  it('never throws for an unreadable template', async () => {
    // A broken symlink is the reachable case: the entry exists, the read fails.
    mkdirSync(join(dir, '.github'), { recursive: true })
    if (!trySymlink(join(dir, 'nowhere.md'), join(dir, '.github/PULL_REQUEST_TEMPLATE.md'))) return
    expect(await discoverPrTemplate(dir)).toBeUndefined()
  })

  it('follows a symlink that stays inside the repo', async () => {
    // A monorepo pointing `.github/` at a doc it keeps elsewhere in the tree is a real layout, so
    // containment is the rule rather than a blanket refusal of symlinked templates.
    write('docs/shared-pr-template.md', '## Shared')
    mkdirSync(join(dir, '.github'), { recursive: true })
    if (
      !trySymlink(
        join(dir, 'docs/shared-pr-template.md'),
        join(dir, '.github/PULL_REQUEST_TEMPLATE.md'),
      )
    ) {
      return
    }
    expect((await discoverPrTemplate(dir))?.text).toBe('## Shared')
  })

  it('refuses a template symlinked OUT of the checkout', async () => {
    // This is the one read the harness performs on a repo-chosen path unprompted, so a repo could
    // otherwise inline an arbitrary container file — the run's own env, a sibling checkout — into
    // the prompt, and from there into a body only `redactSecrets` stands in front of.
    const outside = mkdtempSync(join(tmpdir(), 'pr-tmpl-outside-'))
    try {
      writeFileSync(join(outside, 'secrets.env'), 'GH_TOKEN=ghp_realtoken', 'utf8')
      mkdirSync(join(dir, '.github'), { recursive: true })
      if (
        !trySymlink(join(outside, 'secrets.env'), join(dir, '.github/PULL_REQUEST_TEMPLATE.md'))
      ) {
        return
      }
      expect(await discoverPrTemplate(dir)).toBeUndefined()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('never throws for a missing checkout', async () => {
    expect(await discoverPrTemplate(join(dir, 'does-not-exist'))).toBeUndefined()
  })
})

describe('resolvePrTemplateNote', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pr-tmpl-note-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const repo = (name: string, template?: string) => {
    const repoDir = join(dir, name)
    mkdirSync(join(repoDir, '.github'), { recursive: true })
    if (template !== undefined) {
      writeFileSync(join(repoDir, '.github/PULL_REQUEST_TEMPLATE.md'), template, 'utf8')
    }
    return repoDir
  }

  it('yields no note when the dispatch opens no pull request', async () => {
    repo('api', '## Summary')
    // The caller passes no targets — an in-place fixer amending someone else's PR must not be
    // asked to fill a template for a pull request nothing opens.
    const resolved = await resolvePrTemplateNote({ targets: [], logger: silentLogger })
    expect(resolved.note).toBeUndefined()
    expect(resolved.templated.size).toBe(0)
  })

  it('yields no note when no target ships a template', async () => {
    const repoDir = repo('api')
    const resolved = await resolvePrTemplateNote({ targets: [{ repoDir }], logger: silentLogger })
    expect(resolved.note).toBeUndefined()
    // Nothing to fill ⇒ the sentinel is a free-form briefing, so the title heuristic stays on.
    expect(resolved.templated.has(repoDir)).toBe(false)
  })

  it('builds a note carrying the template text and marks the checkout templated', async () => {
    const repoDir = repo('api', '## Summary\n## Risk')
    const { note, templated } = await resolvePrTemplateNote({
      targets: [{ repoDir }],
      logger: silentLogger,
    })
    expect(note).toContain('.github/PULL_REQUEST_TEMPLATE.md')
    expect(note).toContain('## Summary\n## Risk')
    expect(note).toContain('This repository')
    expect(templated.has(repoDir)).toBe(true)
  })

  it('names each repo in a multi-repo run and skips the ones with no template', async () => {
    const api = repo('api', '## API change')
    const web = repo('web')
    const jobs = repo('jobs', '## Jobs change')
    const { note, templated } = await resolvePrTemplateNote({
      targets: [
        { repoDir: api, repoLabel: 'acme__api' },
        { repoDir: web, repoLabel: 'acme__web' },
        { repoDir: jobs, repoLabel: 'acme__jobs' },
      ],
      logger: silentLogger,
    })
    expect(note).toContain('`acme__api`')
    expect(note).toContain('`acme__jobs`')
    expect(note).not.toContain('acme__web')
    expect(note).toContain('## API change')
    expect(note).toContain('## Jobs change')
    // Per-leg, not per-run: the leg with no template keeps the free-form title heuristic.
    expect([...templated].sort()).toEqual([api, jobs].sort())
  })

  it('spends a shared inline budget across legs, naming the ones that no longer fit', async () => {
    // Four template-carrying repos may not quietly consume four times the single-repo budget.
    const big = 'z'.repeat(MAX_INLINE_PR_TEMPLATE_CHARS)
    const first = repo('first', big)
    const second = repo('second', `${big}\nSECOND MARKER`)
    const { note, templated } = await resolvePrTemplateNote({
      targets: [
        { repoDir: first, repoLabel: 'first' },
        { repoDir: second, repoLabel: 'second' },
      ],
      logger: silentLogger,
    })
    expect(note).toContain(big)
    expect(note).not.toContain('SECOND MARKER')
    expect(note).toContain('read it from the checkout')
    expect(note!.length).toBeLessThan(MAX_TOTAL_INLINE_PR_TEMPLATE_CHARS + 4_000)
    // Named rather than inlined is still templated: the agent fills it either way.
    expect(templated.has(second)).toBe(true)
  })

  it('reports the real size of a template it declined to inline', async () => {
    // `chars: 0` for the LARGEST templates would read in the log exactly like an empty file.
    const oversized = MAX_INLINE_PR_TEMPLATE_CHARS + 500
    const repoDir = repo('api', 'q'.repeat(oversized))
    const lines: { msg: string; fields?: Record<string, unknown> }[] = []
    const recording: Logger = {
      ...silentLogger,
      info: (msg, fields) => lines.push({ msg, ...(fields ? { fields } : {}) }),
    }
    const { note } = await resolvePrTemplateNote({ targets: [{ repoDir }], logger: recording })
    expect(lines[0]?.fields).toMatchObject({
      chars: oversized,
      inlined: false,
      reason: 'over-file-budget',
    })
    expect(note).toContain(`${oversized} characters`)
  })

  it('distinguishes the shared budget from the per-file one', async () => {
    // The two want different fixes — a smaller template, vs a workspace carrying more template
    // text than one prompt should hold — so they must not log as the same condition.
    const big = 'z'.repeat(MAX_INLINE_PR_TEMPLATE_CHARS)
    const first = repo('first', big)
    const second = repo('second', big)
    const reasons: unknown[] = []
    const recording: Logger = {
      ...silentLogger,
      info: (_msg, fields) => reasons.push(fields?.reason),
    }
    await resolvePrTemplateNote({
      targets: [{ repoDir: first }, { repoDir: second }],
      logger: recording,
    })
    expect(reasons).toEqual([undefined, 'over-shared-budget'])
  })
})

describe('buildPrTemplateNote', () => {
  /** An inlined template at an arbitrary path — the path is not what these assertions are about. */
  const inlined = (text: string): PrTemplate => ({
    path: '.github/PULL_REQUEST_TEMPLATE.md',
    chars: text.length,
    text,
  })

  it('states that the host does not apply the template for us', async () => {
    // An agent that believes the host will merge the template with its text has no reason to
    // reproduce the structure itself.
    const note = buildPrTemplateNote(inlined('## Why'))
    expect(note).toMatch(/neither GitHub nor GitLab applies a template/i)
  })

  it('says the template wins where it conflicts with the free-form guidance', () => {
    expect(buildPrTemplateNote(inlined('## Test plan'))).toMatch(/TEMPLATE wins/)
  })

  it('names the sentinel file the filled template must be written to', () => {
    expect(buildPrTemplateNote(inlined('## Why'))).toContain('.cat-pr-description.md')
  })

  it('forbids a title line above the template', () => {
    // The platform titles the PR itself, and a `# <title>` line the agent adds on top would either
    // become the title (stealing it from `<block> (<pipeline>)`) or make the template's own first
    // heading no longer first. Reinforces the `titleFromHeading: false` read on the way out.
    expect(buildPrTemplateNote(inlined('# Pull Request\n\n## Why'))).toMatch(
      /Do NOT put a title line above the template/,
    )
  })

  it('states the body budget so a long template is not answered past it', () => {
    // The platform truncates an over-budget body, which would cut the template's last sections —
    // the same failure the INLINE budget avoids on the way in.
    expect(buildPrTemplateNote(inlined('## Why'))).toContain('15,000 characters')
  })

  it('fences the template so its own fenced blocks cannot break out', () => {
    // Templates routinely contain fenced blocks. A fixed three-tick wrapper closes on the first of
    // them and spills the rest of the template — and the instructions after it — into the prompt as
    // prose; a plain `--- END ---` rule is forgeable by the template's own content. `fencedOutput`
    // sizes the fence past the longest run inside, so neither is possible.
    const note = buildPrTemplateNote(inlined('## Repro\n```sh\nnpm t\n```'))
    expect(note).toContain('````\n## Repro\n```sh\nnpm t\n```\n````')
  })

  it('tells the agent to read an un-inlined template itself, with its size', () => {
    const note = buildPrTemplateNote({ path: '.github/PULL_REQUEST_TEMPLATE.md', chars: 12_345 })
    expect(note).toContain('read it from the checkout')
    expect(note).toContain('(12345 characters)')
    expect(note).not.toContain('```')
  })
})

describe('withPrTemplateNote', () => {
  it('leaves the prompt untouched with no note', () => {
    expect(withPrTemplateNote('do the work', undefined)).toBe('do the work')
  })

  it('appends the note', () => {
    expect(withPrTemplateNote('do the work', 'NOTE')).toBe('do the work\n\nNOTE')
  })
})

describe('a filled template survives the read-back intact', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pr-tmpl-read-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // The shape that breaks: ONE level-1 heading on the first line above a set of `##` sections. The
  // free-form title heuristic (`splitTitle`) fires on exactly that, so a template written to the
  // sentinel unguarded loses its top heading to the PR title — a pull request titled "Pull Request"
  // instead of `<block> (<pipeline>)`, and a body missing the heading the repo asked for.
  const FILLED = '# Pull Request\n\n## What changed\n\nAdded login.\n\n## Test plan\n\nUnit tests.'

  it('keeps the template top heading in the body and does not retitle the PR', async () => {
    writeFileSync(join(dir, PR_DESCRIPTION_FILE), FILLED, 'utf8')
    const parsed = await readPrDescription(dir, { titleFromHeading: false })
    expect(parsed?.title).toBeUndefined()
    expect(parsed?.body).toBe(FILLED)
  })

  it('still lifts the title off a FREE-FORM briefing, which is what asked for one', async () => {
    // The guard is scoped to the templated read; the default behaviour must be untouched.
    writeFileSync(join(dir, PR_DESCRIPTION_FILE), FILLED, 'utf8')
    expect((await readPrDescription(dir))?.title).toBe('Pull Request')
  })
})

describe('opensPr is derived from the job carrying a PR to open', () => {
  // The single line the in-place-fixer exclusion rests on, and the one the coverage guard cannot
  // reach: the fixers run through `runCodingAgent` exactly as the implementer does, so what tells
  // them apart is `job.pr` — never an agent-kind switch, and never a second job-body flag that
  // could disagree with the `if (job.pr)` guard that decides whether a PR opens at all.
  const codingJob = (extra: Record<string, unknown>) =>
    parseAgentJob({
      jobId: 'job_1',
      mode: 'coding',
      systemPrompt: 'sys',
      userPrompt: 'user',
      model: 'qwen3-max',
      proxyBaseUrl: 'https://w/v1',
      sessionToken: 'sess',
      ghToken: 'ght',
      repo: {
        owner: 'acme',
        name: 'widgets',
        baseBranch: 'main',
        cloneUrl: 'https://github.com/acme/widgets.git',
      },
      branch: 'main',
      ...extra,
    })

  it('is set for a dispatch that opens a pull request', () => {
    const job = codingJob({ newBranch: 'cat-factory/b1', pr: { title: 'T', body: 'B' } })
    expect(buildSingleRepoCodingSpec(job, 'cat-factory/b1').opensPr).toBe(true)
  })

  it('is absent for an in-place fixer, which amends a PR it does not own', () => {
    const job = codingJob({ pushBranch: 'cat-factory/b1' })
    expect(buildSingleRepoCodingSpec(job, 'cat-factory/b1').opensPr).toBeUndefined()
  })
})
