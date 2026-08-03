import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runClaudeCode } from '../src/agent-runner.js'
import type { McpServerSpec } from '../src/agent-capabilities.js'
import { secretEnv, testSecretEnv } from '../src/agent.js'
import { installsSkillNatively } from '../src/pi-workspace.js'
import { stubTempHome } from './helpers.js'

// Per-job isolation for the NATIVE (`ambientAuth`) path. A container runs one job per process
// with its own HOME, so the harness could safely stage per-job state in process- and HOME-globals.
// The local native transport breaks both assumptions: ONE long-lived host process serves every
// concurrent ambient job, on the DEVELOPER's own home. These pin the three places that used to
// assume otherwise — the tester's secrets, the repo-sourced Claude Skill, and (in
// package-registries.test.ts) the npmrc.

describe('testSecretEnv', () => {
  it('returns the secrets as child env instead of mutating process.env', () => {
    const before = process.env.TEST_DB_PASSWORD
    const env = testSecretEnv([
      { key: 'TEST_DB_PASSWORD', value: 's3cret' },
      { key: 'TEST_API_KEY', value: 'ak_live_1' },
    ])

    expect(env).toEqual({ TEST_DB_PASSWORD: 's3cret', TEST_API_KEY: 'ak_live_1' })
    // The harness process is shared across concurrent jobs — a global set/restore would leak one
    // job's secrets into a sibling, and the sibling's restore would delete them mid-run.
    expect(process.env.TEST_DB_PASSWORD).toBe(before)
    expect(process.env.TEST_API_KEY).toBeUndefined()
  })

  it('is empty for a run with no test secrets', () => {
    expect(testSecretEnv(undefined)).toEqual({})
    expect(testSecretEnv([])).toEqual({})
  })

  it("keeps two concurrent jobs' secrets in separate envs", () => {
    const a = testSecretEnv([{ key: 'TEST_TOKEN', value: 'from_job_a' }])
    const b = testSecretEnv([{ key: 'TEST_TOKEN', value: 'from_job_b' }])
    expect(a.TEST_TOKEN).toBe('from_job_a')
    expect(b.TEST_TOKEN).toBe('from_job_b')
  })
})

describe('generative integration credentials (generatorSecrets)', () => {
  it("keeps two concurrent jobs' generator credentials in separate envs", () => {
    // The same rule the tester's secrets follow, and it matters more here: a generation API key
    // is per-DEPLOYMENT config resolved per dispatch, so on the shared native host process two
    // jobs against different workspaces would otherwise read whichever landed last.
    const a = secretEnv([{ key: 'RD_TOKEN', value: 'from_job_a' }])
    const b = secretEnv([{ key: 'RD_TOKEN', value: 'from_job_b' }])
    expect(a.RD_TOKEN).toBe('from_job_a')
    expect(b.RD_TOKEN).toBe('from_job_b')
    expect(process.env.RD_TOKEN).toBeUndefined()
  })

  it('is empty for a job that carries none, so a non-generating run is unchanged', () => {
    expect(secretEnv(undefined)).toEqual({})
  })
})

describe('installsSkillNatively', () => {
  it('installs into the isolated config home for a leased-credential claude-code run', () => {
    expect(installsSkillNatively({ harness: 'claude-code' })).toBe(true)
  })

  it('does NOT install natively for an ambient run (no isolated config home to use)', () => {
    // The alternative would be the developer's own ~/.claude, which outlives the run.
    expect(installsSkillNatively({ harness: 'claude-code', ambientAuth: true })).toBe(false)
  })

  it('does not install natively for codex or Pi (they read the checkout)', () => {
    expect(installsSkillNatively({ harness: 'codex' })).toBe(false)
    expect(installsSkillNatively({ harness: 'codex', ambientAuth: true })).toBe(false)
    expect(installsSkillNatively({})).toBe(false)
  })
})

// Drives the REAL `runClaudeCode` against a fake `claude` on PATH, so the skill-install and
// env-threading decisions are asserted where they actually happen. Unix-only: the fake is a
// chmod-+x shebang script (the same constraint agent-runner.test.ts carries).
const unix = process.platform !== 'win32'

describe.runIf(unix)('runClaudeCode per-job isolation', () => {
  let binDir: string
  let cwd: string
  let priorPath: string | undefined

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'bin-'))
    cwd = await mkdtemp(join(tmpdir(), 'cwd-'))
    priorPath = process.env.PATH
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`
  })

  afterEach(async () => {
    process.env.PATH = priorPath
    await rm(binDir, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  })

  /**
   * A fake `claude` that dumps, into its cwd: its environment (`env.json`), its argv
   * (`argv.json`), and — crucially for the MCP assertions — the CONTENT of whatever
   * `--mcp-config` file it was pointed at (`mcp.json`). Reading the config from inside the fake
   * is what makes per-job isolation assertable: the harness deletes the file when the run ends,
   * so checking it afterwards could only ever show it gone, never show which job's servers it
   * held while that job was live.
   */
  async function envDumpingCli(): Promise<void> {
    const script = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
process.stdin.resume()
process.stdin.on('data', () => {})
process.stdin.on('end', () => {
  const argv = process.argv.slice(2)
  fs.writeFileSync(path.join(process.cwd(), 'env.json'), JSON.stringify(process.env))
  fs.writeFileSync(path.join(process.cwd(), 'argv.json'), JSON.stringify(argv))
  const at = argv.indexOf('--mcp-config')
  if (at !== -1 && argv[at + 1]) {
    fs.writeFileSync(path.join(process.cwd(), 'mcp.json'), fs.readFileSync(argv[at + 1], 'utf8'))
  }
  const line = JSON.stringify({ type: 'result', result: 'ok' })
  process.stdout.write(line + '\\n', () => process.exit(0))
})
`
    await writeFile(join(binDir, 'claude'), script, { mode: 0o755 })
  }

  const readArgv = async (dir: string): Promise<string[]> =>
    JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8')) as string[]

  const mcpServer = (id: string, token: string): McpServerSpec => ({
    id,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', `${id}-mcp`],
    env: { SERVER_TOKEN: token },
    secretKeys: ['SERVER_TOKEN'],
  })

  const skill = {
    name: 'repo-linter',
    description: 'Lint this repo',
    instructions: 'Run the linter.',
    resources: [],
  }

  const base = { cwd: '', model: 'claude-opus-4-8', systemPrompt: 'sys', userPrompt: 'do it' }

  it("does not write a run's skill into the developer's ~/.claude on an ambient run", async () => {
    const home = await stubTempHome()
    await envDumpingCli()

    await runClaudeCode({ ...base, cwd, ambientAuth: true, skills: [skill] })

    // Installing here would persist a run's skill in their personal setup after the run, and
    // two concurrent jobs with same-named skills from different repos would clobber each other.
    await expect(stat(join(home, '.claude', 'skills', 'repo-linter'))).rejects.toThrow()
  })

  it('threads the job-scoped extraEnv to the CLI child in ambient mode', async () => {
    await stubTempHome()
    await envDumpingCli()

    await runClaudeCode({
      ...base,
      cwd,
      ambientAuth: true,
      extraEnv: { TEST_DB_PASSWORD: 's3cret', npm_config_userconfig: '/tmp/job/.npmrc' },
    })

    const env = JSON.parse(await readFile(join(cwd, 'env.json'), 'utf8')) as Record<string, string>
    expect(env.TEST_DB_PASSWORD).toBe('s3cret')
    expect(env.npm_config_userconfig).toBe('/tmp/job/.npmrc')
    // Ambient mode must not hand the CLI a config home or a leased credential.
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('threads extraEnv alongside the isolated config home on a leased-credential run', async () => {
    await stubTempHome()
    await envDumpingCli()

    await runClaudeCode({
      ...base,
      cwd,
      subscriptionToken: 'oauth_tok',
      extraEnv: { TEST_DB_PASSWORD: 's3cret' },
    })

    const env = JSON.parse(await readFile(join(cwd, 'env.json'), 'utf8')) as Record<string, string>
    expect(env.TEST_DB_PASSWORD).toBe('s3cret')
    expect(env.CLAUDE_CONFIG_DIR).toBeTruthy()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth_tok')
  })

  // Tool servers (MCP) are the newest per-job state, and the one carrying this job's resolved
  // credentials. A container hides every mistake here (one job, one process, one HOME); the
  // native path does not.
  it('points the CLI at a per-run MCP config and pins it as the ONLY source of servers', async () => {
    const home = await stubTempHome()
    await envDumpingCli()

    await runClaudeCode({
      ...base,
      cwd,
      ambientAuth: true,
      mcpServers: [mcpServer('issues', 'tok-a')],
    })

    const argv = await readArgv(cwd)
    const configPath = argv[argv.indexOf('--mcp-config') + 1]!
    // Without `--strict-mcp-config` an ambient run would ALSO inherit the developer's personal
    // servers, silently handing the agent tools nobody wired for it.
    expect(argv).toContain('--strict-mcp-config')
    // Never the developer's own home (it would outlive the run and race a sibling job), and never
    // the checkout (it would land in a commit).
    expect(configPath.startsWith(home)).toBe(false)
    expect(configPath.startsWith(cwd)).toBe(false)
    // The config carries a credential, so it must not outlive the run.
    await expect(stat(configPath)).rejects.toThrow()
  })

  it('keeps two CONCURRENT ambient jobs on separate MCP configs', async () => {
    await stubTempHome()
    await envDumpingCli()
    const cwdB = await mkdtemp(join(tmpdir(), 'cwd-b-'))

    try {
      await Promise.all([
        runClaudeCode({
          ...base,
          cwd,
          ambientAuth: true,
          mcpServers: [mcpServer('issues', 'tok-a')],
        }),
        runClaudeCode({
          ...base,
          cwd: cwdB,
          ambientAuth: true,
          mcpServers: [mcpServer('advisories', 'tok-b')],
        }),
      ])

      const [argvA, argvB] = await Promise.all([readArgv(cwd), readArgv(cwdB)])
      const pathA = argvA[argvA.indexOf('--mcp-config') + 1]!
      const pathB = argvB[argvB.indexOf('--mcp-config') + 1]!
      // A shared path would have one job's servers (and credentials) served to the other — and
      // whichever finished first would delete the file out from under the one still running.
      expect(pathA).not.toBe(pathB)

      // What each job's CLI actually READ, captured while it was live. This is the assertion that
      // would fail on a HOME-global config: both would show the same, last-written servers.
      const [seenA, seenB] = await Promise.all([
        readFile(join(cwd, 'mcp.json'), 'utf8'),
        readFile(join(cwdB, 'mcp.json'), 'utf8'),
      ])
      expect(Object.keys(JSON.parse(seenA).mcpServers)).toEqual(['issues'])
      expect(Object.keys(JSON.parse(seenB).mcpServers)).toEqual(['advisories'])
      expect(seenA).toContain('tok-a')
      expect(seenA).not.toContain('tok-b')
      expect(seenB).not.toContain('tok-a')
    } finally {
      await rm(cwdB, { recursive: true, force: true })
    }
  })

  it('writes no MCP config, and passes no MCP argv, for a run with no tool servers', async () => {
    await stubTempHome()
    await envDumpingCli()

    await runClaudeCode({ ...base, cwd, ambientAuth: true })

    const argv = await readArgv(cwd)
    expect(argv).not.toContain('--mcp-config')
    expect(argv).not.toContain('--strict-mcp-config')
    expect(argv).not.toContain('--allowedTools')
  })
})
