import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  DEFAULT_PROGRESS_GUARD_LIMITS,
  ProgressGuard,
  type ProgressGuardLimits,
  classifyLlmUpstreamError,
  mergeGuardLimits,
  parsePiOutput,
  parseTodoProgress,
  progressGuardLimitsFromEnv,
  runDiagnostics,
  summarizePiRun,
  terminalRunError,
  webSearchConfigFromEnv,
  webSearchProxyEnv,
  writeAgentsContext,
  writeWebToolsConfig,
} from '../src/pi.js'
import {
  authenticatedCloneUrl,
  branchAheadOfBase,
  branchHasCommitsSince,
  changedPathsFromPorcelain,
  commitTrackedEdits,
  headCommit,
  mergeBranch,
  redactSecrets,
  refreshFromBaseIfClean,
  unmergedPaths,
} from '../src/git.js'
import { producedRepoContent } from '../src/agent.js'
import { stubTempHome } from './helpers.js'

const exec = promisify(execFile)

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

describe('runDiagnostics', () => {
  // A small cap keeps the fixtures readable: `usage.output >= cap` marks truncation.
  const cap = 100

  it('reports a clean final answer as not truncated and not empty', () => {
    const stdout =
      '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"Here is the spec."}],"usage":{"output":42}}]}'
    expect(runDiagnostics(stdout, cap)).toEqual({
      truncated: false,
      finalTruncated: false,
      finalAnswerEmpty: false,
    })
  })

  it('flags an empty final turn (content: []) despite spent output tokens', () => {
    // The exact production failure: 10.9k output tokens but an empty content array.
    const stdout =
      '{"type":"agent_end","messages":[{"role":"assistant","content":[],"usage":{"output":42}}]}'
    expect(runDiagnostics(stdout, cap)).toMatchObject({
      finalAnswerEmpty: true,
      finalTruncated: false,
    })
  })

  it('flags a truncated FINAL answer (output hit the ceiling)', () => {
    const stdout =
      '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"cut off"}],"usage":{"output":100}}]}'
    expect(runDiagnostics(stdout, cap)).toMatchObject({ truncated: true, finalTruncated: true })
  })

  it('flags an intermediate truncation without marking the final answer truncated', () => {
    const stdout =
      '{"type":"agent_end","messages":[' +
      '{"role":"assistant","content":[{"type":"toolCall","name":"read"}],"usage":{"output":100}},' +
      '{"role":"toolResult","content":[{"type":"text","text":"ok"}]},' +
      '{"role":"assistant","content":[{"type":"text","text":"final"}],"usage":{"output":20}}]}'
    expect(runDiagnostics(stdout, cap)).toEqual({
      truncated: true,
      finalTruncated: false,
      finalAnswerEmpty: false,
    })
  })

  it('is all-false when there is no terminal transcript', () => {
    expect(runDiagnostics('', cap)).toEqual({
      truncated: false,
      finalTruncated: false,
      finalAnswerEmpty: false,
    })
  })
})

describe('terminalRunError', () => {
  it('reports the final error when retries are exhausted (auto_retry_end success:false)', () => {
    const stdout = [
      '{"type":"agent_end","messages":[{"role":"assistant","content":[]}],"willRetry":false}',
      '{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"502 model unreachable"}',
    ].join('\n')
    expect(terminalRunError(stdout)).toBe('502 model unreachable')
  })

  it('reports the message from a terminal agent_end with stopReason error', () => {
    const stdout = '{"type":"agent_end","stopReason":"error","errorMessage":"boom","messages":[]}'
    expect(terminalRunError(stdout)).toBe('boom')
  })

  it('returns undefined for a clean run (no terminal error)', () => {
    const stdout = [
      '{"type":"agent_end","stopReason":"stop","messages":[{"role":"assistant","content":[{"type":"text","text":"Done."}]}]}',
    ].join('\n')
    expect(terminalRunError(stdout)).toBeUndefined()
  })

  it('returns undefined when an earlier error was recovered (final retry succeeded)', () => {
    const stdout = [
      '{"type":"agent_end","stopReason":"error","errorMessage":"transient","messages":[]}',
      '{"type":"auto_retry_end","success":true,"attempt":2}',
    ].join('\n')
    expect(terminalRunError(stdout)).toBeUndefined()
  })
})

describe('classifyLlmUpstreamError (F3: LLM-proxy auth/quota/rate-limit remedies)', () => {
  it('classifies a 401/unauthorized → credential-refused remedy', () => {
    expect(classifyLlmUpstreamError('proxy returned 401 Unauthorized: invalid api key')).toMatch(
      /API credential was refused/i,
    )
    expect(classifyLlmUpstreamError('Error: authentication failed')).toMatch(
      /API credential was refused/i,
    )
  })

  it('classifies a 402/quota → out-of-credit remedy', () => {
    expect(classifyLlmUpstreamError('HTTP 402 Payment Required')).toMatch(/out of quota or credit/i)
    expect(classifyLlmUpstreamError('insufficient quota for this request')).toMatch(
      /out of quota or credit/i,
    )
  })

  it('classifies a 429/rate-limit → transient rate-limit remedy', () => {
    expect(classifyLlmUpstreamError('429 Too Many Requests')).toMatch(/rate-limited the run/i)
    expect(classifyLlmUpstreamError('upstream rate limit exceeded')).toMatch(/rate-limited/i)
  })

  it('prefers the quota remedy when a body carries both 402 and auth-ish words', () => {
    expect(classifyLlmUpstreamError('402 Payment Required: unauthorized until you top up')).toMatch(
      /out of quota or credit/i,
    )
  })

  it('prefers the auth remedy over rate-limit when a 403 rides alongside a 429', () => {
    expect(classifyLlmUpstreamError('429 rate limit; 403 Forbidden: key revoked')).toMatch(
      /API credential was refused/i,
    )
  })

  it('returns undefined for an unrelated model error (a bare agent failure stays generic)', () => {
    expect(classifyLlmUpstreamError('502 model unreachable')).toBeUndefined()
    expect(
      classifyLlmUpstreamError('the agent failed after exhausting its retries'),
    ).toBeUndefined()
  })
})

describe('changedPathsFromPorcelain', () => {
  it('extracts paths, follows renames to the new name, and unquotes', () => {
    const status = [
      'A  README.md',
      ' M src/index.ts',
      'R  old.ts -> new.ts',
      '?? "with space.ts"',
    ].join('\n')
    expect(changedPathsFromPorcelain(status)).toEqual([
      'README.md',
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

  it('is false when the scaffold dir is empty (the no-op — harness context is out-of-tree)', async () => {
    expect(await producedRepoContent(dir, false)).toBe(false)
  })

  it('is true once the agent scaffolds a real file', async () => {
    await writeFile(join(dir, 'package.json'), '{}', 'utf8')
    expect(await producedRepoContent(dir, false)).toBe(true)
  })
})

describe('commitTrackedEdits + branchHasCommitsSince', () => {
  let dir: string
  const git = (...args: string[]): Promise<unknown> => exec('git', args, { cwd: dir })
  const initRepo = async (): Promise<string> => {
    await git('init', '-b', 'main')
    await git('config', 'user.email', 'test@example.com')
    await git('config', 'user.name', 'Test')
    await writeFile(join(dir, 'tracked.ts'), 'export const x = 1\n', 'utf8')
    await git('add', '-A')
    await git('commit', '-m', 'base')
    return headCommit(dir)
  }
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'commit-test-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('commits edits to tracked files but never untracked scratch files', async () => {
    const base = await initRepo()
    // The agent edited a tracked file but forgot to commit it, and left a scratch
    // script + a build artifact behind (untracked).
    await writeFile(join(dir, 'tracked.ts'), 'export const x = 2\n', 'utf8')
    await writeFile(join(dir, 'scratch.sh'), 'echo debugging\n', 'utf8')
    await writeFile(join(dir, 'out.log'), 'noise\n', 'utf8')

    expect(await commitTrackedEdits(dir, 'safety-net commit')).toBe(true)
    expect(await branchHasCommitsSince(dir, base)).toBe(true)
    // The scratch + artifact files were NOT committed (still untracked).
    const status = String(
      await exec('git', ['status', '--porcelain'], { cwd: dir }).then((r) => r.stdout),
    )
    expect(status).toMatch(/\?\? scratch\.sh/)
    expect(status).toMatch(/\?\? out\.log/)
    // The tracked edit landed in the commit.
    const show = String(
      await exec('git', ['show', 'HEAD:tracked.ts'], { cwd: dir }).then((r) => r.stdout),
    )
    expect(show).toContain('export const x = 2')
  })

  it('is a no-op when only untracked files exist (agent must commit new files itself)', async () => {
    const base = await initRepo()
    await writeFile(join(dir, 'new-feature.ts'), 'export const y = 1\n', 'utf8')
    // No tracked edits ⇒ nothing the safety net should commit; the branch is unchanged.
    expect(await commitTrackedEdits(dir, 'safety-net commit')).toBe(false)
    expect(await branchHasCommitsSince(dir, base)).toBe(false)
  })

  it('counts the agent’s own commits as advancing the branch', async () => {
    const base = await initRepo()
    await writeFile(join(dir, 'new-feature.ts'), 'export const y = 1\n', 'utf8')
    await git('add', 'new-feature.ts')
    await git('commit', '-m', 'feat: add feature (by the agent)')
    expect(await branchHasCommitsSince(dir, base)).toBe(true)
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

describe('refreshFromBaseIfClean', () => {
  let origin: string
  let work: string

  const g = (cwd: string, ...args: string[]): Promise<unknown> => exec('git', args, { cwd })

  beforeEach(async () => {
    origin = await mkdtemp(join(tmpdir(), 'refresh-origin-'))
    await g(origin, 'init', '-b', 'main')
    await g(origin, 'config', 'user.email', 'o@e.com')
    await g(origin, 'config', 'user.name', 'Origin')
    await writeFile(join(origin, 'file.txt'), 'base\n', 'utf8')
    await g(origin, 'add', '-A')
    await g(origin, 'commit', '-m', 'base')

    work = await mkdtemp(join(tmpdir(), 'refresh-work-'))
    await exec('git', ['clone', origin, work])
    await g(work, 'config', 'user.email', 'w@e.com')
    await g(work, 'config', 'user.name', 'Work')
  })
  afterEach(async () => {
    await rm(origin, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  })

  it('merges the latest base into a resumed branch when it merges cleanly', async () => {
    await g(work, 'checkout', '-b', 'cat-factory/blk')
    await writeFile(join(work, 'feature.txt'), 'work\n', 'utf8')
    await g(work, 'add', '-A')
    await g(work, 'commit', '-m', 'resumed work')
    // Base advances on origin with a non-overlapping file the resumed clone hasn't seen.
    await writeFile(join(origin, 'extra.txt'), 'extra\n', 'utf8')
    await g(origin, 'add', '-A')
    await g(origin, 'commit', '-m', 'base advanced')

    expect(await refreshFromBaseIfClean(work, 'main', 'token')).toBe(true)
    // The advanced base file is now present on the resumed branch.
    const show = String(
      await exec('git', ['show', 'HEAD:extra.txt'], { cwd: work }).then((r) => r.stdout),
    )
    expect(show).toContain('extra')
    // …and the resumed work is preserved.
    expect(
      String(await exec('git', ['show', 'HEAD:feature.txt'], { cwd: work }).then((r) => r.stdout)),
    ).toContain('work')
  })

  it('aborts and leaves the branch untouched when base conflicts', async () => {
    await g(work, 'checkout', '-b', 'cat-factory/blk')
    await writeFile(join(work, 'file.txt'), 'feature change\n', 'utf8')
    await g(work, 'add', '-A')
    await g(work, 'commit', '-m', 'resumed work')
    const tip = await headCommit(work)
    // Base changes the SAME line, so a merge would conflict.
    await writeFile(join(origin, 'file.txt'), 'main change\n', 'utf8')
    await g(origin, 'add', '-A')
    await g(origin, 'commit', '-m', 'base advanced (conflicting)')

    expect(await refreshFromBaseIfClean(work, 'main', 'token')).toBe(false)
    // The aborted merge left no conflict markers and the branch tip unchanged.
    expect(await unmergedPaths(work)).toEqual([])
    expect(await headCommit(work)).toBe(tip)
  })
})

describe('branchAheadOfBase', () => {
  let origin: string
  let work: string

  const g = (cwd: string, ...args: string[]): Promise<unknown> => exec('git', args, { cwd })

  beforeEach(async () => {
    origin = await mkdtemp(join(tmpdir(), 'ahead-origin-'))
    await g(origin, 'init', '-b', 'main')
    await g(origin, 'config', 'user.email', 'o@e.com')
    await g(origin, 'config', 'user.name', 'Origin')
    await writeFile(join(origin, 'file.txt'), 'base\n', 'utf8')
    await g(origin, 'add', '-A')
    await g(origin, 'commit', '-m', 'base')
  })
  afterEach(async () => {
    await rm(origin, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  })

  it('returns false for a resumed branch reachable from base (nothing ahead)', async () => {
    // The work branch points at the SAME commit as main — exactly the stranded, already-merged
    // branch case (GitHub would answer 422 "No commits between ..." on a PR).
    await g(origin, 'branch', 'cat-factory/blk', 'main')
    work = await mkdtemp(join(tmpdir(), 'ahead-work-'))
    // Single-branch clone, mirroring the resume path (no origin/main tracking ref).
    await exec('git', ['clone', '--branch', 'cat-factory/blk', '--single-branch', origin, work])
    expect(await branchAheadOfBase(work, 'main', 'token')).toBe(false)
  })

  it('returns true for a resumed branch that carries commits ahead of base', async () => {
    await g(origin, 'checkout', '-b', 'cat-factory/blk')
    await writeFile(join(origin, 'feature.txt'), 'work\n', 'utf8')
    await g(origin, 'add', '-A')
    await g(origin, 'commit', '-m', 'real work')
    await g(origin, 'checkout', 'main')
    work = await mkdtemp(join(tmpdir(), 'ahead-work-'))
    await exec('git', ['clone', '--branch', 'cat-factory/blk', '--single-branch', origin, work])
    expect(await branchAheadOfBase(work, 'main', 'token')).toBe(true)
  })

  it('returns undefined when the base ref cannot be resolved (fetch fails)', async () => {
    await g(origin, 'branch', 'cat-factory/blk', 'main')
    work = await mkdtemp(join(tmpdir(), 'ahead-work-'))
    await exec('git', ['clone', '--branch', 'cat-factory/blk', '--single-branch', origin, work])
    // No such base branch on origin → the fetch errors → tri-state undefined (couldn't tell),
    // so the caller keeps its prior resume-is-work behaviour rather than dropping real work.
    expect(await branchAheadOfBase(work, 'does-not-exist', 'token')).toBeUndefined()
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

describe('ProgressGuard (anti-rabbithole)', () => {
  const toolCall = (toolName: string, isError = false) => ({
    type: 'tool_execution_end',
    toolName,
    isError,
  })

  it('aborts a run that makes many tool calls without ever editing a file', () => {
    const limits: ProgressGuardLimits = { maxToolCallsWithoutEdit: 5, maxConsecutiveErrors: 99 }
    const guard = new ProgressGuard(limits)
    let reason: string | null = null
    for (let i = 0; i < 5; i++) reason = guard.observe(toolCall('bash'))
    expect(reason).toMatch(/no progress/i)
    expect(reason).toMatch(/not one file edit/i)
  })

  it('does not abort when the agent edits files (resets the no-edit risk)', () => {
    const limits: ProgressGuardLimits = { maxToolCallsWithoutEdit: 5, maxConsecutiveErrors: 99 }
    const guard = new ProgressGuard(limits)
    const seq = ['bash', 'read', 'edit', 'bash', 'read', 'bash', 'write', 'bash']
    let reason: string | null = null
    for (const t of seq) reason = guard.observe(toolCall(t))
    expect(reason).toBeNull()
  })

  it('recognises alternate edit-tool names, case-insensitively', () => {
    const limits: ProgressGuardLimits = { maxToolCallsWithoutEdit: 4, maxConsecutiveErrors: 99 }
    const guard = new ProgressGuard(limits)
    // An `apply_patch`-style edit (in mixed case) counts as a file edit, so the
    // no-edit bound never trips even past its threshold.
    const seq = ['bash', 'read', 'Apply_Patch', 'bash', 'read', 'bash']
    let reason: string | null = null
    for (const t of seq) reason = guard.observe(toolCall(t))
    expect(reason).toBeNull()
  })

  it('does not count planning (todo) calls toward the no-edit bound', () => {
    const limits: ProgressGuardLimits = { maxToolCallsWithoutEdit: 3, maxConsecutiveErrors: 99 }
    const guard = new ProgressGuard(limits)
    let reason: string | null = null
    // Ten todo updates are pure planning, not edits or probing — they must not trip
    // the no-edit guard even well past its threshold.
    for (let i = 0; i < 10; i++) reason = guard.observe(toolCall('todo'))
    expect(reason).toBeNull()
    // But real (non-planning) tool calls past the threshold still trip it.
    for (let i = 0; i < 3; i++) reason = guard.observe(toolCall('bash'))
    expect(reason).toMatch(/no progress/i)
  })

  it('does not count read-only exploration (read/grep/glob/…) toward the no-edit bound', () => {
    const limits: ProgressGuardLimits = { maxToolCallsWithoutEdit: 3, maxConsecutiveErrors: 99 }
    const guard = new ProgressGuard(limits)
    let reason: string | null = null
    // Reading/searching many files before a first edit is legitimate exploration, not
    // the environment-probing the no-edit bound targets — it must not trip even far
    // past the threshold.
    for (const t of ['read', 'grep', 'glob', 'ls', 'search', 'find', 'view']) {
      for (let i = 0; i < 3; i++) reason = guard.observe(toolCall(t))
    }
    expect(reason).toBeNull()
    // But "action" calls (bash) without an edit past the threshold still trip it.
    for (let i = 0; i < 3; i++) reason = guard.observe(toolCall('bash'))
    expect(reason).toMatch(/no progress/i)
  })

  it('does not count web search/fetch toward the no-edit bound', () => {
    const limits: ProgressGuardLimits = { maxToolCallsWithoutEdit: 3, maxConsecutiveErrors: 99 }
    const guard = new ProgressGuard(limits)
    let reason: string | null = null
    // rpiv-web-tools research calls are read-only, like read/grep — they must not
    // trip the no-edit guard even far past its threshold.
    for (const t of ['web_search', 'web_fetch']) {
      for (let i = 0; i < 5; i++) reason = guard.observe(toolCall(t))
    }
    expect(reason).toBeNull()
    // But "action" calls (bash) without an edit past the threshold still trip it.
    for (let i = 0; i < 3; i++) reason = guard.observe(toolCall('bash'))
    expect(reason).toMatch(/no progress/i)
  })

  it('trips on an uninterrupted run of web search/fetch calls (search rabbit-hole)', () => {
    // Web tools are exempt from the no-edit bound, so a dedicated cap stops a model
    // looping on searches forever. Any non-web call resets the streak.
    const limits = {
      maxToolCallsWithoutEdit: 999,
      maxConsecutiveErrors: 99,
      maxConsecutiveWebCalls: 4,
    }
    const guard = new ProgressGuard(limits)
    let reason: string | null = null
    for (let i = 0; i < 3; i++) reason = guard.observe(toolCall('web_search'))
    expect(reason).toBeNull()
    // A non-web call resets the streak, so we don't trip on the next web call.
    guard.observe(toolCall('read'))
    for (let i = 0; i < 3; i++) reason = guard.observe(toolCall('web_fetch'))
    expect(reason).toBeNull()
    // The 4th consecutive web call now trips the cap.
    reason = guard.observe(toolCall('web_search'))
    expect(reason).toMatch(/researching/i)
  })

  it('skips the no-edit bound for assess-only runs (expectsEdits=false)', () => {
    const limits: ProgressGuardLimits = { maxToolCallsWithoutEdit: 3, maxConsecutiveErrors: 99 }
    const guard = new ProgressGuard(limits, false)
    let reason: string | null = null
    for (let i = 0; i < 10; i++) reason = guard.observe(toolCall('bash'))
    expect(reason).toBeNull()
  })

  it('aborts after too many consecutive failing tool calls', () => {
    const limits: ProgressGuardLimits = { maxToolCallsWithoutEdit: 999, maxConsecutiveErrors: 3 }
    const guard = new ProgressGuard(limits)
    expect(guard.observe(toolCall('bash', true))).toBeNull()
    expect(guard.observe(toolCall('bash', false))).toBeNull() // resets the streak
    expect(guard.observe(toolCall('bash', true))).toBeNull()
    expect(guard.observe(toolCall('bash', true))).toBeNull()
    expect(guard.observe(toolCall('bash', true))).toMatch(/consecutive failing tool calls/i)
  })

  it('ignores non-tool events', () => {
    const guard = new ProgressGuard({ maxToolCallsWithoutEdit: 1, maxConsecutiveErrors: 1 })
    expect(guard.observe({ type: 'message_end', message: { role: 'assistant' } })).toBeNull()
    expect(guard.observe({ type: 'agent_end', messages: [] })).toBeNull()
  })

  it('reads limits from the environment, falling back to defaults', () => {
    expect(progressGuardLimitsFromEnv({})).toEqual(DEFAULT_PROGRESS_GUARD_LIMITS)
    expect(
      progressGuardLimitsFromEnv({
        JOB_MAX_TOOLCALLS_WITHOUT_EDIT: '7',
        JOB_MAX_CONSECUTIVE_TOOL_ERRORS: '4',
      }),
    ).toEqual({
      maxToolCallsWithoutEdit: 7,
      maxConsecutiveErrors: 4,
      maxConsecutiveWebCalls: DEFAULT_PROGRESS_GUARD_LIMITS.maxConsecutiveWebCalls,
    })
    expect(progressGuardLimitsFromEnv({ JOB_MAX_CONSECUTIVE_WEB_CALLS: '6' })).toEqual({
      ...DEFAULT_PROGRESS_GUARD_LIMITS,
      maxConsecutiveWebCalls: 6,
    })
    // Garbage values fall back rather than disabling the guard.
    expect(progressGuardLimitsFromEnv({ JOB_MAX_TOOLCALLS_WITHOUT_EDIT: '-3' })).toEqual(
      DEFAULT_PROGRESS_GUARD_LIMITS,
    )
  })
})

describe('mergeGuardLimits (per-kind override over the base)', () => {
  it('returns the base unchanged when there are no overrides', () => {
    expect(mergeGuardLimits(DEFAULT_PROGRESS_GUARD_LIMITS, undefined)).toEqual(
      DEFAULT_PROGRESS_GUARD_LIMITS,
    )
  })

  it('applies only the knobs present in the override, keeping the base for the rest', () => {
    const merged = mergeGuardLimits(DEFAULT_PROGRESS_GUARD_LIMITS, { maxConsecutiveErrors: 20 })
    expect(merged).toEqual({
      ...DEFAULT_PROGRESS_GUARD_LIMITS,
      maxConsecutiveErrors: 20,
    })
    // The unspecified knobs are untouched (a partial override is not all-or-nothing).
    expect(merged.maxToolCallsWithoutEdit).toBe(
      DEFAULT_PROGRESS_GUARD_LIMITS.maxToolCallsWithoutEdit,
    )
    expect(merged.maxConsecutiveWebCalls).toBe(DEFAULT_PROGRESS_GUARD_LIMITS.maxConsecutiveWebCalls)
  })

  it('enforces loosen-only: an override TIGHTER than the base is clamped up to the base', () => {
    // A value below the default must never tighten the guard (it would abort a
    // legitimately-progressing run). Every knob is clamped to at least the base.
    const tighter = {
      maxToolCallsWithoutEdit: 1,
      maxConsecutiveErrors: 1,
      maxConsecutiveWebCalls: 1,
    }
    expect(mergeGuardLimits(DEFAULT_PROGRESS_GUARD_LIMITS, tighter)).toEqual(
      DEFAULT_PROGRESS_GUARD_LIMITS,
    )
  })

  it('loosens only the over-base knobs while clamping the rest, in a mixed override', () => {
    const merged = mergeGuardLimits(DEFAULT_PROGRESS_GUARD_LIMITS, {
      maxConsecutiveErrors: 999, // loosen
      maxConsecutiveWebCalls: 1, // tighter than base ⇒ clamped back to base
    })
    expect(merged.maxConsecutiveErrors).toBe(999)
    expect(merged.maxConsecutiveWebCalls).toBe(DEFAULT_PROGRESS_GUARD_LIMITS.maxConsecutiveWebCalls)
    expect(merged.maxToolCallsWithoutEdit).toBe(
      DEFAULT_PROGRESS_GUARD_LIMITS.maxToolCallsWithoutEdit,
    )
  })
})

describe('web search (rpiv-web-tools) configuration', () => {
  it('stays off when no provider is configured', () => {
    expect(webSearchConfigFromEnv({})).toBeUndefined()
    expect(webSearchConfigFromEnv({ WEB_SEARCH_PROVIDER: '   ' })).toBeUndefined()
  })

  it('auto-enables from a configured provider credential', () => {
    // A provider key present in the env turns web search on with that provider —
    // no separate on/off flag (mirrors Claude Code / Codex enabling on config).
    expect(webSearchConfigFromEnv({ TAVILY_API_KEY: 'tvly-x' })).toEqual({ provider: 'tavily' })
    expect(webSearchConfigFromEnv({ EXA_API_KEY: 'exa-x' })).toEqual({ provider: 'exa' })
    // Keyless backends are signalled by their base-URL var.
    expect(webSearchConfigFromEnv({ SEARXNG_URL: 'http://searx.local' })).toEqual({
      provider: 'searxng',
    })
  })

  it('picks the highest-priority provider when several are configured', () => {
    // brave leads (what Claude Code uses); self-hosted backends come last.
    expect(
      webSearchConfigFromEnv({ SEARXNG_URL: 'http://searx.local', BRAVE_SEARCH_API_KEY: 'b' }),
    ).toEqual({ provider: 'brave' })
  })

  it('honours WEB_SEARCH_PROVIDER as an explicit override (when its key is present)', () => {
    // The pin selects the provider regardless of detection order, but still requires
    // that provider's own credential to be configured.
    expect(
      webSearchConfigFromEnv({
        WEB_SEARCH_PROVIDER: 'Exa',
        EXA_API_KEY: 'exa-x',
        BRAVE_SEARCH_API_KEY: 'b',
      }),
    ).toEqual({ provider: 'exa' })
    expect(
      webSearchConfigFromEnv({ WEB_SEARCH_PROVIDER: ' tavily ', TAVILY_API_KEY: 'tvly' }),
    ).toEqual({ provider: 'tavily' })
  })

  it('ignores an explicit provider pin whose credential is missing', () => {
    // A pin without the matching key would otherwise nudge the agent towards a tool
    // that errors the moment it's called; treat it as not-configured instead.
    expect(webSearchConfigFromEnv({ WEB_SEARCH_PROVIDER: 'exa' })).toBeUndefined()
    expect(
      webSearchConfigFromEnv({ WEB_SEARCH_PROVIDER: 'tavily', BRAVE_SEARCH_API_KEY: 'b' }),
    ).toBeUndefined()
    // An unknown provider id (not in our env table) is taken on trust — we can't
    // validate a key we don't know the name of.
    expect(webSearchConfigFromEnv({ WEB_SEARCH_PROVIDER: 'custom-engine' })).toEqual({
      provider: 'custom-engine',
    })
  })

  it('derives the proxy-backed SearXNG env from the proxy base URL + token', () => {
    // Proxy mode points the SearXNG provider at the backend search proxy with the
    // session token as the bearer — so detection picks searxng and no key is on disk.
    const env = webSearchProxyEnv('https://worker.example/v1', 'sess-tok')
    expect(env).toEqual({
      SEARXNG_URL: 'https://worker.example/v1/web-search',
      SEARXNG_API_KEY: 'sess-tok',
    })
    expect(webSearchConfigFromEnv({ ...env })).toEqual({ provider: 'searxng' })
  })

  it('writes only the provider id to the extension config (no secret on disk)', async () => {
    await stubTempHome()
    const path = await writeWebToolsConfig({ provider: 'exa' })
    const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    // Only the provider — keys/base URLs come from the environment, never written here.
    expect(written).toEqual({ provider: 'exa' })
    expect(path).toContain(join('.config', 'rpiv-web-tools', 'config.json'))
  })
})

describe('writeAgentsContext', () => {
  async function readContext(opts?: { webSearch?: boolean; guidance?: string }): Promise<string> {
    const home = await stubTempHome()
    await writeAgentsContext('ROLE PROMPT', opts)
    return readFile(join(home, '.pi', 'agent', 'AGENTS.md'), 'utf8')
  }

  it('omits the web-tools guidance by default', async () => {
    const md = await readContext()
    expect(md).toContain('ROLE PROMPT')
    expect(md).not.toMatch(/web_search/)
  })

  it('appends the generic web-tools guidance when enabled with no per-kind text', async () => {
    const md = await readContext({ webSearch: true })
    expect(md).toContain('ROLE PROMPT')
    expect(md).toMatch(/web_search/)
    expect(md).toMatch(/web_fetch/)
  })

  it('uses the backend-supplied per-kind guidance when provided', async () => {
    const md = await readContext({ webSearch: true, guidance: '\n\nSEARCH-THE-CVE-DATABASE' })
    expect(md).toContain('SEARCH-THE-CVE-DATABASE')
  })

  it('ignores per-kind guidance when web search is off', async () => {
    const md = await readContext({ webSearch: false, guidance: '\n\nSEARCH-THE-CVE-DATABASE' })
    expect(md).not.toContain('SEARCH-THE-CVE-DATABASE')
  })
})
