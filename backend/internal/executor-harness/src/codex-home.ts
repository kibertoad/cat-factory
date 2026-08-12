import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codexMcpConfigToml,
  mcpServerSecretValues,
  type McpServerSpec,
} from './agent-capabilities.js'
import {
  GENERATED_BINARY_DIR,
  stageCodexImages,
  sweepCodexImages,
  unstageCodexImages,
} from './codex-images.js'
import type { Logger } from './logger.js'
import { registerKnownSecrets } from './redact.js'
import { retainSessionTranscripts } from './transcript-retention.js'

// ---------------------------------------------------------------------------
// The PER-RUN `CODEX_HOME`: everything that is written for one codex job and torn down with it.
//
// Extracted from `runCodex`, which had grown past the file-size ratchet: the run loop's own job is
// streaming and reducing the CLI's events, and this is a distinct concern — a directory with a
// lifecycle, holding a credential, a config and (now) a redirect for the CLI's generated output.
//
// CRITICAL and the reason it is a temp dir rather than anything under the checkout: several
// handlers finish with `git add -A` + push, so a decrypted `auth.json` inside `opts.cwd` would be
// published to the PR branch.
//
// KNOWN LIMITATION, unchanged by the extraction: codex refreshes its OAuth access token in place by
// rewriting `auth.json` mid-run, and this home is wiped afterwards, so the refreshed credential is
// discarded and never written back to the pool. The stored bundle keeps working while its refresh
// token stays valid (ChatGPT refresh tokens are long-lived and reused, not rotated per refresh
// today); if that ever changes, a pooled codex token would need re-connecting by its owner. Claude
// OAuth tokens (from `claude setup-token`) are long-lived and unaffected.
// ---------------------------------------------------------------------------

/** What one codex job needs written into its own home. */
export interface CodexHomeOptions {
  /** The decrypted `auth.json` bundle. Required unless `ambientAuth`. */
  subscriptionToken?: string
  /** Run the developer's own CLI login instead: no isolated home, nothing written. */
  ambientAuth?: boolean
  /** Tool servers to scope to this job's config. */
  mcpServers?: McpServerSpec[]
  /** Enable the CLI's built-in image tool and redirect its output into the checkout. */
  generateImages?: boolean
  /** The checkout, which is where generated output is staged to. */
  cwd: string
  log?: Logger
}

/**
 * Create and populate this job's `CODEX_HOME`, or answer undefined for an ambient run.
 *
 * Ambient mode returns nothing deliberately: there is no per-run home, so there is nowhere to put
 * MCP servers (writing them into the developer's own `~/.codex/config.toml` would outlive the run
 * and race a concurrent job) and nowhere to redirect generated images. The backend states both as
 * unavailable rather than half-enabling them.
 */
export async function createCodexHome(opts: CodexHomeOptions): Promise<string | undefined> {
  if (!opts.ambientAuth && !opts.subscriptionToken) {
    throw new Error('codex harness requires a subscription token (or ambientAuth)')
  }
  if (opts.ambientAuth) return undefined
  const codexHome = await mkdtemp(join(tmpdir(), 'cf-codex-'))
  await writeFile(join(codexHome, 'auth.json'), opts.subscriptionToken!, { mode: 0o600 })
  // Registered before the CLI starts, for the same reason the claude path does it: a server that
  // fails to launch puts its own command line into the stderr tail we keep.
  if (opts.mcpServers?.length) registerKnownSecrets(mcpServerSecretValues(opts.mcpServers))
  const mcpToml = opts.mcpServers?.length ? codexMcpConfigToml(opts.mcpServers) : ''
  // `image_generation` is OPT-IN per job rather than always-on: the tool bills the leased ChatGPT
  // plan at 3-5x an ordinary turn, so every non-generating run would pay for a capability it was
  // never asked for. Enabled only when the dispatch selected a harness-served generator, which is
  // the one thing that knows the step exists to make pictures.
  const imagesToml = opts.generateImages ? '\n[features]\nimage_generation = true\n' : ''
  await writeFile(
    join(codexHome, 'config.toml'),
    `cli_auth_credentials_store = "file"\n${mcpToml ? `\n${mcpToml}` : ''}${imagesToml}`,
    { encoding: 'utf8', mode: 0o600 },
  )
  // Redirect the tool's output into the checkout BEFORE the CLI starts, so the agent never has to
  // read this directory (which holds the decrypted credential) to find what it generated.
  if (opts.generateImages) await stageCodexImages(codexHome, opts.cwd, opts.log)
  return codexHome
}

/**
 * Tear the home down: rescue anything generated, keep the transcripts, delete the credential.
 *
 * ORDER is load-bearing. The image sweep runs first because the files are about to be deleted with
 * the home; the redirect is unlinked next so the recursive delete cannot follow it into the
 * checkout; the transcripts are lifted before the delete (the credential lives at the home ROOT,
 * never in `sessions/`, which is what makes that safe); and the delete is last, because nothing
 * else may leave a decrypted credential on disk past the run.
 */
export async function disposeCodexHome(codexHome: string, opts: CodexHomeOptions): Promise<void> {
  if (opts.generateImages) {
    const stranded = await sweepCodexImages(codexHome, opts.cwd, opts.log)
    if (stranded.length > 0) {
      // REPORTED rather than quietly rescued: an image that arrived too late for the agent to
      // store is a different fact from a run that generated none.
      opts.log?.warn('generated images were staged after the agent finished', {
        count: stranded.length,
        dir: GENERATED_BINARY_DIR,
      })
    }
    await unstageCodexImages(codexHome)
  }
  await retainSessionTranscripts(codexHome, ['sessions'], {
    label: 'codex',
    ...(opts.log ? { log: opts.log } : {}),
  })
  await rm(codexHome, { recursive: true, force: true }).catch(() => {})
}
