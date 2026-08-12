import { lstat, mkdir, readdir, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { CONTEXT_DIR, excludeContextDir } from './pi.js'
import type { Logger } from './logger.js'

// ---------------------------------------------------------------------------
// CODEX'S OWN IMAGE GENERATION, staged somewhere the agent can actually reach.
//
// Codex CLI carries a built-in `image_gen` tool (gpt-image-2) that is available ONLY on ChatGPT
// subscription auth — an `OPENAI_API_KEY` session routes to the Images API instead and does not
// get the tool at all. That makes it the one generative path the platform can offer with no
// vendor API key anywhere, which is exactly what a `harness`-transport binary generator is.
//
// Two facts make this more than a feature flag.
//
// 1. Codex writes generated images to `$CODEX_HOME/generated_images/`, and does not reliably tell
//    anyone where they landed: the tool result exposes no path, no URL and no artifact id
//    (openai/codex#28887, #28898, #28873, #28849, all open), and `codex exec --json` never
//    surfaces structured tool bodies at all. So the PLATFORM has to know where the file is; asking
//    the model is the thing that does not work.
//
// 2. `$CODEX_HOME` is also where the decrypted subscription `auth.json` lives. Telling the agent to
//    go and look there would point a prompt-injectable process at the run's own credential — the
//    same exposure `runCodex` already keeps the home OUTSIDE the checkout to avoid.
//
// So the harness redirects the output instead: `generated_images` is created as a SYMLINK into the
// checkout's context directory before the CLI starts, and codex writes through it. The agent reads
// one stable, credential-free path, with no polling and no race between generating and uploading —
// the file is simply there the moment the tool returns. `$CODEX_HOME` stays unreadable to it.
//
// A post-run sweep backs that up for the case where the symlink could not be made (a filesystem
// that refuses one) or was replaced: anything sitting in a REAL `generated_images` directory is
// moved into the same staging path, so a run never silently loses an image it paid to generate.
// ---------------------------------------------------------------------------

/** Codex's own output directory name, relative to `CODEX_HOME`. Chosen by the CLI, not by us. */
const CODEX_OUTPUT_DIRNAME = 'generated_images'

/**
 * Where a harness-generated binary artifact is staged for the agent, relative to the checkout.
 *
 * Under {@link CONTEXT_DIR} so it inherits that directory's git exclude: an image the agent has
 * not uploaded yet must never be swept into a commit by the `git add -A` a coding run ends with.
 * Part of the backend↔harness path contract (`HARNESS_SENTINEL_PATHS.generatedBinaries`), because
 * the agent's brief has to NAME this path and the two halves are written independently.
 */
export const GENERATED_BINARY_SUBDIR = 'binary-output/generated'

/** The staging directory's repo-relative path, as the prompt names it. */
export const GENERATED_BINARY_DIR = `${CONTEXT_DIR}/${GENERATED_BINARY_SUBDIR}`

/**
 * Point codex's image output at the checkout, before the CLI starts.
 *
 * Returns whether the redirect is in place. FALSE is a real and reportable answer rather than a
 * throw: a run whose images cannot be staged is still a run worth doing (the agent may have plenty
 * of non-generating work), and the caller states the gap instead of failing the job. The sweep
 * below is what keeps that case from losing files outright.
 *
 * Best-effort by construction, and deliberately NOT idempotent-by-overwrite: an existing
 * `generated_images` is left exactly as it is. On the per-run home this is always a fresh
 * directory, so anything already there on the ambient path is the DEVELOPER's own history, and
 * replacing it with a symlink into a throwaway checkout would destroy it.
 */
export async function stageCodexImages(
  codexHome: string,
  cwd: string,
  log?: Logger,
): Promise<boolean> {
  const target = join(cwd, CONTEXT_DIR, GENERATED_BINARY_SUBDIR)
  try {
    await mkdir(target, { recursive: true })
    // The context directory's own exclude, applied here rather than assumed: a codex run that was
    // handed no context files never reaches the materialiser that normally writes it, and this is
    // the one writer whose output is BINARY and would otherwise be committed as such.
    await excludeContextDir(cwd)
    // `junction` is ignored off Windows and is what makes the same call work on a developer's
    // machine, where a plain directory symlink needs a privilege the shell usually lacks.
    await symlink(target, join(codexHome, CODEX_OUTPUT_DIRNAME), 'junction')
    return true
  } catch (error) {
    log?.warn('codex image staging unavailable; falling back to a post-run sweep', {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Move anything codex wrote into a REAL `generated_images` directory across to the staging path.
 *
 * The backstop for a redirect that did not take. Returns the file names moved, so the caller can
 * say what arrived after the agent had already finished — those are images the run generated and
 * the agent never had a chance to upload, which is a different fact from generating none, and the
 * kind of distinction this codebase refuses to let collapse into silence.
 *
 * A live redirect yields nothing here, detected by `lstat` on the directory itself: reading THROUGH
 * the link would list files that are already where they belong and report every one of them as
 * stranded.
 */
export async function sweepCodexImages(
  codexHome: string,
  cwd: string,
  log?: Logger,
): Promise<string[]> {
  const source = join(codexHome, CODEX_OUTPUT_DIRNAME)
  const target = join(cwd, CONTEXT_DIR, GENERATED_BINARY_SUBDIR)
  // A LIVE REDIRECT has nothing to sweep, and it must be detected by asking the filesystem rather
  // than by comparing paths: `readdir` through the link yields the staging directory's own files
  // under the SOURCE prefix, so every path pair looks distinct and every file the run generated is
  // "moved" onto itself and then reported as stranded. That is a false alarm on every successful
  // generating run — precisely inverting what this report is for.
  try {
    if ((await lstat(source)).isSymbolicLink()) return []
  } catch {
    // No directory at all is the normal case: the run generated nothing.
    return []
  }
  let names: string[]
  try {
    names = await readdir(source)
  } catch {
    return []
  }
  const moved: string[] = []
  for (const name of names) {
    const from = join(source, name)
    const to = join(target, name)
    try {
      await mkdir(target, { recursive: true })
      await rename(from, to)
      moved.push(name)
    } catch (error) {
      log?.warn('could not stage a generated image', {
        name,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return moved
}

/**
 * Remove the redirect before the per-run home is torn down.
 *
 * Only ever the LINK: `rm` on a symlink unlinks it and leaves the target alone, which is what must
 * happen here — the target is inside the checkout and holds the run's actual output. Passed the
 * home rather than the link path so a caller cannot accidentally hand it the staging directory.
 */
export async function unstageCodexImages(codexHome: string): Promise<void> {
  await rm(join(codexHome, CODEX_OUTPUT_DIRNAME), { recursive: false, force: true }).catch(() => {})
}
