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
// **This file is wiring only.** It supplies the real config, the real client and the real terminal;
// what it does with what they answer, and what it does when any of them cannot answer, is
// `src/personalPasswordAsk.ts`, where it is unit-tested. Nothing here persists anything (see
// `readPersonalPassword` for what the ask costs and what it still protects), and nothing here takes
// over any reporting: the preflight owns telling an operator that the deployment is unreachable or
// the pinned preset is wrong, and a second voice saying it from a process with no journal would be
// the worse of the two.

import { join } from 'node:path'
import type { TestProject } from 'vitest/node'
import { requireConfig } from '../src/config.ts'
import { envFile } from '../src/envFile.ts'
import { askForPersonalPassword } from '../src/personalPasswordAsk.ts'
import { readPersonalPassword } from '../src/personalUnlock.ts'
import { createClient, readPinnedPreset } from '../src/publicApi.ts'

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

export default function askOnce(project: TestProject): Promise<void> {
  return askForPersonalPassword({
    log: (message) => console.log(message),
    provide: (password) => project.provide('personalPassword', password),
    // The `.env` beside the vitest config is not applied in the MAIN process, so it is read the same
    // way the vitest config reads it rather than assumed to be in `process.env`.
    readPinned: () => {
      const config = requireConfig({ ...process.env, ...envFile(join(import.meta.dirname, '..')) })
      return readPinnedPreset(createClient(config), config.modelPresetId)
    },
    readSecret: readPersonalPassword,
  })
}
