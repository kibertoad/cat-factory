// The two facts that must be settled ONCE for the whole pass, before any spec runs: the pass's RUN
// ID and the operator's personal password.
//
// **Why the run id belongs here.** It is the key to the ledger the specs pass facts through, so a
// pass has exactly one or it has none: minted per spec file (the shape this replaced), five files
// opened five ledgers a second apart, spec 02 could not see the two services spec 01 had just
// adopted, `status` had five journals to choose between, and the `latest` pointer named whichever
// file finished last. Vitest runs this in the main process before any worker exists, and `provide`
// hands the value over its RPC channel, which is the same reason the password is asked here.
//
// **Why the password is asked here.** Vitest gives every test file its own module graph, even under
// this suite's single worker, so the holder in `fixtures.ts` is per spec FILE: asked lazily, a pass that
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
//
// The password ask may therefore never throw, and the run id is the ONE thing here that may: asked
// for `latest` with no previous pass on disk, `resolveRunId` refuses, and that refusal is a decision
// the operator has to make before anything runs (the same class as pressing Ctrl-C at the prompt),
// not a degradation the pass could carry. It reads only `ACCEPTANCE_STATE_DIR`, so a deployment that
// is half-configured still reaches the preflight that diagnoses it.

import { join } from 'node:path'
import type { TestProject } from 'vitest/node'
import { requireConfig, stateDirFrom } from '../src/config.ts'
import { envFile } from '../src/envFile.ts'
import { askForPersonalPassword } from '../src/personalPasswordAsk.ts'
import { readPersonalPassword } from '../src/personalUnlock.ts'
import { createClient, readPinnedPreset } from '../src/publicApi.ts'
import { resolveRunId } from '../src/world.ts'

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
    /**
     * The run id every spec in this pass files its facts under. Required, unlike the password:
     * a spec that is handed none refuses rather than minting its own (`requirePassRunId`).
     */
    acceptanceRunId: string
  }
}

export default async function settleThePass(project: TestProject): Promise<void> {
  // The `.env` beside the vitest config is not applied in the MAIN process, so it is read the same
  // way the vitest config reads it rather than assumed to be in `process.env`. Both readers below
  // need it, which is why it is resolved once here.
  const env = { ...process.env, ...envFile(join(import.meta.dirname, '..')) }
  project.provide('acceptanceRunId', resolveRunId(env, stateDirFrom(env)))
  await askForPersonalPassword({
    log: (message) => console.log(message),
    provide: (password) => project.provide('personalPassword', password),
    readPinned: () => {
      const config = requireConfig(env)
      return readPinnedPreset(createClient(config), config.modelPresetId)
    },
    readSecret: readPersonalPassword,
  })
}
