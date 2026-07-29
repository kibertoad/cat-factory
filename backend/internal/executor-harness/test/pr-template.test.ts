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
} from '../src/pr-template.js'
import type { Logger } from '../src/logger.js'

// The repo's own pull-request template. Neither host applies a template to an API-created pull
// request, so the harness finds it and the agent fills it. Discovery must cover both hosts'
// conventions, be case-insensitive, refuse to GUESS between several templates, and never throw —
// a template is an improvement to a PR body and may not cost a run that otherwise succeeded.

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
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

  it('names but does not inline an over-budget template', async () => {
    // Truncating would have the agent fill a structure whose tail it never saw; the file is on
    // disk, so pointing at it keeps the feature working at any size.
    write('.github/PULL_REQUEST_TEMPLATE.md', 'x'.repeat(MAX_INLINE_PR_TEMPLATE_CHARS + 1))
    expect(await discoverPrTemplate(dir)).toEqual({ path: '.github/PULL_REQUEST_TEMPLATE.md' })
  })

  it('trims but keeps a template exactly at the budget', async () => {
    write('.github/PULL_REQUEST_TEMPLATE.md', 'y'.repeat(MAX_INLINE_PR_TEMPLATE_CHARS))
    expect((await discoverPrTemplate(dir))?.text).toHaveLength(MAX_INLINE_PR_TEMPLATE_CHARS)
  })

  it('never throws for an unreadable template', async () => {
    // A broken symlink is the reachable case: the entry exists, the read fails.
    mkdirSync(join(dir, '.github'), { recursive: true })
    try {
      symlinkSync(join(dir, 'nowhere.md'), join(dir, '.github/PULL_REQUEST_TEMPLATE.md'))
    } catch {
      return // unprivileged Windows cannot create symlinks; the swallow is covered by the ENOENT paths
    }
    expect(await discoverPrTemplate(dir)).toBeUndefined()
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

  it('returns undefined when the dispatch opens no pull request', async () => {
    repo('api', '## Summary')
    // The caller passes no targets — an in-place fixer amending someone else's PR must not be
    // asked to fill a template for a pull request nothing opens.
    expect(await resolvePrTemplateNote({ targets: [], logger: silentLogger })).toBeUndefined()
  })

  it('returns undefined when no target ships a template', async () => {
    const repoDir = repo('api')
    expect(
      await resolvePrTemplateNote({ targets: [{ repoDir }], logger: silentLogger }),
    ).toBeUndefined()
  })

  it('builds a note carrying the template text', async () => {
    const repoDir = repo('api', '## Summary\n## Risk')
    const note = await resolvePrTemplateNote({ targets: [{ repoDir }], logger: silentLogger })
    expect(note).toContain('.github/PULL_REQUEST_TEMPLATE.md')
    expect(note).toContain('## Summary\n## Risk')
    expect(note).toContain('This repository')
  })

  it('names each repo in a multi-repo run and skips the ones with no template', async () => {
    const api = repo('api', '## API change')
    const web = repo('web')
    const jobs = repo('jobs', '## Jobs change')
    const note = await resolvePrTemplateNote({
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
  })

  it('spends a shared inline budget across legs, naming the ones that no longer fit', async () => {
    // Four template-carrying repos may not quietly consume four times the single-repo budget.
    const big = 'z'.repeat(MAX_INLINE_PR_TEMPLATE_CHARS)
    const first = repo('first', big)
    const second = repo('second', `${big}\nSECOND MARKER`)
    const note = await resolvePrTemplateNote({
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
  })
})

describe('buildPrTemplateNote', () => {
  it('states that the host does not apply the template for us', async () => {
    // An agent that believes the host will merge the template with its text has no reason to
    // reproduce the structure itself.
    const note = buildPrTemplateNote({ path: '.github/PULL_REQUEST_TEMPLATE.md', text: '## Why' })
    expect(note).toMatch(/neither GitHub nor GitLab applies a template/i)
  })

  it('says the template wins where it conflicts with the free-form guidance', () => {
    const note = buildPrTemplateNote({ path: 'PULL_REQUEST_TEMPLATE.md', text: '## Test plan' })
    expect(note).toMatch(/TEMPLATE wins/)
  })

  it('names the sentinel file the filled template must be written to', () => {
    const note = buildPrTemplateNote({ path: 'PULL_REQUEST_TEMPLATE.md', text: '## Why' })
    expect(note).toContain('.cat-pr-description.md')
  })

  it('delimits the template with text rules, not a code fence', () => {
    // Templates routinely contain fenced blocks, which would close a wrapping fence early and
    // spill the rest of the template — and the instructions after it — into the prompt as prose.
    const note = buildPrTemplateNote({
      path: 'PULL_REQUEST_TEMPLATE.md',
      text: '## Repro\n```sh\nnpm t\n```',
    })
    expect(note).toContain('--- BEGIN PULL REQUEST TEMPLATE ---')
    expect(note).toContain('--- END PULL REQUEST TEMPLATE ---')
    expect(note.indexOf('```')).toBeGreaterThan(note.indexOf('--- BEGIN'))
  })

  it('tells the agent to read an un-inlined template itself', () => {
    const note = buildPrTemplateNote({ path: '.github/PULL_REQUEST_TEMPLATE.md' })
    expect(note).toContain('read it from the checkout')
    expect(note).not.toContain('--- BEGIN PULL REQUEST TEMPLATE ---')
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
