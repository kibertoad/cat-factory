// Asking for the operator's personal password ONCE, before the pass starts.
//
// **Why here and not in a spec.** Vitest gives every test file its own module graph, even under this
// suite's single worker, so the holder in `fixtures.ts` is per spec FILE: asked lazily, a pass that
// spends four specs starting and answering runs is asked four times. Each of those prompts is written
// to the console while the reporter is redrawing test lines over it, which is how an operator ends up
// unsure whether their password was even accepted. `globalSetup` runs in the MAIN process before any
// worker exists and before a single test line is drawn, and `provide` hands the value to every worker
// over vitest's RPC channel. One ask, legible, for the whole pass.
//
// **What it does not do.** It does not persist anything (see `readPersonalPassword` for what the ask
// costs and what it still protects), and it does not take over any reporting. It answers ONE question,
// "will this pass be asked for a personal password", and when it cannot answer it says so and leaves
// the lazy path exactly as it was: the preflight owns telling an operator that the deployment is
// unreachable or the pinned preset is wrong, with the remedy attached, and a second voice saying it
// here from a process with no journal would be the worse of the two.

import { join } from 'node:path'
import type { TestProject } from 'vitest/node'
import { requireConfig } from '../src/config.ts'
import { envFile } from '../src/envFile.ts'
import { describeThrown } from '../src/operatorText.ts'
import { readPersonalPassword } from '../src/personalUnlock.ts'
import { personalPasswordNeed, pinnedModel } from '../src/presets.ts'
import { createClient } from '../src/publicApi.ts'

declare module 'vitest' {
  interface ProvidedContext {
    /**
     * The password for THIS pass, or absent when nothing asked for one.
     *
     * Optional deliberately: a workspace on a provider API key provides nothing, and `fixtures.ts`
     * reads the absence as "keep the terminal prompt as the fallback" rather than as an empty
     * password it would then send.
     */
    personalPassword?: string
  }
}

export default async function askForPersonalPassword(project: TestProject): Promise<void> {
  const pinned = await readPinnedModel()
  const need = personalPasswordNeed(pinned)
  if (need === 'unknown') {
    // Not a failure, and not silent either: the pass proceeds exactly as it did before this hook
    // existed, and the operator is told why a prompt may still interrupt them later.
    console.log(
      '\nCould not tell yet whether this pass needs your personal password, so it was not asked ' +
        'for up front. The preflight reports what it finds; if a run does need one, the prompt ' +
        'comes at that first dispatch instead.',
    )
    return
  }
  if (need === 'not-needed' || !pinned) return
  project.provide(
    'personalPassword',
    await readPersonalPassword(
      `This pass runs '${pinned.preset.name}' on ${pinned.model.label}, which is your personal ` +
        `${pinned.model.provider} subscription: only your personal password can open it. It is ` +
        'used for this pass only, is held in memory, and is written nowhere.',
    ),
  )
}

/**
 * The pinned preset and its catalog row, or `null` with the reason printed.
 *
 * Everything here can legitimately fail before a pass has reported anything: the `.env` may be
 * incomplete, the deployment may be down, the key may be wrong. None of that is this hook's to
 * diagnose, so a failure answers `null` (which {@link personalPasswordNeed} reads as `unknown`) with
 * the cause named, rather than a stack trace from a hook nobody expected to be doing network reads.
 */
async function readPinnedModel(): Promise<Awaited<ReturnType<typeof pinnedFromDeployment>> | null> {
  try {
    return await pinnedFromDeployment()
  } catch (error) {
    console.log(`\nCould not read the pinned model preset: ${describeThrown(error)}`)
    return null
  }
}

/** The two reads, both key-authed and neither of which can need a password itself. */
async function pinnedFromDeployment() {
  const config = requireConfig({ ...process.env, ...envFile(join(import.meta.dirname, '..')) })
  const client = createClient(config)
  const [{ presets }, { models }] = await Promise.all([
    client.modelPresets.list(),
    client.models.list(),
  ])
  return pinnedModel(presets, models, config.modelPresetId)
}
