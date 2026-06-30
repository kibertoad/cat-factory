import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from './exec.js'
import type { Logger } from './logger.js'

// Minimal git clone for the deploy harness. It only ever reads manifests from a repo —
// no commit/push — so this is far slimmer than the executor harness's git module. As
// there, the token NEVER touches argv: the remote embeds only the `x-access-token`
// username, and the token is handed to git out-of-band via a GIT_ASKPASS helper.

/** Embed only the `x-access-token` username (no secret) in the remote URL. */
function authenticatedCloneUrl(cloneUrl: string): string {
  return cloneUrl.replace(/^https:\/\//, 'https://x-access-token@')
}

let askpassPathPromise: Promise<string> | undefined
function ensureAskpass(): Promise<string> {
  askpassPathPromise ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'git-askpass-'))
    const path = join(dir, 'askpass.sh')
    await writeFile(path, '#!/bin/sh\nexec printf %s "$GIT_ASKPASS_TOKEN"\n', 'utf8')
    await chmod(path, 0o700)
    return path
  })()
  return askpassPathPromise
}

/** Child-process env that lets git authenticate with `ghToken` without it touching argv. */
async function authEnv(ghToken: string | undefined): Promise<NodeJS.ProcessEnv> {
  if (!ghToken) return { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  return {
    ...process.env,
    GIT_ASKPASS: await ensureAskpass(),
    GIT_ASKPASS_TOKEN: ghToken,
    GIT_TERMINAL_PROMPT: '0',
  }
}

/** Shallow-clone `cloneUrl` at `ref` into `dir` (manifests are read-only — no identity set). */
export async function cloneManifests(opts: {
  cloneUrl: string
  ref: string
  dir: string
  ghToken?: string
  signal?: AbortSignal
  redactSecrets?: readonly string[]
  log?: Logger
}): Promise<void> {
  const url = authenticatedCloneUrl(opts.cloneUrl)
  await runCli(
    'git',
    ['clone', '--depth', '1', '--branch', opts.ref, '--single-branch', url, opts.dir],
    {
      signal: opts.signal,
      env: await authEnv(opts.ghToken),
      redactSecrets: opts.redactSecrets,
      ...(opts.log ? { log: opts.log } : {}),
    },
  )
}
