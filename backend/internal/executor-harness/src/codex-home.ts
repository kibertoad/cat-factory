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
 * What became of the image capability a job asked for, so the run can SAY so.
 *
 * Its own value rather than a boolean, because the two failures need different words and the
 * teardown report needs to tell them apart: an image found in the home afterwards is a LATE
 * arrival when the redirect was live, and a file that was never reachable at all when it was not.
 */
export type CodexImageOutcome =
  /** The redirect is in place: the agent reads what the tool writes, the moment it writes it. */
  | { state: 'staged' }
  /** Enabled nowhere: an ambient run has no per-run home to configure or redirect. */
  | { state: 'unavailable'; reason: 'ambient-home' }
  /** The tool is on and its output goes somewhere the agent cannot reach during the run. */
  | { state: 'unavailable'; reason: 'redirect-refused' }

/** This job's `CODEX_HOME` (absent for an ambient run) and what its image capability came to. */
export interface CodexHomeSetup {
  home?: string
  /** Absent when the job asked for no image generation. */
  images?: CodexImageOutcome
}

/**
 * Create and populate this job's `CODEX_HOME`, or answer no home for an ambient run.
 *
 * Ambient mode writes nothing deliberately: there is no per-run home, so there is nowhere to put
 * MCP servers (writing them into the developer's own `~/.codex/config.toml` would outlive the run
 * and race a concurrent job) and nowhere to redirect generated images.
 *
 * What it does NOT do is drop the image capability quietly. The backend composed a brief naming
 * the staging directory and told the agent to collect from it, so an ambient run with the tool
 * silently off leaves the agent hunting for files nothing wrote and reporting a vendor problem
 * for a configuration one. The outcome comes back so the caller can state it, which is what the
 * brief's own "if the tool is unavailable, say so" instruction exists to be paired with.
 */
export async function createCodexHome(opts: CodexHomeOptions): Promise<CodexHomeSetup> {
  if (!opts.ambientAuth && !opts.subscriptionToken) {
    throw new Error('codex harness requires a subscription token (or ambientAuth)')
  }
  if (opts.ambientAuth) {
    return opts.generateImages ? { images: { state: 'unavailable', reason: 'ambient-home' } } : {}
  }
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
  if (!opts.generateImages) return { home: codexHome }
  // Redirect the tool's output into the checkout BEFORE the CLI starts, so the agent never has to
  // read this directory (which holds the decrypted credential) to find what it generated. The
  // answer is KEPT rather than discarded: a refused redirect leaves the tool enabled and its
  // output unreachable until the post-run sweep, which is a different fact from a live one and
  // the difference the teardown report would otherwise get wrong.
  const staged = await stageCodexImages(codexHome, opts.cwd, opts.log)
  return {
    home: codexHome,
    images: staged ? { state: 'staged' } : { state: 'unavailable', reason: 'redirect-refused' },
  }
}

/**
 * What to TELL THE AGENT when the image capability it was briefed on is not there, or undefined
 * when there is nothing to say.
 *
 * Appended to the user prompt rather than left to the backend, because only this half knows: the
 * backend resolved a harness-served generator and composed a brief naming the staging directory,
 * and whether that directory can be written to is decided here, one process later. Silence is the
 * one answer that is never right — it reads to the agent exactly like a working tool that returned
 * nothing.
 */
export function codexImageGapNote(images: CodexImageOutcome | undefined): string | undefined {
  if (!images || images.state === 'staged') return undefined
  const shared =
    `Nothing will appear in \`${GENERATED_BINARY_DIR}/\` while you are working. Report the ` +
    `artifacts you could not produce, exactly as your instructions for an unavailable generation ` +
    `tool describe, and do not substitute another generator or describe an image you did not make.`
  return images.reason === 'ambient-home'
    ? `NOTE: this run's built-in image generation tool could NOT be enabled. It needs an isolated ` +
        `per-run CLI home, and this run uses the host's own CLI login, which is not reconfigured ` +
        `for a job. ${shared}`
    : `NOTE: this run's built-in image generation tool is enabled, but its output could NOT be ` +
        `redirected into the checkout, so anything it writes lands somewhere you cannot read. ` +
        `${shared}`
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
export async function disposeCodexHome(
  codexHome: string,
  opts: CodexHomeOptions,
  images?: CodexImageOutcome,
): Promise<void> {
  if (opts.generateImages) {
    const stranded = await sweepCodexImages(codexHome, opts.cwd, opts.log)
    if (stranded.length > 0) {
      // REPORTED rather than quietly rescued: an image that arrived too late for the agent to
      // store is a different fact from a run that generated none.
      //
      // And WHICH fact depends on what the setup came to, which is why the outcome is threaded in
      // rather than inferred here. With a live redirect these really are late arrivals (the CLI
      // wrote after the agent's last turn); with a refused one they were never reachable at all,
      // and calling those "late" points the next reader at the model instead of at the filesystem.
      opts.log?.warn(
        images?.state === 'unavailable'
          ? 'generated images were rescued after the run: the output redirect was never in place'
          : 'generated images were staged after the agent finished',
        { count: stranded.length, dir: GENERATED_BINARY_DIR },
      )
    }
    await unstageCodexImages(codexHome, opts.log)
  }
  await retainSessionTranscripts(codexHome, ['sessions'], {
    label: 'codex',
    ...(opts.log ? { log: opts.log } : {}),
  })
  await rm(codexHome, { recursive: true, force: true }).catch(() => {})
}
