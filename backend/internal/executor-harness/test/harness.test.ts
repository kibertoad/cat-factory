import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseBootstrapJob, parseConflictResolverJob, parseJob } from '../src/job.js'
import { parsePiOutput, parseTodoProgress, summarizePiRun } from '../src/pi.js'
import {
  authenticatedCloneUrl,
  branchHasChanges,
  changedPathsFromPorcelain,
  commitAll,
  headCommit,
  mergeBranch,
  redactSecrets,
  unmergedPaths,
} from '../src/git.js'
import { producedRepoContent } from '../src/bootstrap.js'

const exec = promisify(execFile)

const validBootstrapBody = {
  jobId: 'boot_123',
  systemPrompt: 'You are a bootstrapper.',
  instructions: 'Rename the service.',
  model: 'qwen3-max',
  proxyBaseUrl: 'https://w/v1',
  sessionToken: 'sess',
  ghToken: 'ght',
  reference: {
    owner: 'acme',
    name: 'service-template',
    baseBranch: 'main',
    cloneUrl: 'https://github.com/acme/service-template.git',
  },
  target: {
    owner: 'acme',
    name: 'new-service',
    cloneUrl: 'https://github.com/acme/new-service.git',
    defaultBranch: 'main',
  },
}

describe('parseBootstrapJob', () => {
  it('accepts a well-formed bootstrap job', () => {
    const job = parseBootstrapJob(validBootstrapBody)
    expect(job.reference?.name).toBe('service-template')
    expect(job.target.name).toBe('new-service')
    expect(job.instructions).toBe('Rename the service.')
  })

  it('accepts a from-scratch job with no reference', () => {
    const { reference: _reference, ...withoutReference } = validBootstrapBody
    const job = parseBootstrapJob(withoutReference)
    expect(job.reference).toBeUndefined()
    expect(job.target.name).toBe('new-service')
  })

  it('rejects missing required fields', () => {
    expect(() => parseBootstrapJob({ ...validBootstrapBody, instructions: '' })).toThrow(
      /instructions/,
    )
    expect(() => parseBootstrapJob({ ...validBootstrapBody, target: { owner: 'acme' } })).toThrow(
      /target\.name/,
    )
  })

  it('rejects a malformed reference when one is supplied', () => {
    expect(() =>
      parseBootstrapJob({ ...validBootstrapBody, reference: { owner: 'acme' } }),
    ).toThrow(/reference\.name/)
  })
})

const validBody = {
  jobId: 'exec-1',
  systemPrompt: 'You are a builder.',
  userPrompt: 'Implement the thing.',
  model: 'qwen3-max',
  proxyBaseUrl: 'https://w/v1',
  sessionToken: 'sess',
  ghToken: 'ght',
  repo: { owner: 'o', name: 'r', baseBranch: 'main', cloneUrl: 'https://github.com/o/r.git' },
  headBranch: 'cat-factory/blk-1',
  pr: { title: 'T', body: 'B' },
}

describe('parseJob', () => {
  it('accepts a well-formed job', () => {
    const job = parseJob(validBody)
    expect(job.jobId).toBe('exec-1')
    expect(job.repo.owner).toBe('o')
    expect(job.pr.title).toBe('T')
  })

  it('requires a jobId (the durable driver keys/polls the job by it)', () => {
    expect(() => parseJob({ ...validBody, jobId: '' })).toThrow(/jobId/)
  })

  it('defaults an absent pr body to empty', () => {
    const job = parseJob({ ...validBody, pr: { title: 'T' } })
    expect(job.pr.body).toBe('')
  })

  it('rejects missing required fields', () => {
    expect(() => parseJob({ ...validBody, sessionToken: '' })).toThrow(/sessionToken/)
    expect(() => parseJob({ ...validBody, repo: { owner: 'o' } })).toThrow(/repo\.name/)
    expect(() => parseJob(null)).toThrow(/object/)
  })
})

describe('authenticatedCloneUrl', () => {
  it('embeds only the username, never the token (token goes via GIT_ASKPASS env)', () => {
    const url = authenticatedCloneUrl('https://github.com/o/r.git')
    expect(url).toBe('https://x-access-token@github.com/o/r.git')
    // The secret must not appear anywhere in the URL/argv.
    expect(url).not.toContain('TOK')
    expect(url).not.toContain('ghs_')
  })

  it('leaves non-https (local file) URLs untouched', () => {
    expect(authenticatedCloneUrl('file:///srv/repo')).toBe('file:///srv/repo')
  })
})

describe('redactSecrets', () => {
  it('strips URL userinfo so a leaked clone URL cannot reveal the token', () => {
    expect(
      redactSecrets('fatal: clone https://x-access-token:ghs_SECRET123@github.com/o/r.git'),
    ).not.toContain('ghs_SECRET123')
  })

  it('strips bare x-access-token credentials and GitHub token shapes', () => {
    expect(redactSecrets('x-access-token:ghs_TOPSECRET failed')).not.toContain('ghs_TOPSECRET')
    expect(redactSecrets('token ghp_abcDEF123 leaked')).not.toContain('ghp_abcDEF123')
    expect(redactSecrets('token github_pat_abc123 leaked')).not.toContain('github_pat_abc123')
  })

  it('redacts a simulated git failure error without losing surrounding context', () => {
    const token = 'ghs_ACTUALINSTALLATIONTOKEN'
    // Shape of an error Node would surface if the token had been in the argv/URL.
    const err = new Error(
      `Command failed: git clone https://x-access-token:${token}@github.com/o/r.git\nfatal: repository not found`,
    )
    const redacted = redactSecrets(err.message)
    expect(redacted).not.toContain(token)
    expect(redacted).toContain('repository not found')
  })
})

describe('parsePiOutput', () => {
  it('returns the last assistant message from the agent_end transcript', () => {
    const stdout = [
      '{"type":"turn_start"}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"write"}]}}',
      'not json',
      '{"type":"agent_end","messages":[' +
        '{"role":"user","content":[{"type":"text","text":"do it"}]},' +
        '{"role":"assistant","content":[{"type":"toolCall","name":"write"}]},' +
        '{"role":"toolResult","content":[{"type":"text","text":"wrote 14 bytes"}]},' +
        '{"role":"assistant","content":[{"type":"text","text":"Created IMPLEMENTED.md."}]}' +
        ']}',
    ].join('\n')
    expect(parsePiOutput(stdout)).toBe('Created IMPLEMENTED.md.')
  })

  it('falls back to message_end assistant text when there is no agent_end', () => {
    const stdout = [
      '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}',
    ].join('\n')
    expect(parsePiOutput(stdout)).toBe('done')
  })

  it('reads string message content', () => {
    const stdout = '{"type":"message_end","message":{"role":"assistant","content":"plain answer"}}'
    expect(parsePiOutput(stdout)).toBe('plain answer')
  })

  it('falls back to the raw tail when nothing structured matches', () => {
    expect(parsePiOutput('plain text only')).toBe('plain text only')
  })
})

describe('summarizePiRun', () => {
  it('counts tool calls and assistant text from the agent_end transcript', () => {
    const stdout = [
      '{"type":"agent_end","messages":[' +
        '{"role":"user","content":[{"type":"text","text":"do it"}]},' +
        '{"role":"assistant","content":[{"type":"toolCall","name":"write"},{"type":"toolCall","name":"bash"}]},' +
        '{"role":"toolResult","content":[{"type":"text","text":"ok"}]},' +
        '{"role":"assistant","content":[{"type":"text","text":"Done."}]}' +
        ']}',
    ].join('\n')
    const { summary, stats } = summarizePiRun(stdout)
    expect(summary).toBe('Done.')
    expect(stats).toEqual({ toolCalls: 2, assistantChars: 'Done.'.length })
  })

  it('falls back to streamed events when there is no agent_end transcript', () => {
    const stdout = [
      '{"type":"tool_execution_end","toolName":"write","isError":false}',
      '{"type":"message_end","message":{"role":"assistant","content":"working"}}',
    ].join('\n')
    expect(summarizePiRun(stdout).stats).toEqual({ toolCalls: 1, assistantChars: 'working'.length })
  })

  it('reports a true no-op (no tool calls, no model output) so the guard can fire', () => {
    // Pi exited cleanly but never reached the model: empty transcript.
    expect(summarizePiRun('{"type":"agent_end","messages":[]}').stats).toEqual({
      toolCalls: 0,
      assistantChars: 0,
    })
    expect(summarizePiRun('').stats).toEqual({ toolCalls: 0, assistantChars: 0 })
  })
})

describe('changedPathsFromPorcelain', () => {
  it('extracts paths, follows renames to the new name, and unquotes', () => {
    const status = [
      'A  AGENTS.md',
      ' M src/index.ts',
      'R  old.ts -> new.ts',
      '?? "with space.ts"',
    ].join('\n')
    expect(changedPathsFromPorcelain(status)).toEqual([
      'AGENTS.md',
      'src/index.ts',
      'new.ts',
      'with space.ts',
    ])
  })

  it('returns nothing for empty output', () => {
    expect(changedPathsFromPorcelain('')).toEqual([])
    expect(changedPathsFromPorcelain('\n  \n')).toEqual([])
  })
})

describe('producedRepoContent (from-scratch scaffold)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'boot-test-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is false when only the harness AGENTS.md exists (the observed no-op)', async () => {
    await writeFile(join(dir, 'AGENTS.md'), 'context', 'utf8')
    expect(await producedRepoContent(dir, false)).toBe(false)
  })

  it('is true once the agent scaffolds a real file', async () => {
    await writeFile(join(dir, 'AGENTS.md'), 'context', 'utf8')
    await writeFile(join(dir, 'package.json'), '{}', 'utf8')
    expect(await producedRepoContent(dir, false)).toBe(true)
  })
})

describe('branchHasChanges', () => {
  let dir: string

  /** Init a repo with one base commit (a tracked file) and return its base tip SHA. */
  const initRepo = async (): Promise<string> => {
    const git = (...args: string[]): Promise<unknown> => exec('git', args, { cwd: dir })
    await git('init', '-b', 'main')
    await git('config', 'user.email', 'test@example.com')
    await git('config', 'user.name', 'Test')
    // AGENTS.md is the harness-written context; in these repos it is gitignored,
    // exactly as in the deployments where the no-op false-positive was observed.
    await writeFile(join(dir, '.gitignore'), 'AGENTS.md\n', 'utf8')
    await writeFile(join(dir, 'base.txt'), 'base\n', 'utf8')
    await git('add', '-A')
    await git('commit', '-m', 'base')
    return headCommit(dir)
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'branch-test-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is false when the agent produced nothing (only the gitignored AGENTS.md)', async () => {
    const base = await initRepo()
    await writeFile(join(dir, 'AGENTS.md'), 'context', 'utf8')
    expect(await branchHasChanges(dir, base)).toBe(false)
  })

  it('is true when the agent committed its own work (the observed false-positive)', async () => {
    const base = await initRepo()
    // The agent writes AND commits its change itself, leaving a clean working tree
    // — so a trailing commitAll finds nothing, but the branch has advanced.
    await writeFile(join(dir, 'feature.ts'), 'export const x = 1\n', 'utf8')
    await exec('git', ['add', '-A'], { cwd: dir })
    await exec('git', ['commit', '-m', 'feat'], { cwd: dir })
    expect(await commitAll(dir, 'noop')).toBe(false)
    expect(await branchHasChanges(dir, base)).toBe(true)
  })

  it('is true when the agent left uncommitted edits', async () => {
    const base = await initRepo()
    await writeFile(join(dir, 'feature.ts'), 'export const x = 1\n', 'utf8')
    expect(await branchHasChanges(dir, base)).toBe(true)
  })

  it('ignores a lone AGENTS.md change even when it is tracked (not gitignored)', async () => {
    const git = (...args: string[]): Promise<unknown> => exec('git', args, { cwd: dir })
    await git('init', '-b', 'main')
    await git('config', 'user.email', 'test@example.com')
    await git('config', 'user.name', 'Test')
    await writeFile(join(dir, 'base.txt'), 'base\n', 'utf8')
    await git('add', '-A')
    await git('commit', '-m', 'base')
    const base = await headCommit(dir)
    // No .gitignore here, so AGENTS.md is tracked; rewriting only it is still a no-op.
    await writeFile(join(dir, 'AGENTS.md'), 'fresh context', 'utf8')
    expect(await branchHasChanges(dir, base)).toBe(false)
  })
})

const validConflictBody = {
  jobId: 'exec-1',
  systemPrompt: 'Resolve the conflicts.',
  userPrompt: 'Resolve.',
  model: 'qwen3-max',
  proxyBaseUrl: 'https://w/v1',
  sessionToken: 'sess',
  ghToken: 'ght',
  repo: { owner: 'o', name: 'r', baseBranch: 'main', cloneUrl: 'https://github.com/o/r.git' },
  branch: 'cat-factory/blk-1',
}

describe('parseConflictResolverJob', () => {
  it('accepts a well-formed conflict-resolver job', () => {
    const job = parseConflictResolverJob(validConflictBody)
    expect(job.jobId).toBe('exec-1')
    expect(job.branch).toBe('cat-factory/blk-1')
    expect(job.repo.baseBranch).toBe('main')
  })

  it('rejects missing required fields', () => {
    expect(() => parseConflictResolverJob({ ...validConflictBody, branch: '' })).toThrow(/branch/)
    expect(() => parseConflictResolverJob({ ...validConflictBody, repo: { owner: 'o' } })).toThrow(
      /repo\.name/,
    )
  })

  it('rejects a clone URL pointing at a non-GitHub host', () => {
    expect(() =>
      parseConflictResolverJob({
        ...validConflictBody,
        repo: { ...validConflictBody.repo, cloneUrl: 'https://evil.example/o/r.git' },
      }),
    ).toThrow(/not an allowed GitHub host/)
  })
})

describe('mergeBranch / unmergedPaths', () => {
  let origin: string
  let work: string

  const g = (cwd: string, ...args: string[]): Promise<unknown> => exec('git', args, { cwd })

  beforeEach(async () => {
    // A real "origin" repo with one commit, cloned into a work tree (so the work
    // tree carries an `origin/main` remote-tracking ref the merge can target).
    origin = await mkdtemp(join(tmpdir(), 'merge-origin-'))
    await g(origin, 'init', '-b', 'main')
    await g(origin, 'config', 'user.email', 'o@e.com')
    await g(origin, 'config', 'user.name', 'Origin')
    await writeFile(join(origin, 'file.txt'), 'base\n', 'utf8')
    await g(origin, 'add', '-A')
    await g(origin, 'commit', '-m', 'base')

    work = await mkdtemp(join(tmpdir(), 'merge-work-'))
    await exec('git', ['clone', origin, work])
    await g(work, 'config', 'user.email', 'w@e.com')
    await g(work, 'config', 'user.name', 'Work')
  })
  afterEach(async () => {
    await rm(origin, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  })

  it('returns true (no conflict) when the base only adds new files', async () => {
    await g(work, 'checkout', '-b', 'feature')
    await writeFile(join(work, 'feature.txt'), 'work\n', 'utf8')
    await g(work, 'add', '-A')
    await g(work, 'commit', '-m', 'feature')
    // origin/main advances with a non-overlapping file.
    await writeFile(join(origin, 'extra.txt'), 'extra\n', 'utf8')
    await g(origin, 'add', '-A')
    await g(origin, 'commit', '-m', 'extra')
    await g(work, 'fetch', 'origin')

    expect(await mergeBranch(work, 'main')).toBe(true)
    expect(await unmergedPaths(work)).toEqual([])
  })

  it('returns false and reports the unmerged path on a real conflict', async () => {
    await g(work, 'checkout', '-b', 'feature')
    await writeFile(join(work, 'file.txt'), 'feature change\n', 'utf8')
    await g(work, 'add', '-A')
    await g(work, 'commit', '-m', 'feature edit')
    // origin/main changes the SAME line, so the merge cannot auto-resolve.
    await writeFile(join(origin, 'file.txt'), 'main change\n', 'utf8')
    await g(origin, 'add', '-A')
    await g(origin, 'commit', '-m', 'main edit')
    await g(work, 'fetch', 'origin')

    expect(await mergeBranch(work, 'main')).toBe(false)
    expect(await unmergedPaths(work)).toEqual(['file.txt'])
  })
})

describe('parseTodoProgress', () => {
  // The real `--mode json` shape: a tool result is a `message_end` event whose
  // message is a `toolResult` (role/toolName/details/isError live on the message).
  const todoEvent = (tasks: Array<{ status: string; subject?: string }>) => ({
    type: 'message_end',
    message: {
      role: 'toolResult',
      toolName: 'todo',
      isError: false,
      details: { action: 'update', tasks, nextId: tasks.length + 1 },
    },
  })

  it('counts completed/in-progress over live tasks from rpiv-todo details', () => {
    const event = todoEvent([
      { status: 'completed' },
      { status: 'completed' },
      { status: 'completed' },
      { status: 'in_progress' },
      { status: 'pending' },
    ])
    expect(parseTodoProgress(event)).toMatchObject({ completed: 3, inProgress: 1, total: 5 })
  })

  it('surfaces each live task as an item with its subject + status', () => {
    const event = todoEvent([
      { status: 'completed', subject: 'Scaffold project' },
      { status: 'in_progress', subject: 'Write app.js' },
      { status: 'pending', subject: 'Add README' },
    ])
    expect(parseTodoProgress(event)?.items).toEqual([
      { label: 'Scaffold project', status: 'completed' },
      { label: 'Write app.js', status: 'in_progress' },
      { label: 'Add README', status: 'pending' },
    ])
  })

  it('labels a subject-less task "Untitled task"', () => {
    expect(parseTodoProgress(todoEvent([{ status: 'pending' }]))?.items).toEqual([
      { label: 'Untitled task', status: 'pending' },
    ])
  })

  it('excludes deleted (tombstoned) tasks from the total and items', () => {
    const event = todoEvent([
      { status: 'completed', subject: 'a' },
      { status: 'deleted', subject: 'gone' },
      { status: 'pending', subject: 'b' },
    ])
    expect(parseTodoProgress(event)).toEqual({
      completed: 1,
      inProgress: 0,
      total: 2,
      items: [
        { label: 'a', status: 'completed' },
        { label: 'b', status: 'pending' },
      ],
    })
  })

  it('falls back to the example extension `todos[].done` shape (no items)', () => {
    const event = {
      type: 'message_end',
      message: {
        role: 'toolResult',
        toolName: 'todo',
        details: { todos: [{ done: true }, { done: false }, { done: true }] },
      },
    }
    expect(parseTodoProgress(event)).toEqual({ completed: 2, inProgress: 0, total: 3 })
  })

  it('reads the tool_execution_end shape (details under result)', () => {
    const event = {
      type: 'tool_execution_end',
      toolName: 'todo',
      isError: false,
      result: { details: { tasks: [{ status: 'completed' }, { status: 'in_progress' }] } },
    }
    expect(parseTodoProgress(event)).toMatchObject({ completed: 1, inProgress: 1, total: 2 })
  })

  it('also reads a defensive top-level tool_result shape', () => {
    const event = {
      type: 'tool_result',
      toolName: 'todo',
      details: { tasks: [{ status: 'completed' }, { status: 'pending' }] },
    }
    expect(parseTodoProgress(event)).toMatchObject({ completed: 1, inProgress: 0, total: 2 })
  })

  it('ignores non-todo, errored, or unrecognised events', () => {
    expect(parseTodoProgress({ type: 'message_end' })).toBeUndefined()
    // A plain assistant message_end is not a tool result.
    expect(
      parseTodoProgress({ type: 'message_end', message: { role: 'assistant', content: 'hi' } }),
    ).toBeUndefined()
    // A different tool's result.
    expect(
      parseTodoProgress({ type: 'message_end', message: { role: 'toolResult', toolName: 'bash' } }),
    ).toBeUndefined()
    // An errored todo call carries no usable counts.
    expect(
      parseTodoProgress({
        ...todoEvent([{ status: 'pending' }]),
        message: { role: 'toolResult', toolName: 'todo', isError: true, details: {} },
      }),
    ).toBeUndefined()
    expect(
      parseTodoProgress({
        type: 'message_end',
        message: { role: 'toolResult', toolName: 'todo', details: {} },
      }),
    ).toBeUndefined()
  })
})
